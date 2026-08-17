/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import path from 'path';
import {z} from 'zod';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';
import {peekSnapshotCounts, resolveSnapshotPath} from './load-snapshot.js';

/**
 * Named snapshot ladders, and the provenance of the captures in them.
 *
 * Three separate problems this solves, all of which showed up as the same
 * symptom — the agent retyping a list of absolute paths into every call:
 *
 *  - **§6.2 ladder abstraction.** A ladder is the unit of work for every trend
 *    tool (`sequence_analysis`, `leak_report`, `hypothesis`), but it had no
 *    representation, so each call carried six 90-character paths. Re-typing them
 *    is where rungs get dropped or misordered, and a misordered ladder produces
 *    a confident, wrong trend.
 *  - **§6.1 capture provenance.** A `.heapsnapshot` records the heap and nothing
 *    about how it was taken — which app, which build, how many interaction
 *    cycles, whether a GC preceded it. Weeks later that context is gone, and it
 *    is exactly what decides whether a delta means anything. Provenance is
 *    stored beside the ladder rather than in a sidecar per file, so it survives
 *    even when snapshots are moved or pruned.
 *  - **§6.3 positive controls.** A hunt that finds nothing is only meaningful if
 *    the pipeline could have found something. Recording the planted control with
 *    the ladder makes "did we detect it?" answerable later instead of relying on
 *    memory.
 *
 * Persisted as one JSON file so it survives a server restart — the case that
 * motivated it, since a dropped MCP connection is what loses the paths.
 */
function registryPath(): string {
  // No /tmp fallback: on a shared host that is a predictable, often
  // world-writable path, so ladders would collide across users and another
  // process could overwrite the registry. Failing is better than a silently
  // shared file.
  const home = process.env.HOME;
  if (!home) {
    throw new Error(
      'HOME is not set, so the ladder registry has no per-user location. ' +
        'Refusing to fall back to a shared /tmp path.',
    );
  }
  return path.join(home, '.memlab-mcp', 'ladders.json');
}

interface Ladder {
  name: string;
  paths: string[];
  app?: string;
  interaction?: string;
  cycles?: number;
  build?: string;
  notes?: string;
  positive_control?: string;
  created?: string;
}

function loadRegistry(): Record<string, Ladder> {
  // Resolved outside the try: a missing HOME must propagate here exactly as it
  // does from saveRegistry. Swallowed into the catch below it would render as a
  // valid, empty registry, which is indistinguishable from "no ladders yet".
  const file = registryPath();
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object') return {};
    return parsed as Record<string, Ladder>;
  } catch {
    // A corrupt registry must not break analysis; it is a convenience index,
    // not a source of truth about the heap.
    return {};
  }
}

function saveRegistry(reg: Record<string, Ladder>): void {
  fs.mkdirSync(path.dirname(registryPath()), {recursive: true});
  fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
}

/**
 * Resolve a `ladder:<name>` reference to its paths, or return the input
 * unchanged. Exported so every trend tool can accept a ladder name wherever it
 * accepts a path list.
 */
export function resolveLadderPaths(paths: string[]): {
  paths: string[];
  ladder: Ladder | null;
} {
  if (paths.length !== 1 || !paths[0].startsWith('ladder:')) {
    return {paths, ladder: null};
  }
  const name = paths[0].slice('ladder:'.length);
  const ladder = loadRegistry()[name];
  if (ladder == null) {
    throw new Error(
      `No ladder named "${name}". List them with memlab_ladder({action: "list"}).`,
    );
  }
  return {paths: ladder.paths, ladder};
}

function describe(l: Ladder): string[] {
  const bits: string[] = [];
  if (l.app) bits.push(`app: ${l.app}`);
  if (l.interaction) bits.push(`interaction: ${l.interaction}`);
  if (l.cycles != null) bits.push(`cycles: ${formatNumber(l.cycles)}`);
  if (l.build) bits.push(`build: ${l.build}`);
  if (l.created) bits.push(`captured: ${l.created}`);
  return bits;
}

export function registerLadder(server: McpServer): void {
  server.tool(
    'memlab_ladder',
    'Name a snapshot ladder once and reference it as `ladder:<name>` from the trend tools (memlab_sequence_analysis, memlab_leak_report, memlab_hypothesis) instead of re-typing its paths on every call. ' +
      'Also records the capture PROVENANCE a .heapsnapshot cannot carry — app, interaction, cycles driven, build, and any planted positive control. That context is what decides whether a delta means anything, and it is gone within days if it lives only in the conversation. A ladder whose rungs are misordered produces a confident, wrong trend, which is the failure re-typing paths invites. ' +
      'Stored in ~/.memlab-mcp/ladders.json so it survives a server restart — the case that loses the paths in the first place.',
    {
      action: z
        .enum(['save', 'list', 'show', 'delete'])
        .describe(
          '"save" registers/overwrites a ladder, "list" shows all, "show" prints one with its rungs verified against disk, "delete" removes one.',
        ),
      name: z
        .string()
        .optional()
        .describe('Ladder name (required for save/show/delete).'),
      paths: z
        .array(z.string())
        .optional()
        .describe('Ordered snapshot paths, OLDEST FIRST (required for save).'),
      app: z.string().optional().describe('App the capture came from.'),
      interaction: z
        .string()
        .optional()
        .describe('What was driven between rungs (e.g. "open/close chat").'),
      cycles: z
        .number()
        .optional()
        .describe('Interaction cycles driven between the first and last rung.'),
      build: z
        .string()
        .optional()
        .describe('Build/revision identifier, if known.'),
      positive_control: z
        .string()
        .optional()
        .describe(
          'A leak deliberately planted for this run, so "we found nothing" can later be distinguished from "the pipeline could not have found anything".',
        ),
      notes: z.string().optional().describe('Anything else worth recording.'),
      captured_at: z
        .string()
        .optional()
        .describe('Capture time (ISO date). Defaults to now on save.'),
    },
    async ({
      action,
      name,
      paths,
      app,
      interaction,
      cycles,
      build,
      positive_control,
      notes,
      captured_at,
    }) => {
      try {
        const reg = loadRegistry();

        if (action === 'list') {
          const names = Object.keys(reg).sort();
          if (names.length === 0) {
            return toolResult(
              'No ladders registered. Save one with memlab_ladder({action:"save", name, paths:[…]}), then pass `["ladder:<name>"]` as `paths` to memlab_sequence_analysis / memlab_leak_report / memlab_hypothesis.',
            );
          }
          return toolResult(
            [
              `## Registered ladders (${names.length})`,
              '',
              markdownTable(
                ['Name', 'Rungs', 'App', 'Interaction', 'Cycles', 'Control'],
                names.map(n => {
                  const l = reg[n];
                  return [
                    n,
                    formatNumber(l.paths.length),
                    l.app ?? '—',
                    l.interaction ?? '—',
                    l.cycles != null ? formatNumber(l.cycles) : '—',
                    l.positive_control ? 'yes' : '—',
                  ];
                }),
                new Set([1, 4]),
              ),
              '',
              '_Use as `paths: ["ladder:<name>"]`._',
            ].join('\n'),
          );
        }

        if (name == null || name === '') {
          return errorResult(`action "${action}" requires a name.`);
        }

        if (action === 'delete') {
          if (reg[name] == null)
            return errorResult(`No ladder named "${name}".`);
          delete reg[name];
          saveRegistry(reg);
          return toolResult(`Deleted ladder "${name}".`);
        }

        if (action === 'save') {
          if (paths == null || paths.length === 0) {
            return errorResult(
              'action "save" requires a non-empty paths array.',
            );
          }
          const resolved: string[] = [];
          const missing: string[] = [];
          for (const p of paths) {
            try {
              const {localPath} = resolveSnapshotPath(p);
              resolved.push(localPath);
              if (!fs.existsSync(localPath)) missing.push(p);
            } catch {
              resolved.push(p);
              missing.push(p);
            }
          }
          if (missing.length > 0) {
            // Refuse rather than register a ladder that will fail later: the
            // whole point is that the stored list is trustworthy.
            return errorResult(
              `${missing.length} path(s) do not exist: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}. Nothing was saved.`,
            );
          }
          reg[name] = {
            name,
            paths: resolved,
            app,
            interaction,
            cycles,
            build,
            positive_control,
            notes,
            created: captured_at ?? new Date().toISOString().slice(0, 19),
          };
          saveRegistry(reg);
          const meta = describe(reg[name]);
          return toolResult(
            [
              `Saved ladder **${name}** with ${formatNumber(resolved.length)} rung(s).`,
              meta.length > 0 ? meta.join(' · ') : '',
              positive_control
                ? `Positive control recorded: ${positive_control}`
                : '_No positive control recorded — a hunt that finds nothing will not be interpretable._',
              '',
              `Use it: \`memlab_leak_report({paths: ["ladder:${name}"]})\`.`,
            ]
              .filter(Boolean)
              .join('\n'),
          );
        }

        // show
        const l = reg[name];
        if (l == null) return errorResult(`No ladder named "${name}".`);
        const rows = l.paths.map((p, i) => {
          const exists = fs.existsSync(p);
          const counts = exists ? peekSnapshotCounts(p) : null;
          const size = exists ? fs.statSync(p).size : 0;
          return [
            String(i + 1),
            p.length > 46 ? '…' + p.slice(-45) : p,
            exists ? formatBytes(size) : 'MISSING',
            counts ? formatNumber(counts.nodeCount) : '—',
          ];
        });
        const missingCount = l.paths.filter(p => !fs.existsSync(p)).length;
        const meta = describe(l);
        return toolResult(
          [
            `## Ladder "${name}" — ${formatNumber(l.paths.length)} rung(s)`,
            '',
            meta.length > 0 ? meta.join(' · ') : '_No provenance recorded._',
            l.positive_control
              ? `**Positive control:** ${l.positive_control}`
              : '',
            l.notes ? `Notes: ${l.notes}` : '',
            '',
            markdownTable(
              ['#', 'Path', 'Size', 'Nodes'],
              rows,
              new Set([2, 3]),
            ),
            missingCount > 0
              ? `\n⚠ **${formatNumber(missingCount)} rung(s) are missing from disk** — the ladder will fail until they are restored or it is re-saved.`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

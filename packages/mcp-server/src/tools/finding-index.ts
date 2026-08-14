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
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {z} from 'zod';
import {
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';

/**
 * A cross-round index of leak findings, keyed by a normalized retainer-path
 * signature.
 *
 * The problem this solves is the most expensive one a hunt hits: rounds
 * re-discover leaks that are already known or already fixed. One measured round
 * produced three findings — a listener accumulation, a completion-map grower and
 * a module-registry grower — all three of which were known, two already fixed
 * behind gates, and the first only visible because the gated fixes were not
 * enabled. That is an entire round spent re-deriving history.
 *
 * Why a retainer-path signature rather than the class name: the class that grows
 * is rarely distinctive (`Object`, `Array`, `(object properties)` are the top
 * growers in almost every heap), while the PATH that retains it is. Node ids,
 * array indices and per-instance scope ids differ per capture, so they are
 * stripped; what remains — the ordered edge names and class names — is stable
 * across captures of the same leak and different between different leaks.
 *
 * Deliberately local (a JSON file), not a service: the index is only useful if
 * it is written by default on every round, and anything requiring a backend
 * would not be. It is seeded from prior runs' manifests.
 */
const INDEX_PATH = path.join(
  process.env.HOME ?? '/tmp',
  '.memlab-mcp',
  'findings.json',
);

interface Finding {
  fingerprint: string;
  signature: string;
  growing_classes: string[];
  first_seen_round: string;
  last_seen_round: string;
  status: 'new' | 'known' | 'fixed';
  fixed_behind?: string;
  note?: string;
  seen_count: number;
}

interface FindingIndex {
  version: number;
  findings: Record<string, Finding>;
  combos_driven: Record<string, string[]>;
}

function loadIndex(): FindingIndex {
  try {
    if (fs.existsSync(INDEX_PATH)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
      if (parsed != null && typeof parsed === 'object') {
        const idx = parsed as Partial<FindingIndex>;
        return {
          version: idx.version ?? 1,
          findings: idx.findings ?? {},
          combos_driven: idx.combos_driven ?? {},
        };
      }
    }
  } catch {
    // A corrupt index must not block a hunt — but it must not be silently
    // erased either: returning empty here means the next `record` overwrites
    // the file wholesale and every prior fingerprint is gone, which defeats the
    // one thing this tool exists to do. Preserve it for recovery first.
    try {
      if (fs.existsSync(INDEX_PATH)) {
        fs.renameSync(INDEX_PATH, `${INDEX_PATH}.corrupt`);
      }
    } catch {
      // Best effort; a failed rename must not block the hunt either.
    }
  }
  return {version: 1, findings: {}, combos_driven: {}};
}

function saveIndex(idx: FindingIndex): void {
  fs.mkdirSync(path.dirname(INDEX_PATH), {recursive: true});
  fs.writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2));
}

/**
 * Normalize a retainer path into a signature that is stable across captures.
 *
 * Strips exactly the things that differ per capture and nothing else:
 *  - `@12345` node ids, including the ` @…`-suffixed Context/scope names;
 *  - numeric array indices (`[47]`, `.47`), which depend on insertion order;
 *  - hex/long digit runs inside names (ids embedded in keys, e.g. a chat id).
 */
export function normalizeRetainerPath(raw: string): string {
  return (
    raw
      .replace(/@\d+/g, '@')
      .replace(/\[\d+\]/g, '[i]')
      // Broad lookahead: retainer paths carry trailing `)`, `]`, `>` and the
      // separator inserted below, so a `\\s|$|\\.`-only lookahead leaves `.47)` /
      // `.47>` unnormalized and feeds per-capture noise into the fingerprint.
      .replace(/\.\d+(?=[^\w]|$)/g, '.i')
      .replace(/\b\d{4,}\b/g, 'N')
      .replace(/\s*(-->|--|→|->)\s*/g, ' > ')
      // `-->` would otherwise match `--` and `->` in turn, doubling the separator.
      .replace(/(?: > )+/g, ' > ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function fingerprintOf(signature: string, classes: string[]): string {
  const material = `${signature}||${[...classes].sort().join(',')}`;
  return crypto.createHash('sha1').update(material).digest('hex').slice(0, 12);
}

export function registerFindingIndex(server: McpServer): void {
  server.tool(
    'memlab_finding_index',
    'Fingerprint a leak finding by its retainer path and check it against findings from previous rounds, so a hunt does not spend itself re-discovering a known or already-fixed leak. ' +
      'This is the highest-cost failure a leak hunt has: a measured round produced three findings that were all already known — two already fixed behind gates — which is an entire round spent re-deriving history. Class names cannot detect that (`Object` and `Array` top every heap); the retainer PATH can, so the fingerprint is a normalized path signature with node ids, array indices and per-capture scope ids stripped. ' +
      'Actions: "check" fingerprints a candidate and reports NEW / KNOWN / KNOWN-AND-FIXED; "record" adds it; "list" prints the index; "cover" records which combos a round drove, so the "do not repeat covered combos" rule stops depending on someone remembering. Stored in ~/.memlab-mcp/findings.json.',
    {
      action: z
        .enum(['check', 'record', 'list', 'cover'])
        .describe(
          '"check" (fingerprint + look up, no write), "record" (add/update), "list", "cover" (log combos driven in a round).',
        ),
      retainer_path: z
        .string()
        .optional()
        .describe(
          "The finding's retainer path, as printed by memlab_retainer_summary / memlab_retainer_trace. Required for check and record.",
        ),
      growing_classes: z
        .array(z.string())
        .optional()
        .default([])
        .describe(
          'Classes that grew across the ladder for this finding. Folded into the fingerprint so the same path holding a different class set is a different finding.',
        ),
      round: z
        .string()
        .optional()
        .describe(
          'Round identifier (e.g. "r59"), recorded as first/last seen.',
        ),
      status: z
        .enum(['new', 'known', 'fixed'])
        .optional()
        .default('known')
        .describe('Status to record. Use "fixed" together with fixed_behind.'),
      fixed_behind: z
        .string()
        .optional()
        .describe('Gate/ABProp the fix sits behind, if it is fixed.'),
      note: z
        .string()
        .optional()
        .describe('Free-text note stored with the finding.'),
      combos: z
        .array(z.string())
        .optional()
        .default([])
        .describe('For action "cover": combo names driven in this round.'),
    },
    async ({
      action,
      retainer_path,
      growing_classes,
      round,
      status,
      fixed_behind,
      note,
      combos,
    }) => {
      try {
        const index = loadIndex();

        if (action === 'list') {
          const all = Object.values(index.findings);
          if (all.length === 0) {
            return toolResult(
              'The findings index is empty. Record findings as you confirm them ' +
                '(`action: "record"`); the value is entirely in future rounds being ' +
                'able to recognize them.',
            );
          }
          const rows = all
            .sort((a, b) => b.seen_count - a.seen_count)
            .slice(0, 40)
            .map(f => [
              f.fingerprint,
              f.status === 'fixed'
                ? `fixed (${f.fixed_behind ?? '?'})`
                : f.status,
              f.growing_classes.slice(0, 3).join(', ') || '—',
              `${f.first_seen_round}${f.last_seen_round !== f.first_seen_round ? `→${f.last_seen_round}` : ''}`,
              String(f.seen_count),
              f.signature.length > 60
                ? f.signature.slice(0, 57) + '…'
                : f.signature,
            ]);
          // Sort by round id rather than trusting object insertion order: a
          // re-recorded round moves in the object and "the last 8" silently
          // stops meaning the most recent ones.
          const covered = Object.entries(index.combos_driven)
            .sort((a, b) =>
              a[0].localeCompare(b[0], undefined, {numeric: true}),
            )
            .slice(-8)
            .map(([r, c]) => `${r}: ${c.join(', ')}`);
          return toolResult(
            [
              `## Findings index (${formatNumber(all.length)})`,
              '',
              markdownTable(
                [
                  'Fingerprint',
                  'Status',
                  'Classes',
                  'Rounds',
                  'Seen',
                  'Signature',
                ],
                rows,
                new Set([4]),
              ),
              covered.length > 0 ? '\n### Combo coverage by round\n' : '',
              ...covered.map(c => `- ${c}`),
            ].join('\n'),
          );
        }

        if (action === 'cover') {
          if (!round) return errorResult('action "cover" requires a round.');
          index.combos_driven[round] = combos;
          saveIndex(index);
          return toolResult(
            `Recorded ${combos.length} combo(s) driven in ${round}: ${combos.join(', ') || '(none)'}.`,
          );
        }

        if (!retainer_path) {
          return errorResult(`action "${action}" requires a retainer_path.`);
        }
        const signature = normalizeRetainerPath(retainer_path);
        const fingerprint = fingerprintOf(signature, growing_classes);
        const existing = index.findings[fingerprint];

        if (action === 'check') {
          if (!existing) {
            return toolResult(
              [
                `## NEW finding — fingerprint \`${fingerprint}\``,
                '',
                `Signature: \`${signature}\``,
                '',
                'No previous round recorded this retainer path with this class set. ' +
                  'Confirm it, then `action: "record"` so the next round recognizes it.',
              ].join('\n'),
            );
          }
          const label =
            existing.status === 'fixed'
              ? `KNOWN-AND-FIXED-BEHIND(${existing.fixed_behind ?? 'unknown gate'})`
              : `KNOWN (${existing.first_seen_round})`;
          return toolResult(
            [
              `## ${label} — fingerprint \`${fingerprint}\``,
              '',
              `Signature: \`${signature}\``,
              `First seen: ${existing.first_seen_round}; last seen: ${existing.last_seen_round}; seen ${existing.seen_count}×.`,
              existing.note ? `Note: ${existing.note}` : '',
              '',
              existing.status === 'fixed'
                ? `**Stop here.** This leak is already fixed behind \`${existing.fixed_behind}\`. If it is still reproducing, the gate is probably not enabled in this run — verify the gating state before treating it as a finding.`
                : '**This is not a new finding.** Check whether the earlier round already root-caused it before spending the rest of this one on it.',
            ]
              .filter(Boolean)
              .join('\n'),
          );
        }

        // record
        const roundId = round ?? 'unknown';
        index.findings[fingerprint] = {
          fingerprint,
          signature,
          growing_classes,
          first_seen_round: existing?.first_seen_round ?? roundId,
          last_seen_round: roundId,
          status,
          fixed_behind: fixed_behind ?? existing?.fixed_behind,
          note: note ?? existing?.note,
          seen_count: (existing?.seen_count ?? 0) + 1,
        };
        saveIndex(index);
        return toolResult(
          `Recorded \`${fingerprint}\` as **${status}**${fixed_behind ? ` (behind \`${fixed_behind}\`)` : ''} for round ${roundId}. ` +
            `Signature: \`${signature}\`. The index now holds ${formatNumber(Object.keys(index.findings).length)} finding(s).`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

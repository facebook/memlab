/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * The served source of one module, read from the heap snapshot itself.
 *
 * Three recurring questions turn on what code the page was actually running:
 * is a chain a dev-compile artifact (compare the dev and prod compiles of the
 * module), is a fix served (does the module read its gate), and what does this
 * closure do. Each was answered by hand-rolling the same walk: script source
 * strings, then the `__d("<module>",` span inside them.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import path from 'path';
import {z} from 'zod';
import {
  getSnapshot,
  getSnapshotByHandle,
  getSnapshotMetadata,
} from '../heap-state.js';
import {resolveRungs, withSnapshotAt} from '../snapshot-borrow.js';
import {errorResult, formatBytes, formatNumber, toolResult} from '../utils.js';

interface ModuleSpan {
  script: string;
  offset: number;
  text: string;
  /** `__d` span, or a whole script whose URL names the module. */
  kind: 'haste' | 'script';
}

function edgeString(node: IHeapNode, name: string): string | null {
  for (const e of node.references) {
    if (String(e.name_or_index) !== name) continue;
    const t = e.toNode;
    if (t.isString) return t.toStringNode()?.stringValue ?? t.name;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every span of `module` in the snapshot's script sources. */
export function findModuleSpans(
  snapshot: IHeapSnapshot,
  module: string,
): ModuleSpan[] {
  const marker = new RegExp(`__d\\((["'])${escapeRegExp(module)}\\1\\s*,`, 'g');
  const spans: ModuleSpan[] = [];
  const byUrl: ModuleSpan[] = [];
  const seenSources = new Set<number>();
  snapshot.nodes.forEach((node: IHeapNode) => {
    // Chrome names a Script `system / Script`; Node's V8 emits a `code` node
    // named by its URL. Both hold the text on a `source` edge.
    if (!node.name.startsWith('system / Script') && node.type !== 'code') {
      return;
    }
    let sourceNode: IHeapNode | null = null;
    for (const e of node.references) {
      if (String(e.name_or_index) === 'source') sourceNode = e.toNode;
    }
    if (sourceNode == null || !sourceNode.isString) return;
    // One source string can back several Script objects (a re-evaluated
    // bundle); its spans are the same, so read it once.
    if (seenSources.has(sourceNode.id)) return;
    seenSources.add(sourceNode.id);
    const text = sourceNode.toStringNode()?.stringValue ?? sourceNode.name;
    const url = edgeString(node, 'name') ?? '(no url)';
    marker.lastIndex = 0;
    for (let m = marker.exec(text); m != null; m = marker.exec(text)) {
      const end = text.indexOf('__d(', m.index + m[0].length);
      spans.push({
        script: url,
        offset: m.index,
        text: end < 0 ? text.slice(m.index) : text.slice(m.index, end),
        kind: 'haste',
      });
    }
    const base = url.replace(/[?#].*$/, '').replace(/^.*\//, '');
    if (base === module || base.replace(/\.[cm]?[jt]sx?$/, '') === module) {
      byUrl.push({script: url, offset: 0, text, kind: 'script'});
    }
  });
  return spans.length > 0 ? spans : byUrl;
}

/** `pattern` as a regex, or as a literal when it does not compile. */
function patternOf(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'g');
  } catch {
    return new RegExp(escapeRegExp(pattern), 'g');
  }
}

function matchesIn(
  text: string,
  pattern: string,
  around: number,
  max: number,
): {count: number; shown: string[]} {
  const re = patternOf(pattern);
  const shown: string[] = [];
  let count = 0;
  for (let m = re.exec(text); m != null; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    count++;
    if (shown.length < max) {
      const from = Math.max(0, m.index - around);
      const to = Math.min(text.length, m.index + m[0].length + around);
      const flat = (s: string) => s.replace(/\s+/g, ' ');
      shown.push(
        `${from > 0 ? '…' : ''}${flat(text.slice(from, m.index))}«${flat(m[0])}»${flat(text.slice(m.index + m[0].length, to))}${to < text.length ? '…' : ''}`,
      );
    }
  }
  return {count, shown};
}

interface Report {
  spans: ModuleSpan[];
  bytes: number;
  grep: {count: number; shown: string[]} | null;
  gates: Array<{gate: string; count: number}>;
}

function analyse(
  snapshot: IHeapSnapshot,
  module: string,
  grep: string | undefined,
  gates: string[],
  around: number,
  maxMatches: number,
): Report {
  const spans = findModuleSpans(snapshot, module);
  const joined = spans.map(s => s.text).join('\n');
  return {
    spans,
    bytes: joined.length,
    grep: grep != null ? matchesIn(joined, grep, around, maxMatches) : null,
    gates: gates.map(g => ({
      gate: g,
      count: joined.split(g).length - 1,
    })),
  };
}

function describeSpans(spans: ModuleSpan[]): string[] {
  return spans.map(
    s =>
      `- ${s.kind === 'haste' ? '`__d` span' : 'whole script'} of ${formatBytes(s.text.length)} at offset ${formatNumber(s.offset)} in \`${s.script.replace(/\?.*$/, '').slice(-90)}\``,
  );
}

export function registerModuleSource(server: McpServer): void {
  server.tool(
    'memlab_module_source',
    'The SERVED source of one module, read from the snapshot: its `__d("<module>", …)` span in the script sources (or a script whose URL names it). Answers "is the fix served?" (`gate`: does this module\'s own code contain the prop), "is this a dev-compile artifact?" (`compare_to` a prod-build snapshot of the same module), and "what does this closure do?" (`grep`). Works on minified builds, where the module name survives in the `__d` call. Needs script source in the snapshot (browser captures keep it).',
    {
      module: z
        .string()
        .min(1)
        .describe(
          'Module name as registered (`WAWebConversationMsgs.react`), or a script file name for non-Haste code.',
        ),
      grep: z
        .string()
        .optional()
        .describe(
          'Regex (literal when it does not compile) to find in the module; each match is shown with `around` characters either side, since a minified module is one line.',
        ),
      gate: z
        .array(z.string())
        .optional()
        .describe(
          "Strings (gate or prop names) to count in this module's source: 0 means the served module does not read it.",
        ),
      compare_to: z
        .string()
        .optional()
        .describe(
          'Another snapshot (resident handle or file path, loaded for the call) to read the same module from, e.g. a prod-like capture against a dev one. Its size, gate counts and grep matches are shown beside this one.',
        ),
      around: z
        .number()
        .int()
        .min(0)
        .max(2000)
        .optional()
        .default(160)
        .describe(
          'Characters of context either side of a grep match (default 160).',
        ),
      max_matches: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(10)
        .describe(
          'Grep matches to show per snapshot (default 10); all are counted.',
        ),
      max_chars: z
        .number()
        .int()
        .min(100)
        .max(200000)
        .optional()
        .default(2000)
        .describe(
          'Without `grep`, how much of the module source to print (default 2000).',
        ),
    },
    async ({
      module,
      grep,
      gate,
      compare_to,
      around,
      max_matches,
      max_chars,
    }) => {
      try {
        const gates = gate ?? [];
        const here = analyse(
          getSnapshot(),
          module,
          grep,
          gates,
          around,
          max_matches,
        );
        let other: Report | null = null;
        if (compare_to != null && compare_to !== '') {
          const resident = getSnapshotByHandle(compare_to);
          if (resident != null) {
            other = analyse(resident, module, grep, gates, around, max_matches);
          } else {
            const [rung] = resolveRungs([compare_to]).rungs;
            if (rung == null) {
              throw new Error(`compare_to: no snapshot at ${compare_to}`);
            }
            other = await withSnapshotAt(rung.localPath, snap =>
              analyse(snap, module, grep, gates, around, max_matches),
            );
          }
        }
        if (
          here.spans.length === 0 &&
          (other == null || other.spans.length === 0)
        ) {
          return toolResult(
            `No source for \`${module}\` in this snapshot: no script source holds \`__d("${module}",\`, and no script URL names it. ` +
              'The module may not be loaded yet (a lazy chunk), the name may differ (check `memlab_source_for_node` on one of its closures), or the capture kept no script source.',
          );
        }
        const lines: string[] = [`## Module source — \`${module}\``, ''];
        lines.push(
          here.spans.length === 0
            ? '_Not in this snapshot._'
            : `${here.spans.length} span(s), ${formatBytes(here.bytes)}:`,
          ...describeSpans(here.spans),
          '',
        );
        if (gates.length > 0) {
          lines.push(
            '| Gate | here' + (other != null ? ' | compare_to' : '') + ' |',
            '|---|---:' + (other != null ? '|---:' : '') + '|',
            ...here.gates.map((g, i) => {
              const verdict = (n: number) =>
                n > 0 ? `${n}` : '**0 — not read here**';
              return `| \`${g.gate}\` | ${verdict(g.count)}${other != null ? ` | ${verdict(other.gates[i].count)}` : ''} |`;
            }),
            '',
          );
        }
        if (grep != null && here.grep != null) {
          lines.push(
            `**\`${grep}\`: ${formatNumber(here.grep.count)} match(es)**${here.grep.count > here.grep.shown.length ? ` (first ${here.grep.shown.length} shown)` : ''}`,
            ...here.grep.shown.map(s => `- \`${s.replace(/`/g, "'")}\``),
            '',
          );
        } else if (gates.length === 0 && here.spans.length > 0) {
          const text = here.spans[0].text;
          lines.push(
            '```js',
            text.length > max_chars
              ? `${text.slice(0, max_chars)}\n// … ${formatNumber(text.length - max_chars)} more chars`
              : text,
            '```',
            '',
          );
        }
        if (other != null) {
          lines.push(
            `### compare_to \`${compare_to}\``,
            '',
            other.spans.length === 0
              ? '_The module is not in that snapshot._'
              : `${other.spans.length} span(s), ${formatBytes(other.bytes)} (${other.bytes >= here.bytes ? '+' : '−'}${formatBytes(Math.abs(other.bytes - here.bytes))} vs here):`,
            ...describeSpans(other.spans),
            '',
          );
          if (grep != null && other.grep != null) {
            lines.push(
              `**\`${grep}\`: ${formatNumber(other.grep.count)} match(es)** there`,
              ...other.grep.shown.map(s => `- \`${s.replace(/`/g, "'")}\``),
              '',
            );
          }
        }
        lines.push(
          '_Read from the script source strings V8 kept alive; a lazy chunk the page never loaded is absent, not missing code. `gate` counts plain substrings, so a prop name that also appears in a comment still counts._',
        );
        // Both snapshots, active first: the borrowed one alone would read as
        // the snapshot every answer above came from.
        return toolResult(
          lines.join('\n'),
          other != null
            ? `> Snapshots: ${getSnapshotMetadata()?.fileName ?? '(active)'} vs ${path.basename(compare_to ?? '')}`
            : undefined,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

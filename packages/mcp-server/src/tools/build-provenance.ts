/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {tickAnalysis} from '../analysis-budget.js';
import {getSnapshot, getSnapshotByHandle} from '../heap-state.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

interface SymbolHit {
  symbol: string;
  occurrences: number;
  sample: string | null;
}

/**
 * Count string nodes containing each marker. Minified bundles keep enough for
 * this to work: template literals, log format strings and — in the WA Web
 * build — function and hook-variable names all survive as heap strings.
 */
function scanSymbols(
  snapshot: ReturnType<typeof getSnapshot>,
  symbols: string[],
): SymbolHit[] {
  const hits: SymbolHit[] = symbols.map(symbol => ({
    symbol,
    occurrences: 0,
    sample: null,
  }));
  if (snapshot == null || symbols.length === 0) return hits;
  snapshot.nodes.forEach((node: IHeapNode) => {
    tickAnalysis();
    if (!node.isString) return;
    const value = node.name;
    for (const hit of hits) {
      if (!value.includes(hit.symbol)) continue;
      hit.occurrences++;
      if (hit.sample == null) {
        hit.sample = value.length > 90 ? `${value.slice(0, 90)}…` : value;
      }
    }
  });
  return hits;
}

export function registerBuildProvenance(server: McpServer): void {
  server.tool(
    'memlab_build_provenance',
    'Assert that the build a snapshot came from actually contains the change you are measuring, BEFORE reading any before/after number. Scans the heap for marker strings from the new revision (`expect_present`) and from the revision it replaced (`expect_absent`). Without this, "the fix does not work" and "the fix was never in the build" produce identical results, and the second is far more common — a stale bundle, a gate forced at one call site but not another, a build that did not pick up the last amend. Minified bundles retain enough to check: log format strings, template literals and many function/variable names survive as heap strings. Run it on every capture in an A/B, not just the treatment arm.',
    {
      expect_present: z
        .array(z.string())
        .optional()
        .describe(
          'Marker strings the new revision should introduce — a distinctive log message, a new function name, a new identifier. Missing any of these means the build predates the change.',
        ),
      expect_absent: z
        .array(z.string())
        .optional()
        .describe(
          'Marker strings the superseded revision had. Any of these still present means the old code is still shipping alongside or instead of the new code.',
        ),
      handle: z
        .string()
        .optional()
        .describe('Snapshot to check (defaults to the active one).'),
    },
    async ({expect_present, expect_absent, handle}) => {
      try {
        const snapshot =
          handle != null ? getSnapshotByHandle(handle) : getSnapshot();
        if (snapshot == null) {
          return errorResult(
            new Error(
              handle != null
                ? `Snapshot "${handle}" is not resident.`
                : 'No snapshot loaded. Use memlab_load_snapshot first.',
            ),
          );
        }
        const present = expect_present ?? [];
        const absent = expect_absent ?? [];
        // An empty marker matches every string, so it always "finds" itself and
        // the check returns PASS having verified nothing — the exact
        // cannot-fail check this tool exists to replace.
        const blank = [...present, ...absent].filter(m => m.trim() === '');
        if (blank.length > 0) {
          return errorResult(
            new Error(
              `${formatNumber(blank.length)} marker(s) are empty or whitespace. An empty marker is a substring of every string, so it always matches and the check passes having verified nothing. Remove them or give them real content.`,
            ),
          );
        }
        if (present.length === 0 && absent.length === 0) {
          return errorResult(
            new Error(
              'Pass `expect_present` and/or `expect_absent`. A provenance check with no markers cannot fail, which is worse than not running one.',
            ),
          );
        }

        const all = scanSymbols(snapshot, [...present, ...absent]);
        const presentHits = all.slice(0, present.length);
        const absentHits = all.slice(present.length);

        const missing = presentHits.filter(h => h.occurrences === 0);
        const lingering = absentHits.filter(h => h.occurrences > 0);
        const ok = missing.length === 0 && lingering.length === 0;

        const lines: string[] = [
          '## Build provenance',
          '',
          ok
            ? '✅ **The build under test contains this revision.** Every expected marker is present and every superseded marker is gone, so a before/after difference can be attributed to the change rather than to which bundle was served.'
            : '❌ **This snapshot is NOT from the revision you think.** Do not read a verdict off it — fix the build and re-capture.',
          '',
        ];

        if (presentHits.length > 0) {
          lines.push(
            '### Expected present',
            '',
            markdownTable(
              ['Marker', 'Occurrences', 'Verdict', 'Sample'],
              presentHits.map(h => [
                `\`${h.symbol}\``,
                formatNumber(h.occurrences),
                h.occurrences > 0 ? 'found' : '**MISSING**',
                h.sample ?? '—',
              ]),
              new Set([1]),
            ),
            '',
          );
        }
        if (absentHits.length > 0) {
          lines.push(
            '### Expected absent',
            '',
            markdownTable(
              ['Marker', 'Occurrences', 'Verdict'],
              absentHits.map(h => [
                `\`${h.symbol}\``,
                formatNumber(h.occurrences),
                h.occurrences === 0 ? 'gone' : '**STILL PRESENT**',
              ]),
              new Set([1]),
            ),
            '',
          );
        }

        if (missing.length > 0) {
          lines.push(
            `> **${formatNumber(missing.length)} expected marker(s) missing.** The served bundle predates ` +
              'the change, or the module was not rebuilt. Note that a marker inside a code path that ' +
              'never executed is still present as a string — so a MISSING marker is conclusive, while a ' +
              'present one proves the code shipped, not that it ran.',
            '',
          );
        }
        if (lingering.length > 0) {
          lines.push(
            `> **${formatNumber(lingering.length)} superseded marker(s) still present.** The old revision is ` +
              'still in the bundle. If both revisions are present, which one executes is not decided by ' +
              'this check — confirm at runtime.',
            '',
          );
        }

        lines.push(
          '_Presence proves the code was SHIPPED, not that it RAN. For the second question use a ' +
            'counter or a log line emitted from the changed path, and confirm it is non-zero before ' +
            'trusting a measurement._',
        );
        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

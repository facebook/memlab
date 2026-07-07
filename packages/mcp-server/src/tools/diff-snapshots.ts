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
import type {IHeapSnapshot} from '@memlab/core';
import fs from 'fs';
import path from 'path';
import {z} from 'zod';
import memlabHeapAnalysis from '@memlab/heap-analysis';
const {getFullHeapFromFile} = memlabHeapAnalysis;
import {
  setSnapshot,
  getCurrentHandle,
  getSnapshotByHandle,
  listSnapshots,
  setCurrentSnapshot,
} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';

interface ClassStats {
  count: number;
  self_size: number;
}

function buildHistogram(snapshot: IHeapSnapshot): Map<string, ClassStats> {
  const map = new Map<string, ClassStats>();
  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    const key = `${node.type}::${node.name}`;
    const entry = map.get(key);
    if (entry) {
      entry.count++;
      entry.self_size += node.self_size;
    } else {
      map.set(key, {count: 1, self_size: node.self_size});
    }
  });
  return map;
}

// Value-named string "classes" (literal values used as the class name, e.g.
// "554", "1780525701808.81", "o:10,add") are noise in a diff (§10).
function isValueNamedStringClass(type: string, name: string): boolean {
  if (type !== 'string' && type !== 'concatenated string') return false;
  if (name.length < 8) return true;
  if (/^[\s\d.,:+-]*$/.test(name)) return true;
  return false;
}

interface ResolvedSnapshot {
  snapshot: IHeapSnapshot;
  // The name to show for this side of the diff (resident handle or file base name).
  label: string;
  // Non-null when the arg resolved to an already-resident snapshot, so callers
  // can activate it in place instead of re-parsing / creating a duplicate handle.
  residentHandle: string | null;
  // The canonical absolute path a freshly-loaded snapshot was read from (null on
  // a resident hit). Callers register the snapshot under THIS path — the same
  // form the resident lookup below canonicalizes to — so the next diff of the
  // same path reuses it instead of re-parsing.
  resolvedPath: string | null;
}

// Resolve a before/after argument to a snapshot, preferring already-resident
// snapshots so diffing a captured ladder never re-parses a file that is already
// in memory (each reparse is a full dominator-tree build + a second resident
// graph). Order: (1) a resident handle, (2) a path matching a resident
// snapshot's file, (3) load from disk.
async function resolveDiffSnapshot(arg: string): Promise<ResolvedSnapshot> {
  const byHandle = getSnapshotByHandle(arg);
  if (byHandle) {
    return {
      snapshot: byHandle,
      label: arg,
      residentHandle: arg,
      resolvedPath: null,
    };
  }
  const resolved = path.resolve(arg);
  for (const m of listSnapshots()) {
    // Match against BOTH the canonicalized path and the raw arg: load_snapshot
    // stores a path.resolve()d filePath, but a snapshot first loaded through a
    // different entry point may have been registered under its raw arg, so
    // comparing only one form would miss the resident hit and re-parse.
    if (m.filePath === resolved || m.filePath === arg) {
      const s = getSnapshotByHandle(m.handle);
      if (s) {
        return {
          snapshot: s,
          label: m.handle,
          residentHandle: m.handle,
          resolvedPath: null,
        };
      }
    }
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `"${arg}" is neither a resident snapshot handle nor an existing file. ` +
        `Use memlab_snapshots (action:"list") to see resident handles, or pass a ` +
        `valid .heapsnapshot path.`,
    );
  }
  const snapshot = await getFullHeapFromFile(resolved);
  return {
    snapshot,
    label: path.basename(arg),
    residentHandle: null,
    resolvedPath: resolved,
  };
}

export function registerDiffSnapshots(server: McpServer): void {
  server.tool(
    'memlab_diff_snapshots',
    'Compare two heap snapshots by class histogram. Shows classes that grew, shrunk, appeared, or disappeared between "before" and "after" snapshots. Each side accepts either a resident snapshot handle (from memlab_snapshots) or a file path — resident handles are reused in place, so diffing a ladder you already loaded never re-parses a file. By default the "after" snapshot becomes the active snapshot (set set_active:false to leave your active snapshot unchanged). For an ordered sequence of 3+ snapshots, use memlab_sequence_analysis instead.',
    {
      before_path: z
        .string()
        .optional()
        .describe(
          'The "before" snapshot: a resident handle (see memlab_snapshots) or a path (local, manifold://, or bare filename). Aliases: before, baseline.',
        ),
      after_path: z
        .string()
        .optional()
        .describe(
          'The "after" snapshot: a resident handle (see memlab_snapshots) or a path (local, manifold://, or bare filename). Aliases: after, target.',
        ),
      before: z.string().optional().describe('Alias for before_path.'),
      after: z.string().optional().describe('Alias for after_path.'),
      baseline: z.string().optional().describe('Alias for before_path.'),
      target: z.string().optional().describe('Alias for after_path.'),
      limit: z
        .number()
        .optional()
        .default(30)
        .describe('Maximum rows per section / top_n (default 30)'),
      min_count_delta: z
        .number()
        .optional()
        .default(0)
        .describe(
          'Minimum absolute change in instance count to show (default 0). Use to filter noise.',
        ),
      min_size_delta: z
        .number()
        .optional()
        .default(0)
        .describe(
          'Minimum absolute change in self size (bytes) to show (default 0).',
        ),
      include_value_classes: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Include anonymous value-named string "classes" (e.g. "554", literal values used as names). Default false: they are filtered and rolled up into a single "(string literals)" row to cut noise (§10).',
        ),
      hide_zero_size_delta: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Hide rows whose self-size delta is 0 B (default true) — these are usually noise.',
        ),
      set_active: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Make the "after" snapshot the active one for subsequent tools (default true). Set false to leave your current active snapshot unchanged.',
        ),
    },
    async ({
      before_path,
      after_path,
      before,
      after,
      baseline,
      target,
      limit,
      min_count_delta,
      min_size_delta,
      include_value_classes,
      hide_zero_size_delta,
      set_active,
    }) => {
      try {
        const beforeArg = before_path ?? before ?? baseline;
        const afterArg = after_path ?? after ?? target;
        if (!beforeArg || !afterArg) {
          return errorResult(
            new Error(
              'Provide both a before and an after snapshot. Accepted names: before_path/before/baseline and after_path/after/target.',
            ),
          );
        }
        const [beforeResolved, afterResolved] = await Promise.all([
          resolveDiffSnapshot(beforeArg),
          resolveDiffSnapshot(afterArg),
        ]);
        const beforeSnapshot = beforeResolved.snapshot;
        const afterSnapshot = afterResolved.snapshot;
        const beforeHist = buildHistogram(beforeSnapshot);
        const afterHist = buildHistogram(afterSnapshot);

        // Make "after" the active snapshot. If it is already resident, switch to
        // its handle in place; only a freshly-loaded snapshot needs registering
        // (and the metadata scan that entails).
        let activeHandle: string | null = getCurrentHandle();
        if (set_active) {
          if (afterResolved.residentHandle) {
            setCurrentSnapshot(afterResolved.residentHandle);
            activeHandle = afterResolved.residentHandle;
          } else {
            let afterNodeCount = 0;
            let afterEdgeCount = 0;
            let afterTotalSize = 0;
            afterSnapshot.nodes.forEach(node => {
              afterNodeCount++;
              afterTotalSize += node.self_size;
            });
            afterSnapshot.edges.forEach(() => {
              afterEdgeCount++;
            });
            let hasWindow = false;
            let hasModule = false;
            afterSnapshot.nodes.forEach(node => {
              if (hasWindow) return;
              if (node.name.startsWith('Window ') && node.type === 'object')
                hasWindow = true;
              if (
                node.name === 'Module' &&
                node.type === 'object' &&
                !hasModule
              )
                hasModule = true;
            });
            const afterEnv = hasWindow
              ? 'browser'
              : hasModule
                ? 'node'
                : 'unknown';
            activeHandle = setSnapshot(
              afterSnapshot,
              afterResolved.resolvedPath ?? afterArg,
              {
                fileName: path.basename(afterArg),
                nodeCount: afterNodeCount,
                edgeCount: afterEdgeCount,
                totalSize: afterTotalSize,
                env: afterEnv as 'browser' | 'node' | 'unknown',
              },
            ).handle;
          }
        }

        // Compute deltas
        const allKeys = new Set([...beforeHist.keys(), ...afterHist.keys()]);

        interface DiffEntry {
          key: string;
          name: string;
          type: string;
          before_count: number;
          after_count: number;
          count_delta: number;
          before_size: number;
          after_size: number;
          size_delta: number;
        }

        const diffs: DiffEntry[] = [];
        // Rollup accumulator for filtered value-named string classes (§10).
        const rollup = {
          grewCount: 0,
          grewSize: 0,
          grewClasses: 0,
          shrunkCount: 0,
          shrunkSize: 0,
          shrunkClasses: 0,
        };
        for (const key of allKeys) {
          const before = beforeHist.get(key);
          const after = afterHist.get(key);
          const bc = before?.count ?? 0;
          const ac = after?.count ?? 0;
          const bs = before?.self_size ?? 0;
          const as_ = after?.self_size ?? 0;
          const countDelta = ac - bc;
          const sizeDelta = as_ - bs;

          if (
            Math.abs(countDelta) < min_count_delta ||
            Math.abs(sizeDelta) < min_size_delta
          ) {
            continue;
          }
          if (hide_zero_size_delta && sizeDelta === 0) continue;

          const parts = key.split('::');
          const type = parts[0];
          const name = parts.slice(1).join('::');

          if (!include_value_classes && isValueNamedStringClass(type, name)) {
            if (countDelta > 0) {
              rollup.grewCount += countDelta;
              rollup.grewSize += sizeDelta;
              rollup.grewClasses++;
            } else if (countDelta < 0) {
              rollup.shrunkCount += countDelta;
              rollup.shrunkSize += sizeDelta;
              rollup.shrunkClasses++;
            }
            continue;
          }

          diffs.push({
            key,
            name,
            type,
            before_count: bc,
            after_count: ac,
            count_delta: countDelta,
            before_size: bs,
            after_size: as_,
            size_delta: sizeDelta,
          });
        }

        // Emit the rolled-up value-string classes as single synthetic rows.
        if (rollup.grewClasses > 0) {
          diffs.push({
            key: 'string::(string literals)',
            name: `(string literals ×${formatNumber(rollup.grewClasses)})`,
            type: 'string',
            before_count: 0,
            after_count: rollup.grewCount,
            count_delta: rollup.grewCount,
            before_size: 0,
            after_size: rollup.grewSize,
            size_delta: rollup.grewSize,
          });
        }
        if (rollup.shrunkClasses > 0) {
          diffs.push({
            key: 'string::(string literals)-shrunk',
            name: `(string literals ×${formatNumber(rollup.shrunkClasses)})`,
            type: 'string',
            before_count: -rollup.shrunkCount,
            after_count: 0,
            count_delta: rollup.shrunkCount,
            before_size: -rollup.shrunkSize,
            after_size: 0,
            size_delta: rollup.shrunkSize,
          });
        }

        const grew = diffs
          .filter(d => d.count_delta > 0)
          .sort((a, b) => b.count_delta - a.count_delta);
        const shrunk = diffs
          .filter(d => d.count_delta < 0)
          .sort((a, b) => a.count_delta - b.count_delta);

        const lines: string[] = [];

        // Overall summary
        let totalBeforeNodes = 0;
        let totalBeforeSize = 0;
        let totalAfterNodes = 0;
        let totalAfterSize = 0;
        beforeHist.forEach(v => {
          totalBeforeNodes += v.count;
          totalBeforeSize += v.self_size;
        });
        afterHist.forEach(v => {
          totalAfterNodes += v.count;
          totalAfterSize += v.self_size;
        });

        const nodeDelta = totalAfterNodes - totalBeforeNodes;
        const sizeDelta = totalAfterSize - totalBeforeSize;
        const sign = (n: number) => (n >= 0 ? '+' : '-');

        lines.push('## Snapshot Comparison');
        lines.push('');
        const residentTag = (r: ResolvedSnapshot): string =>
          r.residentHandle ? ' (resident)' : '';
        lines.push(
          `before: \`${beforeResolved.label}\`${residentTag(beforeResolved)} → after: \`${afterResolved.label}\`${residentTag(afterResolved)}`,
        );
        lines.push('');
        lines.push(`| | Before | After | Delta |`);
        lines.push(`|---|---:|---:|---:|`);
        lines.push(
          `| Nodes | ${formatNumber(totalBeforeNodes)} | ${formatNumber(totalAfterNodes)} | ${sign(nodeDelta)}${formatNumber(Math.abs(nodeDelta))} |`,
        );
        lines.push(
          `| Self Size | ${formatBytes(totalBeforeSize)} | ${formatBytes(totalAfterSize)} | ${sign(sizeDelta)}${formatBytes(Math.abs(sizeDelta))} |`,
        );
        lines.push('');

        // Grew section
        if (grew.length > 0) {
          const headers = [
            'Class',
            'Type',
            'Before',
            'After',
            'Δ Count',
            'Δ Size',
          ];
          const rightCols = new Set([2, 3, 4, 5]);
          const rows = grew
            .slice(0, limit)
            .map(d => [
              d.name,
              d.type,
              formatNumber(d.before_count),
              formatNumber(d.after_count),
              `+${formatNumber(d.count_delta)}`,
              `${sign(d.size_delta)}${formatBytes(Math.abs(d.size_delta))}`,
            ]);
          lines.push(
            `### Classes that grew (${formatNumber(grew.length)} total, showing ${rows.length})`,
          );
          lines.push('');
          lines.push(markdownTable(headers, rows, rightCols));
          lines.push('');
        }

        // Shrunk section
        if (shrunk.length > 0) {
          const headers = [
            'Class',
            'Type',
            'Before',
            'After',
            'Δ Count',
            'Δ Size',
          ];
          const rightCols = new Set([2, 3, 4, 5]);
          const rows = shrunk
            .slice(0, limit)
            .map(d => [
              d.name,
              d.type,
              formatNumber(d.before_count),
              formatNumber(d.after_count),
              formatNumber(d.count_delta),
              `${sign(d.size_delta)}${formatBytes(Math.abs(d.size_delta))}`,
            ]);
          lines.push(
            `### Classes that shrunk (${formatNumber(shrunk.length)} total, showing ${rows.length})`,
          );
          lines.push('');
          lines.push(markdownTable(headers, rows, rightCols));
          lines.push('');
        }

        if (grew.length === 0 && shrunk.length === 0) {
          lines.push(
            'No significant differences found between the two snapshots.',
          );
        }

        lines.push(
          set_active
            ? `\n*The "after" snapshot is now the active snapshot${activeHandle ? ` (handle: ${activeHandle})` : ''} for further analysis. Pass set_active:false to keep your current one.*`
            : `\n*Active snapshot left unchanged${activeHandle ? ` (handle: ${activeHandle})` : ''} (set_active:false).*`,
        );

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

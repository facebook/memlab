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
import os from 'os';
import path from 'path';
import {execFileSync} from 'child_process';
import {z} from 'zod';
import memlabHeapAnalysis from '@memlab/heap-analysis';
const {getFullHeapFromFile} = memlabHeapAnalysis;
import {
  setSnapshot,
  getSnapshotMetadata,
  setSessionConfig,
  listSnapshots,
} from '../heap-state.js';
import type {SnapshotEnv} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  truncateNodeName,
  errorResult,
  textResult,
} from '../utils.js';

// The bucket the Nest auto-capture + the Manifold links in diffs use, so a
// bare snapshot filename resolves predictably (Feedback §7).
export const DEFAULT_MANIFOLD_BUCKET = 'nest_server_nodejs_heap_snapshots';

/**
 * Resolve a `file_path` that may be a local path, a `manifold://bucket/key`
 * URL, or a bare snapshot filename to a local path, fetching from Manifold
 * into a temp dir when needed. Returns {localPath, fetchedFrom}.
 */
export function resolveSnapshotPath(filePath: string): {
  localPath: string;
  fetchedFrom: string | null;
} {
  // Already a local file? Use it directly.
  const asLocal = path.resolve(filePath);
  if (!filePath.startsWith('manifold://') && fs.existsSync(asLocal)) {
    return {localPath: asLocal, fetchedFrom: null};
  }

  let manifoldKey: string | null = null;
  if (filePath.startsWith('manifold://')) {
    manifoldKey = filePath.slice('manifold://'.length);
  } else if (!filePath.includes('/') && /\.heapsnapshot$/i.test(filePath)) {
    // Bare snapshot filename → resolve against the default bucket's flat/ tree.
    manifoldKey = `${DEFAULT_MANIFOLD_BUCKET}/flat/${filePath}`;
  }

  if (!manifoldKey) {
    // Nothing we can fetch; let the caller report "file not found".
    return {localPath: asLocal, fetchedFrom: null};
  }

  // A Manifold key must be bucket/key; if only a key was given, prefix bucket.
  if (!manifoldKey.includes('/')) {
    manifoldKey = `${DEFAULT_MANIFOLD_BUCKET}/${manifoldKey}`;
  }

  const dest = path.join(
    os.tmpdir(),
    `memlab-${path.basename(manifoldKey).replace(/[^A-Za-z0-9._-]/g, '_')}`,
  );
  process.stderr.write(`Fetching ${manifoldKey} from Manifold → ${dest}…\n`);
  execFileSync('manifold', ['get', manifoldKey, dest], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 5 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {localPath: dest, fetchedFrom: manifoldKey};
}

interface LargestObjInfo {
  id: number;
  name: string;
  size: number;
  type: string;
}

function findLargestObject(snapshot: IHeapSnapshot): LargestObjInfo | null {
  let best: LargestObjInfo | null = null;
  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    if (
      node.type === 'object' ||
      node.type === 'closure' ||
      node.type === 'regexp'
    ) {
      if (!best || node.retainedSize > best.size) {
        best = {
          id: node.id,
          name: node.name,
          size: node.retainedSize,
          type: node.type,
        };
      }
    }
  });
  return best;
}

function detectEnv(snapshot: IHeapSnapshot): SnapshotEnv {
  let hasWindow = false;
  let hasModule = false;
  snapshot.nodes.forEach(node => {
    if (hasWindow) return;
    if (node.name.startsWith('Window ') && node.type === 'object') {
      hasWindow = true;
    }
    if (
      node.name === 'Module' &&
      node.type === 'object' &&
      !hasWindow &&
      !hasModule
    ) {
      hasModule = true;
    }
  });
  if (hasWindow) return 'browser';
  if (hasModule) return 'node';
  return 'unknown';
}

function quickDiagnosis(
  snapshot: IHeapSnapshot,
  totalSelfSize: number,
): string[] {
  const warnings: string[] = [];

  const largeStrings: {id: number; name: string; size: number}[] = [];
  const stringCounts = new Map<string, number>();
  const classCounts = new Map<string, number>();

  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;

    if (node.type === 'string' && node.self_size >= 1024 * 1024) {
      largeStrings.push({id: node.id, name: node.name, size: node.self_size});
    }

    // Count flat-string duplication only. Sliced strings (type 'sliced
    // string') share a parent's storage, so they aren't independent dupes.
    if (node.type === 'string') {
      const key = node.name.length > 100 ? node.name.slice(0, 100) : node.name;
      stringCounts.set(key, (stringCounts.get(key) ?? 0) + 1);
    }

    if (node.type !== 'hidden' && node.type !== 'array') {
      classCounts.set(node.name, (classCounts.get(node.name) ?? 0) + 1);
    }
  });

  if (largeStrings.length > 0) {
    const totalSize = largeStrings.reduce((s, n) => s + n.size, 0);
    warnings.push(
      `⚠ ${largeStrings.length} string(s) > 1 MB (${formatBytes(totalSize)} total) — possible unbounded data retention`,
    );
  }

  // Suppress noise: tiny or purely-numeric/SMI-like strings duplicate heavily
  // but carry no signal (e.g. "5" ×3,372, "0" ×2,733). Require some length and
  // non-numeric content to be worth flagging.
  const isNoisyDupKey = (s: string): boolean =>
    s.length < 8 || /^[\s\d.,:+-]*$/.test(s);
  const highDups = [...stringCounts.entries()]
    .filter(([val, count]) => count >= 1000 && !isNoisyDupKey(val))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  for (const [val, count] of highDups) {
    const display = val.length > 40 ? val.slice(0, 40) + '…' : val;
    warnings.push(`⚠ "${display}" duplicated ${formatNumber(count)} times`);
  }

  const largest = findLargestObject(snapshot);
  if (largest && totalSelfSize > 0) {
    const pct = ((largest.size / totalSelfSize) * 100).toFixed(0);
    if (largest.size >= totalSelfSize * 0.3) {
      warnings.push(
        `⚠ @${largest.id} ${truncateNodeName(largest.name, largest.type, largest.size, 40)} (${largest.type}) retains ${formatBytes(largest.size)} (${pct}% of heap)`,
      );
    }
  }

  const anomalous = [...classCounts.entries()]
    .filter(([, count]) => count >= 10000)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  for (const [name, count] of anomalous) {
    warnings.push(`⚠ ${formatNumber(count)}× \`${name}\` instances`);
  }

  if (warnings.length > 0) {
    warnings.push(
      '',
      'Run `memlab_quick_diagnosis` for actionable triage or `memlab_auto_investigate` for deep analysis.',
    );
  }

  return warnings;
}

export function registerLoadSnapshot(server: McpServer): void {
  server.tool(
    'memlab_load_snapshot',
    'Load and parse a .heapsnapshot file. This builds indexes, computes the dominator tree, and calculates retained sizes. Returns a quick diagnosis highlighting potential issues. Accepts a local absolute path, a manifold:// URL, or a bare snapshot filename (resolved against the nest_server_nodejs_heap_snapshots bucket and fetched automatically). Multiple snapshots can be kept resident — pass keep_previous:true to load several for diffing/comparison; switch between them with memlab_snapshots.',
    {
      file_path: z
        .string()
        .describe(
          'A local absolute path to a .heapsnapshot file, a manifold:// URL (manifold://bucket/key), or a bare snapshot filename to fetch from the nest_server_nodejs_heap_snapshots bucket.',
        ),
      alias: z
        .string()
        .optional()
        .describe(
          'Optional short handle to identify this snapshot in a multi-snapshot session (defaults to the file name). Node ids are only valid within the snapshot they came from.',
        ),
      keep_previous: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Keep previously-loaded snapshots resident instead of replacing them (default false). Enables before/after diffing and app-to-app comparison without reloading. Each resident snapshot holds its full graph in memory — watch server RSS for very large heaps.',
        ),
      quiet: z
        .boolean()
        .optional()
        .describe(
          'Session output control: when true, the per-call "> Snapshot: …" header is printed once instead of on every subsequent tool result (saves tokens over a long investigation).',
        ),
      suppress_suggestions: z
        .boolean()
        .optional()
        .describe(
          'Session output control: when true, tools omit their "Suggested next steps" trailers to save tokens.',
        ),
      max_file_size_mb: z
        .number()
        .optional()
        .default(900)
        .describe(
          'Maximum file size in MB to attempt loading (default 900). Snapshots larger than this will return an error instead of risking an OOM crash. Increase if your Node.js process has extra memory (--max-old-space-size).',
        ),
    },
    async ({
      file_path,
      alias,
      keep_previous,
      quiet,
      suppress_suggestions,
      max_file_size_mb,
    }) => {
      try {
        if (quiet != null || suppress_suggestions != null) {
          setSessionConfig({
            ...(quiet != null ? {quietHeader: quiet} : {}),
            ...(suppress_suggestions != null
              ? {suppressSuggestions: suppress_suggestions}
              : {}),
          });
        }
        const previousMeta = getSnapshotMetadata();
        let resolved: string;
        let fetchedFrom: string | null = null;
        try {
          const r = resolveSnapshotPath(file_path);
          resolved = r.localPath;
          fetchedFrom = r.fetchedFrom;
        } catch (fetchErr) {
          const msg =
            fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          return errorResult(
            new Error(
              `Failed to fetch "${file_path}" from Manifold: ${msg}\n` +
                `Ensure the 'manifold' CLI is installed and you have access to the bucket, ` +
                `or pass a local absolute path instead.`,
            ),
          );
        }
        if (!fs.existsSync(resolved)) {
          return errorResult(
            new Error(
              `File not found: ${resolved}` +
                (file_path.includes('/')
                  ? ''
                  : ` (also tried fetching "${file_path}" from the ${DEFAULT_MANIFOLD_BUCKET} bucket)`),
            ),
          );
        }
        const fileStat = fs.statSync(resolved);
        const fileSizeMB = fileStat.size / (1024 * 1024);

        if (fileSizeMB > max_file_size_mb) {
          return errorResult(
            new Error(
              `Snapshot file is ${formatBytes(fileStat.size)} — exceeds the ${max_file_size_mb} MB safety limit. ` +
                `Loading snapshots this large often causes the MCP server to crash with an out-of-memory error, ` +
                `losing all analysis state.\n\n` +
                `Options:\n` +
                `1. Use a smaller snapshot from the same app if available\n` +
                `2. Increase the limit: memlab_load_snapshot({max_file_size_mb: ${Math.ceil(fileSizeMB + 100)}})\n` +
                `3. Restart the MCP server with more memory: NODE_OPTIONS="--max-old-space-size=8192"`,
            ),
          );
        }

        if (fileSizeMB > 200) {
          process.stderr.write(
            `Loading ${formatBytes(fileStat.size)} snapshot — this may take a while (parsing, computing dominators, building indexes)...\n`,
          );
        }

        let snapshot;
        try {
          snapshot = await getFullHeapFromFile(resolved);
        } catch (loadErr: unknown) {
          const msg =
            loadErr instanceof Error ? loadErr.message : String(loadErr);
          if (
            msg.includes('heap out of memory') ||
            msg.includes('allocation failed') ||
            msg.includes('JavaScript heap') ||
            msg.includes('ENOMEM')
          ) {
            return errorResult(
              new Error(
                `Out of memory while loading ${formatBytes(fileStat.size)} snapshot. ` +
                  `The snapshot requires more memory than is available to the MCP server process.\n\n` +
                  `Try:\n` +
                  `1. A smaller snapshot from the same app\n` +
                  `2. Restart with more memory: NODE_OPTIONS="--max-old-space-size=8192"`,
              ),
            );
          }
          throw loadErr;
        }

        let nodeCount = 0;
        let edgeCount = 0;
        let totalSize = 0;
        snapshot.nodes.forEach(node => {
          nodeCount++;
          totalSize += node.self_size;
        });
        snapshot.edges.forEach(() => {
          edgeCount++;
        });

        const env = detectEnv(snapshot);
        const fileName = path.basename(
          fetchedFrom ?? file_path.replace(/^manifold:\/\//, ''),
        );
        const meta = setSnapshot(
          snapshot,
          resolved,
          {
            fileName,
            nodeCount,
            edgeCount,
            totalSize,
            env,
          },
          {alias, replace: !keep_previous},
        );

        const envLabel =
          env === 'browser'
            ? 'Browser'
            : env === 'node'
              ? 'Node.js'
              : 'Unknown';
        const lines: string[] = [];
        if (previousMeta && !keep_previous) {
          lines.push(
            `⚠ Replacing previously loaded snapshot "${previousMeta.fileName}"`,
          );
        }
        if (fetchedFrom) {
          lines.push(`Fetched from Manifold: ${fetchedFrom}`);
        }
        lines.push(
          `Loaded ${fileName} (${formatBytes(fileStat.size)} on disk): ${formatNumber(nodeCount)} nodes, ${formatNumber(edgeCount)} edges, ${formatBytes(totalSize)} heap size (${envLabel} snapshot) [handle: ${meta.handle}]`,
        );
        if (keep_previous) {
          const all = listSnapshots();
          if (all.length > 1) {
            lines.push(
              `Resident snapshots (${all.length}): ${all
                .map(
                  m =>
                    `${m.handle === meta.handle ? '→ ' : ''}${m.handle} (${formatBytes(m.totalSize)})`,
                )
                .join(', ')}. Switch with memlab_snapshots.`,
            );
          }
        }

        const warnings = quickDiagnosis(snapshot, totalSize);
        if (warnings.length > 0) {
          lines.push('', ...warnings);
        }

        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

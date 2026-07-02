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
import v8 from 'v8';
import {execFileSync} from 'child_process';
import {z} from 'zod';
import memlabHeapAnalysis from '@memlab/heap-analysis';
const {getFullHeapFromFile} = memlabHeapAnalysis;
import {
  setSnapshot,
  getSnapshotMetadata,
  setSessionConfig,
  listSnapshots,
  clearAllSnapshots,
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

// Size caps for the OOM guard. Server heap snapshots (Nest auto-capture, the
// Manifold bucket above) routinely run 550–2100 MB, so every one exceeds the
// conservative local-file default and a sweep previously had to pass
// max_file_size_mb on EVERY load call. When a snapshot is fetched from Manifold
// (a server capture, not an arbitrary local file) raise the effective cap to the
// analyzer's documented safe ceiling — larger than this reliably OOMs the parser
// — unless the caller set an explicit limit. Local files keep the tighter guard.
// (Sweep feedback round 6 §2.)
export const LOCAL_FILE_SIZE_LIMIT_MB = 900;
export const MANIFOLD_FETCH_SIZE_LIMIT_MB = 2100;

// A node/edge-count ceiling complements the file-size cap. The load computes a
// dominator tree via the Chrome-DevTools iterative fix-point algorithm, whose
// cost is ~O(passes × edges) and blows up with graph DEPTH and cycle density,
// not raw disk size — so a structurally deep snapshot only modestly larger on
// disk can take effectively forever. Worse, the whole load is one synchronous
// block the cooperative wall-clock guardrail cannot preempt, so there is no
// timeout to fall back on (P2403258184). We therefore refuse BEFORE starting the
// pass when the (cheaply peeked) node/edge counts exceed the ceiling, and warn
// above the soft threshold. File size is a poor proxy for dominator-pass cost,
// so these are separate from the MB caps. Override with max_nodes/max_edges, or
// bypass entirely with force:true (expect a long, uninterruptible load).
//
// These fixed values are FLOORS: the effective ceiling is auto-scaled UP from the
// process's configured old-space limit (see computeDefaultCeilings) and only
// falls back to these when the limit can't be read. A memory-starved server is
// therefore never less safe than before, while an 8 GB server admits the tier
// that previously required a hand-passed override on every call.
export const DEFAULT_MAX_NODES = 12_000_000;
export const DEFAULT_MAX_EDGES = 24_000_000;
export const WARN_NODE_COUNT = 2_000_000;

// Auto-scaling rates (sweep feedback: "the load ceiling is mismatched to Nest
// server snapshots"). Nest server captures are edge-dense (~4 edges/node), so the
// EDGE ceiling — not the node ceiling — is what rejected essentially the whole
// meaningful part of the 550–2100 MB band. Empirically, on a server started with
// --max-old-space-size=8192 the ~11–14M-node / ~45–49M-edge / ~1.1 GB tier loads
// cleanly in seconds-to-tens-of-seconds with no OOM, while the ~2 GB / 24M-node /
// 89M-edge tier is genuinely risky. Rather than hard-code one ceiling tuned to a
// single heap size, scale it from the process's actual old-space limit so an 8 GB
// server admits the 1.1 GB tier by default and a smaller server stays
// conservative. Rates chosen so ~8192 MB → ~13.9M nodes / ~55.7M edges (admits the
// 45–49M-edge band, still rejects the 89M-edge / 2 GB band).
export const NODES_PER_HEAP_MB = 1700;
export const EDGES_PER_HEAP_MB = 6800;

/**
 * Configured V8 old-space limit in MB (reflects --max-old-space-size). Returns 0
 * when it can't be read, so callers fall back to the fixed floors.
 */
export function getOldSpaceLimitMB(): number {
  try {
    return Math.round(v8.getHeapStatistics().heap_size_limit / (1024 * 1024));
  } catch {
    return 0;
  }
}

/**
 * Default node/edge load ceilings, auto-scaled from the configured old-space
 * limit and floored at the historical fixed defaults so the ceiling never
 * regresses below what was previously safe. `heapLimitMB` is 0 when the limit
 * couldn't be read (ceilings then equal the fixed floors).
 */
export function computeDefaultCeilings(): {
  maxNodes: number;
  maxEdges: number;
  heapLimitMB: number;
} {
  const heapLimitMB = getOldSpaceLimitMB();
  if (heapLimitMB <= 0) {
    return {
      maxNodes: DEFAULT_MAX_NODES,
      maxEdges: DEFAULT_MAX_EDGES,
      heapLimitMB: 0,
    };
  }
  return {
    maxNodes: Math.max(
      DEFAULT_MAX_NODES,
      Math.round(heapLimitMB * NODES_PER_HEAP_MB),
    ),
    maxEdges: Math.max(
      DEFAULT_MAX_EDGES,
      Math.round(heapLimitMB * EDGES_PER_HEAP_MB),
    ),
    heapLimitMB,
  };
}

/**
 * Cheaply read `node_count` / `edge_count` from a .heapsnapshot header without
 * parsing the whole file. The V8 format begins with
 * `{"snapshot":{"meta":{…},"node_count":N,"edge_count":M,…},…}`, so both counts
 * sit within the first few KB. Reads a bounded prefix and regex-extracts them;
 * returns null when they aren't found in the prefix (caller then skips the count
 * guard rather than failing the load).
 */
export function peekSnapshotCounts(
  localPath: string,
): {nodeCount: number; edgeCount: number} | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(localPath, 'r');
    const buf = Buffer.allocUnsafe(256 * 1024);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString('utf8', 0, bytes);
    const n = head.match(/"node_count"\s*:\s*(\d+)/);
    const e = head.match(/"edge_count"\s*:\s*(\d+)/);
    if (!n || !e) return null;
    return {nodeCount: Number(n[1]), edgeCount: Number(e[1])};
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

/**
 * Resolve the effective max-file-size limit (MB). An explicit caller value always
 * wins; otherwise default by source — Manifold-fetched server snapshots get the
 * higher ceiling, local files keep the tighter guard.
 */
export function resolveMaxFileSizeMB(
  explicit: number | undefined,
  fetchedFromManifold: boolean,
): number {
  if (explicit != null) return explicit;
  return fetchedFromManifold
    ? MANIFOLD_FETCH_SIZE_LIMIT_MB
    : LOCAL_FILE_SIZE_LIMIT_MB;
}

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

  // Reuse an already-downloaded copy. The temp name is derived from the unique
  // Manifold key, so a non-empty file here IS this object. This makes a RETRY
  // after a size-limit rejection succeed (the prior attempt fully downloaded
  // before the size check ran) instead of failing with "Local object exists",
  // and avoids re-downloading multi-GB snapshots (feedback §A.1).
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    process.stderr.write(`Reusing already-downloaded ${dest}\n`);
    return {localPath: dest, fetchedFrom: manifoldKey};
  }

  process.stderr.write(`Fetching ${manifoldKey} from Manifold → ${dest}…\n`);
  try {
    // --overwrite_local_path so a stale/empty/partial leftover never blocks the
    // fetch (the cause of the "Local object exists" retry failure).
    execFileSync(
      'manifold',
      ['get', '--overwrite_local_path', manifoldKey, dest],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 5 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Friendlier message for a missing object (feedback §E.18) — the raw
    // StorageException is opaque about WHY a path isn't found.
    if (/not found|does not map|StorageException/i.test(msg)) {
      throw new Error(
        `Snapshot not found in Manifold at "${manifoldKey}". ` +
          `It may never have been uploaded (OnDemand-host captures often aren't), ` +
          `or the name/path is wrong. Available mounts: flat/, nodes/, tree/. ` +
          `List an app's snapshots with: ` +
          `manifold ls ${DEFAULT_MANIFOLD_BUCKET}/flat | grep <app-name>\n\n` +
          `Underlying error: ${msg}`,
      );
    }
    throw err;
  }
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

// Nest auto-capture filenames embed the capture time as an epoch (ms or s).
// Surfacing it lets the agent check whether a candidate leak was likely already
// fixed since the snapshot was taken — the dominant outcome when sweeping a
// backlog of old snapshots (Feedback round 5 §12).
function extractCaptureTime(fileName: string): Date | null {
  const msMatch = fileName.match(/(?<!\d)(1\d{12})(?!\d)/);
  const sMatch = fileName.match(/(?<!\d)(1\d{9})(?!\d)/);
  let ms: number | null = null;
  if (msMatch) ms = Number(msMatch[1]);
  else if (sMatch) ms = Number(sMatch[1]) * 1000;
  if (ms == null) return null;
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (year < 2020 || year > 2035) return null;
  return d;
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
    'Load and parse a .heapsnapshot file. This builds indexes, computes the dominator tree, and calculates retained sizes. Returns a quick diagnosis highlighting potential issues. Accepts a local absolute path, a manifold:// URL, or a bare snapshot filename (resolved against the nest_server_nodejs_heap_snapshots bucket and fetched automatically). Multiple snapshots can be kept resident — pass keep_previous:true to load several for diffing/comparison; switch between them with memlab_snapshots. Cost note: the load working set is several× the file size and the dominator pass runs uninterruptibly, so large/deep snapshots are memory- and time-heavy — run the server with NODE_OPTIONS="--max-old-space-size=8192", load one snapshot at a time (omit keep_previous) on large heaps, and prefer memlab_sequence_analysis (transient per-snapshot loads) when you only need trend/growth across a ladder. A node/edge-count ceiling (max_nodes/max_edges) refuses pathologically large loads before they wedge the server; the ceiling auto-scales from the server\'s configured --max-old-space-size (an 8 GB server admits the ~1.1 GB / ~14M-node / ~55M-edge Nest tier by default), and force:true self-sizes from the header counts so a one-off oversized load needs no manual max_nodes/max_edges.',
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
        .describe(
          `Maximum file size in MB to attempt loading. Defaults to ${LOCAL_FILE_SIZE_LIMIT_MB} for local files; for snapshots fetched from Manifold (a bare Nest snapshot filename or a manifold:// URL) it defaults to ${MANIFOLD_FETCH_SIZE_LIMIT_MB} — the analyzer's safe ceiling — since server captures routinely exceed ${LOCAL_FILE_SIZE_LIMIT_MB} MB. Pass an explicit value to override either default (e.g. raise it if your Node.js process has extra memory via --max-old-space-size). Snapshots larger than the effective limit return an error instead of risking an OOM crash.`,
        ),
      max_nodes: z
        .number()
        .optional()
        .describe(
          `Maximum node count to attempt loading. Defaults to an auto-scaled ceiling derived from the server's configured --max-old-space-size (≈${formatNumber(NODES_PER_HEAP_MB)}× the old-space MB, floored at ${formatNumber(DEFAULT_MAX_NODES)}); an 8 GB server defaults to ~${formatNumber(8192 * NODES_PER_HEAP_MB)}. The dominator-tree computation done at load is super-linear in graph size AND depth and runs uninterruptibly, so a very large/deep snapshot can wedge the server with no timeout; the count is peeked cheaply from the header and the load is refused before it starts if it exceeds this. File size is a poor proxy for this cost, so this is separate from max_file_size_mb.`,
        ),
      max_edges: z
        .number()
        .optional()
        .describe(
          `Maximum edge count to attempt loading; see max_nodes. Defaults to an auto-scaled ceiling (≈${formatNumber(EDGES_PER_HEAP_MB)}× the old-space MB, floored at ${formatNumber(DEFAULT_MAX_EDGES)}); an 8 GB server defaults to ~${formatNumber(8192 * EDGES_PER_HEAP_MB)}. Nest server snapshots are edge-dense (~4 edges/node), so this — not max_nodes — is usually the binding limit. Peeked from the header; the load is refused before it starts if it exceeds this.`,
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          'Bypass the node/edge-count ceiling and attempt the load anyway (default false). force:true is self-sizing — it uses the header-peeked counts, so you do NOT also need to pass max_nodes/max_edges. The load cannot be interrupted once started, so only use this when you accept a potentially very long load or possible OOM.',
        ),
    },
    async ({
      file_path,
      alias,
      keep_previous,
      quiet,
      suppress_suggestions,
      max_file_size_mb,
      max_nodes,
      max_edges,
      force,
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

        // Manifold-fetched server snapshots get the higher ceiling by default so
        // the common 550–2100 MB Nest captures load without an explicit override
        // (sweep feedback round 6 §2); an explicit caller value still wins.
        const effectiveMaxFileSizeMB = resolveMaxFileSizeMB(
          max_file_size_mb,
          fetchedFrom != null,
        );

        if (fileSizeMB > effectiveMaxFileSizeMB) {
          const heapMB = getOldSpaceLimitMB();
          const options = [
            `1. Use a smaller snapshot from the same app if available`,
            `2. Increase the limit: memlab_load_snapshot({max_file_size_mb: ${Math.ceil(fileSizeMB + 100)}})`,
          ];
          // Only recommend more memory when the server isn't already at 8 GB —
          // the shipped default (feedback: the "restart with more memory" advice
          // was a red herring when the server was already at 8 GB). An unknown
          // limit (heapMB === 0) also satisfies this and keeps the advice, since
          // we can't confirm the server is already provisioned.
          if (heapMB < 8192) {
            options.push(
              `3. Restart the MCP server with more memory: NODE_OPTIONS="--max-old-space-size=8192"`,
            );
          }
          return errorResult(
            new Error(
              `Snapshot file is ${formatBytes(fileStat.size)} — exceeds the ${effectiveMaxFileSizeMB} MB safety limit. ` +
                `Loading snapshots this large often causes the MCP server to crash with an out-of-memory error, ` +
                `losing all analysis state.` +
                (heapMB > 0
                  ? ` (This server's Node.js heap is ~${formatNumber(heapMB)} MB.)`
                  : '') +
                `\n\nOptions:\n` +
                options.join('\n'),
            ),
          );
        }

        // Node/edge-count ceiling (P2403258184). The load's dominator pass is
        // super-linear in graph size AND depth and runs as one uninterruptible
        // synchronous block the wall-clock guardrail cannot preempt, so a very
        // large/deep snapshot can wedge the server with no timeout. Peek the
        // counts cheaply from the header and refuse BEFORE starting the pass.
        const counts = peekSnapshotCounts(resolved);
        const autoCeilings = computeDefaultCeilings();
        const effectiveMaxNodes = max_nodes ?? autoCeilings.maxNodes;
        const effectiveMaxEdges = max_edges ?? autoCeilings.maxEdges;
        if (
          counts &&
          !force &&
          (counts.nodeCount > effectiveMaxNodes ||
            counts.edgeCount > effectiveMaxEdges)
        ) {
          const heapMB = autoCeilings.heapLimitMB;
          // Tailor the advice to the server's ACTUAL old-space size. The generic
          // "restart with more memory" line is a red herring when the server is
          // already at 8 GB (the shipped default) — in that case force:true is all
          // that's needed, and it self-sizes from these header counts.
          const heapNote =
            heapMB > 0
              ? `This server's Node.js heap is ~${formatNumber(heapMB)} MB (--max-old-space-size), so the auto-scaled ceiling is ${formatNumber(effectiveMaxNodes)} nodes / ${formatNumber(effectiveMaxEdges)} edges. `
              : '';
          const options = [
            `1. Get trend/growth WITHOUT a full load: memlab_sequence_analysis loads snapshots transiently (one at a time) and is the right tool for a ladder.`,
            `2. Use a smaller/earlier snapshot from the same ladder.`,
            `3. Load it anyway with force:true — it self-sizes from these header counts, so you do NOT also need max_nodes/max_edges: memlab_load_snapshot({file_path: "${file_path}", force: true}). Expect a long, uninterruptible dominator pass.`,
          ];
          // Only suggest more memory when the server is actually under-provisioned.
          if (heapMB > 0 && heapMB < 8192) {
            options.push(
              `4. This server has only ~${formatNumber(heapMB)} MB — restart it with more memory to raise the ceiling before forcing: NODE_OPTIONS="--max-old-space-size=8192".`,
            );
          }
          return errorResult(
            new Error(
              `Snapshot has ${formatNumber(counts.nodeCount)} nodes / ${formatNumber(counts.edgeCount)} edges — exceeds the load ceiling ` +
                `(${formatNumber(effectiveMaxNodes)} nodes / ${formatNumber(effectiveMaxEdges)} edges). ${heapNote}\n\n` +
                `The load computes a dominator tree whose cost grows super-linearly with graph size and depth, and it runs as one synchronous block that the wall-clock guardrail cannot interrupt — so a snapshot this large/deep can wedge the server with no timeout. Refusing before the pass starts.\n\n` +
                `Options:\n` +
                options.join('\n'),
            ),
          );
        }

        const bigBySize = fileSizeMB > 200;
        const bigByCount = counts != null && counts.nodeCount > WARN_NODE_COUNT;
        if (bigBySize || bigByCount) {
          const countStr = counts
            ? `${formatNumber(counts.nodeCount)} nodes / ${formatNumber(counts.edgeCount)} edges, `
            : '';
          process.stderr.write(
            `Loading ${formatBytes(fileStat.size)} snapshot (${countStr}parsing → dominators → retained sizes). ` +
              `This runs uninterruptibly and can take minutes on a large/deep heap; if it appears to hang it is the dominator pass, not a crash.\n`,
          );
        }

        // Free any resident snapshot BEFORE parsing the next so peak memory is
        // one heap, not two — the double-residency that tips a large load into
        // GC thrash (P2403258184 §3). Only in replace mode; keep_previous
        // callers explicitly opt into holding several resident.
        if (!keep_previous) {
          clearAllSnapshots();
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
            const heapMB = getOldSpaceLimitMB();
            const already8g = heapMB >= 8192;
            return errorResult(
              new Error(
                `Out of memory while loading ${formatBytes(fileStat.size)} snapshot. ` +
                  `The snapshot requires more memory than is available to the MCP server process` +
                  (heapMB > 0 ? ` (~${formatNumber(heapMB)} MB heap)` : '') +
                  `.\n\n` +
                  `Try:\n` +
                  `1. A smaller/earlier snapshot from the same app or ladder\n` +
                  (already8g
                    ? `2. This server is already at ~${formatNumber(heapMB)} MB — this snapshot is simply too large to load in full; use memlab_sequence_analysis for trend/growth without a full load.`
                    : `2. Restart with more memory: NODE_OPTIONS="--max-old-space-size=8192"`),
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
        const captured = extractCaptureTime(fileName);
        if (captured) {
          const iso = captured.toISOString().slice(0, 10);
          // Clamp to 0: a filename whose embedded epoch is slightly ahead of
          // the host clock (clock skew, or a future-dated name within the
          // allowed window) must not surface as "(-N day(s) ago)".
          const ageDays = Math.max(
            0,
            Math.floor((Date.now() - captured.getTime()) / 86_400_000),
          );
          lines.push(
            `Captured ${iso} (${ageDays} day(s) ago) — if you find a candidate, verify the fix wasn't already deployed since then before writing one.`,
          );
        }
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

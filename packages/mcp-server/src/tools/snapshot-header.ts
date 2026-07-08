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
  resolveSnapshotPath,
  peekSnapshotCounts,
  computeDefaultCeilings,
  estimateMaxLoadableMB,
  extractCaptureTime,
  DEFAULT_MANIFOLD_BUCKET,
} from './load-snapshot.js';
import {formatBytes, formatNumber, errorResult, textResult} from '../utils.js';

/**
 * memlab_snapshot_header — peek a snapshot's header WITHOUT the dominator pass.
 *
 * The expensive/risky part of memlab_load_snapshot is the dominator-tree
 * computation (uninterruptible, super-linear, can wedge/OOM the server). This
 * tool skips it entirely: it resolves + fetches the file (reusing any cached
 * download, so a follow-up real load doesn't re-download), reads the node/edge
 * counts and capture time from the file header, and reports whether the capture
 * fits under the current auto-scaled load ceiling.
 *
 * The point is to end the "attempt load → refused on counts → hand-compute
 * density → re-query Scuba for a smaller file → retry" loop that dominated a
 * server-snapshot sweep (feedback round 7 §1/§2): peek a candidate, read its
 * exact counts + this-app density + the estimated max-loadable file size, then
 * pick the right capture in one step.
 */
export function registerSnapshotHeader(server: McpServer): void {
  server.tool(
    'memlab_snapshot_header',
    "Peek a .heapsnapshot's header (node/edge counts, capture time, file size) WITHOUT loading it — no dominator pass, so it can never wedge or OOM the server the way a full memlab_load_snapshot can. Reports whether the capture fits under the current auto-scaled load ceiling, this app's node/edge density, and — when it doesn't fit — the estimated largest same-app capture that WOULD fit, so you can select a loadable snapshot in one step instead of attempting an oversized load. Accepts a local absolute path, a manifold:// URL, or a bare snapshot filename (resolved against the nest_server_nodejs_heap_snapshots bucket and fetched automatically; the download is reused by a subsequent memlab_load_snapshot). Use this to triage which capture in a size band to load before committing to the expensive load.",
    {
      file_path: z
        .string()
        .describe(
          'A local absolute path to a .heapsnapshot file, a manifold:// URL (manifold://bucket/key), or a bare snapshot filename to fetch from the nest_server_nodejs_heap_snapshots bucket.',
        ),
    },
    async ({file_path}) => {
      try {
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
        const fileName = path.basename(
          fetchedFrom ?? file_path.replace(/^manifold:\/\//, ''),
        );

        const counts = peekSnapshotCounts(resolved);
        const ceilings = computeDefaultCeilings();

        const lines: string[] = [];
        lines.push(`Snapshot header: ${fileName}`);
        if (fetchedFrom) lines.push(`Fetched from Manifold: ${fetchedFrom}`);
        lines.push(`File size: ${formatBytes(fileStat.size)}`);

        if (!counts) {
          lines.push(
            `Node/edge counts: not found in the header prefix — cannot assess loadability without a full load.`,
          );
          return textResult(lines.join('\n'));
        }

        lines.push(
          `Nodes: ${formatNumber(counts.nodeCount)}   Edges: ${formatNumber(counts.edgeCount)}`,
        );

        const captured = extractCaptureTime(fileName);
        if (captured) {
          const iso = captured.toISOString().slice(0, 10);
          const ageDays = Math.max(
            0,
            Math.floor((Date.now() - captured.getTime()) / 86_400_000),
          );
          lines.push(
            `Captured ${iso} (${ageDays} day(s) ago) — if you find a candidate, verify the fix wasn't already deployed since then before writing one.`,
          );
        }

        const heapNote =
          ceilings.heapLimitMB > 0
            ? ` (server heap ~${formatNumber(ceilings.heapLimitMB)} MB via --max-old-space-size)`
            : '';
        lines.push(
          `Current load ceiling: ${formatNumber(ceilings.maxNodes)} nodes / ${formatNumber(ceilings.maxEdges)} edges${heapNote}.`,
        );

        const nodesPerMB = Math.round(counts.nodeCount / fileSizeMB);
        const edgesPerMB = Math.round(counts.edgeCount / fileSizeMB);
        const fitsNodes = counts.nodeCount <= ceilings.maxNodes;
        const fitsEdges = counts.edgeCount <= ceilings.maxEdges;

        if (fitsNodes && fitsEdges) {
          lines.push(
            `✓ Loadable — under the ceiling on both nodes and edges. Load it with memlab_load_snapshot({file_path: "${file_path}"}); the fetched file is cached so it won't re-download.`,
          );
        } else {
          const over =
            !fitsNodes && !fitsEdges
              ? 'nodes and edges'
              : !fitsEdges
                ? 'edges'
                : 'nodes';
          const estMB = estimateMaxLoadableMB(counts, fileSizeMB, {
            maxNodes: ceilings.maxNodes,
            maxEdges: ceilings.maxEdges,
          });
          lines.push(
            `✗ Over the ceiling on ${over}. Density: ${formatNumber(nodesPerMB)} nodes/MB, ${formatNumber(edgesPerMB)} edges/MB.` +
              (estMB != null
                ? ` For this app the ceiling corresponds to roughly a ≤${formatNumber(estMB)} MB capture — select a smaller snapshot below that size (then memlab_snapshot_header it to confirm), or force the load with memlab_load_snapshot({force: true}) accepting a long, uninterruptible dominator pass.`
                : ` Select a smaller snapshot, or force the load with memlab_load_snapshot({force: true}).`),
          );
        }

        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

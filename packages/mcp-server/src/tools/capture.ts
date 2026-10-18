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
import {z} from 'zod';
import {captureLive} from '../cdp-capture.js';
import {errorResult, formatBytes, markdownTable, toolResult} from '../utils.js';

export function registerCapture(server: McpServer): void {
  server.tool(
    'memlab_capture',
    'Take fresh heap snapshots of a LIVE page and/or its dedicated WORKERS over the Chrome DevTools Protocol, without a harness script. ' +
      'A page heap snapshot never contains its workers: one measured web app runs ~14 (backend, search, media, a 10-thread Wasm pool) holding tens of MB of JS heap that no page snapshot shows. ' +
      "Workers are reached through the page connection (flattened auto-attach), because a worker's own websocket never answers in headless Chrome; every command has its own deadline, so workers blocked in `Atomics.wait` are reported as unresponsive and skipped instead of hanging the call. " +
      "Reports each target's JS heap use and the written file; load them with memlab_load_snapshot or compare them with memlab_realm_summary.",
    {
      out_dir: z
        .string()
        .describe('Directory to write the .heapsnapshot files to.'),
      target: z
        .enum(['page', 'workers', 'all'])
        .optional()
        .default('all')
        .describe('What to capture (default "all").'),
      url_filter: z
        .string()
        .optional()
        .default('')
        .describe('Substring of the page URL to attach to (first match).'),
      port: z
        .number()
        .int()
        .optional()
        .default(9222)
        .describe('Chrome remote-debugging port (default 9222).'),
      title_filter: z
        .string()
        .optional()
        .default('')
        .describe(
          'Only snapshot workers whose title contains this; every worker is still sized.',
        ),
      call_timeout_s: z
        .number()
        .optional()
        .default(8)
        .describe('Per-command deadline in seconds (default 8).'),
      snapshot_timeout_s: z
        .number()
        .optional()
        .default(600)
        .describe('Per-snapshot deadline in seconds (default 600).'),
    },
    async ({
      out_dir,
      target,
      url_filter,
      port,
      title_filter,
      call_timeout_s,
      snapshot_timeout_s,
    }) => {
      try {
        const rows = await captureLive({
          port,
          urlFilter: url_filter,
          target,
          outDir: out_dir,
          titleFilter: title_filter,
          callTimeoutMs: call_timeout_s * 1000,
          snapshotTimeoutMs: snapshot_timeout_s * 1000,
        });
        const workers = rows.filter(r => r.target === 'worker');
        const used = workers.reduce((s, r) => s + (r.usedMB ?? 0), 0);
        const blocked = workers.filter(r => r.usedMB == null).length;
        return toolResult(
          [
            `## Live capture — ${rows.filter(r => r.path).length} snapshot(s) written to \`${out_dir}\``,
            '',
            workers.length > 0
              ? `${workers.length} worker(s), ${used.toFixed(1)} MB JS heap in use` +
                (blocked > 0
                  ? `; ${blocked} unresponsive (blocked threads do not answer CDP)`
                  : '') +
                '.'
              : '',
            '',
            markdownTable(
              ['Target', 'Title', 'JS heap used', 'Status', 'File', 'Size'],
              rows.map(r => [
                r.target,
                r.title.length > 50 ? `${r.title.slice(0, 47)}…` : r.title,
                r.usedMB != null ? `${r.usedMB} MB` : '—',
                r.status,
                r.path ?? '—',
                r.bytes > 0 ? formatBytes(r.bytes) : '—',
              ]),
              new Set([2, 5]),
            ),
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

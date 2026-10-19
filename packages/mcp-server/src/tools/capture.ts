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
import path from 'path';
import {z} from 'zod';
import {captureLive, listPageTargets} from '../cdp-capture.js';
import {
  clampLabel,
  errorResult,
  formatBytes,
  markdownTable,
  toolResult,
} from '../utils.js';
import {checkpointLabelError, recordCheckpoint} from '../checkpoints.js';

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
        .optional()
        .describe(
          'Directory to write the .heapsnapshot files to (required unless `list_targets`).',
        ),
      label: z
        .string()
        .optional()
        .describe(
          'Name this capture as a checkpoint (e.g. "baseline", "after-10-opens"). It is recorded in <out_dir>/checkpoints.json, and any tool that takes a snapshot path then accepts `checkpoint:<label>`.',
        ),
      list_targets: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'List the pages Chrome offers on `port` (title and URL) instead of capturing, to choose `url_filter`.',
        ),
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
      label,
      list_targets,
      target,
      url_filter,
      port,
      title_filter,
      call_timeout_s,
      snapshot_timeout_s,
    }) => {
      try {
        if (list_targets) {
          const pages = await listPageTargets(port);
          return toolResult(
            pages.length === 0
              ? `No page targets on port ${port}.`
              : [
                  `## ${pages.length} page target(s) on port ${port}`,
                  '',
                  markdownTable(
                    ['#', 'Title', 'URL'],
                    pages.map((p, i) => [
                      String(i + 1),
                      clampLabel(p.title, 60),
                      clampLabel(p.url, 100),
                    ]),
                  ),
                  '',
                  'Pass a substring of the URL as `url_filter` to choose one.',
                ].join('\n'),
          );
        }
        if (out_dir == null) {
          return errorResult(new Error('`out_dir` is required to capture.'));
        }
        const labelError = label != null ? checkpointLabelError(label) : null;
        if (labelError != null) return errorResult(new Error(labelError));
        const rows = await captureLive({
          port,
          urlFilter: url_filter,
          target,
          outDir: out_dir,
          titleFilter: title_filter,
          callTimeoutMs: call_timeout_s * 1000,
          snapshotTimeoutMs: snapshot_timeout_s * 1000,
        });
        let checkpointNote = '';
        if (label != null && !rows.some(r => r.path != null)) {
          // Recording it would replace a good checkpoint of the same label
          // with one that has no files.
          checkpointNote = `Checkpoint **${label}** NOT recorded: no snapshot was written.`;
        } else if (label != null) {
          const page = rows.find(r => r.target === 'page');
          const all = recordCheckpoint(out_dir, {
            label,
            captured_at: new Date().toISOString(),
            page_url: page?.url ?? '',
            page_title: page?.title ?? '',
            files: rows
              .filter(r => r.path != null)
              .map(r => ({
                target: r.target,
                title: r.title,
                // Absolute, so the reference does not depend on a working directory.
                path: path.resolve(r.path as string),
                used_mb: r.usedMB,
              })),
          });
          const recorded = `Checkpoint **${label}** recorded (${all.length} in \`${out_dir}/checkpoints.json\`: ${all.map(c => c.label).join(', ')}). `;
          const worker = rows.find(
            r => r.target === 'worker' && r.path != null,
          );
          // A bare `checkpoint:<label>` names the page snapshot; with only
          // workers written, point at the form that resolves.
          checkpointNote =
            page?.path == null && worker != null
              ? recorded +
                `It holds worker snapshots only: refer to one as \`checkpoint:${label}/<worker title>\`, e.g. \`checkpoint:${label}/${worker.title}\`.`
              : recorded +
                `Refer to it as \`checkpoint:${label}\` in any tool that takes a snapshot path` +
                (all.length > 1
                  ? `, e.g. \`memlab_diff_snapshots({before: "checkpoint:${all[0].label}", after: "checkpoint:${label}"})\`.`
                  : '; capture the next checkpoint after the interaction, then diff the two.');
        }
        const workers = rows.filter(r => r.target === 'worker');
        const used = workers.reduce((s, r) => s + (r.usedMB ?? 0), 0);
        const blocked = workers.filter(r => r.usedMB == null).length;
        return toolResult(
          [
            `## Live capture — ${rows.filter(r => r.path).length} snapshot(s) written to \`${out_dir}\``,
            '',
            ...(checkpointNote ? [checkpointNote, ''] : []),
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

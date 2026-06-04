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
import {
  listSnapshots,
  getCurrentHandle,
  setCurrentSnapshot,
  removeSnapshot,
  setSessionConfig,
  getSessionConfig,
} from '../heap-state.js';
import {formatBytes, formatNumber, errorResult, textResult} from '../utils.js';

export function registerSnapshots(server: McpServer): void {
  server.tool(
    'memlab_snapshots',
    'Manage the multi-snapshot session: list resident snapshots, switch the active one, or unload one to free memory. Also toggles session-level output controls (quiet header, suppress suggestions) to trim repeated boilerplate tokens. Load several snapshots with memlab_load_snapshot({keep_previous:true}) then switch between them by handle. Node ids are only valid within the snapshot they came from.',
    {
      action: z
        .enum(['list', 'switch', 'unload'])
        .optional()
        .default('list')
        .describe(
          '"list" (default) shows resident snapshots; "switch" makes the given handle active; "unload" removes the given handle to free memory.',
        ),
      handle: z
        .string()
        .optional()
        .describe('Snapshot handle to switch to or unload (see action).'),
      quiet: z
        .boolean()
        .optional()
        .describe(
          'When set, toggles the session "quiet header" mode: the "> Snapshot: …" header prints once per snapshot instead of on every tool result.',
        ),
      suppress_suggestions: z
        .boolean()
        .optional()
        .describe(
          'When set, toggles whether tools omit their "Suggested next steps" trailers.',
        ),
    },
    async ({action, handle, quiet, suppress_suggestions}) => {
      try {
        const configChanges: string[] = [];
        if (quiet != null || suppress_suggestions != null) {
          setSessionConfig({
            ...(quiet != null ? {quietHeader: quiet} : {}),
            ...(suppress_suggestions != null
              ? {suppressSuggestions: suppress_suggestions}
              : {}),
          });
          const cfg = getSessionConfig();
          configChanges.push(
            `Output config: quietHeader=${cfg.quietHeader}, suppressSuggestions=${cfg.suppressSuggestions}`,
          );
        }

        if (action === 'switch') {
          if (!handle) {
            return errorResult('action "switch" requires a handle.');
          }
          if (!setCurrentSnapshot(handle)) {
            return errorResult(
              `No resident snapshot with handle "${handle}". Use action:"list" to see handles.`,
            );
          }
          return textResult(
            [`Active snapshot is now "${handle}".`, ...configChanges].join(
              '\n',
            ),
          );
        }

        if (action === 'unload') {
          if (!handle) {
            return errorResult('action "unload" requires a handle.');
          }
          if (!removeSnapshot(handle)) {
            return errorResult(`No resident snapshot with handle "${handle}".`);
          }
          const cur = getCurrentHandle();
          return textResult(
            [
              `Unloaded snapshot "${handle}".`,
              cur
                ? `Active snapshot is now "${cur}".`
                : 'No snapshots remain loaded.',
              ...configChanges,
            ].join('\n'),
          );
        }

        // list
        const all = listSnapshots();
        const cur = getCurrentHandle();
        if (all.length === 0) {
          return textResult(
            [
              'No snapshots loaded. Use memlab_load_snapshot first.',
              ...configChanges,
            ].join('\n'),
          );
        }
        const lines = [`Resident snapshots (${all.length}):`];
        for (const m of all) {
          lines.push(
            `${m.handle === cur ? '→' : ' '} ${m.handle} — ${m.fileName}, ` +
              `${formatBytes(m.totalSize)}, ${formatNumber(m.nodeCount)} nodes (${m.env})`,
          );
        }
        if (configChanges.length > 0) lines.push('', ...configChanges);
        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

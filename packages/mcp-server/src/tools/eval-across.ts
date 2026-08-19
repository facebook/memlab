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
  getCurrentHandle,
  getMetadataByHandle,
  listSnapshots,
  setCurrentSnapshot,
} from '../heap-state.js';
import {errorResult, toolResult} from '../utils.js';
import {runEval} from './eval.js';

// The tool result shape the MCP SDK expects; runEval returns exactly this.
type TextResult = {content: Array<{type: 'text'; text: string}>};

function textOf(result: unknown): string {
  const content = (result as TextResult)?.content;
  if (!Array.isArray(content)) return '(no output)';
  return content
    .map(c => (typeof c?.text === 'string' ? c.text : ''))
    .join('\n')
    .trim();
}

export function registerEvalAcross(server: McpServer): void {
  server.tool(
    'memlab_eval_across',
    'Run ONE `memlab_eval` program against SEVERAL resident snapshots and return the results side by side. ' +
      'Exists because the interesting questions in a leak hunt are comparative — "how many of these were there at each rung?", ' +
      '"did this collection grow?", "is the new population retained the same way as the old one?" — and answering them with ' +
      '`memlab_eval` alone costs one switch + one paste + one manual diff per rung, which is enough friction that the question ' +
      'often just does not get asked. The code, the sandbox and the helper surface are identical to `memlab_eval` (this calls the ' +
      'same implementation, not a copy), so anything that runs there runs here.\n\n' +
      'Node ids are per-capture, so write code that computes COMPARABLE values (counts, sizes, shapes, string values) rather than ' +
      'code that hardcodes ids from one rung. `helpers.load(name)` still refuses cross-snapshot reads unless you pass ' +
      '`{allowCrossSnapshot: true}`.\n\n' +
      'The active snapshot is restored when the run finishes, including on failure, so this does not disturb an in-progress investigation.',
    {
      code: z
        .string()
        .describe(
          'JavaScript to run against each snapshot. Same conventions as memlab_eval: assign to `result`, iterate with `snapshot.nodes.forEach`, use `helpers.*`. Run `memlab_eval({mode:"describe_env"})` for the full surface.',
        ),
      handles: z
        .array(z.string())
        .optional()
        .describe(
          'Snapshot handles to run against, in the order you want them reported (oldest rung first reads best). Defaults to every resident snapshot in load order.',
        ),
      timeout_ms: z
        .number()
        .optional()
        .default(60000)
        .describe(
          'Execution timeout in milliseconds, applied PER snapshot (default 60000).',
        ),
      max_nodes: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(20000000)
        .describe(
          'Per-snapshot node-visit budget for full-heap walks (default 20000000). On overrun that rung reports a partial result instead of failing the whole run.',
        ),
      stop_on_error: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Stop at the first snapshot whose code throws (default false: record the error for that rung and continue, so one bad rung does not discard the others).',
        ),
    },
    async ({code, handles, timeout_ms, max_nodes, stop_on_error}) => {
      const originalHandle = getCurrentHandle();
      try {
        const resident = listSnapshots().map(m => m.handle);
        if (resident.length === 0) {
          return errorResult(
            new Error(
              'No snapshots are loaded. Load them with memlab_load_snapshot({keep_previous: true}) first — this tool compares snapshots that are already resident, it does not open files.',
            ),
          );
        }
        const targets =
          handles != null && handles.length > 0 ? handles : resident;

        const unknown = targets.filter(h => getMetadataByHandle(h) == null);
        if (unknown.length > 0) {
          return errorResult(
            new Error(
              `Unknown snapshot handle(s): ${unknown.join(', ')}. Resident: ${resident.join(', ')}. ` +
                'Handles come from memlab_snapshots or the alias passed to memlab_load_snapshot.',
            ),
          );
        }
        if (targets.length < 2) {
          // Not an error — a single-handle run is a legitimate way to script
          // one rung — but the whole point of the tool is the comparison.
          // Saying so beats silently returning a one-row report.
          // (falls through and runs)
        }

        const sections: string[] = [];
        let failures = 0;
        for (const handle of targets) {
          if (!setCurrentSnapshot(handle)) {
            sections.push(
              `### ${handle}\n\n(could not switch to this snapshot)`,
            );
            failures++;
            continue;
          }
          const meta = getMetadataByHandle(handle);
          const header = `### ${handle}${meta ? ` — ${meta.fileName}` : ''}`;
          try {
            const res = await runEval({code, timeout_ms, max_nodes});
            const body = textOf(res);
            if (/^Error:/m.test(body)) failures++;
            sections.push(`${header}\n\n${body}`);
            if (stop_on_error && /^Error:/m.test(body)) {
              sections.push(
                '_Stopped here: stop_on_error is set and this rung failed._',
              );
              break;
            }
          } catch (err) {
            failures++;
            const msg = err instanceof Error ? err.message : String(err);
            sections.push(`${header}\n\nError: ${msg}`);
            if (stop_on_error) {
              sections.push(
                '_Stopped here: stop_on_error is set and this rung failed._',
              );
              break;
            }
          }
        }

        const lines = [
          `## eval across ${targets.length} snapshot(s)`,
          '',
          `Order: ${targets.join(' → ')}${failures > 0 ? ` · ${failures} rung(s) reported an error` : ''}`,
          '',
          ...(targets.length < 2
            ? [
                '_Only one snapshot targeted — this tool exists for the comparison; load a second rung with `keep_previous: true` to get one._',
                '',
              ]
            : []),
          sections.join('\n\n'),
          '',
          '_Values are comparable across rungs; node IDS are not — they are assigned per capture. Compare counts, sizes, shapes and string values, never ids._',
        ];
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      } finally {
        // Restore whatever the caller had active, so a comparison run is not a
        // hidden state change for every tool that follows it.
        if (originalHandle != null) setCurrentSnapshot(originalHandle);
      }
    },
  );
}

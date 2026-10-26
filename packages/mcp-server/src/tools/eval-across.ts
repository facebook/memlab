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
import {loadRunManifest} from '../run-manifest.js';
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
  withSnapshotAt,
} from '../snapshot-borrow.js';

/** One snapshot to run against: its report label and how to make it active. */
interface Target {
  label: string;
  /** Runs `fn` with this snapshot active; false when it cannot be. */
  run: <T>(fn: () => Promise<T>) => Promise<{ok: true; value: T} | {ok: false}>;
}

/**
 * `run_dir` rung indices to file paths. Negative indices count from the end,
 * so `[0, -1]` is the baseline and the last driven rung.
 */
export function rungPaths(
  runDir: string,
  rungs: number[] | undefined,
): string[] {
  const all = loadRunManifest(runDir).paths;
  if (rungs == null || rungs.length === 0) return all;
  return rungs.map(i => {
    const at = i < 0 ? all.length + i : i;
    const p = all[at];
    if (p == null) {
      throw new Error(
        `${runDir} has ${all.length} rung(s) (0-${all.length - 1}); there is no rung ${i}.`,
      );
    }
    return p;
  });
}

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
    'Run ONE `memlab_eval` program against SEVERAL snapshots and return the results side by side: resident ones by `handles`, or files by `paths` or `run_dir` + `rungs`, which are loaded one at a time and released after (a resident one is reused). ' +
      'Exists because the interesting questions in a leak hunt are comparative — "how many of these were there at each rung?", ' +
      '"did this collection grow?", "is the new population retained the same way as the old one?" — and answering them with ' +
      '`memlab_eval` alone costs one switch + one paste + one manual diff per rung, which is enough friction that the question ' +
      'often just does not get asked. The code, the sandbox and the helper surface are identical to `memlab_eval` (this calls the ' +
      'same implementation, not a copy), so anything that runs there runs here.\n\n' +
      'Node ids match across rungs only when they come from one isolate (one tab session, no reload; memlab_diff_snapshots reports this), so write code that computes COMPARABLE values (counts, sizes, shapes, string values) rather than ' +
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
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Snapshot files to run against instead of resident handles, in report order. Each is loaded for its run and released after, so two 500 MB rungs need not be resident together.',
        ),
      run_dir: z
        .string()
        .optional()
        .describe(
          "A leak-hunt round's directory: run against its rungs (run.json), loaded one at a time like `paths`.",
        ),
      rungs: z
        .array(z.number().int())
        .optional()
        .describe(
          'With `run_dir`: which rungs, by index into run.json, in report order. Negative counts from the end (`[0, -1]` = baseline and last). Default: every rung.',
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
        .describe(
          'Per-snapshot node-visit budget for full-heap walks. Defaults to a budget SCALED from each loaded graph (6 full passes, floored at 20,000,000). On overrun that rung reports a partial result instead of failing the whole run.',
        ),
      stop_on_error: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Stop at the first snapshot whose code throws (default false: record the error for that rung and continue, so one bad rung does not discard the others).',
        ),
    },
    async ({
      code,
      handles,
      paths,
      run_dir,
      rungs,
      timeout_ms,
      max_nodes,
      stop_on_error,
    }) => {
      const originalHandle = getCurrentHandle();
      try {
        const given = [
          handles != null && handles.length > 0,
          paths != null && paths.length > 0,
          run_dir != null && run_dir !== '',
        ].filter(Boolean).length;
        if (given > 1) {
          return errorResult(
            new Error('Pass one of `handles`, `paths` or `run_dir`.'),
          );
        }
        if (rungs != null && (run_dir == null || run_dir === '')) {
          return errorResult(new Error('`rungs` needs `run_dir`.'));
        }
        let targets: Target[];
        const files =
          run_dir != null && run_dir !== ''
            ? rungPaths(run_dir, rungs)
            : (paths ?? []);
        if (files.length > 0) {
          const {rungs: resolved} = resolveRungs(files);
          targets = resolved.map(rung => ({
            label: rung.label,
            run: async fn => {
              armScanBudgetFor(scaledTimeoutMs(rung.sizeMB, timeout_ms));
              return {
                ok: true as const,
                value: await withSnapshotAt(rung.localPath, () => fn()),
              };
            },
          }));
        } else {
          const resident = listSnapshots().map(m => m.handle);
          if (resident.length === 0) {
            return errorResult(
              new Error(
                'No snapshots are loaded. Pass `paths` or `run_dir` to load rungs for the run, or load them with memlab_load_snapshot({keep_previous: true}) first.',
              ),
            );
          }
          const chosen =
            handles != null && handles.length > 0 ? handles : resident;
          const unknown = chosen.filter(h => getMetadataByHandle(h) == null);
          if (unknown.length > 0) {
            return errorResult(
              new Error(
                `Unknown snapshot handle(s): ${unknown.join(', ')}. Resident: ${resident.join(', ')}. ` +
                  'Handles come from memlab_snapshots or the alias passed to memlab_load_snapshot.',
              ),
            );
          }
          targets = chosen.map(handle => {
            const meta = getMetadataByHandle(handle);
            return {
              label: `${handle}${meta ? ` — ${meta.fileName}` : ''}`,
              run: async fn =>
                setCurrentSnapshot(handle)
                  ? {ok: true as const, value: await fn()}
                  : {ok: false as const},
            };
          });
        }
        if (targets.length < 2) {
          // Not an error — a single-handle run is a legitimate way to script
          // one rung — but the whole point of the tool is the comparison.
          // Saying so beats silently returning a one-row report.
          // (falls through and runs)
        }

        const sections: string[] = [];
        let failures = 0;
        for (const target of targets) {
          const header = `### ${target.label}`;
          try {
            const ran = await target.run(() =>
              runEval({code, timeout_ms, max_nodes}),
            );
            if (!ran.ok) {
              sections.push(`${header}\n\n(could not switch to this snapshot)`);
              failures++;
              continue;
            }
            // The section title names the snapshot; runEval's own header would
            // list every rung this call has read so far.
            const body = textOf(ran.value).replace(/^> Snapshots?: .*\n+/, '');
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
          `Order: ${targets.map(t => t.label.replace(/ — .*$/, '')).join(' → ')}${failures > 0 ? ` · ${failures} rung(s) reported an error` : ''}`,
          '',
          ...(targets.length < 2
            ? [
                '_Only one snapshot targeted — this tool exists for the comparison; pass a second path or rung, or load one with `keep_previous: true`._',
                '',
              ]
            : []),
          sections.join('\n\n'),
          '',
          '_Values are comparable across rungs. Node ids are only comparable between captures of ONE isolate (same tab, no reload) — memlab_diff_snapshots detects that and matches objects by id; otherwise compare counts, sizes, shapes and string values._',
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

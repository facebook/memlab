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
import {getRegisteredTool, listToolNames} from '../tool-registry.js';
import {errorResult, toolResult} from '../utils.js';

interface StepResult {
  tool: string;
  ok: boolean;
  text: string;
  // A step that never started. Distinct from ok=false: it did not run, so it
  // is neither a pass nor a failure, and rendering it as FAILED reports an
  // error the batch never encountered.
  skipped?: boolean;
}

/**
 * A failed step usually does NOT throw. Tool handlers catch their own errors and
 * return `errorResult`, which is a normal MCP envelope carrying `isError: true`,
 * so treating only exceptions as failures silently mislabels those steps as
 * successful — and, worse, makes `stop_on_error` a no-op for the most common
 * failure there is.
 */
function isErrorResult(res: unknown): boolean {
  return (
    res != null &&
    typeof res === 'object' &&
    (res as {isError?: unknown}).isError === true
  );
}

function renderToolText(res: unknown): string {
  // Tool handlers return the MCP content envelope produced by `toolResult`.
  if (res && typeof res === 'object' && 'content' in res) {
    const content = (res as {content?: unknown}).content;
    if (Array.isArray(content)) {
      return content
        .map(c =>
          c && typeof c === 'object' && 'text' in c
            ? String((c as {text?: unknown}).text ?? '')
            : JSON.stringify(c),
        )
        .join('\n');
    }
  }
  return typeof res === 'string' ? res : JSON.stringify(res);
}

/** One step: a tool name plus its arguments. Shared by `steps` and `calls`. */
const STEP_LIST_SCHEMA = z
  .array(
    z.object({
      tool: z.string().describe('Tool name, e.g. "memlab_check_health".'),
      args: z
        .record(z.unknown())
        .optional()
        .describe('Arguments object for that tool (default {}).'),
    }),
  )
  .min(1);

export function registerBatch(server: McpServer): void {
  server.tool(
    'memlab_batch',
    'Run several memlab tools against ONE snapshot load, in order, and return all their outputs together. ' +
      'The natural unit of heap work is "load snapshot X, then run these N tools", but loading is by far the dominant cost — a 380 MB / 4M-node snapshot takes minutes to parse and build a dominator tree, and an MCP session that drops (or a client that cannot attach) makes every call pay it again. ' +
      'Pass `load` to load a snapshot first (same arguments as memlab_load_snapshot); omit it to run against the already-resident snapshot. ' +
      "Steps run sequentially and see each other's side effects, so a step may depend on an earlier one (e.g. load -> check_health -> retainer_summary). " +
      "Every step's tool name AND arguments are validated before step 0 runs, so a step missing a required argument fails the batch immediately instead of after the snapshot load has been paid for. " +
      'NOTE ON TIMEOUTS: the whole batch runs under a single wall-clock guardrail, not one per step — size it with `timeout_ms` (e.g. 600000 for a load plus several whole-heap scans).',
    {
      // A BARE STRING is accepted for `load`. The whole point of this tool is
      // to save calls, and it cost three failed calls to discover that `load`
      // wanted an object and `calls` was not a parameter at all — spelling the
      // common case (`load: "<path>"`) as an error is the opposite of the job.
      load: z
        .union([
          z.string(),
          z.object({
            file_path: z.string(),
            alias: z.string().optional(),
            keep_previous: z.boolean().optional(),
            quiet: z.boolean().optional(),
            max_file_size_mb: z.number().optional(),
          }),
        ])
        .optional()
        .describe(
          'Optional memlab_load_snapshot arguments to run as step 0. A bare path string is accepted and means {file_path: "<path>"}. Omit to use the resident snapshot.',
        ),
      steps: STEP_LIST_SCHEMA.optional().describe(
        'Ordered list of tools to run after the optional load.',
      ),
      calls: STEP_LIST_SCHEMA.optional().describe(
        'Alias for `steps`, accepted because it is the word the tool description and the recipes use for the same thing.',
      ),
      stop_on_error: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Stop at the first failing step (default false: record the error and continue).',
        ),
      timeout_ms: z
        .number()
        .optional()
        .describe(
          'Wall-clock budget for the WHOLE batch (load plus every step). When it is exhausted the remaining steps are skipped and reported as such, rather than the batch running unbounded. Omit for no budget. Size it for the plan: a large load plus several whole-heap scans wants 600000+.',
        ),
    },
    async ({load, steps, calls, stop_on_error, timeout_ms}) => {
      try {
        // Two names for one parameter must not become two parameters. Taking
        // `steps` and dropping `calls` would run a DIFFERENT plan than the one
        // written, with nothing in the output saying so.
        if (steps != null && calls != null) {
          return errorResult(
            '`steps` and `calls` are the same parameter under two names — pass only one. Both were given, and silently running one of them would execute a plan you did not write.',
          );
        }
        const stepList = steps ?? calls;
        if (stepList == null || stepList.length === 0) {
          return errorResult(
            'pass `steps` (or its alias `calls`): an ordered list of {tool, args} to run.',
          );
        }
        steps = stepList;
        // An empty path is "no load", not a load of "". Applied to BOTH
        // spellings: normalising only the bare string left the object form
        // `{file_path: ''}` to fail deep inside load_snapshot, after the plan
        // had already been built and reported.
        if (typeof load === 'string') {
          load = load === '' ? undefined : {file_path: load};
        } else if (load != null && load.file_path === '') {
          load = undefined;
        }
        const plan: Array<{tool: string; args: Record<string, unknown>}> = [];
        if (load != null) {
          plan.push({
            tool: 'memlab_load_snapshot',
            args: load as Record<string, unknown>,
          });
        }
        for (const s of steps) {
          plan.push({
            tool: s.tool,
            args: (s.args ?? {}) as Record<string, unknown>,
          });
        }

        const unknown = plan
          .map(p => p.tool)
          .filter(name => getRegisteredTool(name) == null);
        if (unknown.length > 0) {
          return errorResult(
            new Error(
              `Unknown tool(s): ${[...new Set(unknown)].join(', ')}. Available: ${listToolNames().join(', ')}`,
            ),
          );
        }

        // Validate EVERY step's arguments before running step 0.
        //
        // Parsing inside the execution loop means a step that is missing a
        // required argument fails only after the load has been paid for — and
        // the load is the expensive part: on a 243 MB snapshot this cost a full
        // parse twice in one session (`weakmap_entries` and `retainer_layers`,
        // both missing `node_id`) before the batch reported anything. The
        // information needed to refuse was available before any work started.
        const planned: Array<{tool: string; parsed: unknown}> = [];
        const argErrors: string[] = [];
        plan.forEach(({tool, args}, i) => {
          const entry = getRegisteredTool(tool);
          if (entry == null) return;
          try {
            // Apply the tool's own zod shape so `.default()` values are
            // materialized exactly as they are for a direct MCP call. Without
            // this a step that omits an optional gets `undefined` and a scan
            // gated on e.g. `min_count` silently returns nothing.
            planned.push({
              tool,
              parsed:
                entry.shape != null
                  ? z.object(entry.shape as never).parse(args)
                  : args,
            });
          } catch (err) {
            const detail =
              err instanceof z.ZodError
                ? err.issues
                    .map(
                      iss =>
                        `${iss.path.join('.') || '(root)'}: ${iss.message}`,
                    )
                    .join('; ')
                : err instanceof Error
                  ? err.message
                  : String(err);
            argErrors.push(`step ${i + 1} \`${tool}\` — ${detail}`);
          }
        });
        if (argErrors.length > 0) {
          return errorResult(
            new Error(
              `${argErrors.length} step(s) have invalid arguments; nothing was run (the snapshot load is the expensive part of a batch, so the whole plan is checked first):\n` +
                argErrors.map(e => `- ${e}`).join('\n'),
            ),
          );
        }

        const results: StepResult[] = [];
        // The budget is checked BETWEEN steps rather than enforced inside one:
        // a whole-heap pass is a single synchronous block that nothing can
        // interrupt, so the honest guarantee is "no NEW step starts past the
        // deadline", and saying that is better than implying a hard cutoff.
        const deadline =
          timeout_ms != null && timeout_ms > 0 ? Date.now() + timeout_ms : null;
        let skippedForBudget = 0;
        for (const {tool, parsed} of planned) {
          const entry = getRegisteredTool(tool);
          if (entry == null) continue;
          if (deadline != null && Date.now() > deadline) {
            skippedForBudget++;
            results.push({
              tool,
              ok: false,
              skipped: true,
              text: `SKIPPED: the batch's ${timeout_ms} ms budget was exhausted before this step started.`,
            });
            continue;
          }
          try {
            const res = await entry.handler(parsed, {});
            const ok = !isErrorResult(res);
            results.push({tool, ok, text: renderToolText(res)});
            if (!ok && stop_on_error) break;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({tool, ok: false, text: `ERROR: ${msg}`});
            if (stop_on_error) break;
          }
        }

        // A budget-skipped step is recorded as a result so it is reported, but
        // it neither ran nor failed — counting it as both is how "4 step(s)
        // run, 4 failed" gets printed for a batch that executed one step.
        const ran = results.filter(r => r.skipped !== true).length;
        const failed = results.filter(r => !r.ok && r.skipped !== true).length;
        const budgetNote =
          skippedForBudget > 0
            ? `\n\n> ⚠ ${skippedForBudget} step(s) never ran: the ${timeout_ms} ms batch budget was exhausted. Raise \`timeout_ms\` or split the plan — a skipped step is not a passing step.`
            : '';
        const header =
          `# Batch: ${ran} of ${plan.length} step(s) run` +
          (failed > 0 ? `, ${failed} failed` : '') +
          (results.length < plan.length
            ? ` (stopped early; ${plan.length - results.length} not run)`
            : '') +
          budgetNote;

        const body = results
          .map(
            (r, i) =>
              `\n---\n\n## Step ${i + 1}/${plan.length}: \`${r.tool}\`${r.skipped === true ? ' — SKIPPED' : r.ok ? '' : ' — FAILED'}\n\n${r.text}`,
          )
          .join('\n');

        return toolResult(`${header}\n${body}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

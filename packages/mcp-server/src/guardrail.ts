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
import {
  beginAnalysisBudget,
  endAnalysisBudget,
  getAnalysisTimeoutMs,
  activeElapsedMs,
  ScanTimeoutError,
} from './analysis-budget.js';
import {toolResult} from './utils.js';

type AnyFn = (...a: unknown[]) => unknown;

/**
 * Install a process-wide wall-clock guardrail around every tool call.
 *
 * Monkey-patches `server.tool` so each registered handler is wrapped: a budget
 * is armed for the call (per-call `timeout_ms` arg > MEMLAB_ANALYSIS_TIMEOUT_MS
 * env > 90s default), the heap-iteration funnels (see heap-state.ts) feed it,
 * and if the budget trips the handler's loop throws a {@link ScanTimeoutError}
 * which we convert into a clean "analysis stopped" result instead of letting a
 * runaway scan wedge / OOM the server.
 *
 * Must be called BEFORE the tools are registered so they register wrapped.
 */
export function installAnalysisGuardrail(server: McpServer): void {
  const origTool = (server.tool as AnyFn).bind(server) as AnyFn;
  (server as unknown as {tool: AnyFn}).tool = (...toolArgs: unknown[]) => {
    const name = String(toolArgs[0]);
    const lastIdx = toolArgs.length - 1;
    const handler = toolArgs[lastIdx];
    if (typeof handler === 'function') {
      const inner = handler as AnyFn;
      toolArgs[lastIdx] = async (...hArgs: unknown[]) => {
        // The SDK calls handler(args, extra) for schema tools, handler(extra)
        // otherwise. Read an optional per-call timeout_ms off the params.
        const params = hArgs[0];
        const override =
          params && typeof params === 'object' && 'timeout_ms' in params
            ? (params as {timeout_ms?: unknown}).timeout_ms
            : undefined;
        const timeoutMs = getAnalysisTimeoutMs(
          typeof override === 'number' ? override : undefined,
        );
        beginAnalysisBudget(timeoutMs);
        try {
          return await inner(...hArgs);
        } catch (e) {
          if (e instanceof ScanTimeoutError) {
            const ran = Math.round(activeElapsedMs() / 1000);
            const limit = Math.round(timeoutMs / 1000);
            return toolResult(
              `⚠ Analysis stopped: \`${name}\` exceeded the ${limit}s guardrail (ran ~${ran}s) and was halted to keep the MCP server responsive. No complete result was produced.\n\n` +
                `This usually means the heap is very large. Options:\n` +
                `- Narrow the query with filters (min_count / min_self_size / min_retained_size / a specific name or type).\n` +
                `- For memlab_class_histogram, pass include_retained_size:false for an instant count + self-size histogram.\n` +
                `- Prefer targeted node-id tools (memlab_object_shape, memlab_trace_dominators, memlab_retainer_trace) or memlab_auto_investigate over whole-heap scans.\n` +
                `- Raise the limit for this call where supported (timeout_ms) or globally via the MEMLAB_ANALYSIS_TIMEOUT_MS env var (current default ${limit}s; set 0 to disable).`,
            );
          }
          throw e;
        } finally {
          endAnalysisBudget();
        }
      };
    }
    return origTool(...toolArgs);
  };
}

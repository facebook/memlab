/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Name -> handler index of every registered tool, so one tool can dispatch to
 * another in-process (see `memlab_batch`).
 *
 * Populated from the same `server.tool` monkey-patch the wall-clock guardrail
 * installs, which is the one place every registration already funnels through —
 * so no call site has to opt in and the index cannot drift from the real tool
 * list.
 *
 * The RAW (pre-guardrail) handler is stored on purpose. The wrapped handler arms
 * an analysis budget per call, and a batch is itself running inside one; nesting
 * `beginAnalysisBudget` would let an inner step's `endAnalysisBudget` retire the
 * outer batch's budget early. Storing the raw handler keeps exactly one budget
 * per MCP call — the batch's own, which callers can size with `timeout_ms`.
 */

type RawToolHandler = (...args: unknown[]) => unknown;

/**
 * The raw handler expects arguments the SDK has ALREADY validated against the
 * tool's zod shape, which is where `.default()` values are materialized. A
 * caller that invokes the raw handler with a plain object therefore gets
 * `undefined` for every omitted optional — and an omitted `min_count` silently
 * turns a scan into "no results found" rather than an error. So the shape is
 * stored next to the handler and re-applied by the dispatcher.
 */
export interface RegisteredTool {
  handler: RawToolHandler;
  shape: Record<string, unknown> | null;
}

const tools = new Map<string, RegisteredTool>();

export function recordToolHandler(
  name: string,
  handler: RawToolHandler,
  shape: Record<string, unknown> | null,
): void {
  tools.set(name, {handler, shape});
}

export function getRegisteredTool(name: string): RegisteredTool | undefined {
  return tools.get(name);
}

export function listToolNames(): string[] {
  return [...tools.keys()].sort();
}

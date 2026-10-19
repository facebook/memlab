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
 * Opt-in toolsets: expose a subset of the ~150 tools.
 *
 * Every registered tool costs schema tokens in every session, and most
 * investigations use a few dozen. `MEMLAB_TOOLSETS=core,growth` exposes only
 * those groups (plus the session essentials); `memlab_tools({enable})` turns
 * more on mid-session, and the client is told the tool list changed. Unset,
 * every tool is exposed as before.
 */

import {runsCode} from './tool-annotations.js';

interface SdkTool {
  enabled: boolean;
  enable(): void;
  disable(): void;
}

/** Always exposed: without them a session cannot start or recover. */
const ALWAYS = new Set([
  'memlab_tools',
  'memlab_load_snapshot',
  'memlab_snapshots',
  'memlab_server_status',
  'memlab_snapshot_header',
  'memlab_job_status',
]);

/** The everyday investigation set. */
export const CORE_TOOLS = new Set([
  'memlab_snapshot_summary',
  'memlab_app_heap',
  'memlab_quick_diagnosis',
  'memlab_auto_investigate',
  'memlab_class_histogram',
  'memlab_largest_objects',
  'memlab_query_objects',
  'memlab_get_node',
  'memlab_get_references',
  'memlab_get_referrers',
  'memlab_retainer_trace',
  'memlab_retainer_layers',
  'memlab_dominator_chain',
  'memlab_detached_dom',
  'memlab_diff_snapshots',
  'memlab_sequence_analysis',
  'memlab_closure_inspection',
  'memlab_duplicated_strings',
  'memlab_eval',
]);

function parseSelection(raw: string | undefined): Set<string> | null {
  if (raw == null || raw.trim() === '' || raw.trim() === 'all') return null;
  return new Set(
    raw
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

let selected = parseSelection(process.env.MEMLAB_TOOLSETS);

/**
 * `MEMLAB_DISABLE_CODE_TOOLS=1` turns off every tool that runs caller-supplied
 * JavaScript, for good: `memlab_tools({enable})` cannot bring them back. They
 * run with the server's privileges, and snapshot contents can steer a model
 * into calling them; the structured query tools cover most of what they are
 * used for.
 */
const codeToolsDisabled = /^(1|true|yes)$/i.test(
  process.env.MEMLAB_DISABLE_CODE_TOOLS ?? '',
);

export function codeToolsAreDisabled(): boolean {
  return codeToolsDisabled;
}
const sdkTools = new Map<
  string,
  {tool: SdkTool; toolsets: string[]; params: string[]}
>();

/** The selected toolset keys, or null when every tool is exposed. */
export function selectedToolsets(): string[] | null {
  return selected == null ? null : [...selected].sort();
}

function wanted(
  name: string,
  toolsets: string[],
  params: string[] = [],
): boolean {
  if (codeToolsDisabled && runsCode(name, params)) return false;
  if (selected == null || ALWAYS.has(name)) return true;
  if (selected.has('core') && CORE_TOOLS.has(name)) return true;
  return toolsets.some(t => selected?.has(t));
}

/** Remember a registered tool, and hide it if its toolsets are not selected. */
export function trackSdkTool(
  name: string,
  tool: unknown,
  toolsets: string[],
  params: string[] = [],
): void {
  const t = tool as SdkTool | undefined;
  if (t == null || typeof t.disable !== 'function') return;
  sdkTools.set(name, {tool: t, toolsets, params});
  if (!wanted(name, toolsets, params)) t.disable();
}

/** Tool names currently hidden. */
export function hiddenTools(): string[] {
  return [...sdkTools.entries()]
    .filter(([, e]) => !e.tool.enabled)
    .map(([n]) => n)
    .sort();
}

/**
 * Expose more toolsets ("all" exposes everything). Returns the tools that
 * became available; the SDK notifies the client that the list changed.
 */
export function enableToolsets(keys: string[]): string[] {
  const asked = keys.map(k => k.trim().toLowerCase()).filter(Boolean);
  if (asked.includes('all')) {
    selected = null;
  } else if (selected != null) {
    // With every tool already exposed (`selected` null) there is nothing to
    // add, and recording the group would misreport what is exposed.
    for (const k of asked) selected.add(k);
  }
  const toEnable = [...sdkTools.entries()].filter(
    ([name, e]) => !e.tool.enabled && wanted(name, e.toolsets, e.params),
  );
  // `enable()` notifies the client each time; flip the flag directly for all
  // but the last, whose `enable()` then sends one notification for the batch.
  toEnable.forEach(([, e], i) => {
    if (i < toEnable.length - 1) e.tool.enabled = true;
    else e.tool.enable();
  });
  return toEnable.map(([name]) => name).sort();
}

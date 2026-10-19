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
 * MCP tool annotations for every tool, from one table.
 *
 * Clients use them to decide what is safe to run without asking: a tool
 * marked read-only can be auto-approved, and one that runs caller-supplied
 * code or deletes files never should be. Almost every tool only reads the
 * loaded snapshot, so read-only is the default and this table lists the
 * exceptions. It mirrors "Tool Safety and Auto-Approval" in the README.
 */

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

// Run JavaScript the caller supplies (or a round directory provides) with the
// server's full privileges, so they can do anything the process can.
const RUNS_CODE = new Set([
  'memlab_eval',
  'memlab_eval_across',
  'memlab_for_each',
  'memlab_hypothesis',
  'memlab_ladder_probe',
  'memlab_replicate',
  'memlab_judges',
  'memlab_calibrate_judges',
  'memlab_switch_matrix',
  'memlab_ab_compare',
  'memlab_analysis_battery',
  'memlab_batch',
  'memlab_start_job',
]);

// Parameters that carry code to run. A tool taking one runs code even when it
// is missing from RUNS_CODE, so a new tool cannot default to read-only.
const CODE_PARAMS = new Set([
  'code',
  'prelude',
  'predicate',
  'predicates',
  'invariants',
  'invariants_file',
]);

function takesCode(params: readonly string[]): boolean {
  return params.some(p => CODE_PARAMS.has(p) || p.endsWith('_code'));
}

// Change files outside the heap. `destructive` deletes or overwrites data;
// `idempotent` means repeating the call with the same input changes nothing
// more (a capture is new every time).
const WRITES: Record<
  string,
  {destructive: boolean; idempotent: boolean; openWorld: boolean}
> = {
  memlab_capture: {destructive: false, idempotent: false, openWorld: true},
  memlab_prune_run: {destructive: true, idempotent: false, openWorld: false},
  memlab_anonymize_snapshot: {
    destructive: false,
    idempotent: true,
    openWorld: false,
  },
  memlab_finding_index: {
    destructive: false,
    idempotent: false,
    openWorld: false,
  },
  memlab_metric: {destructive: false, idempotent: true, openWorld: false},
  memlab_ladder: {destructive: false, idempotent: true, openWorld: false},
};

// Read-only, but may fetch a snapshot from remote storage.
const FETCHES = new Set(['memlab_load_snapshot', 'memlab_snapshot_header']);

const WORDS: Record<string, string> = {
  ab: 'A/B',
  cdp: 'CDP',
  dom: 'DOM',
  id: 'ID',
  urls: 'URLs',
};

/** "memlab_class_histogram" → "Class histogram". */
export function toolTitle(name: string): string {
  const words = name
    .replace(/^memlab_/, '')
    .split('_')
    .map(w => WORDS[w] ?? w);
  const first = words[0] ?? '';
  words[0] =
    WORDS[first] != null
      ? first
      : first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(' ');
}

export function toolAnnotations(
  name: string,
  params: readonly string[] = [],
): ToolAnnotations {
  const title = toolTitle(name);
  if (RUNS_CODE.has(name) || takesCode(params)) {
    return {
      title,
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    };
  }
  const writes = WRITES[name];
  if (writes != null) {
    return {
      title,
      readOnlyHint: false,
      destructiveHint: writes.destructive,
      idempotentHint: writes.idempotent,
      openWorldHint: writes.openWorld,
    };
  }
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: FETCHES.has(name),
  };
}

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
 * Is this collection reachable in PRODUCTION, or only because devtools are
 * attached?
 *
 * `memlab_dev_artifacts` answers a narrower question: what is retained SOLELY
 * through a dev ROOT — a DevTools console global handle, a Fast Refresh
 * registry, the automation bridge. That misses the case where dev-only code is
 * loaded as an ordinary module and holds ordinary references.
 *
 * Measured: the largest collection in a WhatsApp Web capture was a 12.7 MB,
 * 1,771-entry, 98.8%-occupancy non-weak Map that `memlab_cache_analysis`
 * ranked first and `dev_artifacts` did not flag at all. It is
 * `traceVisualCompletionMetrics`, declared in
 * `BrowserToolsInteractionTracingInterop` and reachable only through
 * `CometDevToolsInteractionTracingInteropModules` — devtools-only, absent from
 * production. A session came one step from writing a production fix for it, and
 * only caught it by grepping the owning file by hand.
 *
 * The signal is the MODULE the retainer path runs through. Every Haste/CommonJS
 * app in these captures reaches its module instances through a registry keyed by
 * module name (`requireDynamic.context -> modulesMap -> <ModuleName>`), so the
 * name is on the path and can be matched.
 */

import type {IHeapEdge, IHeapNode} from '@memlab/core';

/**
 * Module names that exist only in a dev or instrumented build.
 *
 * Conservative on purpose: a false "dev-only" would tell someone to ignore a
 * real production leak, which is far worse than an unflagged dev artifact. Each
 * pattern below names a component that is either devtools plumbing or a build
 * shim, never product code.
 */
const DEV_MODULE_PATTERNS: ReadonlyArray<{re: RegExp; why: string}> = [
  {re: /^BrowserTools/, why: 'browser-tools devtools interop'},
  {re: /BrowserToolsInterop/, why: 'browser-tools devtools interop'},
  {re: /^CometDevTools/, why: 'Comet DevTools'},
  {re: /DevToolsInterop/, why: 'devtools interop'},
  {re: /^ReactDevTools|react-devtools/i, why: 'React DevTools'},
  {
    re: /\$RefreshSig\$|\$RefreshReg\$|RefreshRuntime/,
    why: 'React Fast Refresh',
  },
  {re: /^__REACT_DEVTOOLS/, why: 'React DevTools hook'},
  {re: /HeroTracingDebugTracing/, why: 'debug-only tracing'},
  {re: /^MemLab|memlab-/i, why: 'the measurement harness itself'},
  {re: /webdriver|puppeteer|playwright/i, why: 'automation harness'},
];

/**
 * Modules that ARE production code but only RUN behind a flag that is off for
 * approximately all production traffic.
 *
 * This is a third state, not a shade of the two above, and the distinction is
 * load-bearing in both directions. Calling these "dev-only" would be wrong —
 * they ship, they are product code, and a ramp makes them live for real users,
 * so a leak in one is worth fixing. Calling them "production" is what actually
 * went wrong: a round attributed **+316 MB of app_delta** to a leak that no
 * production user could experience.
 *
 * They are invisible to every artifact check available. `memlab_dev_artifacts`
 * reports what is retained through a dev ROOT; these hold ordinary references
 * from ordinary app objects. `memlab_artifact_budget` buckets them as `App`,
 * correctly by its own definition. The code is dev-ENABLED but app-RETAINED,
 * and nothing else separates those.
 *
 * Measured (Comet, 2026-09-06): `RedblockInst.#passes`, a `Map<Element, …>` in
 * the accessibility auditor, dominated **318,852 detached nodes / 116.4 MB
 * after 400 interactions**, growing +7.000 detached canvases per cycle at
 * r² = 1.0000. Its gate `comet_redblock` passes for **0.0000%** of production
 * traffic (7-day window, ~1,574 checks/sec); on a dev build it runs because
 * `__DEV__` is true. Everything about the measurement was right except who it
 * applied to.
 *
 * Conservative on purpose, same as above: each entry is an auditor, overlay or
 * debug console that a product does not need in order to function.
 */
const GATED_MODULE_PATTERNS: ReadonlyArray<{re: RegExp; why: string}> = [
  {
    re: /^Redblock|RedblockInst|^CometRedblock/,
    why: 'Redblock a11y auditor, gated on `comet_redblock` (~0% of production)',
  },
  {re: /AccessibilityAudit|A11yAudit/i, why: 'accessibility auditing overlay'},
  {re: /^CometConsole|DebugConsole/, why: 'in-page debug console'},
  {re: /DebugOverlay|^DebugRenderer/, why: 'debug overlay'},
];

export interface ModuleProvenance {
  /** The nearest module name on the retainer path, when one was found. */
  module: string | null;
  /**
   * `no` when the owning module is dev-only, `gated` when it is production
   * code that only runs behind a flag which is off for approximately all
   * production traffic, `yes` when it is ordinary app code.
   */
  prodReachable: 'yes' | 'no' | 'gated' | 'unknown';
  /** Human-readable reason, present unless `prodReachable === 'yes'`. */
  why?: string;
}

/** Does this module name belong to a dev-only or flag-gated component? */
export function classifyModuleName(name: string): {
  dev: boolean;
  gated?: boolean;
  why?: string;
} {
  for (const {re, why} of DEV_MODULE_PATTERNS) {
    if (re.test(name)) return {dev: true, why};
  }
  for (const {re, why} of GATED_MODULE_PATTERNS) {
    if (re.test(name)) return {dev: false, gated: true, why};
  }
  return {dev: false};
}

/**
 * What a module identifier looks like as an edge name: a CamelCase-ish token,
 * which is what a Haste module registry key is. Filters out ordinary property
 * names so the walk does not classify `timeout` or `data` as a module.
 */
const MODULE_NAME_SHAPE = /^[A-Z][A-Za-z0-9_$]{3,}$/;

/**
 * Walk up from a node toward the GC root and name the nearest module it is
 * reached through.
 *
 * Bounded: a retainer walk here is a diagnostic garnish on tools that already
 * did the expensive work, so it must never become the expensive part. `maxHops`
 * stops the walk well before it can matter, and an unresolved walk returns
 * `unknown` rather than guessing.
 */
export function moduleProvenanceOf(
  node: IHeapNode | null,
  maxHops = 12,
): ModuleProvenance {
  if (!node) return {module: null, prodReachable: 'unknown'};

  let current: IHeapNode | null = node;
  for (let hop = 0; hop < maxHops && current != null; hop++) {
    // The class name carries the signal directly for a `$RefreshSig$` closure
    // or a `BrowserTools*` instance.
    const byName = classifyModuleName(current.name ?? '');
    if (byName.dev) {
      return {module: current.name, prodReachable: 'no', why: byName.why};
    }
    if (byName.gated === true) {
      return {module: current.name, prodReachable: 'gated', why: byName.why};
    }

    // `pathEdge` is the edge that reached this node on its shortest path from a
    // GC root. In a Haste/CommonJS app the module registry hop looks like
    // `modulesMap -> <ModuleName>`, so the edge NAME is the module identifier.
    const edge: IHeapEdge | null = current.pathEdge ?? null;
    if (edge == null) break;
    const edgeName =
      typeof edge.name_or_index === 'string' ? edge.name_or_index : '';
    if (edgeName !== '' && MODULE_NAME_SHAPE.test(edgeName)) {
      const byEdge = classifyModuleName(edgeName);
      if (byEdge.dev) {
        return {module: edgeName, prodReachable: 'no', why: byEdge.why};
      }
      if (byEdge.gated === true) {
        return {module: edgeName, prodReachable: 'gated', why: byEdge.why};
      }
    }
    current = edge.fromNode ?? null;
  }
  return {module: null, prodReachable: 'unknown'};
}

/** A short cell for a report table. */
export function provenanceCell(p: ModuleProvenance): string {
  if (p.prodReachable === 'no') {
    return `⚠️ dev-only (${p.why ?? p.module ?? 'dev module'})`;
  }
  if (p.prodReachable === 'gated') {
    return `⚠️ flag-gated (${p.why ?? p.module ?? 'gated module'})`;
  }
  return '';
}

/** The footnote a report needs when it flagged at least one dev-only row. */
export const DEV_ONLY_FOOTNOTE =
  '_A row marked **dev-only** is reached through a devtools or build-shim module and does ' +
  'NOT exist in a production build — do not write a product fix for it. This is a different ' +
  'check from `memlab_dev_artifacts`, which only catches memory retained through a dev ROOT ' +
  '(console handles, Fast Refresh registries); a dev-only module holding ordinary references ' +
  'passes that check. Measured: a 12.7 MB non-weak Map that ranked first here was ' +
  '`traceVisualCompletionMetrics`, loaded only by Comet DevTools._';

/** The footnote a report needs when it flagged at least one flag-gated row. */
export const GATED_FOOTNOTE =
  '_A row marked **flag-gated** IS production code, but it only runs behind a flag that is off ' +
  'for approximately all production traffic — so the leak is real and worth fixing, and the bytes ' +
  "are NOT what a production user carries. Check the gate's actual pass rate before quoting the " +
  'number as production impact, and before treating it as a dev artifact either. Neither ' +
  '`memlab_dev_artifacts` nor `memlab_artifact_budget` can see this: the memory is held by an ' +
  'ordinary app-side reference, so it is bucketed as `App`. Measured: a Redblock `Map<Element, …>` ' +
  'dominating 318,852 detached nodes / 116.4 MB after 400 interactions, behind a gate passing ' +
  '0.0000% of production._';

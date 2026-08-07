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
 * Registry of heap classes whose growth is a MEASUREMENT artifact rather than an
 * application leak.
 *
 * Motivation: across a six-round leak hunt, every single class reported at the
 * top of `sequence_analysis` as "↑ every step (LEAK signal)" belonged to one of
 * the families below — CDP inspector bookkeeping, V8 JIT warmup, or captured
 * error stacks. None was ever a leak. An agent that does not already know this
 * list reads the label and reports a false leak, which is exactly what happened
 * repeatedly before the families were catalogued.
 *
 * These are deliberately matched on CLASS NAME only. Name matching cannot prove
 * that a given instance is an artifact, so the classification is used to
 * annotate and down-rank rows — never to hide them outright (callers can always
 * pass `include_artifacts: true`). Anything that is genuinely ambiguous is left
 * unclassified on purpose: a false "this is an artifact" is far more damaging
 * than a false "this might be a leak".
 */

export type ArtifactKind =
  | 'warmup'
  | 'ax'
  | 'cdp-network'
  | 'cdp-perf'
  | 'cdp-console'
  | 'stack-capture';

/**
 * V8 internal structures emitted while JIT-compiling and warming up code paths.
 * Exercising NEW interactions during a hunt compiles new functions, so this
 * whole family climbs "every step" without being an app leak.
 *
 * Note what is deliberately NOT here: `PropertyArray`, `DescriptorArray`,
 * `(object elements)`, `(object properties)`, `Context`. Those grow with real
 * application objects and suppressing them would hide genuine leaks.
 */
const WARMUP_CLASS_NAMES: ReadonlySet<string> = new Set([
  'InstructionStream',
  'Code',
  'CodeDataContainer',
  'CodeWrapper',
  'BytecodeArray',
  'BytecodeWrapper',
  'FeedbackVector',
  'FeedbackMetadata',
  'FeedbackCell',
  'ClosureFeedbackCellArray',
  'ScopeInfo',
  'SharedFunctionInfo',
  'SharedFunctionInfoWrapper',
  'UncompiledDataWithoutPreparseData',
  'UncompiledDataWithPreparseData',
  'InterpreterData',
  'TrustedByteArray',
  'ProtectedFixedArray',
  'TrustedWeakFixedArray',
  'WeakArrayList',
  'LoadHandler',
  'StoreHandler',
  'AllocationSite',
  'ConstantPool',
  '(constant pool)',
  'ObjectBoilerplateDescription',
]);

/**
 * Blink accessibility caches, materialized by CDP-driven automation.
 */
const AX_NAME_RE =
  /AXObjectCache|AXNodeObject|AXDirtyObject|AXComputedObject|blink::AX/;

/**
 * The attached inspector's network log. Every request the page makes while CDP
 * is attached is retained by `blink::InspectorNetworkAgent` for the lifetime of
 * the session, so on a dev build that polls (hot reload, long-poll transports)
 * this climbs forever. Retained by the DevToolsSession, not by the app.
 */
const CDP_NETWORK_NAME_RE =
  /NetworkResourcesData|XHRReplayData|InspectorNetworkAgent|PerformanceResourceTiming|^URI$/;

/**
 * The inspector's performance timeline. Long-task/layout-shift/script-timing
 * entries accumulate only because something is observing them.
 */
const CDP_PERF_NAME_RE =
  /PerformanceLongTaskTiming|PerformanceLongAnimationFrameTiming|PerformanceScriptTiming|TaskAttributionTiming|ScriptTimingInfo|^LayoutShift$|LayoutShiftAttribution/;

/**
 * Console message storage held by the inspector. Distinct from
 * `dev_artifacts`' console detection, which works on retainer edges: this
 * catches the native message objects by class name.
 */
const CDP_CONSOLE_NAME_RE = /ConsoleMessage/;

/**
 * Captured error stacks. `StackFrameInfo` / `ErrorStackData` balloon when
 * something constructs `Error`s at high frequency — most often React's DEV-only
 * `_debugStack` owner stacks (see the `reactDebugStack` detector in
 * `dev-artifacts`), or dev-build logging that captures a stack per record.
 *
 * Flagged as `stack-capture` rather than asserted dev-only: a production build
 * can legitimately grow these, so the annotation points at the likely cause
 * instead of dismissing the row.
 */
const STACK_CAPTURE_NAME_RE = /StackFrameInfo|ErrorStackData/;

const KIND_LABEL: Record<ArtifactKind, string> = {
  warmup: '⚙ JIT/compile warmup (not a leak)',
  ax: '♿ a11y/CDP cache (automation artifact)',
  'cdp-network': '🔌 CDP network-inspector retention (artifact)',
  'cdp-perf': '🔌 CDP performance-timeline retention (artifact)',
  'cdp-console': '🔌 CDP console retention (artifact)',
  'stack-capture': '🧵 captured Error stacks (often React DEV _debugStack)',
};

const KIND_NOTE: Record<ArtifactKind, string> = {
  warmup:
    '⚙️ V8 **compilation-warmup** structures (`Code`, `BytecodeArray`, `FeedbackVector`, `ScopeInfo`, `InstructionStream`, …) are growing. Exercising new code paths during a hunt JIT-compiles them, so they climb every step without being an app leak.',
  ax: '♿ Blink **accessibility caches** (`AXObjectCacheImpl` / `AXNodeObject` / `AXDirtyObject`) are growing. These are inflated by CDP-driven automation building the a11y tree, and they co-retain detached DOM, so retainer traces can route through them and mislead.',
  'cdp-network':
    '🔌 The attached inspector is retaining the **network log** (`blink::NetworkResourcesData` / `XHRReplayData` / `PerformanceResourceTiming`). Every request made while CDP is attached is held by `blink::DevToolsSession → InspectorNetworkAgent` for the session, so a dev build that polls (hot reload, long-poll transports) grows this forever. Not app memory.',
  'cdp-perf':
    '🔌 The attached inspector is retaining the **performance timeline** (long-task / layout-shift / script-timing entries). These accumulate because something is observing them, not because the app leaks.',
  'cdp-console':
    '🔌 The attached inspector is retaining **console messages**. Cross-check with `memlab_dev_artifacts`, which also detects console retention by retainer edge.',
  'stack-capture':
    '🧵 **Captured Error stacks** (`StackFrameInfo` / `ErrorStackData`) are growing. The usual cause is React DEV `_debugStack` owner stacks or dev-build logging that captures a stack per record — both dev-build-only. `memlab_dev_artifacts` reports the `React DEV owner stack` category when that is the source.',
};

export function artifactLabel(kind: ArtifactKind): string {
  return KIND_LABEL[kind];
}

export function artifactNote(kind: ArtifactKind): string {
  return KIND_NOTE[kind];
}

/**
 * Classify a class NAME as a known measurement artifact, or null when it is a
 * genuine leak candidate.
 */
export function classifyArtifact(name: string): ArtifactKind | null {
  const bare = name.replace(/^system \/ /, '');
  if (WARMUP_CLASS_NAMES.has(bare)) return 'warmup';
  if (AX_NAME_RE.test(name)) return 'ax';
  if (CDP_NETWORK_NAME_RE.test(bare)) return 'cdp-network';
  if (CDP_PERF_NAME_RE.test(bare)) return 'cdp-perf';
  if (CDP_CONSOLE_NAME_RE.test(bare)) return 'cdp-console';
  if (STACK_CAPTURE_NAME_RE.test(bare)) return 'stack-capture';
  return null;
}

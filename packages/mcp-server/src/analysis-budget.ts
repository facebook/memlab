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
 * Wall-clock guardrail for heap analysis.
 *
 * Node.js is single-threaded, so a timer cannot interrupt a synchronous
 * full-heap loop mid-iteration — the guardrail has to be COOPERATIVE: hot loops
 * call `tick()` (cheap, clock checked only every few thousand iterations) and a
 * {@link ScanTimeoutError} is thrown once the budget is exceeded. The per-call
 * wrapper (see guardrail.ts) arms a process-global "active" budget around every
 * tool invocation, and the shared `snapshot.nodes`/`edges.forEach` funnels feed
 * it via {@link tickAnalysis}, so any tool that does a full-heap scan is bounded
 * without per-tool wiring.
 *
 * This module imports nothing so it can be shared by utils, heap-state and the
 * guardrail wrapper without creating an import cycle.
 */

/**
 * Thrown by a budget when a heap walk exceeds its wall-clock limit. Callers
 * either catch it locally to return partial results, or let it bubble to the
 * per-call guardrail which turns it into a clean "analysis stopped" result.
 */
export class ScanTimeoutError extends Error {
  constructor(
    public iterations: number,
    public timeoutMs: number,
  ) {
    super(`Scan exceeded its ${timeoutMs}ms budget after ~${iterations} nodes`);
    this.name = 'ScanTimeoutError';
  }
}

/**
 * Wall-clock budget. Call `tick()` once per iteration; it cheaply checks
 * elapsed time every few thousand iterations and throws {@link ScanTimeoutError}
 * when the budget is exceeded.
 */
export function makeScanBudget(timeoutMs: number): {tick: () => void} {
  const start = Date.now();
  let i = 0;
  return {
    tick() {
      i++;
      if ((i & 0x3fff) === 0 && Date.now() - start > timeoutMs) {
        throw new ScanTimeoutError(i, timeoutMs);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Process-global "active" budget for the current tool call.
// ---------------------------------------------------------------------------

const DEFAULT_ANALYSIS_TIMEOUT_MS = 90_000;

let activeBudget: {tick: () => void} | null = null;
let activeStart = 0;
let activeTimeoutMs = 0;

/**
 * Resolve the analysis timeout in ms: an explicit per-call override wins, then
 * the MEMLAB_ANALYSIS_TIMEOUT_MS env var, then the 90s default. A value <= 0
 * disables the guardrail (returns 0 → never trips).
 */
export function getAnalysisTimeoutMs(override?: number | null): number {
  if (override != null && Number.isFinite(override)) {
    return override > 0 ? override : 0;
  }
  const env = Number(process.env.MEMLAB_ANALYSIS_TIMEOUT_MS);
  if (Number.isFinite(env)) {
    return env > 0 ? env : 0;
  }
  return DEFAULT_ANALYSIS_TIMEOUT_MS;
}

/** Arm the global budget for one tool call. `timeoutMs <= 0` disables it. */
export function beginAnalysisBudget(timeoutMs: number): void {
  activeStart = Date.now();
  activeTimeoutMs = timeoutMs;
  activeBudget = timeoutMs > 0 ? makeScanBudget(timeoutMs) : null;
}

/** Disarm the global budget at the end of a tool call. */
export function endAnalysisBudget(): void {
  activeBudget = null;
  activeTimeoutMs = 0;
}

/**
 * Cooperative checkpoint for high-iteration loops (e.g. full-heap scans). Cheap
 * no-op when no budget is armed; the clock is only sampled every few thousand
 * calls, so this is meant for loops that run millions of times. For loops with
 * few iterations but expensive bodies (e.g. per-class dominator aggregation),
 * use {@link checkAnalysisDeadline} instead.
 */
export function tickAnalysis(): void {
  activeBudget?.tick();
}

/**
 * Unconditional deadline check (samples the clock every call). Use in loops
 * with a small iteration count but an expensive body, where the sampled
 * {@link tickAnalysis} would not check often enough to be effective.
 */
export function checkAnalysisDeadline(): void {
  if (activeTimeoutMs > 0 && Date.now() - activeStart > activeTimeoutMs) {
    throw new ScanTimeoutError(-1, activeTimeoutMs);
  }
}

/** Wall-clock ms elapsed in the current tool call (0 if none armed). */
export function activeElapsedMs(): number {
  return activeStart ? Date.now() - activeStart : 0;
}

/** The timeout the active budget was armed with (0 if disabled/none). */
export function activeTimeoutMs_(): number {
  return activeTimeoutMs;
}

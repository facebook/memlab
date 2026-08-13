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
 * Phase-level progress reporting for long, single-call operations.
 *
 * Why this exists: loading a large snapshot emits NOTHING for its whole
 * duration, so a caller cannot distinguish "working" from "hung" and starts
 * killing sessions that were about to succeed. MCP already has a progress
 * channel; the server simply never used it.
 *
 * Two deliveries, because neither alone covers the callers:
 *  - `notifications/progress` when the client supplied a `progressToken` (an
 *    MCP host that renders progress);
 *  - a stderr line, always, since the plugin's `start.sh` and the fallback CLI
 *    both surface stderr and neither speaks the progress channel.
 *
 * IMPORTANT — what this cannot do: memlab's parse and dominator passes are
 * synchronous blocks that never yield to the event loop, so no update can be
 * emitted *during* a phase. Progress is therefore reported at phase BOUNDARIES,
 * and a phase that is about to block says so. That is still the information the
 * caller needs ("it is in the dominator pass, which is expected to be silent"),
 * but it is not a live percentage and must not be presented as one.
 */

interface ProgressCapableExtra {
  _meta?: {progressToken?: string | number};
  sendNotification?: (notification: {
    method: 'notifications/progress';
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

export interface ProgressReporter {
  /**
   * Report entry into a phase. `step` is 1-based and `total` is the expected
   * number of phases, so a host can render a determinate bar.
   */
  phase(step: number, total: number, message: string): void;
}

const NOOP: ProgressReporter = {
  phase: () => {
    // No progress channel and no stderr labelling to do for a caller that
    // supplied no `extra` (in-process dispatch); reporting is simply off.
  },
};

/**
 * Build a reporter from a tool handler's `extra` argument.
 *
 * Tolerates a missing or empty `extra`: tools dispatched in-process by
 * `memlab_batch` are called with `{}`, and a reporter that threw there would
 * turn a progress nicety into a batch-wide failure.
 */
export function makeProgressReporter(
  extra: unknown,
  label: string,
): ProgressReporter {
  if (extra == null || typeof extra !== 'object') return NOOP;
  const e = extra as ProgressCapableExtra;
  const token = e._meta?.progressToken;
  const send =
    typeof e.sendNotification === 'function' ? e.sendNotification : null;

  return {
    phase(step: number, total: number, message: string): void {
      process.stderr.write(`[${label} ${step}/${total}] ${message}\n`);
      if (send == null || token == null) return;
      // Fire-and-forget: a client that cannot accept the notification must not
      // fail the operation the notification is about.
      void send({
        method: 'notifications/progress',
        params: {progressToken: token, progress: step, total, message},
      }).catch(() => {
        // Swallowed on purpose: a client that rejects the notification must not
        // fail the operation the notification is merely describing.
      });
    },
  };
}

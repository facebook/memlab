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
 * A one-word shape for a per-rung series, so a ladder table says what kind of
 * growth each row is instead of only how much.
 *
 * The decisive data in several rounds was exactly this distinction: a detached
 * population that jumped 1,045 -> 4,483 at the first rung and then grew +596
 * per rung is a one-time mount plus a per-cycle leak, while the same end-to-end
 * delta spread evenly is a leak from the start, and one that falls back at the
 * end is backlog. A first-to-last delta reads all three the same.
 */

import {linearFit} from './tools/ladder-probe.js';

export type LadderShape =
  | 'FLAT'
  | 'DRAINS'
  | 'STEP'
  | 'STEP+LINEAR'
  | 'LINEAR'
  | 'SATURATING'
  | 'ONSET'
  | 'NOISY';

export function ladderShape(
  values: Array<number | null>,
  axis?: number[] | null,
): LadderShape {
  const pts = values
    .map((v, i) => ({x: axis?.[i] ?? i, y: v}))
    .filter((p): p is {x: number; y: number} => p.y != null);
  if (pts.length < 3) return 'NOISY';
  const ys = pts.map(p => p.y);
  const first = ys[0];
  const last = ys[ys.length - 1];
  const peak = Math.max(...ys);
  const scale = Math.max(Math.abs(first), Math.abs(peak), 1);
  if (peak - Math.min(...ys) < 0.05 * scale) return 'FLAT';
  // Ending below the first rung is a drain too, even when the first rung was
  // the peak. Otherwise it must give back at least half its rise: a series
  // that grew hard and dipped at the last rung still retains most of it, and
  // calling that backlog would clear a leak.
  if (last < first || (peak > first && last < peak - 0.5 * (peak - first))) {
    return 'DRAINS';
  }
  if (last === first) return 'FLAT';
  const post = linearFit(
    pts.slice(1).map(p => p.x),
    ys.slice(1),
  );
  const postRise = ys[ys.length - 1] - ys[1];
  const step = ys[1] - ys[0];
  // Rates over the x axis, not over point indices: an unreadable interior
  // rung is dropped from `pts`, and counting indices would then shrink the
  // span the later rise is spread over.
  const stepRate = step / Math.max(pts[1].x - pts[0].x, 1e-9);
  const rateAfter = postRise / Math.max(pts[pts.length - 1].x - pts[1].x, 1e-9);
  // A step is a claim about the jump from the FIRST rung to the second; with
  // either unreadable, ys[0] -> ys[1] spans other rungs and is not the mount.
  const firstTwoRead = values[0] != null && values[1] != null;
  if (
    firstTwoRead &&
    stepRate > 3 * Math.max(rateAfter, 0) &&
    step > 0.3 * (last - first)
  ) {
    return postRise > 0.1 * (last - first) && post.r2 >= 0.9
      ? 'STEP+LINEAR'
      : 'STEP';
  }
  const all = linearFit(
    pts.map(p => p.x),
    ys,
  );
  if (all.r2 >= 0.9) return 'LINEAR';
  // Still rising, but the later rungs add far less than the earlier ones: a
  // working set filling toward a bound, which needs a longer ladder (and
  // memlab_rate_model) before it can be called either way.
  const monotonic = ys.every((y, i) => i === 0 || y >= ys[i - 1]);
  // Halves split on the axis, and compared as rates, so a dropped interior
  // rung does not move the midpoint off the middle of the ladder.
  const xMid = (pts[0].x + pts[pts.length - 1].x) / 2;
  let mid = 1;
  for (let i = 2; i < pts.length - 1; i++) {
    if (Math.abs(pts[i].x - xMid) < Math.abs(pts[mid].x - xMid)) mid = i;
  }
  const early = (ys[mid] - ys[0]) / Math.max(pts[mid].x - pts[0].x, 1e-9);
  const late =
    (ys[ys.length - 1] - ys[mid]) /
    Math.max(pts[pts.length - 1].x - pts[mid].x, 1e-9);
  if (monotonic && late < 0.5 * early) return 'SATURATING';
  // Flat for the first half, rising in the second: a leak that starts
  // mid-ladder (a cache filling up, a threshold crossed). Growth, not noise.
  if (monotonic && late > 0 && early <= 0.1 * late) return 'ONSET';
  return 'NOISY';
}

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
 * In-page values the leak-hunt runner recorded per rung (`--rung-metric`,
 * written to run.json `rungs[].metrics`), fitted per cycle. They are read
 * from the live page, so they need no snapshot load and no holder name — the
 * reliable series on a minified build.
 */

import fs from 'fs';
import path from 'path';
import {linearFit} from './tools/ladder-probe.js';
import {formatNumber, markdownTable} from './utils.js';

// In-page strings go into table cells: a newline or a `|` would split the row.
function cell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|');
}

interface RawRung {
  cycles?: number;
  metrics?: Record<string, unknown>;
}

export function rungMetricSeries(runDir: string):
  | {
      cycles: number[];
      series: Map<string, Array<number | null>>;
      display: Map<string, string[]>;
    }
  | {error: string}
  | null {
  let rungs: RawRung[];
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'),
    ) as {rungs?: RawRung[]};
    rungs = raw.rungs ?? [];
  } catch (err) {
    return {error: err instanceof Error ? err.message : String(err)};
  }
  const names = new Set<string>();
  for (const r of rungs)
    for (const k of Object.keys(r.metrics ?? {})) names.add(k);
  if (names.size === 0) return null;
  const series = new Map<string, Array<number | null>>();
  // Non-numeric values (a socket state, a flag) are shown, not fitted.
  const display = new Map<string, string[]>();
  for (const name of names) {
    display.set(
      name,
      rungs.map(r => {
        const v = r.metrics?.[name];
        if (v == null) return '—';
        return typeof v === 'number'
          ? formatNumber(v)
          : cell(String(v).slice(0, 80));
      }),
    );
    // A series that is non-numeric on any rung (a state string on some, a
    // count on others) is shown, not fitted: a slope over its numeric subset
    // would describe a metric that is not a number.
    const mixed = rungs.some(r => {
      const v = r.metrics?.[name];
      return v != null && !(typeof v === 'number' && Number.isFinite(v));
    });
    series.set(
      name,
      rungs.map(r => {
        const v = r.metrics?.[name];
        return !mixed && typeof v === 'number' && Number.isFinite(v) ? v : null;
      }),
    );
  }
  // A rung without a cycle count has no x; it is shown but not fitted.
  return {cycles: rungs.map(r => r.cycles ?? NaN), series, display};
}

/** A markdown section for the run's rung metrics, or [] when it has none. */
export function rungMetricsSection(runDir: string): string[] {
  const data = rungMetricSeries(runDir);
  if (data == null) return [];
  if ('error' in data) {
    return [
      `_In-page rung metrics: could not read ${path.join(runDir, 'run.json')} (${cell(data.error)}); any \`--rung-metric\` series are not shown._`,
      '',
    ];
  }
  const rows: string[][] = [];
  for (const [name, ys] of data.series) {
    const pts = ys
      .map((y, i) => ({x: data.cycles[i], y}))
      .filter(
        (p): p is {x: number; y: number} => p.y != null && Number.isFinite(p.x),
      );
    const fit =
      pts.length >= 2 && new Set(pts.map(p => p.x)).size >= 2
        ? linearFit(
            pts.map(p => p.x),
            pts.map(p => p.y),
          )
        : null;
    rows.push([
      `\`${cell(name)}\``,
      (data.display.get(name) ?? []).join(' → '),
      fit == null
        ? '—'
        : `${fit.slope >= 0 ? '+' : ''}${fit.slope.toFixed(3)} (r² ${fit.r2.toFixed(2)})`,
    ]);
  }
  return [
    '### In-page rung metrics (`--rung-metric`, from run.json)',
    '',
    markdownTable(['Metric', 'Per rung', 'Δ/cycle'], rows),
    '',
  ];
}

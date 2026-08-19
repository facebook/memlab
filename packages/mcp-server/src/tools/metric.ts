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
import fs from 'fs';
import os from 'os';
import path from 'path';
import {z} from 'zod';
import {getSnapshotMetadata} from '../heap-state.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * A measurement worth keeping outlives the session that produced it. A leak
 * hunt runs over days: capture a rung, measure, fix, capture again a week
 * later. Every number from the earlier sessions is gone by then — it lives in
 * a transcript nobody reloads — so the comparison that decides whether a fix
 * worked gets re-derived from scratch, or skipped.
 *
 * Snapshots themselves are far too large to keep resident for that long (and
 * node ids are per-capture anyway), so what persists is the measurement, not
 * the heap: a name, a number, and enough provenance to know what it describes.
 */
interface MetricPoint {
  value: number;
  unit: string;
  label: string;
  note?: string;
  seq: number;
}

interface MetricStore {
  version: 1;
  metrics: Record<string, MetricPoint[]>;
}

const MAX_POINTS_PER_METRIC = 200;

export function metricStorePath(): string {
  const dir =
    process.env.MEMLAB_STATE_DIR ?? path.join(os.homedir(), '.memlab');
  return path.join(dir, 'metrics.json');
}

function readStore(): MetricStore {
  const file = metricStorePath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as MetricStore;
    if (parsed?.version === 1 && parsed.metrics != null) return parsed;
  } catch {
    // A missing or corrupt store is not an error worth failing a measurement
    // over — start a fresh one rather than losing the number being recorded.
  }
  return {version: 1, metrics: {}};
}

function writeStore(store: MetricStore): void {
  const file = metricStorePath();
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}

function formatValue(p: MetricPoint): string {
  return `${formatNumber(Math.round(p.value * 100) / 100)}${p.unit === '' ? '' : ` ${p.unit}`}`;
}

function trendLine(points: MetricPoint[]): string {
  if (points.length < 2) {
    return '_One point so far — record the same metric again after the next capture to get a trend._';
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (first.unit !== last.unit) {
    return `⚠ Units changed across points (\`${first.unit}\` → \`${last.unit}\`); the delta below is arithmetic only and may be meaningless.`;
  }
  const delta = last.value - first.value;
  const pct = first.value !== 0 ? (delta / Math.abs(first.value)) * 100 : 0;
  const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'unchanged';
  return `**${dir}** ${formatNumber(Math.abs(Math.round(delta * 100) / 100))} ${last.unit} across ${points.length} points (${first.label} → ${last.label})${first.value !== 0 ? `, ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : ''}.`;
}

export function registerMetric(server: McpServer): void {
  server.tool(
    'memlab_metric',
    'Record a measurement under a name and keep it across sessions, so a number measured today can be compared with one measured next week.\n\n' +
      'Snapshots are far too large to keep resident between sessions and node ids are per-capture, so the only thing that can persist is the measurement itself. Without this, every number from an earlier session lives in a transcript nobody reloads, and the before/after comparison that decides whether a fix worked either gets re-derived from scratch or skipped.\n\n' +
      'Modes: `record` a named value, `history` for one metric with its trend, `list` for everything recorded, `forget` to drop one. Values are stored on disk under `~/.memlab/metrics.json` (override with `MEMLAB_STATE_DIR`).',
    {
      mode: z
        .enum(['record', 'history', 'list', 'forget'])
        .optional()
        .default('record')
        .describe('What to do (default "record").'),
      name: z
        .string()
        .optional()
        .describe(
          'Metric name — reuse the SAME name across sessions for anything you want to compare, e.g. "wa.listener_records" or "wa.heap_after_100_msgs".',
        ),
      value: z.number().optional().describe('The measured value to record.'),
      unit: z
        .string()
        .optional()
        .default('')
        .describe(
          'Unit for the value, e.g. "bytes", "MB", "objects", "per cycle". Recorded verbatim and compared on read, so keep it consistent for one metric.',
        ),
      label: z
        .string()
        .optional()
        .describe(
          'What this point describes — the build, gate state or rung, e.g. "gate off, 100 msgs". Defaults to the active snapshot\'s name.',
        ),
      note: z
        .string()
        .optional()
        .describe(
          'Optional free text: how it was measured, which tool call produced it, what to be careful about.',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Rows to show in history/list (default 20).'),
    },
    async ({mode, name, value, unit, label, note, limit}) => {
      try {
        const store = readStore();

        if (mode === 'list') {
          const names = Object.keys(store.metrics).sort();
          if (names.length === 0) {
            return toolResult(
              `No metrics recorded yet (store: \`${metricStorePath()}\`).\n\nRecord one with \`memlab_metric({name: "...", value: 123, unit: "objects"})\` — the point of it is the comparison you will want in a later session.`,
            );
          }
          const rows = names.slice(0, limit).map(n => {
            const points = store.metrics[n];
            const last = points[points.length - 1];
            return [
              n,
              formatNumber(points.length),
              formatValue(last),
              last.label,
            ];
          });
          return toolResult(
            [
              '## Recorded metrics',
              '',
              markdownTable(
                ['Metric', 'Points', 'Latest', 'Latest label'],
                rows,
                new Set([1, 2]),
              ),
              '',
              `Store: \`${metricStorePath()}\`. Use \`memlab_metric({mode: "history", name})\` for the full series.`,
            ].join('\n'),
          );
        }

        if (name == null || name === '') {
          return errorResult(
            new Error('Pass `name` — every metric is identified by its name.'),
          );
        }

        if (mode === 'forget') {
          if (store.metrics[name] == null) {
            return toolResult(`No metric named \`${name}\`; nothing to drop.`);
          }
          delete store.metrics[name];
          writeStore(store);
          return toolResult(`Dropped \`${name}\`.`);
        }

        if (mode === 'history') {
          const points = store.metrics[name];
          if (points == null || points.length === 0) {
            return toolResult(
              `No points recorded for \`${name}\`. \`memlab_metric({mode: "list"})\` shows what is recorded.`,
            );
          }
          const shown = points.slice(-limit);
          const rows = shown.map(p => [
            String(p.seq),
            p.label,
            formatValue(p),
            p.note ?? '',
          ]);
          return toolResult(
            [
              `## \`${name}\``,
              '',
              trendLine(points),
              '',
              markdownTable(
                ['#', 'Label', 'Value', 'Note'],
                rows,
                new Set([2]),
              ),
              points.length > shown.length
                ? `\n_Showing the last ${shown.length} of ${points.length} points._`
                : '',
              '',
              '_Points are compared in the order they were recorded, which is not necessarily chronological order of the captures they describe — the label is the only thing that says what a point is._',
            ].join('\n'),
          );
        }

        if (value == null) {
          return errorResult(
            new Error('Pass `value` — the number to record under this name.'),
          );
        }
        const meta = getSnapshotMetadata();
        const points = store.metrics[name] ?? [];
        const point: MetricPoint = {
          value,
          unit: unit ?? '',
          label: label ?? meta?.fileName ?? meta?.handle ?? 'unlabelled',
          note,
          seq: points.length + 1,
        };
        points.push(point);
        // Bounded: a metric recorded in a loop should not grow the store
        // without limit, and the oldest points are the least useful.
        store.metrics[name] = points.slice(-MAX_POINTS_PER_METRIC);
        writeStore(store);

        const prev = points.length >= 2 ? points[points.length - 2] : null;
        const lines = [
          `Recorded \`${name}\` = **${formatValue(point)}** (${point.label}), point ${point.seq}.`,
        ];
        if (prev != null && prev.unit === point.unit) {
          const delta = point.value - prev.value;
          lines.push(
            '',
            `Previous point (${prev.label}): ${formatValue(prev)} — ${delta === 0 ? 'no change' : `${delta > 0 ? '+' : ''}${formatNumber(Math.round(delta * 100) / 100)} ${point.unit}`}.`,
          );
        }
        if (point.label === 'unlabelled') {
          lines.push(
            '',
            '⚠ No label and no active snapshot, so this point records a number with nothing saying what it describes. Pass `label` — in a later session that is all there is to go on.',
          );
        }
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

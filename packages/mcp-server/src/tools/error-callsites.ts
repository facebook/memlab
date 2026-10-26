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
 * Where retained Error objects were created, from the frames V8 captured.
 *
 * An Error keeps its call stack unformatted until `.stack` is read: a private
 * symbol property holding the frames, each with the function's closure. That
 * survives in the heap snapshot even when the `.stack` string a logger kept is
 * truncated before the app frame, and it is what names the JSX site of a React
 * `_debugStack` Error.
 *
 * V8 has stored the frames three ways: a flat array mixing code objects,
 * receivers and closures; an array of `StackFrameInfo` / `CallSiteInfo`
 * objects that each hold the closure; and either of those behind an
 * `ErrorStackData`. All three are read.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import memlabCore from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {sourceOfNode} from './module-attribution.js';
import {
  boundedDominatorRetainedSize,
  clampLabelTo,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

const {NumericSet} = memlabCore;

const FRAME_OBJECT_RE = /StackFrameInfo|CallSiteInfo/;

/**
 * The Error's frames array, `'formatted'` when `.stack` was already read (the
 * symbol then holds the string), or null for a non-Error.
 */
function frameArrayOf(err: IHeapNode): IHeapNode | 'formatted' | null {
  let formatted = false;
  for (const e of err.references) {
    if (!String(e.name_or_index).includes('symbol')) continue;
    let t = e.toNode;
    if (t.isString && /\n\s+at /.test(t.toStringNode()?.stringValue ?? '')) {
      formatted = true;
      continue;
    }
    if (t.name.includes('ErrorStackData')) {
      const inner = t.references.find(r => r.toNode.type === 'array');
      if (inner == null) continue;
      t = inner.toNode;
    }
    if (t.type === 'array') return t;
  }
  return formatted ? 'formatted' : null;
}

/** The frames' closures, innermost first. */
function frameClosures(arr: IHeapNode): IHeapNode[] {
  const out: IHeapNode[] = [];
  for (const e of arr.references) {
    if (e.type !== 'element' && e.type !== 'internal' && e.type !== 'hidden') {
      continue;
    }
    if (!/^\d+$/.test(String(e.name_or_index))) continue;
    const t = e.toNode;
    if (t.type === 'closure') {
      out.push(t);
    } else if (FRAME_OBJECT_RE.test(t.name)) {
      const fn = t.references.find(r => r.toNode.type === 'closure');
      if (fn != null) out.push(fn.toNode);
    }
  }
  return out;
}

function messageOf(err: IHeapNode): string | null {
  for (const e of err.references) {
    if (e.type === 'property' && e.name_or_index === 'message') {
      const t = e.toNode;
      return t.isString ? (t.toStringNode()?.stringValue ?? t.name) : null;
    }
  }
  return null;
}

interface Group {
  key: string;
  errors: number[];
  messages: Map<string, number>;
  frames: IHeapNode[];
}

export interface CallsiteReport {
  errors: number;
  withoutFrames: number;
  groups: Group[];
}

export function errorCallsites(
  snapshot: IHeapSnapshot,
  opts: {topFrames: number; skip: RegExp | null; message: string | null},
): CallsiteReport {
  const groups = new Map<string, Group>();
  let errors = 0;
  let withoutFrames = 0;
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.type !== 'object') return;
    const msg = messageOf(node);
    // `message` is what every Error carries; a node without one is not an
    // Error however its frames array looks.
    if (msg == null) return;
    if (opts.message != null && !msg.includes(opts.message)) return;
    const arr = frameArrayOf(node);
    if (arr == null) return;
    if (arr === 'formatted') {
      withoutFrames++;
      return;
    }
    const frames = frameClosures(arr);
    if (frames.length === 0) return;
    errors++;
    const filtered = frames.filter(
      f => opts.skip == null || !opts.skip.test(f.name || '(anonymous)'),
    );
    // When `skip` matches every frame, fall back to all of them, for the key
    // and the detail alike.
    const kept = filtered.length > 0 ? filtered : frames;
    const key = kept
      .slice(0, opts.topFrames)
      .map(f => f.name || '(anonymous)')
      .join(' ← ');
    let g = groups.get(key);
    if (g == null) {
      g = {key, errors: [], messages: new Map(), frames: kept};
      groups.set(key, g);
    }
    g.errors.push(node.id);
    g.messages.set(msg, (g.messages.get(msg) ?? 0) + 1);
  });
  return {
    errors,
    withoutFrames,
    groups: [...groups.values()].sort(
      (a, b) => b.errors.length - a.errors.length,
    ),
  };
}

function scriptOf(fn: IHeapNode): string | null {
  const sfi = fn.getReferenceNode('shared');
  if (sfi == null) return null;
  // `script` in Chrome, `script_or_debug_info` in Node.
  for (const e of sfi.references) {
    const n = String(e.name_or_index);
    if (n === 'script' || n === 'script_or_debug_info') {
      return e.toNode.name.replace(/^system \/ Script \/ /, '');
    }
  }
  return null;
}

/** Module when the closure has one, else the script file; plus position. */
function whereOf(snapshot: IHeapSnapshot, fn: IHeapNode): string {
  const src = sourceOfNode(snapshot, fn, 0);
  const loc =
    src.location != null
      ? `:${src.location.line + 1}:${src.location.column + 1}`
      : '';
  if (src.module != null) return `${src.module}${loc}`;
  const script = src.script ?? scriptOf(fn);
  if (script == null || script === '') return '(no source)';
  const file = script.replace(/[?#].*$/, '').replace(/^.*\//, '');
  return `${clampLabelTo(file, 60)}${loc}`;
}

export function registerErrorCallsites(server: McpServer): void {
  server.tool(
    'memlab_error_callsites',
    "Where retained Error objects were created, read from the stack frames V8 captured on each Error (a private symbol holding each frame's closure), not from the `.stack` string, which a logger may have truncated before the app frame. Groups Errors by their top frames (after `skip`), with count, distinct messages and retained size, and lists the leading frames of the biggest groups with module and source position. Also names the JSX site of retained React `_debugStack` Errors (message `react-stack-top-frame`). An Error whose `.stack` was already read has no frames left and is counted separately.",
    {
      top_frames: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .default(3)
        .describe('Frames in the grouping key (default 3).'),
      skip: z
        .string()
        .optional()
        .describe(
          'Regex of frame function names to leave out of the key and frame list, e.g. the logging wrapper every Error passes through (`^(err|logWarning|invariant)$`); anonymous frames match as `(anonymous)`.',
        ),
      message: z
        .string()
        .optional()
        .describe('Only Errors whose message contains this.'),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(10)
        .describe('Groups to list (default 10).'),
      detail: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .default(3)
        .describe(
          'How many of the top groups to expand into their frames (default 3).',
        ),
    },
    async ({top_frames, skip, message, limit, detail}) => {
      try {
        let skipRe: RegExp | null = null;
        if (skip != null && skip !== '') {
          try {
            skipRe = new RegExp(skip);
          } catch (e) {
            return errorResult(
              new Error(`skip is not a valid regex: ${String(e)}`),
            );
          }
        }
        const snapshot = getSnapshot();
        const r = errorCallsites(snapshot, {
          topFrames: top_frames,
          skip: skipRe,
          message: message ?? null,
        });
        if (r.errors === 0) {
          return toolResult(
            `No Error with captured frames${message != null ? ` and a message containing "${message}"` : ''}.` +
              (r.withoutFrames > 0
                ? ` ${formatNumber(r.withoutFrames)} Error object(s) had none: their \`.stack\` was read, which formats it and drops the frames.`
                : ''),
          );
        }
        const lines = [
          '## Error call sites',
          '',
          `${formatNumber(r.errors)} Error object(s) with captured frames in ${formatNumber(r.groups.length)} group(s) by top ${top_frames} frame(s)` +
            (r.withoutFrames > 0
              ? `; ${formatNumber(r.withoutFrames)} more had none (\`.stack\` already read).`
              : '.'),
          '',
          markdownTable(
            [
              'Top frames (innermost first)',
              'Errors',
              'Messages',
              'Retained',
              'Sample',
            ],
            r.groups
              .slice(0, limit)
              .map(g => [
                clampLabelTo(g.key, 120),
                formatNumber(g.errors.length),
                formatNumber(g.messages.size),
                formatBytes(
                  boundedDominatorRetainedSize(
                    new NumericSet(g.errors),
                    snapshot,
                  ).retained,
                ),
                `@${g.errors[0]}`,
              ]),
            new Set([1, 2, 3]),
          ),
        ];
        for (const g of r.groups.slice(0, detail)) {
          const [msg] = [...g.messages.entries()].sort((a, b) => b[1] - a[1]);
          lines.push(
            '',
            `**${clampLabelTo(g.key, 120)}** — ${formatNumber(g.errors.length)} Error(s), e.g. "${clampLabelTo(msg[0], 100)}"`,
            ...g.frames
              .slice(0, 8)
              .map(
                (f, i) =>
                  `${i + 1}. \`${f.name || '(anonymous)'}\` — ${whereOf(snapshot, f)}`,
              ),
          );
        }
        lines.push(
          '',
          '_Frames are the closures V8 captured with each Error, so they survive a truncated `.stack` string. `memlab_retainer_trace` on a sample shows what keeps the Errors alive._',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode, IHeapEdge, IHeapSnapshot} from '@memlab/core';
import {
  getSnapshotMetadata,
  getSessionConfig,
  shouldEmitHeader,
} from './heap-state.js';

export interface NodeSummary {
  id: number;
  name: string;
  type: string;
  self_size: number;
  retained_size: number;
}

export interface NodeDetail extends NodeSummary {
  edge_count: number;
  referrer_count: number;
  is_detached: boolean;
  dominator_id: number | null;
  location: {script_id: number; line: number; column: number} | null;
  string_value?: string;
}

export interface EdgeSummary {
  edge_name: string;
  edge_type: string;
}

export interface OutgoingEdge extends EdgeSummary {
  to_node: NodeSummary;
}

export interface IncomingEdge extends EdgeSummary {
  from_node: NodeSummary;
}

function truncateDomClasses(name: string): string {
  const classMatch = name.match(/^(.*?\s)class="([^"]*)"(.*)$/);
  if (!classMatch) return name;

  const [, before, classes, after] = classMatch;
  const classList = classes.split(/\s+/).filter(c => c.length > 0);
  if (classList.length <= 3) return name;

  const kept = classList.slice(0, 3).join(' ');
  return `${before}class="${kept} …(${classList.length - 3} more)"${after}`;
}

function preferUsefulAttributes(name: string, maxLen: number): string {
  const testId = name.match(/data-testid="([^"]*)"/);
  const ariaLabel = name.match(/aria-label="([^"]*)"/);
  const id = name.match(/ id="([^"]*)"/);

  const detached = name.startsWith('Detached ') ? 'Detached ' : '';
  const nameWithoutDetached = detached ? name.slice(9) : name;
  const tag = nameWithoutDetached.match(/^(\w+)/)?.[1] ?? '';
  const preferred = testId?.[0] ?? ariaLabel?.[0] ?? id?.[0] ?? null;

  if (preferred && name.length > maxLen) {
    return `${detached}<${tag} ${preferred}>`;
  }
  return name;
}

export function truncateDomToTag(name: string): string {
  const detached = name.startsWith('Detached ') ? 'Detached ' : '';
  const nameWithoutDetached = detached ? name.slice(9) : name;
  const tag =
    nameWithoutDetached.match(/^<(\w+)/)?.[1] ??
    nameWithoutDetached.match(/^(\w+)/)?.[1] ??
    '';
  if (!tag) return name;

  const testId = name.match(/data-testid="([^"]*)"/);
  if (testId) return `${detached}<${tag} ${testId[0]}>`;

  const id = name.match(/ id="([^"]*)"/);
  if (id) return `${detached}<${tag} ${id[0]}>`;

  const ariaLabel = name.match(/aria-label="([^"]*)"/);
  if (ariaLabel) {
    const label = ariaLabel[1];
    const shortLabel = label.length > 30 ? label.slice(0, 30) + '…' : label;
    return `${detached}<${tag} aria-label="${shortLabel}">`;
  }

  return `${detached}<${tag}>`;
}

export function truncateNodeName(
  name: string,
  type: string,
  selfSize: number,
  maxLen = 150,
  aggressiveDom = false,
): string {
  if (
    type === 'string' ||
    type === 'concatenated string' ||
    type === 'sliced string'
  ) {
    if (name.length <= maxLen) return name;
    return `${name.slice(0, maxLen)}… (${formatBytes(selfSize)} total)`;
  }

  const isDomLike =
    name.includes('class="') ||
    name.includes('aria-') ||
    name.startsWith('<') ||
    name.startsWith('Detached <');
  if (isDomLike) {
    if (aggressiveDom) return truncateDomToTag(name);
    if (name.length > maxLen) {
      let processed = preferUsefulAttributes(name, maxLen);
      processed = truncateDomClasses(processed);
      if (processed.length <= maxLen) return processed;
      return `${processed.slice(0, maxLen)}…`;
    }
    return name;
  }

  if (name.length <= maxLen) return name;
  return `${name.slice(0, maxLen)}…`;
}

export function serializeNodeSummary(node: IHeapNode): NodeSummary {
  return {
    id: node.id,
    name: truncateNodeName(node.name, node.type, node.self_size),
    type: node.type,
    self_size: node.self_size,
    retained_size: node.retainedSize,
  };
}

export function serializeNodeDetail(node: IHeapNode): NodeDetail {
  const detail: NodeDetail = {
    id: node.id,
    name: truncateNodeName(node.name, node.type, node.self_size),
    type: node.type,
    self_size: node.self_size,
    retained_size: node.retainedSize,
    edge_count: node.edge_count,
    referrer_count: node.numOfReferrers,
    is_detached: node.is_detached,
    dominator_id: node.dominatorNode?.id ?? null,
    location: null,
  };

  const loc = node.location;
  if (loc) {
    detail.location = {
      script_id: loc.script_id,
      line: loc.line,
      column: loc.column,
    };
  }

  if (node.isString) {
    const strNode = node.toStringNode();
    if (strNode) {
      const val = strNode.stringValue;
      detail.string_value = val.length > 200 ? val.slice(0, 200) + '...' : val;
    }
  }

  return detail;
}

export function serializeOutgoingEdge(edge: IHeapEdge): OutgoingEdge {
  return {
    edge_name: String(edge.name_or_index),
    edge_type: edge.type,
    to_node: serializeNodeSummary(edge.toNode),
  };
}

export function serializeIncomingEdge(edge: IHeapEdge): IncomingEdge {
  return {
    edge_name: String(edge.name_or_index),
    edge_type: edge.type,
    from_node: serializeNodeSummary(edge.fromNode),
  };
}

const NODE_TYPE_BLOCK_LIST = new Set([
  'array',
  'native',
  'code',
  'synthetic',
  'hidden',
]);

const NODE_NAME_BLOCK_LIST = new Set([
  '(Startup object cache)',
  '(Global handles)',
  '(External strings)',
  '(Builtins)',
]);

export function isNodeWorthInspecting(node: IHeapNode): boolean {
  if (node.id <= 3) {
    return false;
  }
  if (NODE_TYPE_BLOCK_LIST.has(node.type)) {
    return false;
  }
  if (NODE_NAME_BLOCK_LIST.has(node.name)) {
    return false;
  }
  return true;
}

export function filterLargestObjects(
  snapshot: IHeapSnapshot,
  filter: (node: IHeapNode) => boolean,
  limit: number,
): IHeapNode[] {
  let result: IHeapNode[] = [];
  snapshot.nodes.forEach(node => {
    if (!filter(node)) {
      return;
    }
    const size = node.retainedSize;
    let i: number;
    for (i = result.length - 1; i >= 0; --i) {
      if (result[i].retainedSize >= size) {
        result.splice(i + 1, 0, node);
        break;
      }
    }
    if (i < 0) {
      result.unshift(node);
    }
    result = result.slice(0, limit);
  });
  return result;
}

export type OutputMode = 'full' | 'count' | 'ids';

export interface QueryNodesResult {
  total_count: number;
  nodes?: NodeSummary[];
  ids?: number[];
  timed_out?: boolean;
}

export function queryNodes(
  snapshot: IHeapSnapshot,
  filter: (node: IHeapNode) => boolean,
  opts: {
    limit: number;
    offset: number;
    outputMode: OutputMode;
    budget?: {tick: () => void};
  },
): QueryNodesResult {
  const {limit, offset, outputMode, budget} = opts;
  let timedOut = false;

  if (outputMode === 'count') {
    let total = 0;
    try {
      snapshot.nodes.forEach(node => {
        budget?.tick();
        if (filter(node)) total++;
      });
    } catch (e) {
      if (e instanceof ScanTimeoutError) timedOut = true;
      else throw e;
    }
    return {total_count: total, timed_out: timedOut || undefined};
  }

  // Collect all matching nodes sorted by retained size desc
  const sorted: IHeapNode[] = [];
  try {
    snapshot.nodes.forEach(node => {
      budget?.tick();
      if (!filter(node)) return;
      const size = node.retainedSize;
      let i: number;
      for (i = sorted.length - 1; i >= 0; --i) {
        if (sorted[i].retainedSize >= size) {
          sorted.splice(i + 1, 0, node);
          break;
        }
      }
      if (i < 0) {
        sorted.unshift(node);
      }
    });
  } catch (e) {
    if (e instanceof ScanTimeoutError) timedOut = true;
    else throw e;
  }

  const total_count = sorted.length;
  const sliced = sorted.slice(offset, offset + limit);

  if (outputMode === 'ids') {
    return {
      total_count,
      ids: sliced.map(n => n.id),
      timed_out: timedOut || undefined,
    };
  }

  return {
    total_count,
    nodes: sliced.map(serializeNodeSummary),
    timed_out: timedOut || undefined,
  };
}

/**
 * Thrown by a scan budget when a full-heap walk exceeds its wall-clock limit.
 * Callers catch this to return partial results with a clear note, instead of
 * letting a runaway scan run for many minutes (Feedback round 2 §1/§2).
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
 * Wall-clock budget for full-heap scans. Call `tick()` once per iteration; it
 * cheaply checks elapsed time every few thousand iterations and throws a
 * {@link ScanTimeoutError} when the budget is exceeded. This bounds the damage
 * of an expensive scan on a huge (e.g. multi-million-node browser) heap and
 * returns control to the server cleanly rather than wedging it.
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

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'N/A';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function markdownTable(
  headers: string[],
  rows: string[][],
  alignRight?: Set<number>,
): string {
  // Compute column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)),
  );

  const pad = (s: string, w: number, right?: boolean) =>
    right ? s.padStart(w) : s.padEnd(w);

  const headerLine =
    '| ' +
    headers.map((h, i) => pad(h, widths[i], alignRight?.has(i))).join(' | ') +
    ' |';
  const separatorLine =
    '|' +
    widths
      .map((w, i) =>
        alignRight?.has(i) ? '-'.repeat(w + 1) + ':' : '-'.repeat(w + 2),
      )
      .map(s => (s.length < 3 ? s + '-' : s))
      .join('|') +
    '|';
  const dataLines = rows.map(
    row =>
      '| ' +
      row
        .map((cell, i) => pad(cell, widths[i], alignRight?.has(i)))
        .join(' | ') +
      ' |',
  );

  return [headerLine, separatorLine, ...dataLines].join('\n');
}

export function formatNodeInline(
  id: number,
  name: string,
  type: string,
  selfSize?: number,
): string {
  const displayName =
    selfSize != null ? truncateNodeName(name, type, selfSize, 80) : name;
  return `@${id} ${displayName} (${type})`;
}

export function formatNodeSummaryTable(nodes: NodeSummary[]): string {
  const headers = ['ID', 'Name', 'Type', 'Self Size', 'Retained Size'];
  const rightCols = new Set([3, 4]);
  const rows = nodes.map(n => [
    `@${n.id}`,
    n.name,
    n.type,
    formatBytes(n.self_size),
    formatBytes(n.retained_size),
  ]);
  return markdownTable(headers, rows, rightCols);
}

export function formatQueryNodesResult(
  result: QueryNodesResult,
  offset?: number,
): string {
  const partial = result.timed_out
    ? '\n\n⚠ Scan hit its time budget and returned PARTIAL results (counts shown are a lower bound). Raise timeout_ms, add filters, or use an indexed tool — large browser heaps are slow to full-scan.'
    : '';
  if (result.nodes != null) {
    if (result.nodes.length === 0) {
      return `No matching nodes found (total: ${formatNumber(result.total_count)})${partial}`;
    }
    const lines = [`Total: ${formatNumber(result.total_count)} nodes\n`];
    lines.push(formatNodeSummaryTable(result.nodes));
    return lines.join('\n') + partial;
  }
  if (result.ids != null) {
    const lines = [
      `Total: ${formatNumber(result.total_count)} | Showing ${formatNumber(result.ids.length)} (offset ${offset ?? 0})`,
    ];
    lines.push(`IDs: ${result.ids.join(', ')}`);
    return lines.join('\n') + partial;
  }
  return `Total matching nodes: ${formatNumber(result.total_count)}${partial}`;
}

export function snapshotHeader(): string {
  const meta = getSnapshotMetadata();
  if (!meta) return '';
  const envLabel =
    meta.env === 'browser'
      ? 'Browser'
      : meta.env === 'node'
        ? 'Node.js'
        : 'Unknown';
  return `> Snapshot: ${meta.fileName} (${formatBytes(meta.totalSize)}, ${formatNumber(meta.nodeCount)} nodes, ${envLabel})`;
}

export function textResult(text: string) {
  return {content: [{type: 'text' as const, text}]};
}

export function toolResult(text: string) {
  const header = shouldEmitHeader() ? snapshotHeader() : '';
  const body = header ? `${header}\n\n${text}` : text;
  return {content: [{type: 'text' as const, text: body}]};
}

/**
 * Whether tools should omit "Suggested next steps" / "How to fix" trailers.
 * Honors the session-level `suppressSuggestions` config so callers can trim
 * repeated boilerplate tokens across a long investigation.
 */
export function suggestionsSuppressed(): boolean {
  return getSessionConfig().suppressSuggestions;
}

export function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

export function errorResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{type: 'text' as const, text: `Error: ${msg}`}],
    isError: true,
  };
}

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

export function serializeNodeSummary(node: IHeapNode): NodeSummary {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    self_size: node.self_size,
    retained_size: node.retainedSize,
  };
}

export function serializeNodeDetail(node: IHeapNode): NodeDetail {
  const detail: NodeDetail = {
    id: node.id,
    name: node.name,
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
      detail.string_value = strNode.stringValue;
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
}

export function queryNodes(
  snapshot: IHeapSnapshot,
  filter: (node: IHeapNode) => boolean,
  opts: {limit: number; offset: number; outputMode: OutputMode},
): QueryNodesResult {
  const {limit, offset, outputMode} = opts;

  if (outputMode === 'count') {
    let total = 0;
    snapshot.nodes.forEach(node => {
      if (filter(node)) total++;
    });
    return {total_count: total};
  }

  // Collect all matching nodes sorted by retained size desc
  const sorted: IHeapNode[] = [];
  snapshot.nodes.forEach(node => {
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

  const total_count = sorted.length;
  const sliced = sorted.slice(offset, offset + limit);

  if (outputMode === 'ids') {
    return {total_count, ids: sliced.map(n => n.id)};
  }

  return {total_count, nodes: sliced.map(serializeNodeSummary)};
}

export function formatBytes(bytes: number): string {
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
): string {
  return `@${id} ${name} (${type})`;
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
  if (result.nodes != null) {
    if (result.nodes.length === 0) {
      return `No matching nodes found (total: ${formatNumber(result.total_count)})`;
    }
    const lines = [`Total: ${formatNumber(result.total_count)} nodes\n`];
    lines.push(formatNodeSummaryTable(result.nodes));
    return lines.join('\n');
  }
  if (result.ids != null) {
    const lines = [
      `Total: ${formatNumber(result.total_count)} | Showing ${formatNumber(result.ids.length)} (offset ${offset ?? 0})`,
    ];
    lines.push(`IDs: ${result.ids.join(', ')}`);
    return lines.join('\n');
  }
  return `Total matching nodes: ${formatNumber(result.total_count)}`;
}

export function textResult(text: string) {
  return {content: [{type: 'text' as const, text}]};
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

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
import type {IHeapNode, IHeapEdge, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot, getSnapshotMetadata} from '../heap-state.js';
import {
  filterLargestObjects,
  isNodeWorthInspecting,
  formatBytes,
  formatNumber,
  truncateNodeName,
  errorResult,
  toolResult,
} from '../utils.js';

interface RetainerStep {
  nodeId: number;
  name: string;
  type: string;
  retainedSize: number;
  selfSize: number;
  edgeName?: string;
}

interface PinchPoint {
  nodeId: number;
  name: string;
  type: string;
  selfSize: number;
  retainedSize: number;
  ratio: number;
}

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

interface Finding {
  node: IHeapNode;
  trace: RetainerStep[];
  pinchPoint: PinchPoint | null;
  severity: Severity;
}

function classifySeverity(retainedSize: number, totalSize: number): Severity {
  if (totalSize === 0) return 'LOW';
  const pct = retainedSize / totalSize;
  if (pct >= 0.1) return 'CRITICAL';
  if (pct >= 0.05) return 'HIGH';
  if (pct >= 0.01) return 'MEDIUM';
  return 'LOW';
}

function extractSourceHints(traces: RetainerStep[][]): string[] {
  const paths = new Set<string>();
  const filePathRegex = /(?:\/[\w.-]+){2,}\.\w+/g;

  for (const trace of traces) {
    for (const step of trace) {
      const matches = step.name.match(filePathRegex);
      if (matches) {
        for (const m of matches) {
          if (
            !m.includes('/node_modules/') ||
            m.includes('/node_modules/@') ||
            m.split('/node_modules/').length <= 2
          ) {
            paths.add(m);
          }
        }
      }
      if (step.edgeName) {
        const edgeMatches = step.edgeName.match(filePathRegex);
        if (edgeMatches) {
          for (const m of edgeMatches) {
            if (
              !m.includes('/node_modules/') ||
              m.includes('/node_modules/@') ||
              m.split('/node_modules/').length <= 2
            ) {
              paths.add(m);
            }
          }
        }
      }
    }
  }
  return [...paths];
}

function getRetainerPath(node: IHeapNode): RetainerStep[] {
  const visited = new Set<number>([node.id]);
  let cur: IHeapNode | null = node;
  const reverse: RetainerStep[] = [
    {
      nodeId: cur.id,
      name: cur.name,
      type: cur.type,
      retainedSize: cur.retainedSize,
      selfSize: cur.self_size,
    },
  ];

  while (cur && cur.hasPathEdge) {
    const edge: IHeapEdge | null = cur.pathEdge;
    if (!edge) break;
    const from: IHeapNode = edge.fromNode;
    if (visited.has(from.id)) break;
    visited.add(from.id);
    reverse.push({
      nodeId: from.id,
      name: from.name,
      type: from.type,
      retainedSize: from.retainedSize,
      selfSize: from.self_size,
      edgeName: String(edge.name_or_index),
    });
    cur = from;
  }

  reverse.reverse();
  return reverse;
}

function findPinchPoint(trace: RetainerStep[]): PinchPoint | null {
  let best: PinchPoint | null = null;

  for (const step of trace) {
    if (step.selfSize === 0) continue;
    const ratio = step.retainedSize / step.selfSize;
    if (ratio < 100) continue;
    if (
      step.type === 'hidden' ||
      step.type === 'array' ||
      step.type === 'native' ||
      step.type === 'synthetic'
    ) {
      continue;
    }
    if (!best || ratio > best.ratio) {
      best = {
        nodeId: step.nodeId,
        name: step.name,
        type: step.type,
        selfSize: step.selfSize,
        retainedSize: step.retainedSize,
        ratio,
      };
    }
  }

  return best;
}

function findUnboundedCaches(snapshot: IHeapSnapshot, limit: number) {
  const caches: Array<{
    nodeId: number;
    name: string;
    type: string;
    entryCount: number;
    retainedSize: number;
  }> = [];

  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    if (node.name !== 'Map' && node.name !== 'Set') return;
    if (node.type !== 'object') return;
    if (node.retainedSize < 1024 * 1024) return;

    let entryCount = 0;
    for (const edge of node.references) {
      if (edge.name_or_index === 'table' && edge.toNode.type === 'array') {
        entryCount = edge.toNode.edge_count;
        break;
      }
    }
    if (entryCount < 50) return;

    const size = node.retainedSize;
    let inserted = false;
    for (let i = 0; i < caches.length; i++) {
      if (size > caches[i].retainedSize) {
        caches.splice(i, 0, {
          nodeId: node.id,
          name: node.name,
          type: node.type,
          entryCount,
          retainedSize: size,
        });
        inserted = true;
        break;
      }
    }
    if (!inserted)
      caches.push({
        nodeId: node.id,
        name: node.name,
        type: node.type,
        entryCount,
        retainedSize: size,
      });
    if (caches.length > limit) caches.length = limit;
  });

  return caches;
}

interface PromiseSummary {
  pendingCount: number;
  pendingRetained: number;
  resolvedCount: number;
  topPending: Array<{nodeId: number; retainedSize: number}>;
}

function scanPromises(snapshot: IHeapSnapshot): PromiseSummary {
  const summary: PromiseSummary = {
    pendingCount: 0,
    pendingRetained: 0,
    resolvedCount: 0,
    topPending: [],
  };

  snapshot.nodes.forEach(node => {
    if (node.name !== 'Promise' || node.type !== 'object') return;
    if (node.id <= 3) return;

    let isPending = false;
    for (const edge of node.references) {
      if (
        edge.type === 'internal' &&
        String(edge.name_or_index) === 'reactions_or_result' &&
        edge.toNode.name === 'PromiseReaction'
      ) {
        isPending = true;
        break;
      }
    }

    if (isPending) {
      summary.pendingCount++;
      summary.pendingRetained += node.retainedSize;
      const size = node.retainedSize;
      let inserted = false;
      for (let i = 0; i < summary.topPending.length; i++) {
        if (size > summary.topPending[i].retainedSize) {
          summary.topPending.splice(i, 0, {
            nodeId: node.id,
            retainedSize: size,
          });
          inserted = true;
          break;
        }
      }
      if (!inserted)
        summary.topPending.push({nodeId: node.id, retainedSize: size});
      if (summary.topPending.length > 5) summary.topPending.length = 5;
    } else {
      summary.resolvedCount++;
    }
  });

  return summary;
}

interface ShapeSummary {
  properties: string[];
  count: number;
  totalSelfSize: number;
  exampleNodeId: number;
}

function scanTopShapes(snapshot: IHeapSnapshot, limit: number): ShapeSummary[] {
  const shapeMap = new Map<
    string,
    {
      properties: string[];
      count: number;
      totalSelfSize: number;
      exampleNodeId: number;
    }
  >();

  snapshot.nodes.forEach(node => {
    if (node.type !== 'object' || node.id <= 3) return;
    if (node.name !== 'Object') return;
    const names: string[] = [];
    for (const edge of node.references) {
      if (edge.type === 'property') {
        names.push(String(edge.name_or_index));
      }
    }
    if (names.length === 0) return;
    names.sort();
    const key = names.join(',');
    const existing = shapeMap.get(key);
    if (existing) {
      existing.count++;
      existing.totalSelfSize += node.self_size;
    } else {
      shapeMap.set(key, {
        properties: names,
        count: 1,
        totalSelfSize: node.self_size,
        exampleNodeId: node.id,
      });
    }
  });

  return [...shapeMap.values()]
    .filter(s => s.count >= 100)
    .sort((a, b) => b.totalSelfSize - a.totalSelfSize)
    .slice(0, limit);
}

const LISTENER_SHAPE_KEYWORDS = new Set([
  'callback',
  'handler',
  'listener',
  'onError',
  'onSuccess',
  'onChange',
  'onUpdate',
  'onLoad',
  'onDone',
  'fn',
]);

const LISTENER_CONTEXT_KEYWORDS = new Set([
  'context',
  'ctx',
  'this',
  'target',
  'scope',
  'self',
]);

interface SubscriptionAccumulation {
  properties: string[];
  count: number;
  totalSelfSize: number;
  exampleNodeId: number;
}

function scanSubscriptionAccumulation(
  snapshot: IHeapSnapshot,
  threshold: number,
): SubscriptionAccumulation[] {
  const shapeMap = new Map<
    string,
    {
      properties: string[];
      count: number;
      totalSelfSize: number;
      exampleNodeId: number;
      hasListenerProp: boolean;
      hasContextProp: boolean;
    }
  >();

  snapshot.nodes.forEach(node => {
    if (node.type !== 'object' || node.id <= 3) return;
    if (node.name !== 'Object') return;
    const names: string[] = [];
    for (const edge of node.references) {
      if (edge.type === 'property') {
        names.push(String(edge.name_or_index));
      }
    }
    if (names.length === 0 || names.length > 10) return;
    names.sort();
    const key = names.join(',');
    const existing = shapeMap.get(key);
    if (existing) {
      existing.count++;
      existing.totalSelfSize += node.self_size;
    } else {
      const hasListener = names.some(
        n => LISTENER_SHAPE_KEYWORDS.has(n) || n.startsWith('on'),
      );
      const hasContext = names.some(n => LISTENER_CONTEXT_KEYWORDS.has(n));
      shapeMap.set(key, {
        properties: names,
        count: 1,
        totalSelfSize: node.self_size,
        exampleNodeId: node.id,
        hasListenerProp: hasListener,
        hasContextProp: hasContext,
      });
    }
  });

  return [...shapeMap.values()]
    .filter(s => s.count >= threshold && s.hasListenerProp && s.hasContextProp)
    .sort((a, b) => b.totalSelfSize - a.totalSelfSize);
}

const ERROR_CLASS_NAMES = new Set([
  'Error',
  'SyntaxError',
  'TypeError',
  'ReferenceError',
  'RangeError',
  'URIError',
  'EvalError',
  'AggregateError',
]);

interface ErrorAccumulation {
  errorType: string;
  message: string;
  count: number;
  totalRetained: number;
  exampleNodeId: number;
}

function scanErrorAccumulation(
  snapshot: IHeapSnapshot,
  minCount: number,
): ErrorAccumulation[] {
  const errorMap = new Map<
    string,
    {
      errorType: string;
      message: string;
      count: number;
      totalRetained: number;
      exampleNodeId: number;
    }
  >();

  snapshot.nodes.forEach(node => {
    if (node.type !== 'object' || node.id <= 3) return;
    if (!ERROR_CLASS_NAMES.has(node.name)) return;

    let message = '';
    for (const edge of node.references) {
      if (String(edge.name_or_index) === 'message' && edge.toNode.isString) {
        const strNode = edge.toNode.toStringNode();
        if (strNode) message = strNode.stringValue;
        break;
      }
    }
    if (!message) return;

    const key = `${node.name}::${message}`;
    const existing = errorMap.get(key);
    if (existing) {
      existing.count++;
      existing.totalRetained += node.retainedSize;
    } else {
      errorMap.set(key, {
        errorType: node.name,
        message,
        count: 1,
        totalRetained: node.retainedSize,
        exampleNodeId: node.id,
      });
    }
  });

  return [...errorMap.values()]
    .filter(e => e.count >= minCount)
    .sort((a, b) => b.count - a.count);
}

function tracePrefix(trace: RetainerStep[]): string {
  return trace.map(s => `${s.name}(${s.type})`).join('->');
}

function deduplicateFindings(findings: Finding[]): Finding[] {
  if (findings.length <= 1) return findings;

  const prefixMap = new Map<
    string,
    {representative: Finding; others: Finding[]}
  >();

  for (const f of findings) {
    const collapsed = f.trace.filter(
      s =>
        s.type !== 'hidden' &&
        s.type !== 'array' &&
        s.type !== 'native' &&
        s.type !== 'synthetic' &&
        s.type !== 'code',
    );
    const prefix =
      collapsed.length >= 3
        ? collapsed
            .slice(0, -1)
            .map(s => `${s.name}(${s.type})`)
            .join('->')
        : tracePrefix(collapsed);

    const existing = prefixMap.get(prefix);
    if (existing) {
      if (f.node.retainedSize > existing.representative.node.retainedSize) {
        existing.others.push(existing.representative);
        existing.representative = f;
      } else {
        existing.others.push(f);
      }
    } else {
      prefixMap.set(prefix, {representative: f, others: []});
    }
  }

  const result: Finding[] = [];
  for (const {representative, others} of prefixMap.values()) {
    (
      representative as Finding & {collapsed_siblings?: Finding[]}
    ).collapsed_siblings = others;
    result.push(representative);
  }
  return result;
}

function formatTrace(trace: RetainerStep[], maxSteps: number): string {
  const collapsed: RetainerStep[] = [];
  for (const step of trace) {
    const isInternal =
      step.type === 'hidden' ||
      step.type === 'array' ||
      step.type === 'native' ||
      step.type === 'synthetic' ||
      step.type === 'code';
    if (isInternal && collapsed.length > 0) continue;
    collapsed.push(step);
  }

  const shown =
    collapsed.length <= maxSteps
      ? collapsed
      : [...collapsed.slice(0, 3), ...collapsed.slice(-2)];

  const parts: string[] = [];
  for (let i = 0; i < shown.length; i++) {
    const s = shown[i];
    const name = truncateNodeName(s.name, s.type, s.selfSize, 50);
    parts.push(
      `@${s.nodeId} ${name} (${s.type}) [${formatBytes(s.retainedSize)}]`,
    );
    if (i === 2 && collapsed.length > maxSteps) {
      parts.push(`  … ${collapsed.length - 5} more nodes …`);
    }
    if (i < shown.length - 1 && s.edgeName != null) {
      parts[parts.length - 1] += ` --${s.edgeName}-->`;
    }
  }
  return parts.join('\n  → ');
}

export function registerAutoInvestigate(server: McpServer): void {
  server.tool(
    'memlab_auto_investigate',
    'One-shot deep analysis: finds the top retained objects, traces each retainer chain to the GC root, identifies pinch points (small objects retaining large subtrees), and detects unbounded caches. Returns a structured report with root causes and suggested fixes. Use this as the first tool after loading a snapshot to get immediate actionable findings.',
    {
      top_n: z
        .number()
        .optional()
        .default(5)
        .describe('Number of top retained objects to analyze (default 5)'),
      focus: z
        .enum(['all', 'caches', 'dom', 'strings', 'closures'])
        .optional()
        .default('all')
        .describe(
          'Focus the analysis on a specific category: "caches" (Maps/Sets), "dom" (detached DOM), "strings" (string waste), "closures" (closure leaks), or "all" (default).',
        ),
    },
    async ({top_n, focus}) => {
      try {
        const snapshot = getSnapshot();
        const meta = getSnapshotMetadata();
        const totalSize = meta?.totalSize ?? 0;

        const focusFilter = (node: IHeapNode): boolean => {
          if (!isNodeWorthInspecting(node)) return false;
          switch (focus) {
            case 'caches':
              return (
                (node.name === 'Map' ||
                  node.name === 'Set' ||
                  node.name === 'Array') &&
                node.type === 'object'
              );
            case 'dom':
              return node.is_detached || node.name.startsWith('Detached ');
            case 'strings':
              return (
                node.type === 'string' || node.type === 'concatenated string'
              );
            case 'closures':
              return node.type === 'closure';
            default:
              return true;
          }
        };

        const largest = filterLargestObjects(snapshot, focusFilter, top_n);

        if (largest.length === 0) {
          return toolResult(
            focus === 'all'
              ? 'No significant objects found in the snapshot.'
              : `No significant ${focus} objects found. Try focus: "all" for a broader analysis.`,
          );
        }

        const rawFindings: Finding[] = [];
        for (const node of largest) {
          const trace = getRetainerPath(node);
          const pinch = findPinchPoint(trace);
          const severity = classifySeverity(node.retainedSize, totalSize);
          rawFindings.push({node, trace, pinchPoint: pinch, severity});
        }

        const findings = deduplicateFindings(rawFindings);

        const caches =
          focus === 'all' || focus === 'caches'
            ? findUnboundedCaches(snapshot, 5)
            : [];
        const promises =
          focus === 'all'
            ? scanPromises(snapshot)
            : {
                pendingCount: 0,
                pendingRetained: 0,
                resolvedCount: 0,
                topPending: [],
              };
        const shapes = focus === 'all' ? scanTopShapes(snapshot, 5) : [];
        const subscriptions =
          focus === 'all' ? scanSubscriptionAccumulation(snapshot, 1000) : [];
        const errorAccum =
          focus === 'all' ? scanErrorAccumulation(snapshot, 10) : [];

        const lines: string[] = [`# Auto-Investigation Report`, ''];

        const focusLabel = focus === 'all' ? '' : ` (focus: ${focus})`;
        lines.push(`## Top ${findings.length} Retained Objects${focusLabel}`);
        lines.push('');

        const pinchPointMap = new Map<
          number,
          {pp: PinchPoint; findingIndices: number[]}
        >();
        for (let i = 0; i < findings.length; i++) {
          const f = findings[i];
          if (f.pinchPoint) {
            const existing = pinchPointMap.get(f.pinchPoint.nodeId);
            if (existing) {
              existing.findingIndices.push(i);
            } else {
              pinchPointMap.set(f.pinchPoint.nodeId, {
                pp: f.pinchPoint,
                findingIndices: [i],
              });
            }
          }
        }

        for (let i = 0; i < findings.length; i++) {
          const f = findings[i] as Finding & {
            collapsed_siblings?: Finding[];
          };
          const siblings = f.collapsed_siblings ?? [];
          const totalRetained =
            f.node.retainedSize +
            siblings.reduce((s, sib) => s + sib.node.retainedSize, 0);
          const pct =
            totalSize > 0
              ? ` (${((totalRetained / totalSize) * 100).toFixed(1)}% of heap)`
              : '';
          const name = truncateNodeName(
            f.node.name,
            f.node.type,
            f.node.self_size,
            60,
          );

          const sevIcon =
            f.severity === 'CRITICAL'
              ? '🔴'
              : f.severity === 'HIGH'
                ? '🟠'
                : f.severity === 'MEDIUM'
                  ? '🟡'
                  : '🔵';

          if (siblings.length > 0) {
            lines.push(
              `### ${i + 1}. ${sevIcon} [${f.severity}] \`${name}\` chain — ${formatBytes(totalRetained)} total across ${1 + siblings.length} nodes${pct}`,
            );
            lines.push('');
            lines.push(`**Retainer chain:** ${formatTrace(f.trace, 8)}`);
            lines.push('');
            lines.push(
              `**Same chain contains:** @${f.node.id} (${formatBytes(f.node.retainedSize)})` +
                siblings
                  .map(
                    sib =>
                      `, @${sib.node.id} ${truncateNodeName(sib.node.name, sib.node.type, sib.node.self_size, 30)} (${formatBytes(sib.node.retainedSize)})`,
                  )
                  .join(''),
            );
          } else {
            lines.push(
              `### ${i + 1}. ${sevIcon} [${f.severity}] @${f.node.id} \`${name}\` (${f.node.type}) — ${formatBytes(f.node.retainedSize)}${pct}`,
            );
            lines.push('');
            lines.push(`**Retainer chain:** ${formatTrace(f.trace, 8)}`);
          }
          lines.push('');

          if (f.pinchPoint) {
            const pp = f.pinchPoint;
            const ppEntry = pinchPointMap.get(pp.nodeId);
            const sharedWith = ppEntry?.findingIndices.filter(j => j !== i);
            if (sharedWith && sharedWith.length > 0) {
              lines.push(
                `**Pinch point:** @${pp.nodeId} (shared with findings ${sharedWith.map(j => `#${j + 1}`).join(', ')} — see below)`,
              );
            } else {
              const ppName = truncateNodeName(
                pp.name,
                pp.type,
                pp.selfSize,
                50,
              );
              lines.push(
                `**Pinch point:** @${pp.nodeId} \`${ppName}\` — self: ${formatBytes(pp.selfSize)}, retains: ${formatBytes(pp.retainedSize)} (${formatNumber(Math.round(pp.ratio))}:1 ratio). Freeing this single object would reclaim ${formatBytes(pp.retainedSize)}.`,
              );
            }
          } else {
            lines.push(
              '**Pinch point:** none found (retained size is distributed)',
            );
          }
          lines.push('');
        }

        const sharedPinchPoints = [...pinchPointMap.values()].filter(
          e => e.findingIndices.length > 1,
        );
        if (sharedPinchPoints.length > 0) {
          lines.push('## Shared Pinch Points');
          lines.push('');
          for (const {pp, findingIndices} of sharedPinchPoints) {
            const ppName = truncateNodeName(pp.name, pp.type, pp.selfSize, 50);
            lines.push(
              `- @${pp.nodeId} \`${ppName}\` — self: ${formatBytes(pp.selfSize)}, retains: ${formatBytes(pp.retainedSize)} (${formatNumber(Math.round(pp.ratio))}:1 ratio). Shared by findings ${findingIndices.map(j => `#${j + 1}`).join(', ')}. Freeing this single object would reclaim ${formatBytes(pp.retainedSize)}.`,
            );
          }
          lines.push('');
        }

        if (promises.pendingCount > 0 && promises.pendingRetained > 100_000) {
          lines.push(`## Pending Promises`);
          lines.push('');
          lines.push(
            `${formatNumber(promises.pendingCount)} pending, ${formatNumber(promises.resolvedCount)} resolved. Pending promises retain **${formatBytes(promises.pendingRetained)}** total.`,
          );
          if (promises.topPending.length > 0) {
            lines.push('');
            lines.push('Top pending by retained size:');
            for (const p of promises.topPending) {
              lines.push(
                `- @${p.nodeId} — ${formatBytes(p.retainedSize)} retained`,
              );
            }
            lines.push(
              '',
              '_Pending promises retaining large subtrees are often stuck async operations (HTTP requests, DB queries). Use `memlab_trace_dominators` to trace from the top pending promise to the data it holds._',
            );
          }
          lines.push('');
        }

        if (caches.length > 0) {
          lines.push(`## Unbounded Caches Detected`);
          lines.push('');
          for (const c of caches) {
            lines.push(
              `- @${c.nodeId} \`${c.name}\` — ${formatNumber(c.entryCount)} entries, ${formatBytes(c.retainedSize)} retained. Check if this cache has eviction logic.`,
            );
          }
          lines.push('');
        }

        if (shapes.length > 0) {
          lines.push(`## Object Shape Summary`);
          lines.push('');
          lines.push(
            'Top data record shapes (generic `Object` instances grouped by property structure):',
          );
          lines.push('');
          for (const s of shapes) {
            const propsDisplay =
              s.properties.length <= 6
                ? `{${s.properties.join(', ')}}`
                : `{${s.properties.slice(0, 5).join(', ')}, … +${s.properties.length - 5}}`;
            const shapeSev = classifySeverity(s.totalSelfSize, totalSize);
            const shapeSevIcon =
              shapeSev === 'CRITICAL'
                ? '🔴'
                : shapeSev === 'HIGH'
                  ? '🟠'
                  : shapeSev === 'MEDIUM'
                    ? '🟡'
                    : '';
            const sevLabel =
              shapeSev !== 'LOW' ? ` ${shapeSevIcon} [${shapeSev}]` : '';
            lines.push(
              `- ${propsDisplay} — ${formatNumber(s.count)} instances, ${formatBytes(s.totalSelfSize)} self (example: @${s.exampleNodeId})${sevLabel}`,
            );
          }
          lines.push(
            '',
            '_Use `memlab_shape_histogram` for full shape analysis with retained sizes._',
          );
          lines.push('');
        }

        if (subscriptions.length > 0) {
          lines.push(`## Subscription/Listener Accumulation`);
          lines.push('');
          lines.push(
            'Object shapes matching listener/subscription patterns (properties containing callback/handler + context/target):',
          );
          lines.push('');
          for (const s of subscriptions.slice(0, 5)) {
            const propsDisplay = `{${s.properties.join(', ')}}`;
            const subSev = classifySeverity(s.totalSelfSize, totalSize);
            const subSevIcon =
              subSev === 'CRITICAL'
                ? '🔴'
                : subSev === 'HIGH'
                  ? '🟠'
                  : subSev === 'MEDIUM'
                    ? '🟡'
                    : '🔵';
            lines.push(
              `- ${subSevIcon} [${subSev}] ${propsDisplay} — **${formatNumber(s.count)}** instances, ${formatBytes(s.totalSelfSize)} self (example: @${s.exampleNodeId})`,
            );
          }
          lines.push(
            '',
            '_These may be event listeners, signal subscriptions, or observer registrations that are not being cleaned up. Use `memlab_retainer_summary` with node_ids from the examples to trace the retention pattern._',
          );
          lines.push('');
        }

        if (errorAccum.length > 0) {
          lines.push(`## Repeated Error Accumulation`);
          lines.push('');
          lines.push(
            'Identical Error instances appearing many times — often indicates a module being evaluated repeatedly and failing each time:',
          );
          lines.push('');
          for (const e of errorAccum.slice(0, 5)) {
            const msgDisplay =
              e.message.length > 80
                ? e.message.slice(0, 77) + '...'
                : e.message;
            lines.push(
              `- **${formatNumber(e.count)}x** \`${e.errorType}\`: "${msgDisplay}" — ${formatBytes(e.totalRetained)} total retained (example: @${e.exampleNodeId})`,
            );
          }
          lines.push(
            '',
            '_Repeated identical errors are almost always a bug — a module failing to load, a misconfigured import, or a retry loop that never succeeds._',
          );
          lines.push('');
        }

        const sourceHints = extractSourceHints(findings.map(f => f.trace));
        if (sourceHints.length > 0) {
          lines.push('## Source Hints');
          lines.push('');
          lines.push(
            'File paths extracted from retainer chains (use to locate relevant source code):',
          );
          for (const hint of sourceHints.slice(0, 10)) {
            lines.push(`- \`${hint}\``);
          }
          if (sourceHints.length > 10) {
            lines.push(`- … and ${sourceHints.length - 10} more`);
          }
          lines.push('');
        }

        lines.push('## Suggested Next Steps');
        lines.push('');
        let stepNum = 1;
        if (findings[0]?.pinchPoint) {
          const pp = findings[0].pinchPoint;
          lines.push(
            `${stepNum++}. Inspect pinch point: \`memlab_get_node(${pp.nodeId})\` then \`memlab_dominator_subtree(${pp.nodeId})\``,
          );
        }
        lines.push(
          `${stepNum++}. Trace top retainer: \`memlab_trace_dominators(${findings[0].node.id})\` for full dominator chain in one call`,
        );
        lines.push(
          `${stepNum++}. Check for patterns: \`memlab_retainer_summary\` with class name of top objects`,
        );
        if (promises.pendingCount > 0 && promises.topPending.length > 0) {
          lines.push(
            `${stepNum++}. Investigate pending promises: \`memlab_trace_dominators(${promises.topPending[0].nodeId})\``,
          );
        }
        if (caches.length > 0) {
          lines.push(
            `${stepNum++}. Analyze caches: \`memlab_cache_analysis\` for detailed cache inspection`,
          );
        }
        if (shapes.length > 0) {
          lines.push(
            `${stepNum++}. Explore data shapes: \`memlab_shape_histogram\` for detailed shape clustering`,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

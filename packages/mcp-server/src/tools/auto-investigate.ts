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

interface DistributedAccumulation {
  className: string;
  nodeType: string;
  count: number;
  totalSelfSize: number;
  avgSize: number;
  exampleNodeId: number;
}

function scanDistributedAccumulation(
  snapshot: IHeapSnapshot,
  totalSize: number,
): DistributedAccumulation[] {
  const classMap = new Map<
    string,
    {
      className: string;
      nodeType: string;
      count: number;
      totalSelfSize: number;
      exampleNodeId: number;
    }
  >();

  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    if (node.type === 'hidden' || node.type === 'array') return;
    const key = `${node.type}::${node.name}`;
    const existing = classMap.get(key);
    if (existing) {
      existing.count++;
      existing.totalSelfSize += node.self_size;
    } else {
      classMap.set(key, {
        className: node.name,
        nodeType: node.type,
        count: 1,
        totalSelfSize: node.self_size,
        exampleNodeId: node.id,
      });
    }
  });

  return [...classMap.values()]
    .filter(c => {
      if (c.count < 50_000) return false;
      const avgSize = c.totalSelfSize / c.count;
      if (avgSize > 10_000) return false;
      if (totalSize > 0 && c.totalSelfSize < totalSize * 0.03) return false;
      return true;
    })
    .map(c => ({
      ...c,
      avgSize: c.totalSelfSize / c.count,
    }))
    .sort((a, b) => b.totalSelfSize - a.totalSelfSize)
    .slice(0, 5);
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

interface ListenerFanOutInfo {
  uniqueCallbacks: number;
  uniqueContexts: number;
  orphanedContexts: number;
  contextShapes: Array<{name: string; count: number}>;
  escalatedSeverity: Severity;
}

interface SubscriptionAccumulation {
  properties: string[];
  count: number;
  totalSelfSize: number;
  exampleNodeId: number;
  fanOut?: ListenerFanOutInfo;
}

function scanSubscriptionAccumulation(
  snapshot: IHeapSnapshot,
  threshold: number,
  totalSize: number,
): SubscriptionAccumulation[] {
  const CALLBACK_PROPS = new Set(['callback', 'fn', 'handler', 'listener']);
  const CONTEXT_PROPS_SET = new Set([
    'context',
    'ctx',
    'this',
    'target',
    'scope',
  ]);

  const shapeMap = new Map<
    string,
    {
      properties: string[];
      count: number;
      totalSelfSize: number;
      exampleNodeId: number;
      hasListenerProp: boolean;
      hasContextProp: boolean;
      callbackIds: Set<number>;
      contextIds: Set<number>;
      contextShapeMap: Map<string, number>;
      orphanedContexts: number;
    }
  >();

  snapshot.nodes.forEach(node => {
    if (node.type !== 'object' || node.id <= 3) return;
    if (node.name !== 'Object') return;
    const names: string[] = [];
    let callbackId = 0;
    let contextId = 0;
    let contextName = '';
    for (const edge of node.references) {
      if (edge.type === 'property') {
        const pName = String(edge.name_or_index);
        names.push(pName);
        if (CALLBACK_PROPS.has(pName)) {
          callbackId = edge.toNode.id;
        }
        if (CONTEXT_PROPS_SET.has(pName)) {
          contextId = edge.toNode.id;
          contextName = edge.toNode.name;
        }
      }
    }
    if (names.length === 0 || names.length > 10) return;
    names.sort();
    const key = names.join(',');
    const existing = shapeMap.get(key);
    if (existing) {
      existing.count++;
      existing.totalSelfSize += node.self_size;
      if (callbackId > 0) existing.callbackIds.add(callbackId);
      if (contextId > 0) {
        existing.contextIds.add(contextId);
        existing.contextShapeMap.set(
          contextName,
          (existing.contextShapeMap.get(contextName) ?? 0) + 1,
        );
        const ctxNode = snapshot.getNodeById(contextId);
        if (ctxNode && ctxNode.numOfReferrers <= 2) {
          existing.orphanedContexts++;
        }
      }
    } else {
      const hasListener = names.some(
        n => LISTENER_SHAPE_KEYWORDS.has(n) || n.startsWith('on'),
      );
      const hasContext = names.some(n => LISTENER_CONTEXT_KEYWORDS.has(n));
      const contextShapeMap = new Map<string, number>();
      let orphanedContexts = 0;
      if (contextId > 0) {
        contextShapeMap.set(contextName, 1);
        const ctxNode = snapshot.getNodeById(contextId);
        if (ctxNode && ctxNode.numOfReferrers <= 2) {
          orphanedContexts = 1;
        }
      }
      shapeMap.set(key, {
        properties: names,
        count: 1,
        totalSelfSize: node.self_size,
        exampleNodeId: node.id,
        hasListenerProp: hasListener,
        hasContextProp: hasContext,
        callbackIds: new Set(callbackId > 0 ? [callbackId] : []),
        contextIds: new Set(contextId > 0 ? [contextId] : []),
        contextShapeMap,
        orphanedContexts,
      });
    }
  });

  const results = [...shapeMap.values()]
    .filter(s => s.count >= threshold && s.hasListenerProp && s.hasContextProp)
    .sort((a, b) => b.totalSelfSize - a.totalSelfSize);

  return results.map(s => {
    const hasHighFanOut = s.callbackIds.size <= 5 && s.contextIds.size > 10;
    const hasOrphanedContexts = s.orphanedContexts > s.contextIds.size * 0.5;

    let fanOut: ListenerFanOutInfo | undefined;
    if (hasHighFanOut || hasOrphanedContexts) {
      let escalatedSeverity = classifySeverity(s.totalSelfSize, totalSize);
      if (
        hasHighFanOut &&
        hasOrphanedContexts &&
        (escalatedSeverity === 'LOW' || escalatedSeverity === 'MEDIUM')
      ) {
        escalatedSeverity = s.orphanedContexts > 100 ? 'CRITICAL' : 'HIGH';
      }

      const contextShapes = [...s.contextShapeMap.entries()]
        .map(([name, count]) => ({name, count}))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      fanOut = {
        uniqueCallbacks: s.callbackIds.size,
        uniqueContexts: s.contextIds.size,
        orphanedContexts: s.orphanedContexts,
        contextShapes,
        escalatedSeverity,
      };
    }

    return {
      properties: s.properties,
      count: s.count,
      totalSelfSize: s.totalSelfSize,
      exampleNodeId: s.exampleNodeId,
      fanOut,
    };
  });
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

  // Phase 1: Collapse findings that share the same retainer trace prefix
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

  const prefixResult: Array<Finding & {collapsed_siblings?: Finding[]}> = [];
  for (const {representative, others} of prefixMap.values()) {
    (
      representative as Finding & {collapsed_siblings?: Finding[]}
    ).collapsed_siblings = others;
    prefixResult.push(
      representative as Finding & {collapsed_siblings?: Finding[]},
    );
  }

  // Phase 2: Collapse findings along the same dominator chain (Feedback #12)
  // If finding B's node appears in finding A's retainer trace, B is dominated by A
  if (prefixResult.length <= 1) return prefixResult;

  const traceNodeSets = prefixResult.map(f => {
    const ids = new Set<number>();
    for (const step of f.trace) {
      ids.add(step.nodeId);
    }
    return ids;
  });

  const absorbed = new Set<number>();
  for (let i = 0; i < prefixResult.length; i++) {
    if (absorbed.has(i)) continue;
    for (let j = 0; j < prefixResult.length; j++) {
      if (i === j || absorbed.has(j)) continue;
      // If finding j's target node appears in finding i's trace, j is a sub-finding of i
      if (traceNodeSets[i].has(prefixResult[j].node.id)) {
        const siblings = prefixResult[i].collapsed_siblings ?? [];
        siblings.push(prefixResult[j]);
        const jSiblings = prefixResult[j].collapsed_siblings ?? [];
        siblings.push(...jSiblings);
        prefixResult[i].collapsed_siblings = siblings;
        absorbed.add(j);
      }
    }
  }

  return prefixResult.filter((_, idx) => !absorbed.has(idx));
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

function computeTraceOverlap(
  a: RetainerStep[],
  b: RetainerStep[],
): {prefixLen: number; matchIndex: number} {
  let prefixLen = 0;
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i].nodeId === b[i].nodeId) {
      prefixLen++;
    } else {
      break;
    }
  }
  return {prefixLen, matchIndex: -1};
}

function findBestTraceMatch(
  trace: RetainerStep[],
  previousTraces: RetainerStep[][],
): {matchedIndex: number; prefixLen: number} | null {
  let bestMatch: {matchedIndex: number; prefixLen: number} | null = null;
  for (let j = 0; j < previousTraces.length; j++) {
    const {prefixLen} = computeTraceOverlap(trace, previousTraces[j]);
    if (prefixLen > trace.length * 0.5) {
      if (!bestMatch || prefixLen > bestMatch.prefixLen) {
        bestMatch = {matchedIndex: j, prefixLen};
      }
    }
  }
  return bestMatch;
}

function detectAsyncContextLeaks(findings: Finding[]): string[] {
  const alerts: string[] = [];
  const seen = new Set<string>();

  for (const f of findings) {
    const traceNames = f.trace.map(s => s.name);
    const traceEdges = f.trace.map(s => s.edgeName ?? '');

    // Pattern 1: TCP/Socket → kResourceStore → afterContext (Next.js request context leak)
    const hasTCP = traceNames.some(
      n => n === 'TCP' || n === 'Socket' || n.includes('TCP'),
    );
    const hasResourceStore = traceEdges.some(
      e => e === 'kResourceStore' || e === 'resource_symbol',
    );
    const hasAfterContext = traceEdges.some(e => e === 'afterContext');
    const hasOnClose = traceEdges.some(e => e === 'onClose');
    const hasContext = traceNames.some(
      n => n === 'system / Context' || n.startsWith('system /'),
    );

    if (
      hasTCP &&
      hasResourceStore &&
      (hasAfterContext || hasOnClose) &&
      hasContext &&
      !seen.has('tcp-als')
    ) {
      seen.add('tcp-als');
      alerts.push(
        `🔴 **[CRITICAL] AsyncLocalStorage context retained by TCP connection**\n` +
          `A TCP socket's async context chain retains ${formatBytes(f.node.retainedSize)} of request-scoped data. ` +
          `The \`onClose\` closure captures the request's AsyncLocalStorage context, which chains to prior contexts via \`previous\` pointers.\n` +
          `**Fix:** Ensure response bodies are fully consumed/canceled (check \`resp.body.cancel()\`), ` +
          `or avoid capturing large data in request-scoped closures.`,
      );
    }

    // Pattern 2: Generator.parameters_and_registers holding large arrays (Undici response body retention)
    const hasGenerator = traceNames.some(
      n => n === 'Generator' || n.includes('Generator'),
    );
    const hasParamsAndRegisters = traceEdges.some(
      e => e === 'parameters_and_registers',
    );

    if (
      hasGenerator &&
      hasParamsAndRegisters &&
      f.node.retainedSize > 1024 * 1024 &&
      !seen.has('generator-undici')
    ) {
      seen.add('generator-undici');
      alerts.push(
        `🟠 **[HIGH] Generator retaining large data via \`parameters_and_registers\`**\n` +
          `A Generator object holds ${formatBytes(f.node.retainedSize)} through its parameters/registers. ` +
          `This is a common Undici pattern where an async generator (response body stream) retains the full response buffer.\n` +
          `**Fix:** Ensure response bodies are fully read and the stream is closed/destroyed after use. ` +
          `For fetch(), always call \`resp.text()\`, \`resp.json()\`, or \`resp.body.cancel()\`.`,
      );
    }

    // Pattern 3: PromiseReaction chains with large retained sizes (unresolved/leaked promises)
    const hasPromiseReaction = traceNames.some(
      n => n === 'PromiseReaction' || n === 'Promise',
    );
    const hasReactionEdge = traceEdges.some(
      e =>
        e === 'reactions_or_result' ||
        e === 'fulfill_handler' ||
        e === 'reject_handler',
    );

    if (
      hasPromiseReaction &&
      hasReactionEdge &&
      f.node.retainedSize > 5 * 1024 * 1024 &&
      !seen.has('promise-chain')
    ) {
      seen.add('promise-chain');
      alerts.push(
        `🟠 **[HIGH] Unresolved Promise chain retaining ${formatBytes(f.node.retainedSize)}**\n` +
          `A PromiseReaction chain is keeping large data alive. This often indicates a stuck async operation ` +
          `(HTTP request, DB query, timer) whose promise was never resolved or rejected.\n` +
          `**Fix:** Add timeouts to async operations. Check for \`await\` on promises that may never resolve. ` +
          `Ensure \`.catch()\` handlers don't capture the entire response.`,
      );
    }

    // Pattern 4: Undici Client/Pool response retention (Feedback #6)
    const hasUndiciClient = traceNames.some(
      n => n === 'Client' || n === 'Pool' || n === 'Agent',
    );
    const hasRequestQueue = traceEdges.some(
      e =>
        e === 'requests' || e === 'queue' || e === 'pending' || e === 'running',
    );

    if (
      hasUndiciClient &&
      hasRequestQueue &&
      f.node.retainedSize > 1024 * 1024 &&
      !seen.has('undici-client')
    ) {
      seen.add('undici-client');
      alerts.push(
        `🟠 **[HIGH] Undici HTTP Client/Pool retaining ${formatBytes(f.node.retainedSize)} via request queue**\n` +
          `An Undici Client or Pool object is keeping response data alive through its request queue or closure chain. ` +
          `This typically happens when HTTP response bodies are not fully consumed or canceled.\n` +
          `**Fix:** Always consume or cancel response bodies: \`await resp.text()\`, \`resp.body.cancel()\`, ` +
          `or \`resp.body.destroy()\`. For streaming responses, ensure the readable stream is fully drained.`,
      );
    }

    // Pattern 5: mysql2 Connection retaining large data (Feedback #8)
    const hasMysqlConn = traceNames.some(
      n =>
        n === 'Connection' ||
        n === 'PoolConnection' ||
        n === 'PromiseConnection',
    );
    const hasMysqlEdge = traceEdges.some(
      e => e === '_protocol' || e === '_statements' || e === 'connectionConfig',
    );

    if (
      hasMysqlConn &&
      hasMysqlEdge &&
      f.node.retainedSize > 5 * 1024 * 1024 &&
      !seen.has('mysql2-conn')
    ) {
      seen.add('mysql2-conn');
      alerts.push(
        `🟠 **[HIGH] mysql2 Connection retaining ${formatBytes(f.node.retainedSize)}**\n` +
          `A mysql2 Connection object is keeping query results or protocol buffers alive, often through ` +
          `error event handler closure chains or unreleased prepared statements.\n` +
          `**Fix:** Set pool \`idleTimeout\` (e.g., 60000ms) to free idle connections. ` +
          `Ensure query result rows are not captured in long-lived closures. ` +
          `Consider \`stream()\` instead of \`query()\` for large result sets.`,
      );
    }
  }
  return alerts;
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
          focus === 'all'
            ? scanSubscriptionAccumulation(snapshot, 1000, totalSize)
            : [];
        const errorAccum =
          focus === 'all' ? scanErrorAccumulation(snapshot, 10) : [];
        const distributed =
          focus === 'all'
            ? scanDistributedAccumulation(snapshot, totalSize)
            : [];

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

        const previousTraces: RetainerStep[][] = [];
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

          // Check if this finding's trace shares a common prefix with a previous one
          const traceMatch =
            i > 0 ? findBestTraceMatch(f.trace, previousTraces) : null;

          if (siblings.length > 0) {
            lines.push(
              `### ${i + 1}. ${sevIcon} [${f.severity}] \`${name}\` chain — ${formatBytes(totalRetained)} total across ${1 + siblings.length} nodes${pct}`,
            );
            lines.push('');
            if (traceMatch) {
              const divergeStep = f.trace[traceMatch.prefixLen];
              const divergeEdge = divergeStep?.edgeName ?? '…';
              const divergeName = divergeStep
                ? truncateNodeName(
                    divergeStep.name,
                    divergeStep.type,
                    divergeStep.selfSize,
                    40,
                  )
                : '…';
              lines.push(
                `**Retainer chain:** (same chain as #${traceMatch.matchedIndex + 1}) → [${divergeEdge}] ${divergeName} — ${formatBytes(f.node.retainedSize)}`,
              );
            } else {
              lines.push(`**Retainer chain:** ${formatTrace(f.trace, 8)}`);
            }
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
          } else if (traceMatch) {
            const divergeStep = f.trace[traceMatch.prefixLen];
            const divergeEdge = divergeStep?.edgeName ?? '…';
            const divergeName = divergeStep
              ? truncateNodeName(
                  divergeStep.name,
                  divergeStep.type,
                  divergeStep.selfSize,
                  40,
                )
              : '…';
            lines.push(
              `### ${i + 1}. ${sevIcon} [${f.severity}] @${f.node.id} \`${name}\` (${f.node.type}) — ${formatBytes(f.node.retainedSize)}${pct}`,
            );
            lines.push('');
            lines.push(
              `**Retainer chain:** (same chain as #${traceMatch.matchedIndex + 1}) → [${divergeEdge}] ${divergeName} — ${formatBytes(f.node.retainedSize)}`,
            );
          } else {
            lines.push(
              `### ${i + 1}. ${sevIcon} [${f.severity}] @${f.node.id} \`${name}\` (${f.node.type}) — ${formatBytes(f.node.retainedSize)}${pct}`,
            );
            lines.push('');
            lines.push(`**Retainer chain:** ${formatTrace(f.trace, 8)}`);
          }
          previousTraces.push(f.trace);
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
            const ppNode = snapshot.getNodeById(pp.nodeId);
            const ppName = truncateNodeName(pp.name, pp.type, pp.selfSize, 50);
            lines.push(
              `- @${pp.nodeId} \`${ppName}\` — self: ${formatBytes(pp.selfSize)}, retains: ${formatBytes(pp.retainedSize)} (${formatNumber(Math.round(pp.ratio))}:1 ratio). Shared by findings ${findingIndices.map(j => `#${j + 1}`).join(', ')}. Freeing this single object would reclaim ${formatBytes(pp.retainedSize)}.`,
            );
            if (ppNode) {
              const topProps: string[] = [];
              for (const edge of ppNode.references) {
                if (edge.type === 'property' && topProps.length < 5) {
                  topProps.push(String(edge.name_or_index));
                }
              }
              if (topProps.length > 0) {
                lines.push(
                  `  Properties: {${topProps.join(', ')}${ppNode.edge_count > 5 ? ', …' : ''}}`,
                );
              }
            }
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

          // Feedback #4: Low-cardinality column detection
          // Feedback #8: High-cost unique property detection
          // For large shapes (>10K instances), sample property value cardinality
          const columnAlerts: string[] = [];

          // Pre-bucket: collect qualifying shape keys, then single-pass scan
          const qualifyingShapes = shapes.filter(s => {
            if (s.count < 10_000) return false;
            return !!snapshot.getNodeById(s.exampleNodeId);
          });
          const shapeBuckets = new Map<string, IHeapNode[]>();
          for (const s of qualifyingShapes) {
            shapeBuckets.set(s.properties.join(','), []);
          }

          if (shapeBuckets.size > 0) {
            const maxSamples = 200;
            snapshot.nodes.forEach(node => {
              if (node.type !== 'object' || node.id <= 3) return;
              if (node.name !== 'Object') return;
              const props: string[] = [];
              for (const edge of node.references) {
                if (edge.type === 'property') {
                  props.push(String(edge.name_or_index));
                }
              }
              props.sort();
              const key = props.join(',');
              const bucket = shapeBuckets.get(key);
              if (bucket && bucket.length < maxSamples) {
                bucket.push(node);
              }
            });
          }

          for (const s of qualifyingShapes) {
            const sampleNodes = shapeBuckets.get(s.properties.join(',')) ?? [];
            if (sampleNodes.length < 50) continue;

            // Analyze each property's cardinality and value characteristics
            for (const propName of s.properties) {
              const values = new Set<string>();
              let totalValueSize = 0;
              let stringValueCount = 0;
              let allUnique = true;

              for (const node of sampleNodes) {
                for (const edge of node.references) {
                  if (
                    edge.type === 'property' &&
                    String(edge.name_or_index) === propName
                  ) {
                    const target = edge.toNode;
                    let val = target.name;
                    if (target.isString) {
                      const strNode = target.toStringNode();
                      if (strNode) val = strNode.stringValue;
                      stringValueCount++;
                      totalValueSize += target.self_size;
                    }
                    if (values.has(val)) allUnique = false;
                    values.add(val);
                    break;
                  }
                }
              }

              const cardinality = values.size;
              const sampleCount = sampleNodes.length;

              // Low cardinality: few unique values relative to instance count
              if (cardinality <= 20 && sampleCount >= 100) {
                columnAlerts.push(
                  `- Property \`${propName}\` has only **${cardinality} unique value(s)** across ${formatNumber(s.count)} instances — low-cardinality column suitable for pre-filtering at the data source or string interning`,
                );
              }

              // High-cost unique: all values unique, string, large average size
              if (
                allUnique &&
                stringValueCount > sampleCount * 0.8 &&
                cardinality > sampleCount * 0.9
              ) {
                const avgSize = totalValueSize / stringValueCount;
                if (avgSize > 50 && s.count > 10_000) {
                  const estimatedWaste = avgSize * s.count;
                  columnAlerts.push(
                    `- Property \`${propName}\` has **all unique string values** (avg ${Math.round(avgSize)}B each × ${formatNumber(s.count)} instances = ~${formatBytes(estimatedWaste)}) — verify this field is needed by consumers`,
                  );
                }
              }
            }
          }

          if (columnAlerts.length > 0) {
            lines.push('## Data Column Analysis');
            lines.push('');
            lines.push('Property value analysis across large object shapes:');
            lines.push('');
            lines.push(...columnAlerts);
            lines.push(
              '',
              '_Low-cardinality columns can often be filtered at the data source (SQL WHERE clause). High-cost unique string properties should be verified as needed by consumers._',
            );
            lines.push('');
          }
        }

        if (distributed.length > 0) {
          lines.push(`## Distributed Accumulation`);
          lines.push('');
          lines.push(
            'Classes with many small instances that collectively consume significant memory. No single instance stands out, but the total is substantial:',
          );
          lines.push('');
          for (const d of distributed) {
            const pct =
              totalSize > 0
                ? ` (${((d.totalSelfSize / totalSize) * 100).toFixed(1)}% of heap)`
                : '';
            const sevIcon =
              d.totalSelfSize >= totalSize * 0.1
                ? '🔴'
                : d.totalSelfSize >= totalSize * 0.05
                  ? '🟠'
                  : '🟡';
            lines.push(
              `- ${sevIcon} \`${d.className}\` (${d.nodeType}) — **${formatNumber(d.count)}** instances × ${Math.round(d.avgSize)}B avg = **${formatBytes(d.totalSelfSize)}**${pct} (example: @${d.exampleNodeId})`,
            );
          }
          lines.push(
            '',
            '_These won\'t appear in "top retained objects" because no single instance retains enough. Reduce instance count at the source (batch, deduplicate, or filter before storing)._',
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
            const baseSev = classifySeverity(s.totalSelfSize, totalSize);
            const effectiveSev = s.fanOut
              ? s.fanOut.escalatedSeverity
              : baseSev;
            const subSevIcon =
              effectiveSev === 'CRITICAL'
                ? '🔴'
                : effectiveSev === 'HIGH'
                  ? '🟠'
                  : effectiveSev === 'MEDIUM'
                    ? '🟡'
                    : '🔵';
            lines.push(
              `- ${subSevIcon} [${effectiveSev}] ${propsDisplay} — **${formatNumber(s.count)}** instances, ${formatBytes(s.totalSelfSize)} self (example: @${s.exampleNodeId})`,
            );

            if (s.fanOut) {
              const fo = s.fanOut;
              lines.push(
                `  - **Listener fan-out detected:** ${formatNumber(fo.uniqueCallbacks)} unique callback(s), ${formatNumber(fo.uniqueContexts)} unique context(s)`,
              );
              if (fo.orphanedContexts > 0) {
                lines.push(
                  `  - **${formatNumber(fo.orphanedContexts)} orphaned context(s)** — only retained by listener registrations`,
                );
              }
              if (fo.contextShapes.length > 0) {
                const shapeStr = fo.contextShapes
                  .map(cs => `${cs.count}× ${cs.name}`)
                  .join(', ');
                lines.push(`  - Context shapes: ${shapeStr}`);
              }
              if (effectiveSev !== baseSev) {
                lines.push(
                  `  - _Severity escalated from ${baseSev} → ${effectiveSev} due to listener fan-out pattern (few callbacks, many orphaned contexts)_`,
                );
              }
            }
          }
          lines.push('');
          lines.push(
            '_These may be event listeners, signal subscriptions, or observer registrations that are not being cleaned up. ' +
              'Use `memlab_event_listener_leaks` for detailed listener analysis or ' +
              '`memlab_retainer_summary` with node_ids from the examples to trace the retention pattern._',
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

        const asyncAlerts = detectAsyncContextLeaks(findings);
        if (asyncAlerts.length > 0) {
          lines.push('## Known Leak Patterns');
          lines.push('');
          for (const alert of asyncAlerts) {
            lines.push(alert);
            lines.push('');
          }
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

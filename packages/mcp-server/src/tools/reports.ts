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
import type {IHeapNode, IHeapEdge} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  isNodeWorthInspecting,
  filterLargestObjects,
  serializeNodeSummary,
  formatNodeSummaryTable,
  queryNodes,
  formatQueryNodesResult,
  errorResult,
  textResult,
} from '../utils.js';
import type {OutputMode} from '../utils.js';

// --- Detached DOM analysis ---

function isDetachedDOMNode(node: IHeapNode): boolean {
  if (node.id <= 3) return false;
  if (node.is_detached) return true;
  return node.name.startsWith('Detached ');
}

function runDetachedDom(limit: number): string {
  const snapshot = getSnapshot();
  const result = queryNodes(snapshot, isDetachedDOMNode, {
    limit,
    offset: 0,
    outputMode: 'full' as OutputMode,
  });
  return `## Detached DOM Nodes\n\n${formatQueryNodesResult(result)}`;
}

// --- Duplicated Strings analysis ---

function runDuplicatedStrings(limit: number): string {
  const snapshot = getSnapshot();

  const stringMap = new Map<
    string,
    {count: number; total_size: number; example_node_ids: number[]}
  >();

  snapshot.nodes.forEach(node => {
    if (node.type !== 'string') return;
    if (node.name === 'system / SlicedString') return;

    const strNode = node.toStringNode();
    if (!strNode) return;

    const value = strNode.stringValue;
    const entry = stringMap.get(value);
    if (entry) {
      entry.count++;
      entry.total_size += node.retainedSize;
      if (entry.example_node_ids.length < 3) {
        entry.example_node_ids.push(node.id);
      }
    } else {
      stringMap.set(value, {
        count: 1,
        total_size: node.retainedSize,
        example_node_ids: [node.id],
      });
    }
  });

  const duplicated = Array.from(stringMap.entries())
    .filter(([, stats]) => stats.count > 1)
    .sort((a, b) => b[1].total_size - a[1].total_size)
    .slice(0, limit)
    .map(([value, stats]) => ({
      value: value.length > 80 ? value.slice(0, 80) + '...' : value,
      count: stats.count,
      total_size_formatted: formatBytes(stats.total_size),
      example_node_ids: stats.example_node_ids,
    }));

  if (duplicated.length === 0) {
    return '## Duplicated Strings\n\nNo duplicated strings found.';
  }

  const lines = duplicated.map((d, i) => {
    const nodeIds = d.example_node_ids.map(id => `@${id}`).join(', ');
    return `${i + 1}. "${d.value}" x ${d.count} copies, ${d.total_size_formatted} total (nodes: ${nodeIds})`;
  });
  return `## Duplicated Strings\n\n${duplicated.length} entries:\n\n${lines.join('\n')}`;
}

// --- Stale Collections analysis ---

const COLLECTION_NAMES = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Array']);

function isCollectionNode(node: IHeapNode): boolean {
  return node.type === 'object' && COLLECTION_NAMES.has(node.name);
}

function isStaleNode(node: IHeapNode): boolean {
  return node.is_detached || node.name.startsWith('Detached ');
}

function getCollectionChildren(node: IHeapNode): IHeapEdge[] {
  if (node.name === 'Map' || node.name === 'Set') {
    const tableEdge = node.references.find(e => e.name_or_index === 'table');
    if (tableEdge) {
      return tableEdge.toNode.references;
    }
  }
  return node.references;
}

function runStaleCollections(limit: number): string {
  const snapshot = getSnapshot();
  const results: Array<{
    collection: IHeapNode;
    stale_item_count: number;
    stale_retained_size: number;
    total_children: number;
  }> = [];

  snapshot.nodes.forEach(node => {
    if (!isCollectionNode(node)) return;

    const children = getCollectionChildren(node);
    let staleCount = 0;
    let staleRetainedSize = 0;
    let totalChildren = 0;

    for (const edge of children) {
      totalChildren++;
      if (isStaleNode(edge.toNode)) {
        staleCount++;
        staleRetainedSize += edge.toNode.retainedSize;
      }
    }

    if (staleCount > 0) {
      results.push({
        collection: node,
        stale_item_count: staleCount,
        stale_retained_size: staleRetainedSize,
        total_children: totalChildren,
      });
    }
  });

  results.sort((a, b) => b.stale_retained_size - a.stale_retained_size);
  const topResults = results.slice(0, limit);

  if (topResults.length === 0) {
    return '## Stale Collections\n\nNo stale collections found.';
  }

  const headers = ['Collection ID', 'Name', 'Stale / Total', 'Stale Retained'];
  const rightCols = new Set([2, 3]);
  const rows = topResults.map(r => [
    `@${r.collection.id}`,
    r.collection.name,
    `${formatNumber(r.stale_item_count)} / ${formatNumber(r.total_children)}`,
    formatBytes(r.stale_retained_size),
  ]);
  return `## Stale Collections\n\n${topResults.length} found\n\n${markdownTable(headers, rows, rightCols)}`;
}

// --- Global Variables analysis ---

const BUILTIN_GLOBALS = new Set([
  'undefined',
  'NaN',
  'Infinity',
  'globalThis',
  'self',
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'screen',
  'performance',
  'localStorage',
  'sessionStorage',
  'caches',
  'crypto',
  'indexedDB',
  'console',
  'alert',
  'confirm',
  'prompt',
  'close',
  'open',
  'print',
  'top',
  'parent',
  'frames',
  'frameElement',
  'opener',
  'devicePixelRatio',
  'innerHeight',
  'innerWidth',
  'outerHeight',
  'outerWidth',
  'scrollX',
  'scrollY',
  'pageXOffset',
  'pageYOffset',
  'screenX',
  'screenY',
  'screenLeft',
  'screenTop',
  'visualViewport',
  'styleMedia',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'onclick',
  'onload',
  'onerror',
  'onmessage',
  'onresize',
  'onscroll',
  'onbeforeunload',
  'onunload',
  'onhashchange',
  'onpopstate',
  'onfocus',
  'onblur',
  'onkeydown',
  'onkeyup',
  'onkeypress',
  'onmousedown',
  'onmouseup',
  'onmousemove',
  'onmouseenter',
  'onmouseleave',
  'ontouchstart',
  'ontouchend',
  'ontouchmove',
  'ontouchcancel',
  'onanimationend',
  'onanimationstart',
  'onanimationiteration',
  'ontransitionend',
  'onpointerdown',
  'onpointerup',
  'onpointermove',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Request',
  'Response',
  'Headers',
  'URL',
  'URLSearchParams',
  'AbortController',
  'AbortSignal',
  'Worker',
  'SharedWorker',
  'ServiceWorker',
  'BroadcastChannel',
  'MessageChannel',
  'Image',
  'Audio',
  'MediaSource',
  'MediaStream',
  'MediaRecorder',
  'AudioContext',
  'OfflineAudioContext',
  'SpeechSynthesis',
  'Object',
  'Function',
  'Array',
  'Number',
  'String',
  'Boolean',
  'Symbol',
  'Date',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'FinalizationRegistry',
  'Promise',
  'Proxy',
  'Reflect',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'JSON',
  'Math',
  'Intl',
  'Atomics',
  'BigInt',
  'TextEncoder',
  'TextDecoder',
  'Blob',
  'File',
  'FileReader',
  'FileList',
  'FormData',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'CompressionStream',
  'DecompressionStream',
  'MutationObserver',
  'IntersectionObserver',
  'ResizeObserver',
  'PerformanceObserver',
  'CustomEvent',
  'Event',
  'EventTarget',
  'Element',
  'HTMLElement',
  'HTMLDivElement',
  'HTMLSpanElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLFormElement',
  'HTMLAnchorElement',
  'HTMLImageElement',
  'HTMLCanvasElement',
  'HTMLVideoElement',
  'HTMLAudioElement',
  'HTMLScriptElement',
  'HTMLStyleElement',
  'HTMLLinkElement',
  'HTMLMetaElement',
  'HTMLHeadElement',
  'HTMLBodyElement',
  'HTMLIFrameElement',
  'HTMLSelectElement',
  'HTMLOptionElement',
  'HTMLTextAreaElement',
  'HTMLTableElement',
  'HTMLTableRowElement',
  'HTMLTableCellElement',
  'Document',
  'DocumentFragment',
  'Node',
  'NodeList',
  'NamedNodeMap',
  'DOMParser',
  'XMLSerializer',
  'Range',
  'Selection',
  'TreeWalker',
  'SVGElement',
  'SVGSVGElement',
  'CSS',
  'CSSStyleSheet',
  'CSSRule',
  'CSSStyleDeclaration',
  'getComputedStyle',
  'matchMedia',
  'atob',
  'btoa',
  'encodeURI',
  'decodeURI',
  'encodeURIComponent',
  'decodeURIComponent',
  'escape',
  'unescape',
  'eval',
  'isFinite',
  'isNaN',
  'parseInt',
  'parseFloat',
  'queueMicrotask',
  'structuredClone',
  'reportError',
  'createImageBitmap',
  'postMessage',
]);

function runGlobalVariables(limit: number): string {
  const snapshot = getSnapshot();

  const globals: Array<{
    name: string;
    target_id: number;
    target_name: string;
    target_type: string;
    retained_size: number;
  }> = [];

  snapshot.nodes.forEach(node => {
    if (!node.name.startsWith('Window ')) return;

    for (const edge of node.references) {
      const edgeName = String(edge.name_or_index);
      if (BUILTIN_GLOBALS.has(edgeName)) continue;
      if (edge.type === 'hidden' || edge.type === 'internal') continue;
      if (edgeName.startsWith('<symbol>')) continue;
      const target = edge.toNode;
      if (
        target.type === 'hidden' ||
        target.type === 'array' ||
        target.type === 'number'
      )
        continue;

      globals.push({
        name: edgeName,
        target_id: target.id,
        target_name: target.name,
        target_type: target.type,
        retained_size: target.retainedSize,
      });
    }
  });

  globals.sort((a, b) => b.retained_size - a.retained_size);
  const topGlobals = globals.slice(0, limit);

  if (topGlobals.length === 0) {
    return '## Global Variables\n\nNo non-built-in global variables found.';
  }

  const headers = ['Variable', 'Target ID', 'Target Name', 'Type', 'Retained'];
  const rightCols = new Set([4]);
  const rows = topGlobals.map(g => [
    g.name,
    `@${g.target_id}`,
    g.target_name,
    g.target_type,
    formatBytes(g.retained_size),
  ]);
  return `## Global Variables\n\n${topGlobals.length} found\n\n${markdownTable(headers, rows, rightCols)}`;
}

// --- Class Histogram analysis ---

function runClassHistogram(limit: number): string {
  const snapshot = getSnapshot();

  const classMap = new Map<
    string,
    {count: number; total_self_size: number; type: string}
  >();

  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;

    const key = `${node.type}::${node.name}`;
    const entry = classMap.get(key);
    if (entry) {
      entry.count++;
      entry.total_self_size += node.self_size;
    } else {
      classMap.set(key, {
        count: 1,
        total_self_size: node.self_size,
        type: node.type,
      });
    }
  });

  // Sort by total self size (avoids expensive dominator computation in the report)
  const sorted = [...classMap.entries()]
    .sort((a, b) => b[1].total_self_size - a[1].total_self_size)
    .slice(0, limit);

  const headers = ['Class', 'Type', 'Count', 'Self Size'];
  const rightCols = new Set([2, 3]);
  const rows = sorted.map(([key, v]) => {
    const name = key.split('::').slice(1).join('::');
    return [
      name,
      v.type,
      formatNumber(v.count),
      formatBytes(v.total_self_size),
    ];
  });

  return `## Class Histogram\n\n${formatNumber(classMap.size)} total classes, showing ${rows.length}\n\n${markdownTable(headers, rows, rightCols)}`;
}

// --- Largest Objects analysis ---

function runLargestObjects(limit: number): string {
  const snapshot = getSnapshot();
  const nodes = filterLargestObjects(snapshot, isNodeWorthInspecting, limit);
  const summaries = nodes.map(serializeNodeSummary);
  return `## Largest Objects\n\nTop ${summaries.length} by retained size\n\n${formatNodeSummaryTable(summaries)}`;
}

// --- Report definitions ---

interface ReportDef {
  name: string;
  description: string;
  run: (limit: number) => string;
}

const REPORTS: ReportDef[] = [
  {
    name: 'detached_dom',
    description:
      'Find detached DOM elements still retained in memory — common source of leaks',
    run: runDetachedDom,
  },
  {
    name: 'duplicated_strings',
    description:
      'Find duplicated string instances ranked by total size — common source of waste',
    run: runDuplicatedStrings,
  },
  {
    name: 'stale_collections',
    description:
      'Find Map/Set/Array collections holding references to detached or unmounted nodes',
    run: runStaleCollections,
  },
  {
    name: 'global_variables',
    description:
      'Find non-built-in global variables on Window, sorted by retained size',
    run: runGlobalVariables,
  },
  {
    name: 'class_histogram',
    description:
      'Show instance count and total self size per class/constructor name',
    run: runClassHistogram,
  },
  {
    name: 'largest_objects',
    description: 'Find the top objects by retained size in the heap',
    run: runLargestObjects,
  },
];

const REPORT_NAMES = REPORTS.map(r => r.name);

function runList(): string {
  const lines = REPORTS.map(r => `- **${r.name}**: ${r.description}`);
  return `# Available Memory Reports\n\n${lines.join('\n')}\n\nUse \`report: "full_analysis"\` to run all reports at once, or pick an individual report by name.`;
}

export function registerReports(server: McpServer): void {
  server.tool(
    'memlab_reports',
    'Run curated memory analysis reports — like Chrome DevTools Memory panel views. Use "list" to see available reports, pick one by name, or use "full_analysis" to run all reports for a comprehensive triage.',
    {
      report: z
        .enum(['list', 'full_analysis', ...REPORT_NAMES] as [
          string,
          string,
          ...string[],
        ])
        .optional()
        .default('list')
        .describe(
          'Which report to run: "list" shows available reports, "full_analysis" runs all, or pick one by name',
        ),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe('Maximum items per report section (default 10)'),
    },
    async ({report, limit}) => {
      try {
        if (report === 'list') {
          return textResult(runList());
        }

        if (report === 'full_analysis') {
          const sections = REPORTS.map(r => {
            try {
              return r.run(limit);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return `## ${r.name}\n\nError: ${msg}`;
            }
          });
          return textResult(
            `# Full Memory Analysis\n\n${sections.join('\n\n---\n\n')}`,
          );
        }

        // Individual report
        const def = REPORTS.find(r => r.name === report);
        if (!def) {
          return textResult(
            `Unknown report "${report}". Use report: "list" to see available reports.`,
          );
        }
        return textResult(def.run(limit));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

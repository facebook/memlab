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
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {formatBytes, markdownTable, errorResult, textResult} from '../utils.js';

// Common built-in Window properties that should be excluded.
// This is a subset of the ~780 known browser globals from MemLab's BuiltInGlobalVariables.
const BUILTIN_GLOBALS = new Set([
  // Core
  'undefined',
  'NaN',
  'Infinity',
  'globalThis',
  'self',
  'window',
  // DOM
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
  // Events
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
  // Timers
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  // Fetch / Network
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
  // Workers
  'Worker',
  'SharedWorker',
  'ServiceWorker',
  'BroadcastChannel',
  'MessageChannel',
  // Media
  'Image',
  'Audio',
  'MediaSource',
  'MediaStream',
  'MediaRecorder',
  'AudioContext',
  'OfflineAudioContext',
  'SpeechSynthesis',
  // Constructors
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
  // DOM constructors
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
  // CSS
  'CSS',
  'CSSStyleSheet',
  'CSSRule',
  'CSSStyleDeclaration',
  'getComputedStyle',
  'matchMedia',
  // Encoding
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
  // Misc
  'queueMicrotask',
  'structuredClone',
  'reportError',
  'createImageBitmap',
  'postMessage',
]);

export function registerGlobalVariables(server: McpServer): void {
  server.tool(
    'memlab_global_variables',
    'Find non-built-in global variables on the Window object, sorted by retained size. These are application-specific globals that may indicate memory issues.',
    {
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of results (default 20)'),
    },
    async ({limit}) => {
      try {
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
            // Skip built-in globals
            if (BUILTIN_GLOBALS.has(edgeName)) continue;
            // Skip internal/hidden edges
            if (edge.type === 'hidden' || edge.type === 'internal') continue;
            // Skip symbol edges
            if (edgeName.startsWith('<symbol>')) continue;
            // Skip non-inspectable target types
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

        // Sort by retained size descending
        globals.sort((a, b) => b.retained_size - a.retained_size);
        const topGlobals = globals.slice(0, limit);

        if (topGlobals.length === 0) {
          return textResult('No non-built-in global variables found.');
        }
        const headers = [
          'Variable',
          'Target ID',
          'Target Name',
          'Target Type',
          'Retained',
        ];
        const rightCols = new Set([4]);
        const rows = topGlobals.map(g => [
          g.name,
          `@${g.target_id}`,
          g.target_name,
          g.target_type,
          formatBytes(g.retained_size),
        ]);
        return textResult(
          `Global variables (${topGlobals.length} found)\n\n${markdownTable(headers, rows, rightCols)}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

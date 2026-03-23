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
import vm from 'node:vm';
import memlabCore from '@memlab/core';
const {utils} = memlabCore;
import {getSnapshot} from '../heap-state.js';
import {
  errorResult,
  textResult,
  serializeNodeSummary,
  serializeNodeDetail,
  formatBytes,
  formatNumber,
  markdownTable,
  isNodeWorthInspecting,
  filterLargestObjects,
  queryNodes,
} from '../utils.js';

const MAX_OUTPUT_SIZE = 50 * 1024; // 50KB

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '\n... [truncated, output exceeded 50KB]';
}

export function registerEval(server: McpServer): void {
  server.tool(
    'memlab_eval',
    'Execute arbitrary JavaScript code against the loaded heap snapshot. ' +
      'The code runs in a sandboxed VM with access to `snapshot` (IHeapSnapshot), ' +
      '`utils` (@memlab/core utils), and `helpers` (plugin utility functions). ' +
      'Assign your result to the `result` variable. ' +
      'No require/process/fs/network access. Read-only heap analysis only.',
    {
      code: z
        .string()
        .describe(
          'JavaScript code to execute. Must assign the output to a `result` variable. ' +
            'Available globals: snapshot (IHeapSnapshot), utils (@memlab/core utils with ' +
            'aggregateDominatorMetrics, isFiberNode, isDetachedDOMNode, etc.), ' +
            'helpers ({ serializeNodeSummary, serializeNodeDetail, formatBytes, formatNumber, ' +
            'markdownTable, isNodeWorthInspecting, filterLargestObjects, queryNodes }), ' +
            'and standard JS built-ins (Array, Object, Map, Set, JSON, Math, RegExp, console).',
        ),
      timeout_ms: z
        .number()
        .optional()
        .default(30000)
        .describe('Execution timeout in milliseconds (default 30000)'),
    },
    async ({code, timeout_ms}) => {
      try {
        const snapshot = getSnapshot();

        const consoleOutput: string[] = [];
        const capturedConsole = {
          log: (...args: unknown[]) =>
            consoleOutput.push(args.map(String).join(' ')),
          warn: (...args: unknown[]) =>
            consoleOutput.push('[warn] ' + args.map(String).join(' ')),
          error: (...args: unknown[]) =>
            consoleOutput.push('[error] ' + args.map(String).join(' ')),
          info: (...args: unknown[]) =>
            consoleOutput.push('[info] ' + args.map(String).join(' ')),
        };

        const helpers = {
          serializeNodeSummary,
          serializeNodeDetail,
          formatBytes,
          formatNumber,
          markdownTable,
          isNodeWorthInspecting,
          filterLargestObjects,
          queryNodes,
        };

        const sandbox = {
          snapshot,
          utils,
          helpers,
          console: capturedConsole,
          result: undefined as unknown,
          // Standard JS globals
          Array,
          Object,
          Map,
          Set,
          JSON,
          Math,
          RegExp,
          String,
          Number,
          Boolean,
          Date,
          Error,
          TypeError,
          RangeError,
          WeakMap,
          WeakSet,
          Symbol,
          parseInt,
          parseFloat,
          isNaN,
          isFinite,
          Infinity,
          NaN,
          undefined,
        };

        const context = vm.createContext(sandbox);
        const script = new vm.Script(code, {filename: 'memlab_eval'});
        script.runInContext(context, {timeout: timeout_ms});

        let output: string;
        try {
          output = JSON.stringify(sandbox.result, null, 2) ?? 'undefined';
        } catch {
          output = String(sandbox.result);
        }

        output = truncate(output, MAX_OUTPUT_SIZE);

        if (consoleOutput.length > 0) {
          const consolePart = truncate(
            consoleOutput.join('\n'),
            MAX_OUTPUT_SIZE - output.length > 1024 ? 4096 : 1024,
          );
          output += '\n\n--- console output ---\n' + consolePart;
        }

        return textResult(output);
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes('Script execution timed out')
        ) {
          return errorResult(
            new Error(`Execution timed out after ${timeout_ms}ms`),
          );
        }
        return errorResult(err);
      }
    },
  );
}

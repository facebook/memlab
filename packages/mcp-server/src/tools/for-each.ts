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

export function registerForEach(server: McpServer): void {
  server.tool(
    'memlab_for_each',
    'Structured map/filter/reduce over all heap nodes. ' +
      'Provide a filter predicate to select nodes, an optional map to transform them, ' +
      'and an optional reduce to aggregate results. ' +
      'All code strings receive `node` (for filter/map) or `acc, item` (for reduce), ' +
      'plus `utils` and `helpers` in scope. ' +
      'Returns an array of mapped results (capped at `limit`) or the reduced value.',
    {
      filter_code: z
        .string()
        .describe(
          'JS expression or function body: receives `node` (IHeapNode), return true to include. ' +
            'Example: "node.type === \'closure\' && node.retainedSize > 1048576"',
        ),
      map_code: z
        .string()
        .optional()
        .describe(
          'JS expression or function body: receives `node` (IHeapNode), return transformed value. ' +
            'Default: serializes node to NodeSummary. ' +
            'Example: "({ id: node.id, name: node.name, retained: node.retainedSize })"',
        ),
      reduce_code: z
        .string()
        .optional()
        .describe(
          'JS expression or function body: receives `acc` (accumulator) and `item` (mapped value), ' +
            'return new accumulator. If omitted, returns array of mapped results. ' +
            'Example: "acc + item.retained"',
        ),
      initial_value: z
        .string()
        .optional()
        .describe(
          'JSON string for the reduce initial accumulator value. ' +
            'Default: "[]" when reduce_code is present, ignored otherwise. ' +
            'Example: "0" or "{}"',
        ),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe('Max results when not reducing (default 100)'),
      timeout_ms: z
        .number()
        .optional()
        .default(30000)
        .describe('Execution timeout in milliseconds (default 30000)'),
    },
    async ({
      filter_code,
      map_code,
      reduce_code,
      initial_value,
      limit,
      timeout_ms,
    }) => {
      try {
        const snapshot = getSnapshot();

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
          // Internal: will be set by the orchestration script
          __filter: null as unknown,
          __map: null as unknown,
          __reduce: null as unknown,
          __result: undefined as unknown,
        };

        const context = vm.createContext(sandbox);

        // Compile filter function
        const filterScript = new vm.Script(
          `__filter = (function(node) { return (${filter_code}); });`,
          {filename: 'memlab_for_each:filter'},
        );
        filterScript.runInContext(context, {timeout: 5000});

        // Compile map function
        if (map_code) {
          const mapScript = new vm.Script(
            `__map = (function(node) { return (${map_code}); });`,
            {filename: 'memlab_for_each:map'},
          );
          mapScript.runInContext(context, {timeout: 5000});
        } else {
          const defaultMapScript = new vm.Script(
            `__map = (function(node) { return helpers.serializeNodeSummary(node); });`,
            {filename: 'memlab_for_each:default_map'},
          );
          defaultMapScript.runInContext(context, {timeout: 5000});
        }

        // Compile reduce function if provided
        if (reduce_code) {
          const reduceScript = new vm.Script(
            `__reduce = (function(acc, item) { return (${reduce_code}); });`,
            {filename: 'memlab_for_each:reduce'},
          );
          reduceScript.runInContext(context, {timeout: 5000});
        }

        // Build and run the iteration logic
        const isReducing = reduce_code != null;
        const initVal = initial_value ?? (isReducing ? '[]' : undefined);

        let iterationCode: string;
        if (isReducing) {
          iterationCode = `
            (function() {
              var acc = ${initVal};
              snapshot.nodes.forEach(function(node) {
                if (__filter(node)) {
                  var item = __map(node);
                  acc = __reduce(acc, item);
                }
              });
              __result = acc;
            })();
          `;
        } else {
          iterationCode = `
            (function() {
              var results = [];
              var count = 0;
              var limit = ${limit};
              snapshot.nodes.forEach(function(node) {
                if (count >= limit) return;
                if (__filter(node)) {
                  results.push(__map(node));
                  count++;
                }
              });
              __result = results;
            })();
          `;
        }

        const iterScript = new vm.Script(iterationCode, {
          filename: 'memlab_for_each:iterate',
        });
        iterScript.runInContext(context, {timeout: timeout_ms});

        let output: string;
        try {
          output = JSON.stringify(sandbox.__result, null, 2) ?? 'undefined';
        } catch {
          output = String(sandbox.__result);
        }

        output = truncate(output, MAX_OUTPUT_SIZE);
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

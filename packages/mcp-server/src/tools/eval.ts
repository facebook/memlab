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
  toolResult,
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

const NODE_PROPERTY_ALIASES: Record<string, string> = {
  retained_size: 'retainedSize',
  referrer_count: 'numOfReferrers',
};

function wrapNode(node: unknown): unknown {
  if (node == null) return node;
  return new Proxy(node as object, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in NODE_PROPERTY_ALIASES) {
        return (target as Record<string, unknown>)[NODE_PROPERTY_ALIASES[prop]];
      }
      const val = Reflect.get(target, prop, receiver);
      if (prop === 'references' || prop === 'referrers') {
        return wrapEdgeIterable(val);
      }
      if (prop === 'dominatorNode' || prop === 'pathEdge') {
        if (val != null && typeof val === 'object' && 'fromNode' in val) {
          return wrapEdge(val);
        }
        if (val != null && typeof val === 'object' && 'id' in val) {
          return wrapNode(val);
        }
      }
      return val;
    },
  });
}

function wrapEdge(edge: unknown): unknown {
  if (edge == null) return edge;
  return new Proxy(edge as object, {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);
      if (prop === 'toNode' || prop === 'fromNode') {
        return wrapNode(val);
      }
      return val;
    },
  });
}

function wrapEdgeIterable(iterable: unknown): unknown {
  if (iterable == null) return iterable;
  const original = iterable as Iterable<unknown>;
  return {
    [Symbol.iterator]() {
      const iter = original[Symbol.iterator]();
      return {
        next() {
          const result = iter.next();
          if (result.done) return result;
          return {done: false, value: wrapEdge(result.value)};
        },
      };
    },
  };
}

function wrapSnapshot(snapshot: unknown): unknown {
  return new Proxy(snapshot as object, {
    get(target, prop, receiver) {
      if (prop === 'getNodeById') {
        const orig = (
          target as Record<string, (...args: unknown[]) => unknown>
        ).getNodeById.bind(target);
        return (id: number) => wrapNode(orig(id));
      }
      if (prop === 'nodes') {
        const nodes = Reflect.get(target, prop, receiver);
        return new Proxy(nodes as object, {
          get(nodesTarget, nodesProp, nodesReceiver) {
            if (nodesProp === 'forEach') {
              const origForEach = (
                nodesTarget as Record<string, (...args: unknown[]) => unknown>
              ).forEach.bind(nodesTarget);
              return (cb: (node: unknown) => void) => {
                origForEach((node: unknown) => cb(wrapNode(node)));
              };
            }
            return Reflect.get(nodesTarget, nodesProp, nodesReceiver);
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function registerEval(server: McpServer): void {
  server.tool(
    'memlab_eval',
    'Execute arbitrary JavaScript code against the loaded heap snapshot. ' +
      'The code runs in a sandboxed VM with access to `snapshot` (IHeapSnapshot), ' +
      '`utils` (@memlab/core utils), and `helpers` (plugin utility functions). ' +
      'Assign your result to the `result` variable. ' +
      'No require/process/fs/network access. Read-only heap analysis only.\n\n' +
      '**IHeapNode API:** Each node has: `.id`, `.name`, `.type`, `.self_size`, ' +
      '`.retained_size` (alias: `.retainedSize`), `.edge_count`, `.is_detached`, ' +
      '`.referrer_count` (alias: `.numOfReferrers`), `.isString`, `.hasPathEdge`, ' +
      '`.pathEdge`, `.dominatorNode`, `.location` (script_id/line/column).\n' +
      '**Traversal:** Use `node.references` (outgoing edges, iterable with for-of) and ' +
      '`node.referrers` (incoming edges, iterable with for-of). ' +
      'Each edge has: `.name_or_index`, `.type` (property/element/context/internal/hidden/shortcut), ' +
      '`.toNode`, `.fromNode`.\n' +
      '**Iterating all nodes:** `snapshot.nodes.forEach(node => { ... })` — NOT for-of.\n' +
      '**Get node by ID:** `snapshot.getNodeById(id)` returns IHeapNode or null.\n' +
      '**String values:** `node.toStringNode()?.stringValue` for string nodes.\n\n' +
      '**Example — inspect Map entries:**\n' +
      '```\nconst map = snapshot.getNodeById(12345);\nconst entries = [];\n' +
      'for (const edge of map.references) {\n' +
      '  if (edge.name_or_index === "table") {\n' +
      '    for (const te of edge.toNode.references) {\n' +
      '      entries.push({name: te.toNode.name, type: te.toNode.type});\n' +
      '    }\n  }\n}\nresult = entries.slice(0, 10);\n```',
    {
      code: z
        .string()
        .describe(
          'JavaScript code to execute. Must assign the output to a `result` variable. ' +
            'Available globals: snapshot (IHeapSnapshot — use .nodes.forEach(), .getNodeById(), .edges.forEach()), ' +
            'utils (@memlab/core utils with aggregateDominatorMetrics, isFiberNode, isDetachedDOMNode), ' +
            'helpers ({ serializeNodeSummary, serializeNodeDetail, formatBytes, formatNumber, ' +
            'markdownTable, isNodeWorthInspecting, filterLargestObjects, queryNodes, ' +
            'groupReferrersByEdge(nodeId), groupArrayElementsByProperty(arrayNodeId, propName), ' +
            'isOrphaned(nodeId, ownershipEdgeNames[]), countUniqueTargets(arrayNodeId, propName) }), ' +
            'and standard JS built-ins. ' +
            'Node traversal: use node.references (outgoing) and node.referrers (incoming) with for-of. ' +
            'Edge properties: .name_or_index, .type, .toNode, .fromNode.',
        ),
      timeout_ms: z
        .number()
        .optional()
        .default(60000)
        .describe(
          'Execution timeout in milliseconds (default 60000). Full-snapshot scans on large heaps may need 120000+.',
        ),
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

        const groupReferrersByEdge = (nodeId: number) => {
          const target = snapshot.getNodeById(nodeId);
          if (!target) return {};
          const groups: Record<
            string,
            Array<{fromName: string; fromType: string; fromId: number}>
          > = {};
          for (const edge of target.referrers) {
            const eName = String(edge.name_or_index);
            const from = edge.fromNode;
            if (!groups[eName]) groups[eName] = [];
            if (groups[eName].length < 10) {
              groups[eName].push({
                fromName: from.name,
                fromType: from.type,
                fromId: from.id,
              });
            }
          }
          return groups;
        };

        const groupArrayElementsByProperty = (
          arrayNodeId: number,
          propertyName: string,
        ) => {
          const arrNode = snapshot.getNodeById(arrayNodeId);
          if (!arrNode) return {error: 'Node not found'};
          const groups: Record<string, {count: number; exampleId: number}> = {};
          let missing = 0;
          let total = 0;
          for (const edge of arrNode.references) {
            if (edge.type !== 'element') continue;
            const elem = edge.toNode;
            if (elem.id <= 3) continue;
            total++;
            let found = false;
            for (const propEdge of elem.references) {
              if (String(propEdge.name_or_index) === propertyName) {
                const target = propEdge.toNode;
                const key = target.name;
                if (!groups[key])
                  groups[key] = {count: 0, exampleId: target.id};
                groups[key].count++;
                found = true;
                break;
              }
            }
            if (!found) missing++;
          }
          return {groups, total, missing};
        };

        const isOrphaned = (nodeId: number, ownershipEdgeNames: string[]) => {
          const target = snapshot.getNodeById(nodeId);
          if (!target) return false;
          const ownerSet = new Set(ownershipEdgeNames);
          for (const edge of target.referrers) {
            if (ownerSet.has(String(edge.name_or_index))) return false;
          }
          return true;
        };

        const countUniqueTargets = (
          arrayNodeId: number,
          propertyName: string,
        ) => {
          const arrNode = snapshot.getNodeById(arrayNodeId);
          if (!arrNode) return {error: 'Node not found'};
          const uniqueIds = new Set<number>();
          let total = 0;
          for (const edge of arrNode.references) {
            if (edge.type !== 'element') continue;
            const elem = edge.toNode;
            if (elem.id <= 3) continue;
            total++;
            for (const propEdge of elem.references) {
              if (String(propEdge.name_or_index) === propertyName) {
                uniqueIds.add(propEdge.toNode.id);
                break;
              }
            }
          }
          return {uniqueCount: uniqueIds.size, totalElements: total};
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
          groupReferrersByEdge,
          groupArrayElementsByProperty,
          isOrphaned,
          countUniqueTargets,
        };

        const sandbox = {
          snapshot: wrapSnapshot(snapshot),
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

        return toolResult(output);
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

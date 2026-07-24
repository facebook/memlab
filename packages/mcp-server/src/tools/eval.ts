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
import type {IHeapNode} from '@memlab/core';
import {z} from 'zod';
import vm from 'node:vm';
import memlabCore from '@memlab/core';
const {utils, NumericSet} = memlabCore;
import {getSnapshot, getEvalScratch} from '../heap-state.js';
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
  enumerateMapEntries,
  enumerateSetElements,
  objectContentSignature,
  boundedDominatorRetainedSize,
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
      '**String values:** `node.toStringNode()?.stringValue` for string nodes.\n' +
      '**Caveat — retained_size is unreliable here:** inside eval, `node.retained_size`/`.retainedSize` can read back ~0 for every node on some loads. Node counts, property/edge walks, and string values ARE trustworthy. For authoritative retained sizes call `helpers.retainedSize(id)` (number) / `helpers.retainedSizes([ids])` (a `Record<id, bytes>` object, NOT an array) — they re-resolve the node on the real snapshot — or use the dedicated tools (`memlab_largest_objects`, `memlab_class_histogram`, `memlab_pinch_points`, `memlab_object_shape`).\n\n' +
      '**Example — inspect Map entries (use the helper; do NOT hand-roll the ' +
      'backing-store walk — browser slots are `internal`-typed and SMI values ' +
      'leave index gaps):**\n' +
      '```\nresult = helpers.mapEntries(12345, 10);  // [{key, value}] briefs\n' +
      '// Set: helpers.setElements(setId, 10)\n```\n' +
      '**Example — dedup / composition of a Relay record type:**\n' +
      '```\nconst ids = helpers.byTypename("AdCreativeFeatureSpecAttachment");\n' +
      'const sigs = {};\n' +
      'for (const id of ids) { const s = helpers.shapeSignature(id); sigs[s] = (sigs[s]||0)+1; }\n' +
      'result = {count: ids.length, distinct: Object.keys(sigs).length};\n```',
    {
      mode: z
        .enum(['eval', 'describe_env'])
        .optional()
        .default('eval')
        .describe(
          '"eval" (default) runs `code`. "describe_env" ignores `code` and returns the in-scope globals, the IHeapNode/IHeapEdge API, and the required calling conventions (`result =`, `.forEach`) so you can self-correct before running.',
        ),
      code: z
        .string()
        .optional()
        .describe(
          'JavaScript code to execute. Must assign the output to a `result` variable. ' +
            'Available globals: snapshot (IHeapSnapshot — use .nodes.forEach(), .getNodeById(), .edges.forEach()), ' +
            'utils (@memlab/core utils with aggregateDominatorMetrics, isFiberNode, isDetachedDOMNode), ' +
            'helpers ({ serializeNodeSummary, serializeNodeDetail, formatBytes, formatNumber, ' +
            'markdownTable, isNodeWorthInspecting, filterLargestObjects, queryNodes, ' +
            'groupReferrersByEdge(nodeId), groupArrayElementsByProperty(arrayNodeId, propName), ' +
            'isOrphaned(nodeId, ownershipEdgeNames[]), countUniqueTargets(arrayNodeId, propName), ' +
            'retainedSize(id)->number, retainedSizes(ids[])->Record<id,bytes> (an OBJECT keyed by id, NOT an array — index it as sizes[id] or Object.values(sizes)), ' +
            'mapEntries(mapId, limit?)->[{key,value}] & setElements(setId, limit?)->[brief] (correct Map/Set/WeakMap enumeration — handles browser internal-typed slots AND SMI-value gaps, so you never re-derive it wrong), ' +
            'props(nodeOrId)->{prop: scalar | {ref,name,type}} & getProp(nodeOrId, name) & shapeSignature(nodeOrId, {maxStringLen?}) (content signature for dedup checks), ' +
            'byClass(name)->ids[] & byTypename(name)->ids[] & withProp(name)->ids[] (INDEXED lookups — built once per snapshot then memoized in a session scratch, so repeated questions are index-speed not full-scan), ' +
            'aggregateRetained(ids[])->{retained,exact} (dominator-deduped retained for a SET of ids, no double-counting) }), ' +
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
    async ({mode, code, timeout_ms}) => {
      try {
        if (mode === 'describe_env') {
          return toolResult(describeEnv());
        }
        if (code == null || code.trim() === '') {
          return errorResult(
            new Error(
              'No code provided. Pass `code`, or use mode:"describe_env" to see the available globals and conventions.',
            ),
          );
        }
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

        // Authoritative retained sizes (Feedback round 3 §3b). Reading
        // `.retainedSize` off proxied/iterated nodes inside eval can come back
        // ~0; these helpers look the node up fresh on the real snapshot (the
        // same path the dedicated tools use) so custom analyses can rank by
        // retained size.
        const retainedSize = (id: number): number => {
          const n = snapshot.getNodeById(id);
          return n ? n.retainedSize : 0;
        };
        const retainedSizes = (ids: number[]): Record<number, number> => {
          const out: Record<number, number> = {};
          for (const id of ids) {
            const n = snapshot.getNodeById(id);
            out[id] = n ? n.retainedSize : 0;
          }
          return out;
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

        // Compact, ready-to-use view of a node (no proxy, values inlined) so
        // custom scripts get data they can JSON-return directly instead of
        // re-deriving `.toStringNode()?.stringValue` etc. `retained_size` is
        // resolved via the trusted `retainedSize(id)` re-lookup (NOT the raw
        // `.retainedSize`, which can read back ~0 inside eval on some loads — the
        // foot-gun this whole tool's description warns about).
        const nodeBrief = (n: IHeapNode | null | undefined) =>
          n == null
            ? null
            : {
                id: n.id,
                name: n.name,
                type: n.type,
                self_size: n.self_size,
                retained_size: retainedSize(n.id),
                string: n.isString
                  ? (n.toStringNode()?.stringValue ?? null)
                  : null,
              };

        const resolveNode = (
          nodeOrId: number | {id: number} | null | undefined,
        ): IHeapNode | null => {
          if (nodeOrId == null) return null;
          const id = typeof nodeOrId === 'number' ? nodeOrId : nodeOrId.id;
          return snapshot.getNodeById(id);
        };

        // Correctly enumerate Map/WeakMap entries and Set elements via the shared
        // index-aware backing-store walk (handles browser `internal`-typed slots
        // AND SMI-value gaps). Removes the #1 eval foot-gun: hand-rolling this
        // and silently getting 0 results by filtering on `type === 'element'`.
        const mapEntries = (id: number, limit = 1000) => {
          const node = snapshot.getNodeById(id);
          if (!node) throw new Error(`mapEntries: node @${id} not found`);
          // Guard the node type — enumerateMapEntries assumes key/value slots, so
          // running it on a Set (element/chain layout) would emit each element as
          // a lone key with value:null, which is silently misleading.
          if (node.name !== 'Map' && node.name !== 'WeakMap') {
            throw new Error(
              `mapEntries: @${id} is a ${node.name} (${node.type}), not a Map/WeakMap. ` +
                `For a Set use helpers.setElements(${id}); otherwise inspect with helpers.props()/get_references.`,
            );
          }
          return enumerateMapEntries(node)
            .slice(0, limit)
            .map(e => ({key: nodeBrief(e.key), value: nodeBrief(e.value)}));
        };
        const setElements = (id: number, limit = 1000) => {
          const node = snapshot.getNodeById(id);
          if (!node) throw new Error(`setElements: node @${id} not found`);
          if (node.name !== 'Set' && node.name !== 'WeakSet') {
            throw new Error(
              `setElements: @${id} is a ${node.name} (${node.type}), not a Set/WeakSet. ` +
                `For a Map use helpers.mapEntries(${id}).`,
            );
          }
          return enumerateSetElements(node).slice(0, limit).map(nodeBrief);
        };

        // Read an object's own properties as a plain object: scalars inlined,
        // object-valued props as `{ref, name, type}`. Saves the repetitive
        // `for (const e of n.references) if (e.name_or_index === X)` boilerplate.
        const props = (
          nodeOrId: number | {id: number},
        ): Record<string, unknown> => {
          const node = resolveNode(nodeOrId);
          if (!node) return {};
          const out: Record<string, unknown> = {};
          for (const e of node.references) {
            if (e.type !== 'property') continue;
            const name = String(e.name_or_index);
            if (name === '__proto__') continue;
            const t = e.toNode;
            if (t.isString) out[name] = t.toStringNode()?.stringValue ?? '';
            else if (t.name === 'true') out[name] = true;
            else if (t.name === 'false') out[name] = false;
            else if (t.name === 'null') out[name] = null;
            else if (t.name === 'undefined') out[name] = undefined;
            else out[name] = {ref: t.id, name: t.name, type: t.type};
          }
          return out;
        };
        const getProp = (nodeOrId: number | {id: number}, name: string) =>
          props(nodeOrId)[name];

        const shapeSignature = (
          nodeOrId: number | {id: number},
          opts?: {maxStringLen?: number; ignoreProps?: ReadonlySet<string>},
        ): string => {
          const node = resolveNode(nodeOrId);
          return node ? objectContentSignature(node, opts ?? {}) : '';
        };

        // Index helpers — build once per snapshot, memoized in the eval scratch
        // so a follow-up call is index-speed, not a fresh 12M-node scan. Ids are
        // only valid for the active snapshot (the scratch is keyed to it).
        const scratch = getEvalScratch();
        interface ClassTypeIndex {
          byClass: Map<string, number[]>;
          byTypename: Map<string, number[]>;
        }
        const buildClassTypeIndex = (): ClassTypeIndex => {
          const cached = scratch.__classTypeIndex as ClassTypeIndex | undefined;
          if (cached) return cached;
          const byClass = new Map<string, number[]>();
          const byTypename = new Map<string, number[]>();
          snapshot.nodes.forEach((node: IHeapNode) => {
            if (node.type !== 'object') return;
            if (node.id <= 3) return; // skip oddball/root nodes, matching the histogram/duplicate-objects tools for count parity
            let a = byClass.get(node.name);
            if (!a) {
              a = [];
              byClass.set(node.name, a);
            }
            a.push(node.id);
            for (const e of node.references) {
              if (
                e.type === 'property' &&
                String(e.name_or_index) === '__typename'
              ) {
                const t = e.toNode;
                const tn = t.isString ? t.toStringNode()?.stringValue : null;
                if (tn) {
                  let b = byTypename.get(tn);
                  if (!b) {
                    b = [];
                    byTypename.set(tn, b);
                  }
                  b.push(node.id);
                }
                break;
              }
            }
          });
          const idx: ClassTypeIndex = {byClass, byTypename};
          scratch.__classTypeIndex = idx;
          return idx;
        };
        const byClass = (name: string): number[] =>
          buildClassTypeIndex().byClass.get(name) ?? [];
        const byTypename = (name: string): number[] =>
          buildClassTypeIndex().byTypename.get(name) ?? [];
        const withProp = (name: string): number[] => {
          const key = `__withProp:${name}`;
          const cached = scratch[key] as number[] | undefined;
          if (cached) return cached;
          const ids: number[] = [];
          snapshot.nodes.forEach((node: IHeapNode) => {
            if (node.type !== 'object') return;
            if (node.id <= 3) return; // skip oddball/root nodes for parity with other tools
            for (const e of node.references) {
              if (e.type === 'property' && String(e.name_or_index) === name) {
                ids.push(node.id);
                break;
              }
            }
          });
          scratch[key] = ids;
          return ids;
        };

        // Dominator-deduped retained size for a SET of ids (bounded walk). Unlike
        // summing helpers.retainedSize over the ids, this does not double-count
        // bytes when one id dominates another in the set.
        const aggregateRetained = (
          ids: number[],
        ): {retained: number; exact: boolean} =>
          boundedDominatorRetainedSize(new NumericSet(ids), snapshot);

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
          retainedSize,
          retainedSizes,
          nodeBrief,
          mapEntries,
          setElements,
          props,
          getProp,
          shapeSignature,
          byClass,
          byTypename,
          withProp,
          aggregateRetained,
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

        // Actionable hint when nothing was assigned to `result` (the #1 user
        // error — code that `return`s a value or runs a value-returning IIFE
        // never populates `result`, so output is silently "undefined").
        if (sandbox.result === undefined && consoleOutput.length === 0) {
          return toolResult(
            'Your code ran without error but never assigned to `result`, so there is nothing to return.\n' +
              'Assign the value you want back to `result` (do NOT use `return` at the top level), e.g.:\n' +
              '  `result = someValue;`\n' +
              'Use mode:"describe_env" to see the full calling convention.',
          );
        }

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
        return errorResult(new Error(actionableEvalError(err, code)));
      }
    },
  );
}

// Map the opaque VM errors that the documented calling-convention mistakes
// produce into actionable guidance (Feedback §3).
function actionableEvalError(err: unknown, code: string | undefined): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('Script execution timed out')) {
    return `Execution timed out. Increase timeout_ms, or narrow the scan (filter earlier, use a dedicated tool like memlab_find_by_property/memlab_property_distribution instead of a full snapshot.nodes walk).`;
  }
  if (msg.includes('Illegal return statement')) {
    return `Illegal return statement: you cannot \`return\` at the top level here. Assign the value to \`result\` instead — e.g. \`result = ...;\`. (Use mode:"describe_env" for the convention.)`;
  }
  if (msg.includes('is not iterable')) {
    return `${msg}\nHint: \`snapshot.nodes\` is not a for-of iterable. Use \`snapshot.nodes.forEach(node => { ... })\` (and \`snapshot.edges.forEach(...)\`). \`node.references\`/\`node.referrers\` ARE for-of iterable.`;
  }
  if (
    code &&
    /\bfor\s*\(\s*(const|let|var)\b.*\bof\b.*\bsnapshot\.nodes\b/.test(code)
  ) {
    return `${msg}\nHint: iterate all nodes with \`snapshot.nodes.forEach(node => { ... })\`, not \`for...of\`.`;
  }
  return msg;
}

function describeEnv(): string {
  return [
    '# memlab_eval environment',
    '',
    '## Calling conventions (REQUIRED)',
    '- Assign your output to `result` — do NOT use `return` at the top level (that throws "Illegal return statement").',
    '- Iterate all nodes with `snapshot.nodes.forEach(node => { ... })` and all edges with `snapshot.edges.forEach(...)`. `snapshot.nodes` is NOT a for-of iterable.',
    '- `node.references` (outgoing) and `node.referrers` (incoming) ARE for-of iterable.',
    '',
    '## In-scope globals',
    '- `snapshot` — IHeapSnapshot: `.nodes.forEach(cb)`, `.edges.forEach(cb)`, `.getNodeById(id)`.',
    '- `utils` — @memlab/core utils (e.g. `aggregateDominatorMetrics`, `isFiberNode`, `isDetachedDOMNode`).',
    '- `helpers` — `serializeNodeSummary`, `serializeNodeDetail`, `formatBytes`, `formatNumber`, `markdownTable`, `isNodeWorthInspecting`, `filterLargestObjects`, `queryNodes`, `groupReferrersByEdge(nodeId)`, `groupArrayElementsByProperty(arrayNodeId, prop)`, `isOrphaned(nodeId, ownerEdges[])`, `countUniqueTargets(arrayNodeId, prop)`, `retainedSize(id) -> number`, `retainedSizes(ids[]) -> Record<id, bytes>` (an OBJECT keyed by id, NOT an array — use `sizes[id]` or `Object.values(sizes)`, not `.reduce`/`.map` directly).',
    '- Standard JS built-ins (Array, Object, Map, Set, JSON, Math, RegExp, …). No require/process/fs/network.',
    '',
    '## Collection / shape / index helpers (prefer these over hand-rolling)',
    '- `helpers.mapEntries(mapId, limit=1000) -> [{key, value}]` and `helpers.setElements(setId, limit=1000) -> [brief]` — CORRECT Map/Set/WeakMap enumeration. Handles browser `internal`-typed backing slots and SMI-value gaps (naive `type === "element"` filtering or positional `[i],[i+1]` pairing silently returns 0 / mispairs). Each brief is `{id, name, type, self_size, retained_size, string}`.',
    "- `helpers.props(nodeOrId) -> {prop: scalar | {ref, name, type}}` and `helpers.getProp(nodeOrId, name)` — read an object's own properties without the `for (const e of n.references) …` boilerplate. Number-valued props surface as a ref to a `smi number`/`heap number` node; their actual numeric value is not in the snapshot format.",
    '- `helpers.shapeSignature(nodeOrId, {maxStringLen?}) -> string` — stable shallow content signature (sorted prop names + scalar values) for duplicate-record detection. Numeric values are NOT captured (see `memlab_duplicate_objects`), so records differing only in a number field hash the same.',
    '- `helpers.byClass(name) -> ids[]`, `helpers.byTypename(name) -> ids[]`, `helpers.withProp(name) -> ids[]` — INDEXED id lookups. The class/typename index is built once per snapshot and memoized in a session scratch, so a follow-up call is index-speed, not another full `snapshot.nodes` scan. (See also the `memlab_duplicate_objects` tool for a ready-made dedup report.)',
    '- `helpers.aggregateRetained(ids[]) -> {retained, exact}` — dominator-deduped retained size for a SET of ids (does not double-count when one id dominates another); `exact:false` means the bounded walk was truncated (upper bound).',
    '',
    '## IHeapNode API',
    '`.id`, `.name`, `.type`, `.self_size`, `.retainedSize` (alias `.retained_size`), `.edge_count`, `.is_detached`, `.numOfReferrers` (alias `.referrer_count`), `.isString`, `.toStringNode()?.stringValue`, `.hasPathEdge`, `.pathEdge`, `.dominatorNode`, `.location` (`script_id`/`line`/`column`).',
    '',
    '## Caveat: retained_size',
    'Inside eval, `.retainedSize`/`.retained_size` can read back ~0 for every node on some loads. Counts, property/edge walks, and string values are reliable. For authoritative retained sizes call `helpers.retainedSize(id)` (returns a number) or `helpers.retainedSizes([ids])` (returns a `Record<id, bytes>` OBJECT — not an array; iterate with `Object.values(sizes)` / index with `sizes[id]`) — both re-resolve the node on the real snapshot, so you can rank custom analyses by retained size. Or use `memlab_largest_objects`, `memlab_class_histogram`, `memlab_pinch_points`, or `memlab_object_shape`.',
    '',
    '## IHeapEdge API',
    '`.name_or_index`, `.type` (property/element/context/internal/hidden/shortcut), `.toNode`, `.fromNode`.',
    '',
    '## Runnable example',
    '```',
    'const counts = {};',
    'snapshot.nodes.forEach(node => { counts[node.type] = (counts[node.type] || 0) + 1; });',
    'result = counts;',
    '```',
  ].join('\n');
}

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
import {
  getCurrentHandle,
  getSavedResult,
  getSnapshot,
  isLightSnapshot,
  listSavedResults,
  setSavedResult,
  getEvalScratch,
  getSnapshotMetadata,
} from '../heap-state.js';
import {
  errorResult,
  toolResult,
  serializeNodeSummary,
  serializeNodeDetail,
  formatBytes,
  formatNumber,
  markdownTable,
  isNodeWorthInspecting,
  makeNamePatternTest,
  filterLargestObjects,
  queryNodes,
  enumerateMapEntries,
  enumerateSetElements,
  objectContentSignature,
  boundedDominatorRetainedSize,
} from '../utils.js';

const MAX_OUTPUT_SIZE = 50 * 1024; // 50KB

// Prefix for user-named result sets inside the per-snapshot eval scratch, so
// they cannot collide with the internal `__classTypeIndex` / `__withProp:` keys.

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '\n... [truncated, output exceeded 50KB]';
}

/**
 * Node-visit budget for a single eval call. `snapshot.nodes.forEach` increments
 * it; exceeding `max` aborts the walk by throwing `BudgetExceeded`, which the
 * handler catches so a partial `result` is still returned with a truncation
 * note. Without this a broad exploratory scan either completes or dies at the
 * wall-clock timeout with nothing to show, which pushes callers to pre-narrow.
 */
interface VisitBudget {
  visited: number;
  max: number;
  exceeded: boolean;
}

class BudgetExceeded extends Error {
  constructor(max: number) {
    super(`max_nodes budget of ${max} exhausted`);
    this.name = 'BudgetExceeded';
  }
}

const NODE_PROPERTY_ALIASES: Record<string, string> = {
  referrer_count: 'numOfReferrers',
};

/**
 * Lets helpers recover the real node behind a sandbox proxy. Sandbox code holds
 * proxies; the helpers it passes them to need the underlying object, both to
 * avoid proxy overhead per property read and because the proxy deliberately
 * refuses `retainedSize` (below) while the helpers legitimately read it.
 */
const RAW_NODE: unique symbol = Symbol('memlabRawNode');

export function unwrapNode<T>(node: T): T {
  if (node != null && typeof node === 'object') {
    const raw = (node as Record<symbol, unknown>)[RAW_NODE];
    if (raw != null) return raw as T;
  }
  return node;
}

function unwrapNodes<T>(nodes: T[]): T[] {
  return Array.isArray(nodes) ? nodes.map(unwrapNode) : nodes;
}

/**
 * `node.retainedSize` read off a node inside eval has been observed to come
 * back ~0 for every node on some loads, while the same id read through
 * `snapshot.getNodeById(id).retainedSize` returns the true value. A field that
 * silently yields a wrong NUMBER is worse than one that fails: every ranking
 * built on it looks plausible and is wrong, and nothing in the output says so.
 *
 * So the sandbox refuses the read and names the working call. The docs already
 * carried this as a caveat; a caveat is only as good as the reader's memory of
 * it, and this class of silent-zero bug has produced published errors before.
 */
const RETAINED_SIZE_PROPS = new Set(['retainedSize', 'retained_size']);

function wrapNode(node: unknown): unknown {
  if (node == null) return node;
  return new Proxy(node as object, {
    get(target, prop, receiver) {
      if (prop === RAW_NODE) return target;
      if (typeof prop === 'string' && RETAINED_SIZE_PROPS.has(prop)) {
        const id = (target as {id?: unknown}).id;
        throw new Error(
          `node.${prop} is not readable inside eval — it can come back ~0 for every node on some loads, which silently corrupts any ranking built on it. ` +
            `Use helpers.retainedSize(${typeof id === 'number' ? id : 'id'}) for one node, helpers.retainedSizes([ids]) for many, or helpers.aggregateRetained([ids]) for a dominator-deduped total. ` +
            'Self size (`node.self_size`) is read directly from the snapshot and IS reliable here.',
        );
      }
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

function wrapSnapshot(snapshot: unknown, budget: VisitBudget): unknown {
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
              return (cb: (node: unknown) => unknown) => {
                origForEach((node: unknown) => {
                  if (++budget.visited > budget.max) {
                    budget.exceeded = true;
                    throw new BudgetExceeded(budget.max);
                  }
                  // Returning `false` from the callback breaks the walk, so the
                  // callback's return value has to be passed through.
                  return cb(wrapNode(node));
                });
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

/**
 * Identifiers whose value comes from the dominator / retained-size / shortest-
 * path pass that a LIGHT load skips. On such a snapshot each of these reads
 * back 0 or undefined WITHOUT failing, so eval code using them returns
 * confident zeros — worse than an error. Matched textually before the code
 * runs, so the refusal costs nothing.
 */
const RETENTION_IDENTIFIERS = [
  'retainedSize',
  'retainedSizes',
  'retained_size',
  'aggregateRetained',
  'dominatorNode',
  'hasPathEdge',
  'pathEdge',
  'filterLargestObjects',
];

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
      'result = {count: ids.length, distinct: Object.keys(sigs).length};\n```\n' +
      '**Multi-step exploration:** pass `save_as` to keep a result set server-side and `helpers.load(name)` to read it back in a later call, so intermediate id lists never have to be printed to the transcript. `mode:"list_saved"` lists them. ' +
      'Runs on a LIGHT snapshot too (counts, names, types, self sizes, string values, edge walks). Code referencing retained sizes, dominators or path edges is refused up front there rather than returning zeros. ' +
      'Pass `max_nodes` to bound a full-heap walk — on overrun the partial `result` is returned with a warning instead of failing, so a broad scan is safe to attempt. Every call reports `nodes_visited`.',
    {
      mode: z
        .enum(['eval', 'describe_env', 'list_saved'])
        .optional()
        .default('eval')
        .describe(
          '"eval" (default) runs `code`. "describe_env" ignores `code` and returns the in-scope globals, the IHeapNode/IHeapEdge API, and the required calling conventions (`result =`, `.forEach`) so you can self-correct before running. "list_saved" ignores `code` and lists the named result sets saved so far for this snapshot.',
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
            'byClass(name, {type?})->ids[] & byTypename(name)->ids[] & withProp(name)->ids[] (INDEXED lookups — built once per snapshot then memoized in a session scratch, so repeated questions are index-speed not full-scan; byClass covers EVERY node type, matching memlab_find_nodes_by_class, so closures/strings/arrays/natives are found — pass {type:"object"} to narrow), ' +
            'aggregateRetained(ids[])->{retained,exact} (dominator-deduped retained for a SET of ids, no double-counting), ' +
            'iterByClass(name, {type?})->nodes[] & iterByType(type)->nodes[] (INDEXED iteration — no full scan), ' +
            'classCounts({pattern?, type?, minCount?})->[{name,type,count,selfSize}] (one-pass histogram, cached), ' +
            'entries(nodeOrId)->[{key,value}] (generic Map/Set/WeakMap/Array/object walk, holes filtered), ' +
            'edgeTarget(nodeOrId, edgeName)->node|null, isRealDetached(node)->boolean (same filtering the tools apply internally), ' +
            'dominates(id, {population?, limit?})->{count,selfSize,ids,truncated}, ' +
            'pathBetween(fromId, toId, {maxNodes?})->{found,exhausted,path[]}, ' +
            'save(name, value) / load(name, {allowCrossSnapshot?}) / listSaved() (SESSION-scoped, survives loading another snapshot) }), ' +
            'and standard JS built-ins. ' +
            'NOTE: `node.retainedSize` / `node.retained_size` THROW inside eval — they can read back ~0 for every node on some loads, so a silent wrong number is refused; use helpers.retainedSize(id). `node.self_size` is reliable. ' +
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
      save_as: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .optional()
        .describe(
          'Save this call\'s `result` under a name, reusable in later calls via `helpers.load("<name>")`. Lets a multi-step investigation keep intermediate sets (candidate ids, per-id measurements) SERVER-SIDE instead of round-tripping them through the transcript. Save plain data (ids, counts, strings) — not node objects. Scoped to the current snapshot and dropped when it is unloaded.',
        ),
      dry_run: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Report what the code WOULD scan and stop, without running it (default false). Returns the snapshot size, whether the code contains a full-heap walk, and the effective max_nodes budget. Use it before an exploratory scan on a multi-million-node heap, where the difference between an indexed lookup and a full walk is the difference between milliseconds and minutes.',
        ),
      max_nodes: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(20000000)
        .describe(
          'Abort a `snapshot.nodes.forEach` walk after this many node visits (default 20000000, i.e. effectively unlimited). On abort the partial `result` is returned with a note instead of failing, so a broad exploratory scan can be attempted safely. Reported back as `nodes_visited` on every call.',
        ),
    },
    async ({mode, code, timeout_ms, save_as, max_nodes, dry_run}) => {
      const budget: VisitBudget = {visited: 0, max: max_nodes, exceeded: false};
      try {
        if (mode === 'describe_env') {
          return toolResult(describeEnv());
        }
        if (mode === 'list_saved') {
          return toolResult(describeSaved());
        }
        if (code == null || code.trim() === '') {
          return errorResult(
            new Error(
              'No code provided. Pass `code`, or use mode:"describe_env" to see the available globals and conventions.',
            ),
          );
        }
        // Light snapshots are allowed here. Most eval code touches only
        // `name`, `type`, `self_size`, `references` and `referrers`, none of
        // which the dominator pass produces — refusing the whole tool forced a
        // full (2x slower) load for counts-only work on a baseline rung. What
        // IS unavailable is refused precisely instead: by a pre-flight text
        // check below, and by the helpers themselves as a backstop.
        const light = isLightSnapshot();
        const snapshot = getSnapshot({allowLight: true});
        const currentHandle = getCurrentHandle() ?? '(none)';

        if (light) {
          const needsRetention = RETENTION_IDENTIFIERS.filter(id =>
            new RegExp(`\\b${id}\\b`).test(code),
          );
          if (needsRetention.length > 0) {
            return errorResult(
              new Error(
                `This snapshot was loaded in LIGHT mode (no dominator tree, no retained sizes, no shortest-path edges), and the code references ${needsRetention.map(i => `\`${i}\``).join(', ')}. ` +
                  'Those would read 0 / undefined rather than fail, so the run is refused instead of returning confident zeros. ' +
                  'Reload without `light` for retention work, or drop the reference — counts, names, types, self sizes, string values and edge walks all work fine on a light snapshot. ' +
                  '(If the identifier only appears inside a string literal, this is a false match; the same call succeeds on a non-light load.)',
              ),
            );
          }
        }

        if (dry_run) {
          // Estimate, do not execute. A full-heap walk is detected textually —
          // the honest limit of a pre-flight check, and stated as such rather
          // than implying the code was analysed.
          const meta = getSnapshotMetadata();
          const fullWalk =
            /\b(?:snapshot\.)?(?:nodes|edges)\s*\.\s*forEach/.test(code);
          const indexed = /helpers\.(byClass|byTypename|withProp|getNode)/.test(
            code,
          );
          return toolResult(
            [
              '## Dry run — nothing was executed',
              '',
              `Snapshot: ${formatNumber(meta?.nodeCount ?? 0)} nodes, ${formatNumber(meta?.edgeCount ?? 0)} edges.`,
              `Walk budget (\`max_nodes\`): ${formatNumber(budget.max)}.`,
              '',
              fullWalk
                ? `⚠ The code contains a full-heap walk, so it will visit up to ${formatNumber(Math.min(budget.max, meta?.nodeCount ?? 0))} nodes. On a heap this size that is seconds to minutes.${indexed ? '' : ' `helpers.byClass` / `byTypename` / `withProp` are indexed and avoid the walk when you know what you are looking for.'}`
                : indexed
                  ? 'No full-heap walk detected; the code uses the indexed helpers, which do not scan the heap.'
                  : 'No full-heap walk detected by text match. This is a textual check, not an analysis — a walk reached indirectly will not be seen here.',
              '',
              '_Re-run without `dry_run` to execute._',
            ].join('\n'),
          );
        }

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
        // On a light snapshot these would return 0 for every id, which is
        // indistinguishable from a genuinely tiny object. Throw instead: the
        // pre-flight check above catches the common case, and this covers code
        // that reaches them indirectly.
        const requireRetention = (what: string): void => {
          if (!light) return;
          throw new Error(
            `helpers.${what} needs retained sizes, which a LIGHT snapshot does not have (it would return 0 for every id). Reload with memlab_load_snapshot({file_path, light: false}).`,
          );
        };
        const retainedSize = (id: number): number => {
          requireRetention('retainedSize');
          const n = snapshot.getNodeById(id);
          return n ? n.retainedSize : 0;
        };
        const retainedSizes = (ids: number[]): Record<number, number> => {
          requireRetention('retainedSizes');
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
            if (node.id <= 3) return; // skip oddball/root nodes, matching the histogram/duplicate-objects tools for count parity
            // Index EVERY node type. Restricting this to `object` made the
            // helper silently return [] for closures, strings, arrays and
            // native (`blink::*`) nodes — which is most of what other tools
            // report. Measured: byClass('setComposerLinks_$0') returned [] on a
            // snapshot where a manual walk found 1,011 of them, because the
            // class is a closure; the empty result reads as "does not exist".
            // memlab_find_nodes_by_class matches any type by default and this
            // helper is documented as its indexed equivalent, so the two must
            // agree.
            let a = byClass.get(node.name);
            if (!a) {
              a = [];
              byClass.set(node.name, a);
            }
            a.push(node.id);
            // `__typename` is a JS object property, so only object nodes can
            // carry one; skipping the edge walk for other types keeps the
            // widened index roughly as cheap as the object-only one.
            if (node.type !== 'object') return;
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
        const byClass = (name: string, opts?: {type?: string}): number[] => {
          const ids = buildClassTypeIndex().byClass.get(name) ?? [];
          const want = opts?.type;
          if (want == null) return ids;
          return ids.filter(id => snapshot.getNodeById(id)?.type === want);
        };
        const byTypename = (name: string): number[] =>
          buildClassTypeIndex().byTypename.get(name) ?? [];
        const withProp = (name: string): number[] => {
          const key = `__withProp:${name}`;
          const cached = scratch[key] as number[] | undefined;
          if (cached) return cached;
          const ids: number[] = [];
          snapshot.nodes.forEach((node: IHeapNode) => {
            if (node.id <= 3) return; // skip oddball/root nodes for parity with other tools
            // Every node type is scanned: the `property` edge check below is
            // what constrains the match, and closures do carry named property
            // edges. Restricting the walk to `object` hid them, the same way it
            // hid non-object classes from byClass.
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
        ): {retained: number; exact: boolean} => {
          requireRetention('aggregateRetained');
          return boundedDominatorRetainedSize(new NumericSet(ids), snapshot);
        };

        // ---- additional traversal helpers -------------------------------
        // Each of these was hand-written inside `code` during a leak hunt,
        // several of them more than once and with small differences that made
        // results incomparable. Shipping them makes the common traversals both
        // cheaper to write and consistent with what the dedicated tools do.

        // The oddball/root filtering the tools apply internally. Hand-written
        // eval that omits it counts nodes the tools do not, so the two disagree
        // for reasons that have nothing to do with the question being asked.
        const isRealDetached = (node: unknown): boolean => {
          const n = unwrapNode(node) as IHeapNode | null;
          if (n == null || n.id <= 3) return false;
          return n.is_detached || n.name.startsWith('Detached ');
        };

        // Cached type -> ids index, mirroring the class index above, so a
        // second pass over "every closure" does not re-walk the heap.
        const buildTypeIndex = (): Map<string, number[]> => {
          const cached = scratch.__typeIndex as
            Map<string, number[]> | undefined;
          if (cached) return cached;
          const byType = new Map<string, number[]>();
          snapshot.nodes.forEach((node: IHeapNode) => {
            if (node.id <= 3) return;
            let a = byType.get(node.type);
            if (!a) {
              a = [];
              byType.set(node.type, a);
            }
            a.push(node.id);
          });
          scratch.__typeIndex = byType;
          return byType;
        };

        const nodesFromIds = (ids: number[]): IHeapNode[] => {
          const out: IHeapNode[] = [];
          for (const id of ids) {
            const n = snapshot.getNodeById(id);
            if (n) out.push(n);
          }
          return out;
        };
        const iterByClass = (name: string, opts?: {type?: string}) =>
          nodesFromIds(byClass(name, opts)).map(wrapNode);
        const iterByType = (type: string) =>
          nodesFromIds(buildTypeIndex().get(type) ?? []).map(wrapNode);

        // One-pass class histogram, cached, optionally filtered. `byClass`
        // answers "where are the X"; this answers "what is in here at all",
        // which otherwise means a full manual walk every time.
        const classCounts = (opts?: {
          pattern?: string;
          type?: string;
          minCount?: number;
        }): Array<{
          name: string;
          type: string;
          count: number;
          selfSize: number;
        }> => {
          const cacheKey = '__classCounts';
          let all = scratch[cacheKey] as
            | Array<{
                name: string;
                type: string;
                count: number;
                selfSize: number;
              }>
            | undefined;
          if (!all) {
            const acc = new Map<
              string,
              {name: string; type: string; count: number; selfSize: number}
            >();
            snapshot.nodes.forEach((node: IHeapNode) => {
              if (node.id <= 3) return;
              const key = `${node.type}::${node.name}`;
              const e = acc.get(key);
              if (e) {
                e.count++;
                e.selfSize += node.self_size;
              } else {
                acc.set(key, {
                  name: node.name,
                  type: node.type,
                  count: 1,
                  selfSize: node.self_size,
                });
              }
            });
            all = [...acc.values()].sort((a, b) => b.count - a.count);
            scratch[cacheKey] = all;
          }
          const matches = makeNamePatternTest(opts?.pattern);
          const minCount = opts?.minCount ?? 1;
          return all.filter(
            r =>
              r.count >= minCount &&
              (opts?.type == null || r.type === opts.type) &&
              matches(r.name),
          );
        };

        // The node behind a named edge. Written from scratch in four separate
        // evals because `props()` returns {ref,name,type} wrappers, which are
        // awkward exactly when the node itself is what you need.
        const edgeTarget = (nodeOrId: unknown, edgeName: string): unknown => {
          const n =
            typeof nodeOrId === 'number'
              ? snapshot.getNodeById(nodeOrId)
              : (unwrapNode(nodeOrId) as IHeapNode | null);
          if (n == null) return null;
          for (const e of n.references) {
            if (e.type === 'hidden') continue;
            if (String(e.name_or_index) !== edgeName) continue;
            return e.toNode.id > 3 ? wrapNode(e.toNode) : null;
          }
          return null;
        };

        // Generic container walk. `mapEntries` / `setElements` cover Map and
        // Set; WeakMap tables and plain arrays needed a manual `references`
        // walk with hole filtering every time.
        const entries = (
          nodeOrId: unknown,
        ): Array<{key: unknown; value: unknown}> => {
          const n =
            typeof nodeOrId === 'number'
              ? snapshot.getNodeById(nodeOrId)
              : (unwrapNode(nodeOrId) as IHeapNode | null);
          if (n == null) return [];
          if (n.name === 'Map' || n.name === 'WeakMap') {
            return enumerateMapEntries(n).map(e => ({
              key: wrapNode(e.key),
              value: e.value == null ? null : wrapNode(e.value),
            }));
          }
          if (n.name === 'Set' || n.name === 'WeakSet') {
            return enumerateSetElements(n).map(el => ({
              key: null,
              value: wrapNode(el),
            }));
          }
          const out: Array<{key: unknown; value: unknown}> = [];
          for (const e of n.references) {
            if (e.type === 'hidden') continue;
            const name = String(e.name_or_index);
            if (name === '__proto__' || name === 'map') continue;
            if (e.type === 'element') {
              out.push({
                key: Number(e.name_or_index),
                value: wrapNode(e.toNode),
              });
            } else if (name === 'elements' && e.type === 'internal') {
              for (const el of e.toNode.references) {
                if (el.type !== 'element') continue;
                out.push({
                  key: Number(el.name_or_index),
                  value: wrapNode(el.toNode),
                });
              }
            } else if (e.type === 'property') {
              out.push({key: name, value: wrapNode(e.toNode)});
            }
          }
          return out;
        };

        // What does this node actually own? The question behind
        // memlab_dominator_attribution, exposed for ad-hoc populations.
        const dominates = (
          id: number,
          opts?: {population?: (node: unknown) => boolean; limit?: number},
        ): {
          count: number;
          selfSize: number;
          ids: number[];
          truncated: boolean;
        } => {
          requireRetention('dominates');
          const limit = opts?.limit ?? 1000;
          const pop = opts?.population;
          let count = 0;
          let selfSize = 0;
          const ids: number[] = [];
          let truncated = false;
          snapshot.nodes.forEach((node: IHeapNode) => {
            if (node.id <= 3 || node.id === id) return;
            if (pop != null && !pop(wrapNode(node))) return;
            let cur: IHeapNode | null = node.dominatorNode ?? null;
            let hops = 0;
            while (cur && hops++ < 500) {
              if (cur.id === id) {
                count++;
                selfSize += node.self_size;
                if (ids.length < limit) ids.push(node.id);
                else truncated = true;
                break;
              }
              const next: IHeapNode | null = cur.dominatorNode ?? null;
              if (!next || next.id === cur.id) break;
              cur = next;
            }
          });
          return {count, selfSize, ids, truncated};
        };

        // Shortest reference path a -> b, by BFS over outgoing edges. Bounded,
        // and reports that it gave up rather than returning null as if no path
        // existed.
        const pathBetween = (
          fromId: number,
          toId: number,
          opts?: {maxNodes?: number},
        ): {found: boolean; exhausted: boolean; path: string[]} => {
          const maxNodes = opts?.maxNodes ?? 200_000;
          const start = snapshot.getNodeById(fromId);
          if (start == null || snapshot.getNodeById(toId) == null) {
            return {found: false, exhausted: false, path: []};
          }
          const prev = new Map<number, {via: string; from: number}>();
          const seen = new Set<number>([fromId]);
          let queue: IHeapNode[] = [start];
          let visited = 0;
          while (queue.length > 0) {
            const next: IHeapNode[] = [];
            for (const node of queue) {
              if (++visited > maxNodes) {
                return {found: false, exhausted: true, path: []};
              }
              for (const e of node.references) {
                const t = e.toNode;
                if (t.id <= 3 || seen.has(t.id)) continue;
                seen.add(t.id);
                prev.set(t.id, {via: String(e.name_or_index), from: node.id});
                if (t.id === toId) {
                  const path: string[] = [];
                  let cur = toId;
                  while (cur !== fromId) {
                    const p = prev.get(cur);
                    if (p == null) break;
                    const n = snapshot.getNodeById(cur);
                    path.unshift(`.${p.via} -> @${cur} ${n?.name ?? ''}`);
                    cur = p.from;
                  }
                  path.unshift(`@${fromId} ${start.name}`);
                  return {found: true, exhausted: false, path};
                }
                next.push(t);
              }
            }
            queue = next;
          }
          return {found: false, exhausted: false, path: []};
        };

        // Named result sets are SESSION-scoped, not snapshot-scoped: comparing
        // a baseline scan against a final scan is the whole job, and the old
        // per-snapshot scratch dropped the baseline the moment the next rung
        // was loaded — exactly when it was needed.
        //
        // Node ids, however, are per-capture. A set of ids saved against one
        // snapshot means nothing against another, so a cross-snapshot load is
        // refused unless the caller opts in. Counts and strings are portable;
        // ids are not, and silently letting them through is the failure this
        // whole class of guard exists to prevent.
        const save = <T>(name: string, value: T): T => {
          setSavedResult(name, value, currentHandle);
          return value;
        };
        const load = (name: string, opts?: {allowCrossSnapshot?: boolean}) => {
          const entry = getSavedResult(name);
          if (entry == null) {
            throw new Error(
              `No saved result named "${name}". Saved names: ${savedNames().join(', ') || '(none)'}. ` +
                'Save one with the save_as parameter or helpers.save(name, value).',
            );
          }
          if (
            entry.handle !== currentHandle &&
            opts?.allowCrossSnapshot !== true
          ) {
            throw new Error(
              `"${name}" was saved against snapshot "${entry.handle}" and the current snapshot is "${currentHandle}". Node ids are per-capture, so ids from another snapshot resolve to unrelated objects or to nothing. ` +
                'If the value is counts/strings/shapes rather than ids, pass {allowCrossSnapshot: true} to read it anyway.',
            );
          }
          return entry.value;
        };
        const listSaved = (): Array<{name: string; handle: string}> =>
          listSavedResults();

        // Sandbox code holds PROXIED nodes (see wrapNode). The helpers below
        // read `retainedSize`, which the proxy refuses on purpose, so they take
        // the real node: unwrap at the boundary rather than making every caller
        // remember which helpers are proxy-safe.
        const helpers = {
          serializeNodeSummary: (n: unknown) =>
            serializeNodeSummary(unwrapNode(n) as IHeapNode),
          serializeNodeDetail: (n: unknown) =>
            serializeNodeDetail(unwrapNode(n) as IHeapNode),
          formatBytes,
          formatNumber,
          markdownTable,
          isNodeWorthInspecting: (n: unknown, ...rest: unknown[]) =>
            (isNodeWorthInspecting as (...a: unknown[]) => boolean)(
              unwrapNode(n),
              ...rest,
            ),
          filterLargestObjects: (nodes: unknown[], ...rest: unknown[]) =>
            (filterLargestObjects as (...a: unknown[]) => unknown)(
              Array.isArray(nodes) ? nodes.map(unwrapNode) : nodes,
              ...rest,
            ),
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
          isRealDetached,
          iterByClass,
          iterByType,
          classCounts,
          edgeTarget,
          entries,
          dominates,
          pathBetween,
          save,
          load,
          listSaved,
        };

        const sandbox = {
          snapshot: wrapSnapshot(snapshot, budget),
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
        // A budget abort is a controlled stop, not a failure: whatever the code
        // had already assigned to `result` is still returned, annotated below.
        try {
          script.runInContext(context, {timeout: timeout_ms});
        } catch (err) {
          // Keyed on the error itself, never on `budget.exceeded`: code that
          // catches the abort and then throws for an unrelated reason must
          // still surface that error.
          if (!(err instanceof BudgetExceeded)) throw err;
        }

        // Actionable hint when nothing was assigned to `result` (the #1 user
        // error — code that `return`s a value or runs a value-returning IIFE
        // never populates `result`, so output is silently "undefined").
        if (
          sandbox.result === undefined &&
          consoleOutput.length === 0 &&
          !budget.exceeded
        ) {
          return toolResult(
            'Your code ran without error but never assigned to `result`, so there is nothing to return.\n' +
              'Assign the value you want back to `result` (do NOT use `return` at the top level), e.g.:\n' +
              '  `result = someValue;`\n' +
              'Use mode:"describe_env" to see the full calling convention.',
          );
        }

        // `undefined` is never worth persisting: on reload it is
        // indistinguishable from a name that was never saved, and the usual
        // cause is the "never assigned to `result`" mistake — which the hint
        // above only catches when the run produced no console output.
        const nothingToSave = sandbox.result === undefined;
        if (save_as != null && !budget.exceeded && !nothingToSave) {
          setSavedResult(save_as, sandbox.result, currentHandle);
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

        const footer: string[] = [];
        if (budget.exceeded) {
          footer.push(
            `⚠️ Walk aborted after ${formatNumber(budget.max)} node visits (max_nodes). The value above is PARTIAL. ` +
              'Raise max_nodes, or narrow the scan with an indexed helper (`helpers.byClass` / `byTypename` / `withProp`) instead of a full `snapshot.nodes` walk.',
          );
          if (save_as != null) {
            footer.push(
              `Not saved as "${save_as}" — a partial result would be indistinguishable from a complete one on reload.`,
            );
          }
        } else if (budget.visited > 0) {
          footer.push(`nodes_visited: ${formatNumber(budget.visited)}`);
        }
        if (save_as != null && !budget.exceeded) {
          footer.push(
            nothingToSave
              ? `Not saved as "${save_as}" — \`result\` was undefined, and a saved \`undefined\` is indistinguishable from a name that was never saved. Assign the value you want to keep to \`result\` (do NOT \`return\` at the top level) and re-run.`
              : `Saved as "${save_as}" — read it back in a later call with \`helpers.load("${save_as}")\`.`,
          );
        }
        if (footer.length > 0) {
          output += '\n\n--- ' + footer.join('\n');
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

function savedNames(): string[] {
  return listSavedResults()
    .map(r => r.name)
    .sort();
}

/** One-line shape description so `list_saved` is useful without re-dumping the data. */
function describeSavedValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value))
    return `array (${formatNumber(value.length)} items)`;
  if (typeof value === 'string') {
    return `string (${formatNumber(value.length)} chars)`;
  }
  if (typeof value === 'object') {
    // The sandbox is seeded with the host realm's Map/Set/Date/typed arrays, so
    // `instanceof` holds for values built inside eval. Without these cases every
    // one of them reports `object (0 keys)` — a container holding millions of
    // entries would look empty here.
    if (value instanceof Map) {
      return `Map (${formatNumber(value.size)} entries)`;
    }
    if (value instanceof Set) {
      return `Set (${formatNumber(value.size)} items)`;
    }
    if (value instanceof Date) {
      return `Date (${value.toISOString()})`;
    }
    if (ArrayBuffer.isView(value)) {
      const ctor = value.constructor?.name ?? 'TypedArray';
      const len = (value as unknown as {length?: number}).length;
      return typeof len === 'number'
        ? `${ctor} (${formatNumber(len)} items)`
        : `${ctor} (${formatNumber(value.byteLength)} bytes)`;
    }
    const keys = formatNumber(Object.keys(value as object).length);
    // A named constructor (WeakMap, a class instance, …) is reported by name so
    // a `0 keys` line is attributable rather than just puzzling.
    const ctor = (value as {constructor?: {name?: string}}).constructor?.name;
    return ctor == null || ctor === 'Object'
      ? `object (${keys} keys)`
      : `${ctor} (${keys} own keys)`;
  }
  return typeof value;
}

function describeSaved(): string {
  const saved = listSavedResults();
  if (saved.length === 0) {
    return [
      '# Saved result sets: (none)',
      '',
      'Save one by passing `save_as: "<name>"` on a memlab_eval call, or calling `helpers.save("<name>", value)` inside your code.',
      'Read it back in a later call with `helpers.load("<name>")`.',
      'Saved sets last for the SERVER SESSION and survive loading another snapshot, so a baseline scan can be compared against a later rung. The snapshot each was saved against is recorded: reading one back under a different snapshot is refused unless you pass `{allowCrossSnapshot: true}`, because node ids are per-capture.',
    ].join('\n');
  }
  const current = getCurrentHandle();
  return [
    `# Saved result sets (${saved.length}) — session-scoped`,
    '',
    markdownTable(
      ['name', 'saved against', 'shape'],
      saved.map(r => [
        r.name,
        r.handle === current ? `${r.handle} (current)` : r.handle,
        describeSavedValue(getSavedResult(r.name)?.value),
      ]),
    ),
    '',
    'Read one back with `helpers.load("<name>")`. Ids saved against another snapshot need `helpers.load("<name>", {allowCrossSnapshot: true})` — and are only meaningful if the value is counts/strings/shapes rather than node ids.',
  ].join('\n');
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
    '- `helpers.byClass(name, {type?}) -> ids[]`, `helpers.byTypename(name) -> ids[]`, `helpers.withProp(name) -> ids[]` — INDEXED id lookups. The class/typename index is built once per snapshot and memoized in a session scratch, so a follow-up call is index-speed, not another full `snapshot.nodes` scan. `byClass` indexes EVERY node type (closure, string, array, native, …), matching `memlab_find_nodes_by_class`; pass `{type: "object"}` to narrow. `byTypename` is object-only because `__typename` is a JS property. (See also the `memlab_duplicate_objects` tool for a ready-made dedup report.)',
    '- `helpers.iterByClass(name, {type?}) -> node[]` / `helpers.iterByType(type) -> node[]` — indexed iteration; no full scan, index built once per snapshot.',
    '- `helpers.classCounts({pattern?, type?, minCount?}) -> [{name, type, count, selfSize}]` — one-pass class histogram, cached; `pattern` is a case-insensitive regex (substring fallback).',
    '- `helpers.entries(nodeOrId) -> [{key, value}]` — generic container walk: Map/WeakMap (paired, SMI gaps handled), Set/WeakSet, Array (both direct `element` edges and the `(object elements)` backing store), plain object properties. Holes and `__proto__`/`map` are filtered.',
    '- `helpers.edgeTarget(nodeOrId, edgeName) -> node | null` — the node behind a named edge, when you need the node and not the `{ref,name,type}` wrapper `props()` returns.',
    '- `helpers.isRealDetached(node) -> boolean` — the oddball/root filtering the detached-DOM tools apply internally, so hand-written eval counts the same set they do.',
    '- `helpers.dominates(id, {population?, limit?}) -> {count, selfSize, ids, truncated}` — what this node actually owns (bounded 500-hop dominator walk). `population` is a predicate over nodes.',
    '- `helpers.pathBetween(fromId, toId, {maxNodes?}) -> {found, exhausted, path[]}` — BFS over outgoing edges; `exhausted:true` means the budget ran out, which is NOT the same as "no path".',
    '- `helpers.save(name, value)` / `helpers.load(name, {allowCrossSnapshot?})` / `helpers.listSaved()` — named result sets, SESSION-scoped: they survive loading another snapshot, which is what makes a baseline-vs-final comparison possible. The snapshot each was saved against is recorded, and a cross-snapshot read is refused unless you opt in — node ids are per-capture and mean nothing in another snapshot.',
    '- `helpers.aggregateRetained(ids[]) -> {retained, exact}` — dominator-deduped retained size for a SET of ids (does not double-count when one id dominates another); `exact:false` means the bounded walk was truncated (upper bound).',
    '',
    '## Named result sets (multi-step exploration)',
    'Keep intermediate sets SERVER-SIDE instead of round-tripping them through the transcript — the ids never have to be printed, so a long investigation costs a fraction of the tokens.',
    '- `save_as: "<name>"` (tool parameter) — saves this call\'s `result` under that name after it completes. An `undefined` `result` is NOT saved (it would be indistinguishable from an unsaved name); the response says so.',
    '- `helpers.save(name, value) -> value` — save mid-script (returns the value, so it composes inline).',
    '- `helpers.load(name) -> value` — read a saved set back in a later call. Throws with the list of known names if it does not exist.',
    '- `helpers.listSaved() -> names[]`, or call the tool with `mode:"list_saved"` for names + shapes.',
    'Save plain data (ids, counts, strings) — NOT node objects or proxies. Sets are scoped to the current snapshot and dropped when it is unloaded, so a saved id list can never be read against the wrong snapshot.',
    'Typical shape: call 1 `save_as:"candidates"` builds the id list; call 2 does `const ids = helpers.load("candidates");` and measures them; call 3 traces only the survivors.',
    '',
    '## Traversal budget',
    'Every call reports `nodes_visited`. Pass `max_nodes` to bound a `snapshot.nodes.forEach` walk: on overrun the walk aborts and the PARTIAL `result` is returned with a warning rather than failing, so a broad exploratory scan is safe to attempt. A partial result is never saved by `save_as`.',
    '',
    '## IHeapNode API',
    '`.id`, `.name`, `.type`, `.self_size`, `.edge_count`, `.is_detached`, `.numOfReferrers` (alias `.referrer_count`), `.isString`, `.toStringNode()?.stringValue`, `.hasPathEdge`, `.pathEdge`, `.dominatorNode`, `.location` (`script_id`/`line`/`column`).',
    '',
    '## `.retainedSize` THROWS here',
    '`node.retainedSize` / `node.retained_size` raise inside eval instead of returning a number. They have been observed reading back ~0 for every node on some loads while the same id read via `snapshot.getNodeById(id)` returns the true value — and a silently wrong number ranks a whole analysis wrongly with nothing in the output to say so. Use `helpers.retainedSize(id)` (number), `helpers.retainedSizes([ids])` (a `Record<id, bytes>` OBJECT — index it as `sizes[id]` or iterate `Object.values(sizes)`, do not `.map`/`.reduce` it directly), or `helpers.aggregateRetained([ids])` for a dominator-deduped total. `node.self_size` is read straight from the snapshot and is reliable.',
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

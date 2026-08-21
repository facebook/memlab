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
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
import {beginAnalysisBudget} from '../analysis-budget.js';
import {formatEvalHints, hintsForEval} from '../eval-hints.js';
import {
  abbreviateBlinkTypeName,
  errorResult,
  toolResult,
  serializeNodeSummary,
  serializeNodeDetail,
  type NodeDetail,
  type NodeSummary,
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

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return (
    str.slice(0, max) +
    `\n... [truncated, output exceeded ${Math.round(max / 1024)}KB]`
  );
}

/**
 * Wall-clock budget for one eval, scaled from the loaded graph.
 *
 * A fixed 60 s default is right for an indexed lookup and wrong for everything
 * else: a full-heap walk on a 6M-node graph takes two to four minutes, so every
 * large-snapshot eval aborted on its first attempt and had to be re-issued with
 * an explicit `timeout_ms`. That is a guaranteed wasted call per question, and
 * the node count needed to avoid it is already known.
 *
 * The floor stays at 60 s so small heaps behave exactly as before.
 */
export function scaledEvalTimeoutMs(): number {
  const nodes = getSnapshotMetadata()?.nodeCount ?? 0;
  return Math.max(60000, Math.ceil((nodes / 40000) * 1000));
}

/**
 * Default `max_nodes`, scaled to the loaded graph.
 *
 * A probe that makes several passes over the heap is the normal shape — one
 * pass to census classes, one to match shapes, one to size things — so the
 * budget has to be a MULTIPLE of the node count, not a constant. At the old
 * flat 20,000,000 a routine two-pass probe on an 8.24M-node capture aborted
 * mid-walk and returned a partial value; because the result was assigned after
 * the loops, what came back was `undefined` with a note, which reads as a
 * legitimate empty answer.
 *
 * Six passes is generous on purpose: the wall-clock timeout above is the real
 * guard against a runaway eval, and this budget exists to stop pathological
 * traversals, not ordinary multi-pass analysis.
 */
export function scaledWalkBudget(): number {
  const nodes = getSnapshotMetadata()?.nodeCount ?? 0;
  return Math.max(20000000, nodes * 6);
}

/**
 * Shorten a heap result STRUCTURALLY rather than mid-string.
 *
 * A census result is an array of rows or a `{key: count}` map, and cutting the
 * JSON at a byte offset yields unparseable output plus a re-run with a
 * hand-written limit — which is what actually happened to a detached-class
 * census whose `blink::HeapVectorBacking<…>` keys blew the cap. Dropping whole
 * entries keeps the value valid JSON and keeps the largest rows, which are the
 * ones the question was about.
 *
 * Blink's C++ template names are elided first: they are frequently most of the
 * payload and none of the information, and `abbreviateBlinkTypeName` is the same
 * elision the table renderers already use.
 */
export function shrinkResult(
  value: unknown,
  maxBytes: number,
): {
  value: unknown;
  truncated: boolean;
  droppedEntries: number;
  keptEntries: number;
} {
  const size = (v: unknown): number => {
    try {
      return JSON.stringify(v)?.length ?? 0;
    } catch {
      return String(v).length;
    }
  };
  if (size(value) <= maxBytes) {
    return {value, truncated: false, droppedEntries: 0, keptEntries: -1};
  }

  // Abbreviate VALUES freely, but keys only where it cannot lose data.
  //
  // `abbreviateBlinkTypeName` collapses everything between the first `<` and
  // the last `>`, so `blink::HeapVectorBacking<Foo>` and
  // `blink::HeapVectorBacking<Bar>` abbreviate to the SAME string. On a census
  // map — `{className: count}`, the exact shape this exists to shrink — the
  // second entry would overwrite the first and the count would silently
  // disappear before any trimming happened. So a key is only shortened when the
  // shortened form is still unique within its object; otherwise the full key is
  // kept, because a longer result is recoverable and a wrong one is not.
  const abbreviate = (v: unknown): unknown => {
    if (typeof v === 'string') return abbreviateBlinkTypeName(v);
    if (Array.isArray(v)) return v.map(abbreviate);
    if (v != null && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      const shortened = entries.map(([k]) => abbreviateBlinkTypeName(k));
      const collides = new Set(shortened).size !== shortened.length;
      const out: Record<string, unknown> = {};
      entries.forEach(([k, val], i) => {
        out[collides ? k : shortened[i]] = abbreviate(val);
      });
      return out;
    }
    return v;
  };
  let shrunk = abbreviate(value);
  if (size(shrunk) <= maxBytes) {
    return {
      value: shrunk,
      truncated: false,
      droppedEntries: 0,
      keptEntries: -1,
    };
  }

  // Binary-search the entry count that fits, so a 40k-row result does not cost
  // 40k serializations to trim.
  const entriesOf = (
    v: unknown,
  ): {take: (n: number) => unknown; length: number} | null => {
    if (Array.isArray(v)) {
      return {length: v.length, take: n => v.slice(0, n)};
    }
    if (v != null && typeof v === 'object') {
      const pairs = Object.entries(v as Record<string, unknown>);
      return {
        length: pairs.length,
        take: n => Object.fromEntries(pairs.slice(0, n)),
      };
    }
    return null;
  };
  const entries = entriesOf(shrunk);
  if (entries == null || entries.length === 0) {
    return {value: shrunk, truncated: true, droppedEntries: 0, keptEntries: -1};
  }
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(entries.take(mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  shrunk = entries.take(lo);
  return {
    value: shrunk,
    truncated: true,
    droppedEntries: entries.length - lo,
    keptEntries: lo,
  };
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
      // Same escape hatch the node proxy carries, for the same reason: helpers
      // that take a whole snapshot walk it with the real `forEach` and read
      // `retainedSize` off the nodes it yields, which this proxy refuses.
      if (prop === RAW_NODE) return target;
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
            'shapeKeys(nodeOrId)->Set<string> & ownProps(nodeOrId) & hasShape(nodeOrId, [names], {exact?,exclude?}) (own JS properties ONLY — USE THESE FOR SHAPE MATCHING; props() falls back to an internal-edge walk and injects length/map/__via/__note, which makes a props()-based shape test silently return zero matches), ' +
            'rootPath(nodeOrId, {maxHops?})->[{id,name,type,edge}] (GC-root path, root first — the retainer_trace walk, callable inside an eval), ' +
            'byClass(name, {type?})->ids[] & byTypename(name)->ids[] & withProp(name)->ids[] (INDEXED lookups — built once per snapshot then memoized in a session scratch, so repeated questions are index-speed not full-scan; byClass covers EVERY node type, matching memlab_find_nodes_by_class, so closures/strings/arrays/natives are found — pass {type:"object"} to narrow), ' +
            'aggregateRetained(ids[])->{retained,exact} (dominator-deduped retained for a SET of ids, no double-counting), ' +
            'iterByClass(name, {type?, instancesOnly?})->nodes[] & iterByType(type)->nodes[] (INDEXED iteration — no full scan; instancesOnly defaults TRUE and drops the constructor closure, the `Foo (prototype)` object and `system/SharedFunctionInfo/Foo`, which otherwise come back as class members whose only "properties" are length/map and make a per-instance loop produce garbage), ' +
            'classCounts({pattern?, type?, minCount?})->[{name,type,count,selfSize}] (one-pass histogram, cached), ' +
            'entries(nodeOrId)->[{key,value}] (generic Map/Set/WeakMap/Array/object walk, holes filtered), ' +
            'edgeTarget(nodeOrId, edgeName)->node|null, isRealDetached(node)->boolean (same filtering the tools apply internally), ' +
            'dominates(id, {population?, limit?})->{count,selfSize,ids,truncated}, ' +
            'remember(name, value)/recall(name?) (persist ACROSS sessions), ' +
            'sample(items, n) (deterministic, evenly spaced), ' +
            'owner(idOrNode, {maxHops?})->{id,name,type,hops,selfSize,named}|null, ' +
            'histogram(ids, keyFn, {limit?})->[{key,count}], ' +
            'pathBetween(fromId, toId, {maxNodes?})->{found,exhausted,path[]}, ' +
            'save(name, value) / load(name, {allowCrossSnapshot?}) / listSaved() (SESSION-scoped, survives loading another snapshot) }), ' +
            'and standard JS built-ins. ' +
            'NOTE: `helpers.byClass()` returns IDS, and not every id resolves — `snapshot.getNodeById()` returns null for many native classes (AudioContext, OpusRecorder, …), so `byClass(x).map(id => getNodeById(id).referrers)` throws on the first try. Use `helpers.nodesByClass(name)` / `helpers.iterByClass(name)`, which return node objects and skip the unresolvable ones. `helpers.props()` on an unresolvable node now returns `{__unavailable: true}` rather than `{}`, so "no properties" and "could not read properties" are distinguishable. ' +
            'NOTE: `node.retainedSize` / `node.retained_size` THROW inside eval — they can read back ~0 for every node on some loads, so a silent wrong number is refused; use helpers.retainedSize(id). `node.self_size` is reliable. ' +
            'Node traversal: use node.references (outgoing) and node.referrers (incoming) with for-of. ' +
            'Edge properties: .name_or_index, .type, .toNode, .fromNode.',
        ),
      timeout_ms: z
        .number()
        .optional()
        .describe(
          'Execution timeout in milliseconds. Defaults to a value SCALED from the loaded snapshot (60s floor, ~1s per 40k nodes), because a full-heap walk on a 6M-node graph takes minutes and a fixed 60s default made the first attempt abort on every large capture.',
        ),
      max_result_bytes: z
        .number()
        .int()
        .min(1024)
        .optional()
        .describe(
          `Byte budget for the serialized \`result\` (default ${MAX_OUTPUT_SIZE}). Over budget, whole ENTRIES are dropped from the end of an array/object rather than the JSON being cut mid-string, and \`truncated: true\` is reported — so a large census stays valid and readable instead of needing a re-run with a hand-written limit.`,
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
        .describe(
          'Abort a `snapshot.nodes.forEach` walk after this many node visits. Defaults to a budget SCALED from the loaded graph (6 full passes, floored at 20,000,000) — a probe that makes several passes is the normal shape, so a flat cap silently truncated ordinary multi-pass analysis on large heaps. On abort the partial `result` is returned with a note; an abort that produced NO result is refused outright, because an empty value is indistinguishable from a genuine empty census. Reported back as `nodes_visited` on every call.',
        ),
    },
    async args => runEval({...args, ownsScanBudget: true}),
  );
}

/**
 * The `memlab_eval` handler, callable directly so a caller can run the same
 * code against several snapshots (see memlab_eval_across) with identical
 * sandbox semantics — one definition of the helper surface, not two.
 */
/**
 * Cross-session scratch for `helpers.remember` / `helpers.recall`. Kept beside
 * the metric store (same MEMLAB_STATE_DIR) because it answers the same problem
 * from the other end: `memlab_metric` persists a NUMBER worth quoting, this
 * persists whatever an exploration derived on the way to it.
 */
function evalStorePath(): string {
  const dir =
    process.env.MEMLAB_STATE_DIR ?? path.join(os.homedir(), '.memlab');
  return path.join(dir, 'eval-store.json');
}

function readEvalStore(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(evalStorePath(), 'utf8'));
    if (parsed != null && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A missing or corrupt store must not fail the eval that is writing to it.
  }
  return {};
}

function writeEvalStore(store: Record<string, unknown>): void {
  const file = evalStorePath();
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}

export async function runEval({
  mode,
  code,
  timeout_ms,
  save_as,
  max_nodes,
  dry_run,
  max_result_bytes,
  ownsScanBudget,
}: {
  mode?: 'eval' | 'describe_env' | 'list_saved';
  code?: string;
  timeout_ms?: number;
  save_as?: string;
  max_nodes?: number;
  dry_run?: boolean;
  max_result_bytes?: number;
  /**
   * True only for a direct `memlab_eval` MCP call, which owns the scan budget
   * the guardrail armed for it and may therefore re-arm it to a scaled value.
   * Left false by every in-process caller — `memlab_eval_across`,
   * `memlab_ladder_probe`, `memlab_batch` — because those run MANY evals inside
   * ONE MCP call and each re-arm would reset the shared wall clock.
   */
  ownsScanBudget?: boolean;
}): Promise<ReturnType<typeof toolResult>> {
  // Schema defaults are applied by the MCP layer for tool calls; a direct
  // caller (memlab_eval_across) gets them here so both paths behave alike.
  //
  // Anything that needs to scale with the LOADED SNAPSHOT therefore must NOT
  // carry a `.default()` in the zod schema — the MCP layer fills that in before
  // this function runs, so the `?? scaled...()` below never fires and the
  // scaling is silently dead for every tool call. `max_nodes` shipped with
  // exactly that bug: the schema default of 20,000,000 shadowed the scaled
  // budget, and a three-pass probe on an 8.06M-node capture still aborted at
  // 20,000,000 while the error text correctly reported the graph as 8,055,593
  // nodes. Both schemas now leave it optional-with-no-default.
  mode = mode ?? 'eval';
  const scaledTimeout = timeout_ms ?? scaledEvalTimeoutMs();
  if (ownsScanBudget === true && timeout_ms == null && scaledTimeout > 0) {
    // Raising only the VM script timeout is not enough, and the half-fix is
    // worse than none because it looks like it worked. `guardrail.ts` arms the
    // whole-heap scan budget from the tool's INCOMING `timeout_ms` before this
    // handler runs; with no explicit value it arms the 90s default, so a scaled
    // 150s eval on a 6M-node graph is still killed at 90s — the exact failure
    // the scaling exists to remove. Re-arm the scan budget to match.
    //
    // Gated on `ownsScanBudget` because `beginAnalysisBudget` RESETS the clock
    // rather than extending it, and the registry's invariant is exactly one
    // budget per MCP call. `memlab_eval_across` runs one eval per rung inside a
    // single call, so an ungated re-arm would hand every rung a fresh budget
    // and leave the batch's total wall clock effectively unbounded — the guard
    // the budget exists to be.
    beginAnalysisBudget(scaledTimeout);
  }
  timeout_ms = scaledTimeout;
  // Scale the walk budget to the graph, the way the timeout already scales.
  // A flat 20M was under one snapshot's worth of visits for any probe that
  // makes more than two passes over a large heap: on an 8.06M-node capture a
  // routine three-pass probe hit the cap and returned a PARTIAL result, which —
  // because the accumulator was assigned at the end — printed as a bare
  // `undefined`. A budget that silently converts "too big" into "no answer"
  // is worse than one that is simply large.
  max_nodes = max_nodes ?? scaledWalkBudget();
  dry_run = dry_run ?? false;
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
      const fullWalk = /\b(?:snapshot\.)?(?:nodes|edges)\s*\.\s*forEach/.test(
        code,
      );
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
            if (!groups[key]) groups[key] = {count: 0, exampleId: target.id};
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

    const countUniqueTargets = (arrayNodeId: number, propertyName: string) => {
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
    //
    // On a LIGHT snapshot it is reported as `null` rather than thrown:
    // `mapEntries` / `setElements` are built on this and are legitimate
    // there (keys, values, names and self sizes all survive a light load),
    // so propagating `retainedSize`'s refusal would refuse them too. A null
    // reads as "not measured"; a 0 would read as "measured and tiny".
    const nodeBrief = (n: IHeapNode | null | undefined) =>
      n == null
        ? null
        : {
            id: n.id,
            name: n.name,
            type: n.type,
            self_size: n.self_size,
            retained_size: light ? null : retainedSize(n.id),
            string: n.isString ? (n.toStringNode()?.stringValue ?? null) : null,
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
    const describeTarget = (t: IHeapNode): unknown => {
      if (t.isString) return t.toStringNode()?.stringValue ?? '';
      if (t.name === 'true') return true;
      if (t.name === 'false') return false;
      if (t.name === 'null') return null;
      if (t.name === 'undefined') return undefined;
      return {ref: t.id, name: t.name, type: t.type};
    };

    const props = (
      nodeOrId: number | {id: number},
    ): Record<string, unknown> => {
      const node = resolveNode(nodeOrId);
      // An empty object used to mean three different things — unresolvable
      // node, no property edges, and properties held under a non-`property`
      // edge type — and the caller could not tell which. Reading `{}` as "this
      // object has no fields" when it plainly does is what makes shape
      // inspection unreliable and sends people back to manual edge walks.
      if (!node) {
        return {
          __unavailable: true,
          __reason:
            'node not resolvable in the active snapshot — ids from ' +
            'helpers.byClass() are not all resolvable (natives especially); ' +
            'use helpers.iterByClass() to get node objects directly',
        };
      }
      const out: Record<string, unknown> = {};
      for (const e of node.references) {
        if (e.type !== 'property') continue;
        const name = String(e.name_or_index);
        if (name === '__proto__') continue;
        out[name] = describeTarget(e.toNode);
      }
      if (Object.keys(out).length > 0) return out;

      // Fall back to a named-edge walk. Natives, closures and some internal
      // objects carry their fields under `internal`/`shortcut`/`hidden` edges
      // rather than `property`, so the fast path legitimately finds nothing on
      // objects that visibly have state. Provenance is marked so a caller
      // cannot mistake these for real own-properties.
      let found = 0;
      for (const e of node.references) {
        if (e.type === 'element') continue;
        const name = String(e.name_or_index);
        if (name === '' || name === '__proto__' || /^\d+$/.test(name)) continue;
        out[name] = describeTarget(e.toNode);
        found++;
      }
      if (found === 0) return out;
      out.__via = 'edge-walk';
      out.__note =
        'no `property` edges on this node; these are named non-property edges ' +
        '(internal/shortcut/hidden) and are NOT own JS properties';
      return out;
    };
    const getProp = (nodeOrId: number | {id: number}, name: string) =>
      props(nodeOrId)[name];

    /**
     * Own JS properties ONLY — no `internal`/`shortcut`/`hidden` edges, no
     * `__via`/`__note` provenance keys, no fallback.
     *
     * `props()` deliberately falls back to a named-edge walk so that natives and
     * closures show their state, and marks the result. That is right for
     * INSPECTION and wrong for SHAPE MATCHING, and the failure is silent in the
     * worst direction: a shape test written as
     *   `new Set(Object.keys(helpers.props(id)))` … `s.size === 2 && s.has('element')`
     * returns ZERO matches on objects that plainly have that shape, because the
     * fallback injected `length`/`map`/`__via`/`__note`. An empty result reads as
     * "this pattern is not in the heap" and gets written up as a negative.
     *
     * Use `ownProps`/`shapeKeys` whenever the question is "what shape is this",
     * and `props` when the question is "what is in this".
     */
    const ownProps = (
      nodeOrId: number | {id: number},
    ): Record<string, unknown> => {
      const node = resolveNode(nodeOrId);
      if (!node) return {};
      const out: Record<string, unknown> = {};
      for (const e of node.references) {
        if (e.type !== 'property') continue;
        const name = String(e.name_or_index);
        if (name === '__proto__') continue;
        out[name] = describeTarget(e.toNode);
      }
      return out;
    };
    const shapeKeys = (nodeOrId: number | {id: number}): Set<string> => {
      const node = resolveNode(nodeOrId);
      const out = new Set<string>();
      if (!node) return out;
      for (const e of node.references) {
        if (e.type !== 'property') continue;
        const name = String(e.name_or_index);
        if (name === '__proto__') continue;
        out.add(name);
      }
      return out;
    };
    const hasShape = (
      nodeOrId: number | {id: number},
      required: readonly string[],
      opts?: {exact?: boolean; exclude?: readonly string[]},
    ): boolean => {
      const keys = shapeKeys(nodeOrId);
      for (const r of required) if (!keys.has(r)) return false;
      for (const x of opts?.exclude ?? []) if (keys.has(x)) return false;
      if (opts?.exact === true && keys.size !== required.length) return false;
      return true;
    };

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
    /**
     * A class index entry is not necessarily an INSTANCE of that class. V8 names
     * the constructor closure, the prototype object and the `SharedFunctionInfo`
     * after the class too, so `iterByClass('Resolvable')` hands back nodes whose
     * only "properties" are `length`/`map` — and a per-instance loop over them
     * produces confident garbage. (Measured: `Resolvable` and `JobInfoEvent`
     * both came back looking like empty objects for exactly this reason.)
     *
     * `instancesOnly` (default true) drops those three shapes. Pass false to get
     * the raw index back.
     */
    const isClassScaffolding = (id: number, className: string): boolean => {
      const n = snapshot.getNodeById(id);
      if (!n) return false;
      // `Foo (prototype) / https://…` and `system / SharedFunctionInfo / Foo`.
      if (n.name !== className) return true;
      if (n.type === 'code' || n.type === 'synthetic') return true;
      // The constructor closure itself: a closure named exactly like the class
      // whose only outgoing named edge is `prototype`.
      if (n.type === 'closure') {
        for (const e of n.references) {
          if (
            e.type === 'property' &&
            String(e.name_or_index) === 'prototype'
          ) {
            return true;
          }
        }
      }
      return false;
    };
    const byClass = (
      name: string,
      opts?: {type?: string; instancesOnly?: boolean},
    ): number[] => {
      const raw = buildClassTypeIndex().byClass.get(name) ?? [];
      const want = opts?.type;
      const ids =
        want == null
          ? raw
          : raw.filter(id => snapshot.getNodeById(id)?.type === want);
      if (opts?.instancesOnly === false) return ids;
      const filtered = ids.filter(id => !isClassScaffolding(id, name));
      // If the filter would empty a non-empty class, the heuristic is wrong for
      // this shape — hand back what we had rather than report "not present".
      return filtered.length > 0 || ids.length === 0 ? filtered : ids;
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

    /**
     * The GC-root path for one node, as `retainer_trace` walks it — but callable
     * from inside an eval.
     *
     * This exact `pathEdge` loop was hand-written five separate times in one
     * session, once per probe that needed to name an owner, each time with
     * slightly different truncation. Shipping it makes the traversal consistent
     * with the dedicated tool and removes the boilerplate that discourages
     * asking "who holds this?" in the middle of a larger eval.
     *
     * Root first, target last. `maxHops` bounds pathological chains.
     */
    const rootPath = (
      nodeOrId: number | {id: number},
      opts?: {maxHops?: number},
    ): Array<{id: number; name: string; type: string; edge: string | null}> => {
      const maxHops = opts?.maxHops ?? 24;
      let cur = resolveNode(nodeOrId);
      const out: Array<{
        id: number;
        name: string;
        type: string;
        edge: string | null;
      }> = [];
      const seen = new Set<number>();
      let hops = 0;
      while (cur != null && hops < maxHops && !seen.has(cur.id)) {
        seen.add(cur.id);
        const edge = cur.hasPathEdge && cur.pathEdge ? cur.pathEdge : null;
        out.push({
          id: cur.id,
          name: cur.name,
          type: cur.type,
          edge: edge ? `${String(edge.name_or_index)} [${edge.type}]` : null,
        });
        if (!edge) break;
        cur = edge.fromNode as IHeapNode | null;
        hops++;
      }
      return out.reverse();
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
      const cached = scratch.__typeIndex as Map<string, number[]> | undefined;
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
    const iterByClass = (
      name: string,
      opts?: {type?: string; instancesOnly?: boolean},
    ) => nodesFromIds(byClass(name, opts)).map(wrapNode);
    // Same thing under the name people actually reach for. `byClass` returns
    // IDS, and not all of them resolve through `snapshot.getNodeById` — native
    // classes (AudioContext, OpusRecorder, Recorder) come back null, so the
    // reflexive `byClass(x).map(id => getNodeById(id).referrers)` throws
    // "Cannot read properties of null" on the first attempt, every time. This
    // returns node objects and skips the unresolvable ones.
    const nodesByClass = iterByClass;
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
        if (name === '__proto__') continue;
        // V8 hangs the hidden class off an internal edge literally named
        // `map`; dropping it unconditionally also dropped a real property
        // named `map` (a config object with a `.map` field), which then
        // read as "the object does not have one".
        if (name === 'map' && e.type !== 'property') continue;
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

    // Walk up the dominator chain to the nearest node that carries a class
    // identity, skipping V8's containers and system objects. "Who owns this?"
    // is a loop every investigation rewrites by hand — and writes slightly
    // differently each time, which is why the same population gets attributed
    // to different owners on different days.
    //
    // A single-letter name is NOT skipped. In a minified bundle `t` and `e`
    // are the only class identity that exists; treating them as meaningless
    // walks straight past the owner and reports the system container above it.
    // Pair the name with `memlab_identify` to find out what it is.
    const CONTAINER_OWNER = /^(Object|Array|system(\s*\/.*)?|\(.*\))$/;
    const owner = (
      nodeOrId: number | {id: number},
      opts?: {maxHops?: number},
    ): {
      id: number;
      name: string;
      type: string;
      hops: number;
      selfSize: number;
      named: boolean;
    } | null => {
      requireRetention('owner');
      const start =
        typeof nodeOrId === 'number'
          ? snapshot.getNodeById(nodeOrId)
          : (unwrapNode(nodeOrId) as IHeapNode | null);
      if (start == null) return null;
      const maxHops = opts?.maxHops ?? 50;
      let cur: IHeapNode | null = start.dominatorNode ?? null;
      let last: IHeapNode | null = null;
      let hops = 1;
      let lastHops = 0;
      while (cur != null && cur.id > 3 && hops <= maxHops) {
        last = cur;
        lastHops = hops;
        if (!CONTAINER_OWNER.test(cur.name)) {
          return {
            id: cur.id,
            name: cur.name,
            type: cur.type,
            hops,
            selfSize: cur.self_size,
            named: true,
          };
        }
        const next: IHeapNode | null = cur.dominatorNode ?? null;
        if (next == null || next.id === cur.id) break;
        cur = next;
        hops++;
      }
      // Nothing but containers all the way up is itself the answer — report
      // the furthest node reached with named:false rather than null, which
      // would be indistinguishable from "no such node".
      if (last == null) return null;
      return {
        id: last.id,
        name: last.name,
        type: last.type,
        hops: lastHops,
        selfSize: last.self_size,
        named: false,
      };
    };

    // Group-and-count over ids. The single most-rewritten block in ad-hoc eval
    // code, and the one whose hand-written versions most often silently drop
    // the undefined bucket.
    const histogram = (
      ids: Iterable<number>,
      keyFn: (node: unknown, id: number) => string | null | undefined,
      opts?: {limit?: number},
    ): Array<{key: string; count: number}> => {
      const counts = new Map<string, number>();
      for (const id of ids) {
        const node = snapshot.getNodeById(id);
        if (node == null) continue;
        const raw = keyFn(wrapNode(node), id);
        const key = raw == null ? '(none)' : String(raw);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const rows = [...counts.entries()]
        .map(([key, count]) => ({key, count}))
        .sort((a, b) => b.count - a.count);
      return opts?.limit != null ? rows.slice(0, opts.limit) : rows;
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
      // `seen` is seeded with `fromId`, so the BFS below can never reach it
      // again and the trivial 0-hop path would come back as "no path".
      if (fromId === toId) {
        return {
          found: true,
          exhausted: false,
          path: [`@${fromId} ${start.name}`],
        };
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
      if (entry.handle !== currentHandle && opts?.allowCrossSnapshot !== true) {
        throw new Error(
          `"${name}" was saved against snapshot "${entry.handle}" and the current snapshot is "${currentHandle}". Node ids are per-capture, so ids from another snapshot resolve to unrelated objects or to nothing. ` +
            'If the value is counts/strings/shapes rather than ids, pass {allowCrossSnapshot: true} to read it anyway.',
        );
      }
      return entry.value;
    };
    // Cross-SESSION persistence. `save`/`load` above are scoped to the current
    // snapshot and dropped when it is unloaded, which is right for an id list
    // (ids are per-capture) and wrong for a derived fact — a decoded cap, a
    // per-entry cost, a conclusion. Those are what a later session needs and
    // the only thing that can meaningfully outlive the heap they came from.
    const remember = <T>(name: string, value: T): T => {
      writeEvalStore({...readEvalStore(), [name]: value});
      return value;
    };
    const recall = (name?: string): unknown => {
      const store = readEvalStore();
      return name == null ? Object.keys(store) : store[name];
    };

    // Evenly-spaced sampling, not random: two calls over the same population
    // return the same members, so a follow-up question lands on the objects
    // the first answer described. Math.random() here would silently make
    // every re-run a different measurement.
    const sample = <T>(items: Iterable<T>, n: number): T[] => {
      const arr = Array.isArray(items) ? (items as T[]) : [...items];
      if (n <= 0 || arr.length === 0) return [];
      if (arr.length <= n) return arr.slice();
      const step = arr.length / n;
      const out: T[] = [];
      for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
      return out;
    };

    const listSaved = (): Array<{name: string; handle: string}> =>
      listSavedResults();

    // Sandbox code holds PROXIED nodes (see wrapNode). The helpers below
    // read `retainedSize`, which the proxy refuses on purpose, so they take
    // the real node: unwrap at the boundary rather than making every caller
    // remember which helpers are proxy-safe.
    // The retention-bearing fields of a serialized node, blanked on a LIGHT
    // snapshot. The dominator pass never ran there, so they serialize as 0 /
    // null-by-accident — a confident wrong number. Blanked rather than
    // refused because everything else these two return (id, name, type,
    // self size, edge/referrer counts, string value) is genuinely available
    // on a light load, and refusing would take that away too.
    const blankRetentionOnLight = (
      s: NodeSummary | NodeDetail,
    ): Record<string, unknown> => {
      if (!light) return {...s};
      const out: Record<string, unknown> = {...s, retained_size: null};
      if ('dominator_id' in s) out.dominator_id = null;
      return out;
    };

    const helpers = {
      serializeNodeSummary: (n: unknown) =>
        blankRetentionOnLight(serializeNodeSummary(unwrapNode(n) as IHeapNode)),
      serializeNodeDetail: (n: unknown) =>
        blankRetentionOnLight(serializeNodeDetail(unwrapNode(n) as IHeapNode)),
      formatBytes,
      formatNumber,
      markdownTable,
      isNodeWorthInspecting: (n: unknown, ...rest: unknown[]) =>
        (isNodeWorthInspecting as (...a: unknown[]) => boolean)(
          unwrapNode(n),
          ...rest,
        ),
      // Both of these RANK by `node.retainedSize`, so both need the real
      // snapshot and a non-light load. The previous wrapper renamed the
      // first parameter `nodes` and mapped it as an array, which matched
      // neither utility's signature — `filterLargestObjects(snapshot,
      // filter, limit)` — and did nothing. Unwrapping is what was actually
      // needed: sandbox code only ever holds the PROXIED snapshot, whose
      // nodes refuse the very `retainedSize` read these two rank on.
      //
      // `RETENTION_IDENTIFIERS` catches `filterLargestObjects` textually
      // before the code runs; these runtime guards cover both, and cover
      // them precisely (a `queryNodes` count needs no retention at all).
      filterLargestObjects: (
        snap: unknown,
        filter: (node: IHeapNode) => boolean,
        limit: number,
      ) => {
        requireRetention('filterLargestObjects');
        return filterLargestObjects(
          unwrapNode(snap) as IHeapSnapshot,
          filter,
          limit,
        );
      },
      queryNodes: (
        snap: unknown,
        filter: (node: IHeapNode) => boolean,
        opts: Parameters<typeof queryNodes>[2],
      ) => {
        if (opts?.outputMode !== 'count') requireRetention('queryNodes');
        return queryNodes(unwrapNode(snap) as IHeapSnapshot, filter, opts);
      },
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
      ownProps,
      shapeKeys,
      hasShape,
      rootPath,
      shapeSignature,
      byClass,
      byTypename,
      withProp,
      aggregateRetained,
      isRealDetached,
      iterByClass,
      nodesByClass,
      iterByType,
      classCounts,
      edgeTarget,
      entries,
      dominates,
      owner,
      histogram,
      pathBetween,
      save,
      load,
      listSaved,
      remember,
      recall,
      sample,
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

    const budgetBytes = max_result_bytes ?? MAX_OUTPUT_SIZE;
    const shrunk = shrinkResult(sandbox.result, budgetBytes);

    let output: string;
    try {
      output = JSON.stringify(shrunk.value, null, 2) ?? 'undefined';
    } catch {
      output = String(shrunk.value);
    }

    // Pretty-printing adds indentation the byte budget above did not account
    // for, so the string clamp stays as a backstop; it should rarely fire now.
    output = truncate(output, budgetBytes * 2);

    if (consoleOutput.length > 0) {
      const consolePart = truncate(
        consoleOutput.join('\n'),
        MAX_OUTPUT_SIZE - output.length > 1024 ? 4096 : 1024,
      );
      output += '\n\n--- console output ---\n' + consolePart;
    }

    const footer: string[] = [];
    // Attached to the RESULT of the call that hand-rolled a built-in, because
    // that is the one moment the caller is guaranteed to read. Never suppresses
    // or alters the value above it.
    const hintText = code != null ? formatEvalHints(hintsForEval(code)) : null;
    if (hintText != null) footer.push(hintText);
    if (shrunk.truncated) {
      const nothingFit = shrunk.keptEntries === 0 && shrunk.droppedEntries > 0;
      footer.push(
        `⚠️ truncated: true — the result exceeded ${formatNumber(budgetBytes)} bytes` +
          (nothingFit
            ? `, and NOT EVEN ONE of the ${formatNumber(shrunk.droppedEntries)} entries fit inside it, ` +
              'so the value above is EMPTY. Nothing was kept — do not read it as a leading subset. ' +
              'A single entry is larger than the whole budget, so raise `max_result_bytes` ' +
              'substantially or return less per entry.'
            : shrunk.droppedEntries > 0
              ? `, so the last ${formatNumber(shrunk.droppedEntries)} entr${shrunk.droppedEntries === 1 ? 'y was' : 'ies were'} dropped. ` +
                'Entries are dropped whole, so what is shown is still valid and still the leading rows — ' +
                'sort your result before assigning it if the ones you want are not first.'
              : '.') +
          ' Raise `max_result_bytes`, or aggregate in the eval instead of returning raw rows.',
      );
    }
    if (budget.exceeded) {
      // A partial walk that also produced NO value is not a degraded answer, it
      // is no answer — and it prints as a bare `undefined`, which is exactly
      // what a legitimate empty census looks like. Refuse it instead: the
      // accumulator is usually assigned after the loops, so this is the common
      // shape of the failure, not an edge case.
      const producedNothing =
        sandbox.result === undefined || sandbox.result === null;
      if (producedNothing) {
        return errorResult(
          `Walk aborted after ${formatNumber(budget.max)} node visits (max_nodes) and the code assigned no \`result\`. ` +
            'Refusing to return the empty value: an aborted walk that produced nothing is indistinguishable from a genuine empty result, ' +
            'and reads as "this pattern is not in the heap".\n\n' +
            `This snapshot has ${formatNumber(getSnapshotMetadata()?.nodeCount ?? 0)} nodes, so the default budget allows ~6 full passes. ` +
            'Either raise `max_nodes`, narrow the scan with an indexed helper (`helpers.byClass` / `byTypename` / `withProp`) instead of a full ' +
            '`snapshot.nodes` walk, or assign to `result` incrementally so a partial answer is still meaningful — then re-run.',
        );
      }
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
    "- `helpers.props(nodeOrId) -> {prop: scalar | {ref, name, type}}` and `helpers.getProp(nodeOrId, name)` — read an object's own properties without the `for (const e of n.references) …` boilerplate. Number-valued props surface as a ref to a `smi number`/`heap number` node; their actual numeric value is not in the snapshot format. ⚠️ **`props()` is for INSPECTION, not for SHAPE MATCHING** — on a node with no `property` edges it falls back to a named internal/shortcut/hidden edge walk and adds `length`/`map`/`__via`/`__note`, so a shape test written against `Object.keys(props(id))` returns ZERO matches on objects that plainly have the shape. Use the next line for that.",
    '- `helpers.shapeKeys(nodeOrId) -> Set<string>`, `helpers.ownProps(nodeOrId) -> {…}`, `helpers.hasShape(nodeOrId, ["a","b"], {exact?, exclude?}) -> boolean` — own JS properties ONLY (`property` edges, no `__proto__`, no fallback, no provenance keys). **This is the correct way to ask "what shape is this object".** `hasShape(id, ["element","record"], {exact: true})` is the whole test.',
    '- `helpers.rootPath(nodeOrId, {maxHops?}) -> [{id, name, type, edge}]` — the GC-root path for one node, root first, exactly as `memlab_retainer_trace` walks it. Saves hand-writing the `while (cur.hasPathEdge) cur = cur.pathEdge.fromNode` loop inside a larger eval (which gets rewritten, slightly differently, every time a probe needs to name an owner).',
    '- `helpers.shapeSignature(nodeOrId, {maxStringLen?}) -> string` — stable shallow content signature (sorted prop names + scalar values) for duplicate-record detection. Numeric values are NOT captured (see `memlab_duplicate_objects`), so records differing only in a number field hash the same.',
    '- `helpers.byClass(name, {type?}) -> ids[]`, `helpers.byTypename(name) -> ids[]`, `helpers.withProp(name) -> ids[]` — INDEXED id lookups. The class/typename index is built once per snapshot and memoized in a session scratch, so a follow-up call is index-speed, not another full `snapshot.nodes` scan. `byClass` indexes EVERY node type (closure, string, array, native, …), matching `memlab_find_nodes_by_class`; pass `{type: "object"}` to narrow. `byTypename` is object-only because `__typename` is a JS property. (See also the `memlab_duplicate_objects` tool for a ready-made dedup report.)',
    '- `helpers.nodesByClass(name, {type?}) -> node[]` (alias of `iterByClass`) — the same lookup returning NODE OBJECTS. Prefer it over `byClass`: ids from `byClass` are not all resolvable through `snapshot.getNodeById` — native classes such as `AudioContext` / `OpusRecorder` come back null — so the reflexive `byClass(x).map(id => getNodeById(id).referrers)` throws `Cannot read properties of null` and needs defensive `if (!n) continue` boilerplate on every native-touching eval.',
    '- `helpers.iterByClass(name, {type?}) -> node[]` / `helpers.iterByType(type) -> node[]` — indexed iteration; no full scan, index built once per snapshot.',
    '- `helpers.classCounts({pattern?, type?, minCount?}) -> [{name, type, count, selfSize}]` — one-pass class histogram, cached; `pattern` is a case-insensitive regex (substring fallback).',
    '- `helpers.entries(nodeOrId) -> [{key, value}]` — generic container walk: Map/WeakMap (paired, SMI gaps handled), Set/WeakSet, Array (both direct `element` edges and the `(object elements)` backing store), plain object properties. Holes and `__proto__`/`map` are filtered.',
    '- `helpers.edgeTarget(nodeOrId, edgeName) -> node | null` — the node behind a named edge, when you need the node and not the `{ref,name,type}` wrapper `props()` returns.',
    '- `helpers.isRealDetached(node) -> boolean` — the oddball/root filtering the detached-DOM tools apply internally, so hand-written eval counts the same set they do.',
    '- `helpers.dominates(id, {population?, limit?}) -> {count, selfSize, ids, truncated}` — what this node actually owns (bounded 500-hop dominator walk). `population` is a predicate over nodes.',
    '- `helpers.owner(idOrNode, {maxHops?}) -> {id, name, type, hops, selfSize, named} | null` — nearest dominator carrying a class identity, skipping V8 containers (`Object`, `Array`, `system / …`, `(closure)`). Minified single-letter names are KEPT: in a production bundle they are the only identity there is — pair with `memlab_identify`. `named:false` means the walk found only containers and is reporting the furthest node reached.',
    '- `helpers.remember(name, value)` / `helpers.recall(name?)` — persist a derived fact to disk (`~/.memlab/eval-store.json`, override with `MEMLAB_STATE_DIR`) and read it back in a LATER session. `save`/`load` are per-snapshot and dropped on unload, which is right for id lists (ids are per-capture) and wrong for a conclusion. `recall()` with no name lists the keys.',
    '- `helpers.sample(items, n) -> items[]` — evenly-spaced sample, NOT random: two calls over the same population return the same members, so a follow-up question lands on the objects the first answer described.',
    '- `helpers.histogram(ids, keyFn, {limit?}) -> [{key, count}]` — group-and-count over ids, sorted by count; a null/undefined key becomes `(none)` rather than being dropped.',
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

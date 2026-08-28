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
import {nearestFiber, fiberComponentName} from '../react-shapes.js';
import {readElements as readElementsInfo} from '../heap-shapes.js';
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
  /** 1 = visit every node. N = visit every Nth (see the `sample` parameter). */
  sampleEvery?: number;
  /** Nodes CONSIDERED, including those skipped by sampling. */
  seen?: number;
  /** When set, `nodes.forEach` visits only these ids (see `restrict_to_ids`). */
  restrictTo?: Set<number>;
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
                const stride = budget.sampleEvery ?? 1;
                const only = budget.restrictTo;
                origForEach((node: unknown) => {
                  // `restrict_to_ids` promotes a cheap triage pass to an exact
                  // one without re-walking the graph blind: the same code runs,
                  // but only over the candidates the triage pass surfaced.
                  // Filtering here rather than in user code means the budget and
                  // the reported `nodes_visited` describe the real work.
                  if (
                    only != null &&
                    !only.has((node as {id?: number}).id ?? -1)
                  ) {
                    return undefined;
                  }
                  // Sampling is a STRIDE, not a random draw: two calls over the
                  // same snapshot visit the same nodes, so a follow-up question
                  // lands on the objects the first answer described.
                  const idx = budget.seen ?? 0;
                  budget.seen = idx + 1;
                  if (stride > 1 && idx % stride !== 0) return undefined;
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

/**
 * Words that make a bare `size` mean BYTES rather than a count of things.
 *
 * `size` on its own is ambiguous and mostly is not bytes: `sample_size`,
 * `arraySize`, `queueSize`, `mapSize` and `chainSize` all count items, and any
 * of them can legitimately exceed the heap's byte total on a small snapshot —
 * which would publish a confident "exceeds the whole snapshot" warning about a
 * field that was never measured in bytes. The warning below is only ever a
 * warning, so missing one is cheap and crying wolf is not; `size` therefore
 * needs corroboration from elsewhere in the key.
 */
const BYTE_CONTEXT_WORDS = new Set([
  'alloc',
  'allocated',
  'byte',
  'bytes',
  'footprint',
  'heap',
  'mem',
  'memory',
  'retained',
  'self',
  'store',
]);

/**
 * Scale factor for a key that names a byte quantity, or null if it names
 * something else.
 *
 * The unit is read from the key's last WORD rather than from a suffix match.
 * `mb`, `kb` and `gb` are two letters that also end ordinary English words, so
 * a suffix test rescales `numb`, `dumb`, `thumb` and `climb` by 1024^n — enough
 * to trip the implausibility warning below on a field holding no bytes at all.
 * Splitting on `_` and camelCase boundaries makes `heap_mb` and `heapMB` units
 * while leaving `dumb` a word.
 */
function byteUnitScale(key: string): number | null {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
  switch (words[words.length - 1]) {
    case 'gb':
      return 1024 ** 3;
    case 'mb':
      return 1024 ** 2;
    case 'kb':
      return 1024;
    case 'byte':
    case 'bytes':
      return 1;
    case 'size':
      // `retainedSize` and `self_size` are the fields this guard was written
      // for; `arraySize` is not. See BYTE_CONTEXT_WORDS.
      return words.some(w => BYTE_CONTEXT_WORDS.has(w)) ? 1 : null;
    default:
      return null;
  }
}

/**
 * Flag a numeric field that claims more bytes than the whole heap contains.
 *
 * A total larger than the snapshot is not a rounding error, it is a
 * double-count, and it is the easiest way for an eval to publish a confident
 * wrong number. Measured case: a verification walk over 820 Map backing tables
 * reported 7,005 MB of backing stores in a 425 MB heap — a Map's `table` yields
 * KEYS as well as values, and the key objects were members of every one of the
 * 820 tables, so each store was counted a few hundred times. It was caught only
 * because 7 GB in a 425 MB heap is absurd; a 1.4x error would have shipped.
 *
 * A warning, never an error: summing `retainedSize` over an arbitrary set
 * legitimately exceeds the heap (subtrees overlap), which is a real thing to
 * measure — `helpers.aggregateRetained` exists for the deduplicated version.
 */
function implausibleByteFields(
  value: unknown,
  heapBytes: number,
): Array<{path: string; bytes: number}> {
  if (heapBytes <= 0) return [];
  const hits: Array<{path: string; bytes: number}> = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, path: string, depth: number): void => {
    if (hits.length >= 4 || depth > 6 || node == null) return;
    if (typeof node === 'object') {
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        // Only a bounded prefix: a 10k-row census would otherwise be walked in
        // full to warn about at most four fields.
        for (let i = 0; i < Math.min(node.length, 200); i++) {
          visit(node[i], `${path}[${i}]`, depth + 1);
        }
        return;
      }
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (typeof v === 'number') {
          const scale = byteUnitScale(k);
          if (scale != null && v * scale > heapBytes) {
            hits.push({path: path ? `${path}.${k}` : k, bytes: v * scale});
          }
        } else {
          visit(v, path ? `${path}.${k}` : k, depth + 1);
        }
      }
    }
  };
  visit(value, '', 0);
  return hits;
}

/**
 * Deepest nesting of a `.references` / `.referrers` traversal inside another
 * loop, by brace depth.
 *
 * Textual, like the full-walk check next to it — the honest limit of a
 * pre-flight, and the alternative is parsing the code. It exists because
 * `max_nodes` bounds the OUTER loop and nothing warns that the inner one turns
 * a 7M-node pass into a 41M-edge one. A measured probe with two nested
 * traversals ran for ten minutes and returned nothing.
 */
function maxTraversalNesting(code: string): number {
  const TRAVERSAL = /\.\s*(?:references|referrers)\b/g;
  const LOOP =
    /\b(?:for\s*\(|while\s*\(|\.forEach\s*\(|\.map\s*\(|\.filter\s*\(|\.flatMap\s*\()/g;

  // Character-based, not line-based. The first version tested one line at a
  // time and scored `nodes.forEach(n => { for (const e of n.references) ... })`
  // as depth 0, because the loop it is nested in opens on the same line — which
  // is how this gets written most of the time.
  /**
   * Whether the construct whose opening paren ends at `from` will actually open
   * a brace body.
   *
   * A brace-less callback — `nodes.map(n => n.name)` — never does, and counting
   * it as pending made the NEXT unrelated `{` in the source (an `if` block, an
   * object literal) read as that loop's body, so every traversal after it was
   * reported one level deeper than it is. Scan from the paren: a `{` before the
   * parens balance is a callback body, a `{` immediately after they balance is
   * a `for`/`while` body, and anything else means there is no body to wait for.
   */
  const opensBraceBody = (from: number): boolean => {
    let parens = 1;
    for (let i = from; i < code.length; i++) {
      const c = code[i];
      if (c === '{') return true;
      if (c === '(') {
        parens++;
      } else if (c === ')') {
        parens--;
        if (parens === 0) {
          let j = i + 1;
          while (j < code.length && /\s/.test(code[j])) j++;
          return code[j] === '{';
        }
      }
    }
    return false;
  };

  type Event = {pos: number; kind: 'loop' | 'traversal'};
  const events: Event[] = [];
  for (const m of code.matchAll(LOOP)) {
    const pos = m.index ?? 0;
    // Every LOOP alternative ends with its opening paren.
    if (opensBraceBody(pos + m[0].length)) {
      events.push({pos, kind: 'loop'});
    }
  }
  for (const m of code.matchAll(TRAVERSAL)) {
    events.push({pos: m.index ?? 0, kind: 'traversal'});
  }
  events.sort((a, b) => a.pos - b.pos);

  const loopDepths: number[] = [];
  let depth = 0;
  let pendingLoops = 0;
  let deepest = 0;
  let next = 0;
  for (let i = 0; i < code.length; i++) {
    while (next < events.length && events[next].pos === i) {
      const ev = events[next++];
      if (ev.kind === 'loop') {
        pendingLoops++;
      } else {
        deepest = Math.max(deepest, loopDepths.length);
      }
    }
    const ch = code[i];
    if (ch === '{') {
      // The first `{` after a loop header opens that loop's body.
      if (pendingLoops > 0) {
        loopDepths.push(depth);
        pendingLoops--;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      while (
        loopDepths.length > 0 &&
        loopDepths[loopDepths.length - 1] >= depth
      ) {
        loopDepths.pop();
      }
    }
  }
  return deepest;
}

/**
 * The helper names from the most recent eval build in this process.
 *
 * `mode: "lint"` runs WITHOUT a snapshot, so it cannot construct the helpers
 * object to read its keys. Recording them here keeps the lint check honest:
 * when the list is unknown (a fresh server that has not run an eval yet) the
 * check is SKIPPED and said to be skipped, rather than reporting every real
 * helper as unknown.
 */
let lastKnownHelperNames: string[] | null = null;

/** True when `a` and `b` are within `max` single-character edits. Cheap bail-out. */
function editDistanceWithin(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return false;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length] <= max;
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
      'result = {count: ids.length, distinct: Object.keys(sigs).length};\n```\n' +
      '**Multi-step exploration:** pass `save_as` to keep a result set server-side and `helpers.load(name)` to read it back in a later call, so intermediate id lists never have to be printed to the transcript. `mode:"list_saved"` lists them. ' +
      'Runs on a LIGHT snapshot too (counts, names, types, self sizes, string values, edge walks). Code referencing retained sizes, dominators or path edges is refused up front there rather than returning zeros. ' +
      'Pass `max_nodes` to bound a full-heap walk — on overrun the partial `result` is returned with a warning instead of failing, so a broad scan is safe to attempt. Every call reports `nodes_visited`.',
    {
      mode: z
        .enum(['eval', 'describe_env', 'list_saved', 'lint'])
        .optional()
        .default('eval')
        .describe(
          '"eval" (default) runs `code`. "describe_env" ignores `code` and returns the in-scope globals, the IHeapNode/IHeapEdge API, and the required calling conventions (`result =`, `.forEach`) so you can self-correct before running — narrow it with `section` to avoid paying for all ~10 KB. "lint" syntax-checks `code`, lists the helpers it references and flags unknown ones, and estimates traversal nesting — all WITHOUT a snapshot, so a typo in a 40-line eval costs seconds instead of a 2-4 minute load. "list_saved" ignores `code` and lists the named result sets saved so far for this snapshot.',
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
            'edgeTarget(nodeOrId, edgeName)->node|null, walkChain(startOrNode, edgeName, {maxHops?, collectIds?})->{length, terminated:"cycle"|"end"|"cap", truncated} (USE THIS instead of a hand-written `while` over `.next` — a hand-rolled loop cannot tell a circular list from its own hop cap, and reports the cap as if it were the length), isRealDetached(node)->boolean (same filtering the tools apply internally), ' +
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
      sample: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(1)
        .describe(
          'TRIAGE MODE: visit only every Nth node in a `snapshot.nodes.forEach` walk (1 = every node, the default). A full-heap walk on a multi-million-node graph takes 1-2 minutes, which is enough friction that most exploratory ideas never get run at all; `sample: 200` answers "is there anything here?" in about a second, and you pay for the exact walk only once an idea looks worth it. The stride is deterministic, not random, so a follow-up question lands on the same objects. COUNTS COME BACK ~N TIMES LOW and the result is labelled an ESTIMATE — never record a sampled number as a measurement, and never conclude ABSENCE from one (a population of 50 is easily missed at stride 200).',
        ),
      section: z
        .string()
        .optional()
        .describe(
          'For mode:"describe_env" only — return just the section(s) whose heading matches this text (case-insensitive substring), e.g. "collection", "populations", "traversal", "IHeapNode". The calling conventions and the section list are always included. The full document is ~10 KB of tokens and is usually read to write one eval.',
        ),
      restrict_to_ids: z
        .array(z.number())
        .optional()
        .describe(
          'Restrict `snapshot.nodes.forEach` to these node ids, so the SAME code runs over a candidate set instead of the whole graph. This is how a `sample`-based triage pass is promoted to an exact answer without paying for a second blind full walk: run `sample: 200` with `save_as: "candidates"` collecting ids, then re-run with `restrict_to_ids: helpers.load("candidates")` and `sample: 1`. Filtering happens inside the walk, so `nodes_visited` reports the real work.',
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
  section,
  timeout_ms,
  save_as,
  max_nodes,
  sample,
  restrict_to_ids,
  dry_run,
  max_result_bytes,
  ownsScanBudget,
}: {
  mode?: 'eval' | 'describe_env' | 'list_saved' | 'lint';
  code?: string;
  section?: string;
  timeout_ms?: number;
  save_as?: string;
  max_nodes?: number;
  /** Visit every Nth node in a full-heap walk. 1/undefined = every node. */
  sample?: number;
  /** Restrict `snapshot.nodes.forEach` to these node ids. */
  restrict_to_ids?: number[];
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
  const budget: VisitBudget = {
    visited: 0,
    max: max_nodes,
    exceeded: false,
    sampleEvery: sample != null && sample > 1 ? Math.floor(sample) : 1,
    seen: 0,
    restrictTo:
      restrict_to_ids != null && restrict_to_ids.length > 0
        ? new Set(restrict_to_ids)
        : undefined,
  };
  try {
    if (mode === 'lint') {
      return toolResult(lintEval(code ?? '', lastKnownHelperNames));
    }
    if (mode === 'describe_env') {
      return toolResult(describeEnv(section));
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
      const indexed =
        /helpers\.(byClass|byTypename|withProp|byReferrerEdge|getNode)/.test(
          code,
        );
      const nestingDepth = maxTraversalNesting(code);
      const meanOutDegree =
        (meta?.edgeCount ?? 0) / Math.max(1, meta?.nodeCount ?? 1);
      // A nested `.references` walk inside a full-heap walk costs EDGE visits,
      // not node visits, and the difference is the difference between seconds
      // and "the probe died at 600s having produced nothing". `max_nodes`
      // bounds the outer loop only, so nothing else warns about this.
      const estimatedVisits =
        fullWalk && nestingDepth > 0
          ? (meta?.nodeCount ?? 0) * Math.pow(meanOutDegree, nestingDepth)
          : null;
      return toolResult(
        [
          '## Dry run — nothing was executed',
          '',
          `Snapshot: ${formatNumber(meta?.nodeCount ?? 0)} nodes, ${formatNumber(meta?.edgeCount ?? 0)} edges.`,
          `Walk budget (\`max_nodes\`): ${formatNumber(budget.max)}.`,
          '',
          fullWalk
            ? `⚠ The code contains a full-heap walk, so it will visit up to ${formatNumber(Math.min(budget.max, meta?.nodeCount ?? 0))} nodes. On a heap this size that is seconds to minutes.${indexed ? '' : ' `helpers.byClass` / `byTypename` / `withProp` / `byReferrerEdge` are indexed and avoid the walk when you know what you are looking for.'}`
            : indexed
              ? 'No full-heap walk detected; the code uses the indexed helpers, which do not scan the heap.'
              : 'No full-heap walk detected by text match. This is a textual check, not an analysis — a walk reached indirectly will not be seen here.',
          estimatedVisits != null && nestingDepth >= 1
            ? `⚠ NESTED TRAVERSAL, depth ${nestingDepth}: the walk iterates \`.references\`/\`.referrers\` inside the outer loop, so the real cost is EDGE visits — roughly ${formatNumber(Math.round(estimatedVisits))} (${formatNumber(meta?.nodeCount ?? 0)} nodes x mean out-degree ${meanOutDegree.toFixed(1)}^${nestingDepth}). \`max_nodes\` bounds the OUTER loop only and will not stop this.${nestingDepth >= 2 ? ' At depth 2 or more, expect minutes: hoist the inner lookup, or collect candidate ids in a cheap pass and re-run with `restrict_to_ids`.' : ''}`
            : '',
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
      opts?: {maxHops?: number; collapseRepeatedEdges?: boolean},
    ): Array<{
      id: number;
      name: string;
      type: string;
      edge: string | null;
      repeated?: number;
    }> => {
      const maxHops = opts?.maxHops ?? 24;
      // Collapsing is ON by default. Inside a linked-list leak — React update
      // queues, LRU chains, intrusive `.prev` lists — every hop is the SAME
      // edge, so the whole budget is spent walking the leak instead of escaping
      // it. Measured: 114 of 120 sampled update records returned
      // `Object.next -> Object.next -> ... (18 hops, no root)`, which
      // attributes nothing and then dominates the "top root paths" histogram
      // with an artifact of the walk.
      const collapse = opts?.collapseRepeatedEdges ?? true;
      let cur = resolveNode(nodeOrId);
      const out: Array<{
        id: number;
        name: string;
        type: string;
        edge: string | null;
        repeated?: number;
      }> = [];
      const seen = new Set<number>();
      let distinctHops = 0;
      let lastEdgeKey: string | null = null;
      let runLength = 0;
      while (cur != null && distinctHops < maxHops && !seen.has(cur.id)) {
        seen.add(cur.id);
        const edge = cur.hasPathEdge && cur.pathEdge ? cur.pathEdge : null;
        const edgeStr = edge
          ? `${String(edge.name_or_index)} [${edge.type}]`
          : null;
        // A run is the same edge name arriving at the same class — that is the
        // shape a chain makes, and it keeps two unrelated `.value` hops apart.
        const edgeKey = edgeStr == null ? null : `${cur.name}\u0000${edgeStr}`;
        if (collapse && edgeKey != null && edgeKey === lastEdgeKey) {
          runLength++;
          const prev = out[out.length - 1];
          prev.repeated = runLength + 1;
        } else {
          out.push({
            id: cur.id,
            name: cur.name,
            type: cur.type,
            edge: edgeStr,
          });
          lastEdgeKey = edgeKey;
          runLength = 0;
          // Only a DISTINCT hop spends budget; a 2,000-link chain should cost
          // one, so the remaining hops can reach the actual owner.
          distinctHops++;
        }
        if (!edge) break;
        cur = edge.fromNode as IHeapNode | null;
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

    /**
     * The scope object a closure captured, or null if it captured nothing.
     *
     * Exists because the hand-written version is wrong in a way that returns a
     * clean zero: the hop is an `internal` edge NAMED `context`, not a
     * `context`-TYPED edge (that type only appears on the edges INSIDE the
     * scope). Filtering on `e.type === 'context'` matches nothing on any heap.
     */
    const contextOf = (nodeOrId: number | {id: number}): unknown => {
      const n = resolveNode(nodeOrId);
      if (n == null) return null;
      for (const e of n.references) {
        if (String(e.name_or_index) === 'context' && e.type === 'internal') {
          return wrapNode(e.toNode);
        }
      }
      return null;
    };

    /**
     * Every closure class, with how many of them captured a scope.
     *
     * A per-name count alone does not separate "1,000 copies of a function" from
     * "1,000 copies each pinning a distinct scope", and only the second is a
     * retention story. Cached, since it is a full pass.
     */
    const closureCensus = (opts?: {
      minCount?: number;
      pattern?: string;
    }): Array<{name: string; count: number; withScope: number}> => {
      const key = '__closureCensus';
      let all = scratch[key] as
        Array<{name: string; count: number; withScope: number}> | undefined;
      if (!all) {
        const acc = new Map<string, {count: number; withScope: number}>();
        snapshot.nodes.forEach((node: IHeapNode) => {
          if (node.id <= 3 || node.type !== 'closure') return;
          let rec = acc.get(node.name);
          if (!rec) {
            rec = {count: 0, withScope: 0};
            acc.set(node.name, rec);
          }
          rec.count++;
          for (const e of node.references) {
            if (
              String(e.name_or_index) === 'context' &&
              e.type === 'internal'
            ) {
              rec.withScope++;
              break;
            }
          }
        });
        all = [...acc.entries()]
          .map(([name, r]) => ({name, ...r}))
          .sort((a, b) => b.count - a.count);
        scratch[key] = all;
      }
      const minCount = opts?.minCount ?? 1;
      const re =
        opts?.pattern != null ? makeNamePatternTest(opts.pattern) : null;
      return all.filter(r => r.count >= minCount && (re == null || re(r.name)));
    };

    /**
     * Objects shaped like an event-listener record — carrying BOTH a
     * callback-ish and a context-ish property.
     *
     * This walk gets rewritten by hand almost every round, slightly differently
     * each time, which makes two rounds' numbers incomparable for reasons that
     * have nothing to do with the app. `callbackNamed` narrows to records whose
     * callback is a specific closure class, which is the form the question is
     * actually asked in ("how many `subscribe_$0` records are held?").
     */
    const listenerRecords = (
      callbackNamed?: string,
    ): Array<{id: number; callback: string; context: string}> => {
      const key = '__listenerRecords';
      let all = scratch[key] as
        Array<{id: number; callback: string; context: string}> | undefined;
      if (!all) {
        const found: Array<{id: number; callback: string; context: string}> =
          [];
        snapshot.nodes.forEach((node: IHeapNode) => {
          if (node.id <= 3 || node.type !== 'object') return;
          let cb: IHeapNode | null = null;
          let ctx: IHeapNode | null = null;
          for (const e of node.references) {
            if (e.type !== 'property') continue;
            const p = String(e.name_or_index);
            if (cb == null && LISTENER_CALLBACK_PROPS.has(p)) cb = e.toNode;
            else if (ctx == null && LISTENER_CONTEXT_PROPS.has(p))
              ctx = e.toNode;
            if (cb != null && ctx != null) break;
          }
          if (cb != null && ctx != null) {
            found.push({id: node.id, callback: cb.name, context: ctx.name});
          }
        });
        all = found;
        scratch[key] = all;
      }
      return callbackNamed == null
        ? all
        : all.filter(r => r.callback === callbackNamed);
    };

    /**
     * Detached nodes whose CLASS NAME contains `needle`.
     *
     * Note what this cannot do, because the reflexive attempt returns a clean
     * zero: a detached node's `name` is its element or Blink class — `Detached
     * EventListener`, `Detached blink::RegisteredEventListener`, `Detached
     * HTMLDivElement` — and never a `data-testid`. Measured on a real capture:
     * 908 detached nodes, whose top names were `Detached EventListener` (148),
     * `Detached blink::RegisteredEventListener` (148) and `Detached
     * V8EventListener` (146). Filtering these for an app-level testid matches
     * nothing on any heap. For "which UI element leaked", go through the
     * retainer path (`memlab_detached_dom` groups by nearest non-detached
     * dominator) rather than the node name.
     */
    const detachedNamed = (
      needle: string,
    ): Array<{id: number; name: string}> => {
      const lowered = needle.toLowerCase();
      const out: Array<{id: number; name: string}> = [];
      snapshot.nodes.forEach((node: IHeapNode) => {
        if (node.id <= 3) return;
        if (!node.is_detached && !node.name.startsWith('Detached ')) return;
        if (!node.name.toLowerCase().includes(lowered)) return;
        out.push({id: node.id, name: node.name});
      });
      return out;
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

    // Walk a dotted path of edges, reporting WHERE it stopped.
    //
    // The one-level-off mistake is the most common way an eval produces a
    // clean-looking wrong answer: a probe tested `_PSD` on an LRU wrapper when
    // the field lived on `wrapper.value`, got 0 across 300 samples, and the
    // zero was reported before the level was rechecked. `edgeTarget` chained by
    // hand hides that, because a null halfway looks the same as a null at the
    // end.
    const derefPath = (nodeOrId: unknown, path: string): unknown => {
      let cur =
        typeof nodeOrId === 'number'
          ? snapshot.getNodeById(nodeOrId)
          : (unwrapNode(nodeOrId) as IHeapNode | null);
      if (cur == null) return {found: false, stoppedAt: '(start)', node: null};
      const parts = path.split('.').filter(Boolean);
      const walked: string[] = [];
      for (const part of parts) {
        let next: IHeapNode | null = null;
        const node: IHeapNode = cur;
        for (const e of node.references) {
          if (e.type === 'hidden') continue;
          if (String(e.name_or_index) === part) {
            next = e.toNode;
            break;
          }
        }
        if (next == null) {
          return {
            found: false,
            stoppedAt: walked.length > 0 ? walked.join('.') : '(start)',
            missingEdge: part,
            node: null,
            available: [...node.references]
              .filter(e => e.type === 'property')
              .slice(0, 20)
              .map(e => String(e.name_or_index)),
          };
        }
        walked.push(part);
        cur = next;
      }
      return {found: true, stoppedAt: walked.join('.'), node: wrapNode(cur)};
    };

    // "Is there anything matching this within N hops?" — answers the question
    // derefPath needs you to already know the answer to.
    const findWithin = (
      nodeOrId: unknown,
      edgeName: string,
      opts?: {maxDepth?: number},
    ): unknown => {
      const start =
        typeof nodeOrId === 'number'
          ? snapshot.getNodeById(nodeOrId)
          : (unwrapNode(nodeOrId) as IHeapNode | null);
      if (start == null) return [];
      const maxDepth = Math.max(1, Math.min(opts?.maxDepth ?? 3, 6));
      const seen = new Set<number>([start.id]);
      const hits: Array<{path: string; id: number; name: string}> = [];
      const queue: Array<{node: IHeapNode; path: string; depth: number}> = [
        {node: start, path: '', depth: 0},
      ];
      while (queue.length > 0 && hits.length < 25) {
        const item = queue.shift();
        if (!item) break;
        for (const e of item.node.references) {
          if (e.type === 'hidden') continue;
          const name = String(e.name_or_index);
          const path = item.path ? `${item.path}.${name}` : name;
          if (name === edgeName) {
            hits.push({path, id: e.toNode.id, name: e.toNode.name});
            if (hits.length >= 25) break;
          }
          if (item.depth + 1 < maxDepth && !seen.has(e.toNode.id)) {
            seen.add(e.toNode.id);
            queue.push({node: e.toNode, path, depth: item.depth + 1});
          }
        }
      }
      return hits;
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

    // Walk a repeated linked structure and say HOW it ended.
    //
    // Hand-written versions of this loop are the single most reliable way to
    // publish a wrong number from an eval. React's `queue.pending` is CIRCULAR,
    // so `while (next && next.id !== start)` with a `hops < 800` guard reported
    // `longestNextChain: 800` — the cap, presented as a measurement. The true
    // length was 2,066, and nothing in the output distinguished "the list ended"
    // from "I stopped counting". The discriminator is the point of this helper:
    // `terminated: 'cap'` means the number is a floor, not a length.
    const walkChain = (
      startOrNode: unknown,
      edgeName: string,
      opts?: {maxHops?: number; collectIds?: boolean},
    ): {
      length: number;
      terminated: 'cycle' | 'end' | 'cap';
      truncated: boolean;
      ids?: number[];
    } => {
      const maxHops = Math.max(1, opts?.maxHops ?? 100000);
      const start =
        typeof startOrNode === 'number'
          ? snapshot.getNodeById(startOrNode)
          : (unwrapNode(startOrNode) as IHeapNode | null);
      if (start == null) {
        throw new Error(`walkChain: start node not found`);
      }
      const seen = new Set<number>();
      const ids: number[] = [];
      let cur: IHeapNode | null = start;
      let terminated: 'cycle' | 'end' | 'cap' = 'end';
      while (cur != null) {
        if (seen.has(cur.id)) {
          terminated = 'cycle';
          break;
        }
        if (seen.size >= maxHops) {
          terminated = 'cap';
          break;
        }
        seen.add(cur.id);
        if (opts?.collectIds) ids.push(cur.id);
        let nextNode: IHeapNode | null = null;
        for (const e of cur.references) {
          if (String(e.name_or_index) !== edgeName) continue;
          nextNode = e.toNode.id > 3 ? e.toNode : null;
          break;
        }
        cur = nextNode;
      }
      return {
        length: seen.size,
        terminated,
        truncated: terminated === 'cap',
        ...(opts?.collectIds ? {ids} : {}),
      };
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
      // React fallback. Hooks, update queues and fibers are all plain `Object`,
      // so the container filter above walks straight past every one of them and
      // reports nothing: on one population `recordsByOwner` came back
      // `[["(none)", 1645]]` for 100% of the records. A fiber is recognisable
      // by its own fields rather than by its class name, and its component name
      // is the answer the caller actually wanted.
      const fiber = nearestFiber(start, maxHops);
      if (fiber != null) {
        const componentName = fiberComponentName(fiber);
        return {
          id: fiber.id,
          name: componentName ?? fiber.name,
          type: fiber.type,
          hops: 0,
          selfSize: fiber.self_size,
          named: componentName != null,
        };
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

    // Elements backing store, read correctly. Five separate facts are needed
    // (owner-vs-store edge split, SMI invisibility, unmeasurability, slot-width
    // calibration, dictionary detection) and every one of them was got wrong
    // once before it was got right — see src/heap-shapes.ts. Hand-deriving this
    // in an eval is how an all-SMI array reads as 100% wasted.
    const elements = (nodeOrId: number | {id: number}): unknown => {
      const n =
        typeof nodeOrId === 'number'
          ? snapshot.getNodeById(nodeOrId)
          : (unwrapNode(nodeOrId) as IHeapNode | null);
      if (n == null) return null;
      return readElementsInfo(snapshot, n);
    };

    // DISTINCT nodes pointed at by an edge with this name — the mirror of
    // `withProp`, which finds nodes that HAVE the property. Asking "what is
    // stored under `.logs` anywhere in the heap" previously needed a full scan.
    //
    // Deduplicated because a shared target reached from N referrers is one
    // storage site, not N: the obvious use ("how many distinct places hold a
    // `.logs`") would otherwise multiply-count every shared array, and nothing
    // in the returned ids says which of them were duplicates.
    const byReferrerEdge = (edgeName: string): number[] => {
      const hits = new Set<number>();
      snapshot.nodes.forEach(node => {
        for (const e of node.references) {
          if (String(e.name_or_index) !== edgeName) continue;
          if (e.toNode.id > 3) hits.add(e.toNode.id);
          break;
        }
      });
      return [...hits];
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

    const helpersImpl = {
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
      contextOf,
      closureCensus,
      listenerRecords,
      detachedNamed,
      isRealDetached,
      iterByClass,
      nodesByClass,
      iterByType,
      classCounts,
      edgeTarget,
      walkChain,
      elements,
      byReferrerEdge,
      derefPath,
      findWithin,
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

    /**
     * A mistyped helper name used to fail as `helpers.foo is not a function`,
     * with no clue what the right name was. The surface is 40+ helpers and
     * `describe_env` is a separate round trip that costs ~10 KB of tokens, so
     * the cheapest fix is to answer the question at the point it is asked.
     */
    const helperNames = Object.keys(helpersImpl).sort();
    lastKnownHelperNames = helperNames;
    const helpers = new Proxy(helpersImpl, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && !(prop in target)) {
          const lower = prop.toLowerCase();
          const near = helperNames.filter(
            n =>
              n.toLowerCase().includes(lower) ||
              lower.includes(n.toLowerCase()) ||
              editDistanceWithin(n.toLowerCase(), lower, 2),
          );
          throw new Error(
            `helpers.${prop} does not exist.` +
              (near.length > 0
                ? ` Did you mean: ${near.slice(0, 5).join(', ')}?`
                : '') +
              ` All helpers: ${helperNames.join(', ')}.` +
              ' Use mode:"describe_env" for signatures.',
          );
        }
        return Reflect.get(target, prop, receiver);
      },
    });

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
    let wallClockTimedOut = false;
    try {
      script.runInContext(context, {timeout: timeout_ms});
    } catch (err) {
      // A wall-clock timeout used to discard everything and return only
      // "Execution timed out", while a `max_nodes` overrun returned the partial
      // value with a warning. That asymmetry is the expensive one: a probe that
      // ran 120s, was backgrounded and died at 600s produced ZERO information,
      // which is a strong argument against ever writing an ambitious eval
      // again. V8 terminates the script but the sandbox keeps whatever was
      // already assigned, so the partial value is right there.
      if (isScriptTimeout(err) && sandbox.result !== undefined) {
        wallClockTimedOut = true;
      } else if (!(err instanceof BudgetExceeded)) {
        // Keyed on the error itself, never on `budget.exceeded`: code that
        // catches the abort and then throws for an unrelated reason must
        // still surface that error.
        throw err;
      }
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
    if (
      save_as != null &&
      !budget.exceeded &&
      !wallClockTimedOut &&
      !nothingToSave
    ) {
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
    const heapBytes = getSnapshotMetadata()?.totalSize ?? 0;
    const implausible = implausibleByteFields(sandbox.result, heapBytes);
    if (implausible.length > 0) {
      footer.push(
        `⚠️ IMPLAUSIBLE TOTAL — ${implausible
          .map(h => `\`${h.path}\` = ${formatBytes(h.bytes)}`)
          .join(
            ', ',
          )} exceeds the whole snapshot (${formatBytes(heapBytes)}). ` +
          'A byte total larger than the heap is a DOUBLE-COUNT, not a big number. The usual cause is walking a ' +
          'Map/Set backing `table`, which yields KEYS as well as values and whose members are frequently shared ' +
          'across many containers, so the same node is measured once per container. Deduplicate by node id ' +
          '(`const seen = new Set()`) and re-run. If you meant to sum overlapping retained subtrees, use ' +
          '`helpers.aggregateRetained(ids)` for the dominator-deduplicated figure.',
      );
    }
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
    if (wallClockTimedOut) {
      footer.push(
        `⚠️ WALL-CLOCK TIMEOUT after ${formatNumber(timeout_ms)}ms — the value above is PARTIAL. ` +
          'It is whatever your code had assigned to `result` when the script was terminated, so treat every count in ' +
          'it as a FLOOR, not a measurement. Raise `timeout_ms`, narrow the scan with an indexed helper ' +
          '(`helpers.byClass` / `byTypename` / `withProp` / `byReferrerEdge`), or run `dry_run: true` first — a nested ' +
          'walk over `.references` inside a `nodes.forEach` costs edge-visits, not node-visits.',
      );
      if (save_as != null) {
        footer.push(
          `Not saved as "${save_as}" — a partial result would be indistinguishable from a complete one on reload.`,
        );
      }
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
      const stride = budget.sampleEvery ?? 1;
      if (stride > 1) {
        footer.push(
          `⚠️ ESTIMATE — sampled 1-in-${formatNumber(stride)}: the walk considered ` +
            `${formatNumber(budget.seen ?? 0)} nodes and ran your callback on ` +
            `${formatNumber(budget.visited)} of them. **Counts above are roughly ` +
            `${formatNumber(stride)}x low**; multiply to estimate, and re-run with ` +
            '`sample: 1` before recording any number. A ZERO here is not absence — ' +
            `a population smaller than ~${formatNumber(stride)} is easily missed entirely.`,
        );
      }
      // A whole-heap walk that matched NOTHING is reported as a confident
      // negative — "there are no closures with captured scopes" — when the
      // overwhelmingly likelier cause is a predicate that cannot match.
      //
      // The edge-type filter is the canonical way to get here: a JSFunction's
      // hop to its Context is an `internal` edge NAMED `context`, so the
      // reflexive `e.type === 'context'` matches zero edges on every heap and
      // returns a clean 0 with no error. That silent zero is worse than a
      // throw, because nothing in the output suggests re-checking the filter.
      if (
        (budget.sampleEvery ?? 1) === 1 &&
        budget.visited >= ZERO_MATCH_WALK_THRESHOLD &&
        isEmptyCensusResult(sandbox.result)
      ) {
        footer.push(
          `⚠️ ZERO matches over ${formatNumber(budget.visited)} node visits. This may be a real negative — ` +
            'but a whole-heap walk that matches nothing is more often a predicate that cannot match. ' +
            'Check the edge-type filter first: a closure→scope hop is an `internal` edge NAMED `context` ' +
            "(`e.name_or_index === 'context'`), NOT `e.type === 'context'`; `props()` adds provenance keys so " +
            'shape tests must use `helpers.shapeKeys`/`hasShape`; and `byClass` needs the exact class name. ' +
            'Confirm with a deliberately broad version of the same predicate before recording this as "not present".',
        );
      }
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

/**
 * True for the `vm` module's wall-clock timeout.
 *
 * Keyed on `err.code`, which is a documented Node error code, with the message
 * text only as a fallback. Matching the prose alone couples salvaging a partial
 * result to V8's exact wording: a reworded message would silently stop matching
 * and quietly revert to throwing away the partial value, which is the behaviour
 * this branch exists to prevent.
 */
function isScriptTimeout(err: unknown): boolean {
  // Deliberately NOT `err instanceof Error`. `vm` raises this from the script's
  // OWN realm, whose `Error` is a different constructor, so a cross-realm
  // instanceof is false — measured, not assumed. Gating on it made the salvage
  // below unreachable: every wall-clock timeout fell through to `throw err` and
  // the partial `result` was discarded, which is the exact behaviour this
  // branch was written to end.
  if (err == null || typeof err !== 'object') return false;
  const e = err as {code?: unknown; message?: unknown};
  if (e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return true;
  return (
    typeof e.message === 'string' &&
    e.message.includes('Script execution timed out')
  );
}

// Map the opaque VM errors that the documented calling-convention mistakes
// produce into actionable guidance (Feedback §3).
function actionableEvalError(err: unknown, code: string | undefined): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (isScriptTimeout(err)) {
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

/**
 * A result that says "none of them" — 0, `[]`, `{}`, or an empty Map/Set.
 *
 * `undefined`/`null` are deliberately NOT included: those mean "the code
 * assigned nothing", which is a different failure and is already handled.
 */
export function isEmptyCensusResult(v: unknown): boolean {
  if (v === 0) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (v instanceof Map || v instanceof Set) return v.size === 0;
  if (v != null && typeof v === 'object') {
    return Object.keys(v as Record<string, unknown>).length === 0;
  }
  return false;
}

/**
 * How many node visits make a zero result worth questioning.
 *
 * Below this the caller probably scanned an indexed subset and legitimately
 * found nothing; above it they walked the whole graph and got no match, which
 * is far more often a wrong predicate than an empty heap.
 */
const ZERO_MATCH_WALK_THRESHOLD = 100000;

/**
 * Property names that make an object look like an event-listener record. Kept
 * identical to `stale-collections.ts` on purpose: two tools disagreeing about
 * what a listener record IS produces two incomparable counts of the same thing.
 */
const LISTENER_CALLBACK_PROPS = new Set([
  'callback',
  'fn',
  'handler',
  'listener',
]);
const LISTENER_CONTEXT_PROPS = new Set([
  'context',
  'ctx',
  'this',
  'target',
  'scope',
]);

/** Helper names mentioned as `helpers.x(` anywhere in the describe_env text. */
function documentedHelperNames(): string[] {
  const doc = describeEnvLines().join('\n');
  return [
    ...new Set(
      [...doc.matchAll(/helpers\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]),
    ),
  ].sort();
}

/**
 * Syntax-check an eval and report what it references — WITHOUT a snapshot.
 *
 * The only way to discover a typo in a 40-line eval used to be to pay a 2–4
 * minute snapshot load first, which is enough friction that most exploratory
 * ideas were never written down. Everything here is decidable from the source
 * text alone, so the cost of a wrong guess drops from minutes to seconds.
 */
function lintEval(code: string, knownHelpers: string[] | null): string {
  const lines: string[] = ['## memlab_eval lint — nothing was executed', ''];
  if (code.trim() === '') {
    return 'Pass `code` to lint. Nothing to check.';
  }

  let syntaxOk = true;
  try {
    // Compiling does not run anything; it is the same parse the real call does.
    new vm.Script(code, {filename: 'memlab_eval_lint'});
    lines.push('- **Syntax:** parses cleanly.');
  } catch (err) {
    syntaxOk = false;
    lines.push(
      `- **Syntax ERROR:** ${err instanceof Error ? err.message : String(err)}`,
    );
    if (
      err instanceof SyntaxError &&
      /Illegal return/.test(err.message ?? '')
    ) {
      lines.push('  Assign to `result` instead of using a top-level `return`.');
    }
  }

  if (!/\bresult\s*=/.test(code)) {
    lines.push(
      '- ⚠ **No assignment to `result`** — the call will run and return nothing. This is the single most common eval mistake.',
    );
  }

  const referenced = [
    ...new Set(
      [...code.matchAll(/helpers\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]),
    ),
  ].sort();
  if (referenced.length > 0) {
    lines.push(`- **Helpers referenced:** ${referenced.join(', ')}.`);
    // On a fresh server the live table has not been built yet (it needs a
    // snapshot). The documented list is the next best source and is always
    // available — worded as "not documented" so an undocumented-but-real helper
    // is not reported as a typo.
    const documented = documentedHelperNames();
    const table = knownHelpers ?? documented;
    const authoritative = knownHelpers != null;
    {
      const unknown = referenced.filter(n => !table.includes(n));
      if (unknown.length === 0) {
        lines.push(
          authoritative
            ? '  All exist.'
            : '  All are documented (checked against `describe_env`; this server has not built the live helper table yet).',
        );
      } else {
        for (const name of unknown) {
          const lower = name.toLowerCase();
          const near = table.filter(
            n =>
              n.toLowerCase().includes(lower) ||
              lower.includes(n.toLowerCase()) ||
              editDistanceWithin(n.toLowerCase(), lower, 2),
          );
          lines.push(
            `  - ❌ \`helpers.${name}\` does not exist.` +
              (near.length > 0
                ? ` Did you mean ${near.slice(0, 4).join(', ')}?`
                : ''),
          );
        }
      }
    }
  }

  const fullWalk = /\b(?:snapshot\.)?(?:nodes|edges)\s*\.\s*forEach/.test(code);
  const nesting = maxTraversalNesting(code);
  if (fullWalk) {
    lines.push(
      `- **Full-heap walk:** yes${nesting > 0 ? `, with a nested \`.references\`/\`.referrers\` traversal at depth ${nesting}` : ''}.` +
        (nesting >= 2
          ? ' At depth 2 or more the cost is edge-visits and typically runs for minutes — run `dry_run: true` against the loaded snapshot for a concrete estimate.'
          : ''),
    );
  } else {
    lines.push('- **Full-heap walk:** none detected by text match.');
  }

  if (/for\s*\(\s*const\s+\w+\s+of\s+snapshot\.nodes/.test(code)) {
    lines.push(
      '- ❌ `snapshot.nodes` is NOT for-of iterable. Use `snapshot.nodes.forEach(node => { ... })`.',
    );
  }
  if (
    /\.\s*retained_?[Ss]ize\b/.test(code) &&
    !/helpers\.retainedSize/.test(code)
  ) {
    lines.push(
      '- ⚠ `node.retainedSize` / `node.retained_size` THROW inside eval (they read back ~0 on some loads). Use `helpers.retainedSize(id)` / `helpers.retainedSizes([ids])` / `helpers.aggregateRetained([ids])`.',
    );
  }

  lines.push(
    '',
    syntaxOk
      ? '_Re-run with `mode:"eval"` (the default) to execute._'
      : '_Fix the syntax error first._',
  );
  return lines.join('\n');
}

function describeEnv(section?: string): string {
  const all = describeEnvLines();
  if (section == null || section.trim() === '') return all.join('\n');
  const wanted = section.trim().toLowerCase();
  // Split on `## ` headings and keep the ones that match. The calling
  // conventions always travel with the answer: they are what an eval gets wrong
  // when it is written from a partial read of this document.
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of all) {
    if (line.startsWith('## ')) {
      if (current.length > 0) blocks.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  const headings = blocks
    .map(b => b[0])
    .filter(h => h.startsWith('## '))
    .map(h => h.slice(3));
  const isConventions = (heading: string): boolean =>
    heading.toLowerCase().includes('calling convention');
  const required = blocks.filter(b => isConventions(b[0]));
  const matched = blocks.filter(
    b =>
      b[0].startsWith('## ') &&
      b[0].toLowerCase().includes(wanted) &&
      !isConventions(b[0]),
  );
  // Naming the calling conventions is not a miss. That block is kept out of
  // `matched` only because `required` always emits it, so treating it as
  // unmatched answered `section: "calling"` — or "convention", or the
  // "(REQUIRED)" in its own heading — with `no section matches`, for the one
  // section guaranteed to be in every reply.
  const wantedConventions = required.some(b =>
    b[0].toLowerCase().includes(wanted),
  );
  if (matched.length === 0 && !wantedConventions) {
    return [
      `# memlab_eval environment — no section matches "${section}"`,
      '',
      `Sections: ${headings.map(h => `"${h}"`).join(', ')}.`,
      'Omit `section` for the whole document.',
    ].join('\n');
  }
  return [
    '# memlab_eval environment (filtered)',
    '',
    ...required.flatMap(b => [...b, '']),
    ...matched.flatMap(b => [...b, '']),
    `_Other sections: ${headings
      .filter(h => !isConventions(h) && !matched.some(b => b[0].slice(3) === h))
      .map(h => `"${h}"`)
      .join(', ')}. Omit \`section\` for all of them._`,
  ].join('\n');
}

function describeEnvLines(): string[] {
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
    '- `helpers.derefPath(nodeOrId, "value._PSD.trans") -> {found, stoppedAt, missingEdge?, available?, node}` — walk a dotted edge path and, on failure, say WHICH hop failed and what was there instead. Use this instead of chaining edgeTarget: a null halfway looks identical to a null at the end, which is how a probe tests the wrong level and reports a confident zero.',
    '- `helpers.findWithin(nodeOrId, edgeName, {maxDepth}) -> [{path,id,name}]` — is this property anywhere within N hops, and at what path? Answers "which level is it on?" in one call.',
    '- `helpers.edgeTarget(nodeOrId, edgeName) -> node | null` — the node behind a named edge, when you need the node and not the `{ref,name,type}` wrapper `props()` returns.',
    '- `helpers.walkChain(startOrNode, edgeName, {maxHops?, collectIds?}) -> {length, terminated: "cycle" | "end" | "cap", truncated}` — walk a linked structure (`.next` update queues, `.prev` closure chains, LRU lists) and report HOW it ended. Use this rather than a hand-written loop: React update queues are CIRCULAR, and a hand-rolled `while (next && next.id !== start)` with a hop guard reports the guard as the length. A measured case printed 800 for a chain of 2,066. `terminated: "cap"` means the length is a floor. For the full per-link report (what each link captures, distinct vs repeated) use the `memlab_chain_walk` tool.',
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
    '## Populations that get hand-rolled every round (use these instead)',
    "Each of these was rewritten by hand in round after round, slightly differently each time — which makes two rounds' numbers incomparable for reasons that have nothing to do with the app, and in one case (the edge filter) returns a confident zero.",
    '- `helpers.detachedNamed(substr) -> [{id, name}]` — detached nodes whose CLASS NAME contains `substr`, with the same oddball/root filtering the detached-DOM tools apply. ⚠️ A detached node\'s name is its element or Blink class (`Detached EventListener`, `Detached blink::RegisteredEventListener`, `Detached HTMLDivElement`) and **never a `data-testid`** — filtering these for an app-level testid matches nothing on any heap. For "which UI element leaked", use `memlab_detached_dom`, which groups by nearest non-detached dominator.',
    '- `helpers.listenerRecords(callbackName?) -> [{id, callback, context}]` — objects carrying BOTH a callback-ish and a context-ish property, i.e. event-listener records. Optionally narrowed to one callback class, which is how the question is actually asked ("how many `subscribe_$0` records are held?"). Cached; the definition matches `memlab_stale_collections` exactly.',
    '- `helpers.contextOf(nodeOrId) -> node | null` — the scope a closure captured, e.g. `system / Context / scope @767271`. **Do not hand-roll this**: the hop is an `internal` edge NAMED `context`, not a `context`-TYPED edge, so the reflexive filter returns null on every closure in the heap (see the edge-type section below). Returns null for a non-closure — note `helpers.byClass`/`nodesByClass` also match the class-NAME STRING node, so filter on `type === "closure"` before asking for a scope.',
    '- `helpers.closureCensus({minCount?, pattern?}) -> [{name, count, withScope}]` — closure classes with how many instances captured a scope. `count` alone cannot separate "1,000 copies of a function" from "1,000 copies each pinning a distinct scope", and only the second is a retention story. Cached.',
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
    '### Edge TYPE vs edge NAME — the silent-zero trap',
    'These are different fields and the reflexive guess is wrong for the most-asked question. A closure and its captured scope are linked like this:',
    '```',
    "closure --(type: 'internal', name_or_index: 'context')--> 'system / Context / scope @<id>'",
    "'system / Context / scope @<id>' --(type: 'context', name_or_index: '<varName>')--> captured value",
    '```',
    "So the hop FROM a function TO its scope is an **`internal` edge named `context`** — filtering a function's `.references` on `e.type === 'context'` matches **zero edges on every heap** and returns a clean `0`. The `context` TYPE only appears on the edges INSIDE the scope object, one per captured variable. (Measured on a 2.9M-node browser capture: 37,791 `context`-NAMED edges out of closures, every one of them `internal`, and not a single `context`-TYPED edge among the 255,084 edges leaving closures; the scope objects they point at emit 60,513 `context`-typed edges between them.) Rule of thumb: match `e.name_or_index` for a specific named hop, `e.type` only for a category.",
    'The same shape bites elsewhere: array backing stores hang off an `internal` edge named `elements`, and Map/Set contents live behind `internal` `table` — which is why `helpers.entries` / `mapEntries` exist.',
    '',
    '## Runnable example',
    '```',
    'const counts = {};',
    'snapshot.nodes.forEach(node => { counts[node.type] = (counts[node.type] || 0) + 1; });',
    'result = counts;',
    '```',
  ];
}

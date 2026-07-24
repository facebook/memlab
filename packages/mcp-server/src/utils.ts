/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {
  IHeapNode,
  IHeapEdge,
  IHeapSnapshot,
  HeapNodeIdSet,
} from '@memlab/core';
import {
  getSnapshotMetadata,
  getSessionConfig,
  shouldEmitHeader,
} from './heap-state.js';
// ScanTimeoutError / makeScanBudget moved to analysis-budget.ts (shared, no
// import cycle). Re-exported here so existing `from '../utils.js'` imports in
// the tools keep working unchanged.
import {
  ScanTimeoutError,
  makeScanBudget,
  tickAnalysis,
} from './analysis-budget.js';
export {ScanTimeoutError, makeScanBudget};

export interface NodeSummary {
  id: number;
  name: string;
  type: string;
  self_size: number;
  retained_size: number;
}

export interface NodeDetail extends NodeSummary {
  edge_count: number;
  referrer_count: number;
  is_detached: boolean;
  dominator_id: number | null;
  location: {script_id: number; line: number; column: number} | null;
  string_value?: string;
}

export interface EdgeSummary {
  edge_name: string;
  edge_type: string;
}

export interface OutgoingEdge extends EdgeSummary {
  to_node: NodeSummary;
}

export interface IncomingEdge extends EdgeSummary {
  from_node: NodeSummary;
}

function truncateDomClasses(name: string): string {
  const classMatch = name.match(/^(.*?\s)class="([^"]*)"(.*)$/);
  if (!classMatch) return name;

  const [, before, classes, after] = classMatch;
  const classList = classes.split(/\s+/).filter(c => c.length > 0);
  if (classList.length <= 3) return name;

  const kept = classList.slice(0, 3).join(' ');
  return `${before}class="${kept} …(${classList.length - 3} more)"${after}`;
}

function preferUsefulAttributes(name: string, maxLen: number): string {
  const testId = name.match(/data-testid="([^"]*)"/);
  const ariaLabel = name.match(/aria-label="([^"]*)"/);
  const id = name.match(/ id="([^"]*)"/);

  const detached = name.startsWith('Detached ') ? 'Detached ' : '';
  const nameWithoutDetached = detached ? name.slice(9) : name;
  const tag = nameWithoutDetached.match(/^(\w+)/)?.[1] ?? '';
  const preferred = testId?.[0] ?? ariaLabel?.[0] ?? id?.[0] ?? null;

  if (preferred && name.length > maxLen) {
    return `${detached}<${tag} ${preferred}>`;
  }
  return name;
}

export function truncateDomToTag(name: string): string {
  const detached = name.startsWith('Detached ') ? 'Detached ' : '';
  const nameWithoutDetached = detached ? name.slice(9) : name;
  const tag =
    nameWithoutDetached.match(/^<(\w+)/)?.[1] ??
    nameWithoutDetached.match(/^(\w+)/)?.[1] ??
    '';
  if (!tag) return name;

  const testId = name.match(/data-testid="([^"]*)"/);
  if (testId) return `${detached}<${tag} ${testId[0]}>`;

  const id = name.match(/ id="([^"]*)"/);
  if (id) return `${detached}<${tag} ${id[0]}>`;

  const ariaLabel = name.match(/aria-label="([^"]*)"/);
  if (ariaLabel) {
    const label = ariaLabel[1];
    const shortLabel = label.length > 30 ? label.slice(0, 30) + '…' : label;
    return `${detached}<${tag} aria-label="${shortLabel}">`;
  }

  return `${detached}<${tag}>`;
}

export function truncateNodeName(
  name: string,
  type: string,
  selfSize: number,
  maxLen = 150,
  aggressiveDom = false,
): string {
  if (
    type === 'string' ||
    type === 'concatenated string' ||
    type === 'sliced string'
  ) {
    if (name.length <= maxLen) return name;
    return `${name.slice(0, maxLen)}… (${formatBytes(selfSize)} total)`;
  }

  const isDomLike =
    name.includes('class="') ||
    name.includes('aria-') ||
    name.startsWith('<') ||
    name.startsWith('Detached <');
  if (isDomLike) {
    if (aggressiveDom) return truncateDomToTag(name);
    if (name.length > maxLen) {
      let processed = preferUsefulAttributes(name, maxLen);
      processed = truncateDomClasses(processed);
      if (processed.length <= maxLen) return processed;
      return `${processed.slice(0, maxLen)}…`;
    }
    return name;
  }

  if (name.length <= maxLen) return name;
  return `${name.slice(0, maxLen)}…`;
}

export function serializeNodeSummary(node: IHeapNode): NodeSummary {
  return {
    id: node.id,
    name: truncateNodeName(node.name, node.type, node.self_size),
    type: node.type,
    self_size: node.self_size,
    retained_size: node.retainedSize,
  };
}

export function serializeNodeDetail(node: IHeapNode): NodeDetail {
  const detail: NodeDetail = {
    id: node.id,
    name: truncateNodeName(node.name, node.type, node.self_size),
    type: node.type,
    self_size: node.self_size,
    retained_size: node.retainedSize,
    edge_count: node.edge_count,
    referrer_count: node.numOfReferrers,
    is_detached: node.is_detached,
    dominator_id: node.dominatorNode?.id ?? null,
    location: null,
  };

  const loc = node.location;
  if (loc) {
    detail.location = {
      script_id: loc.script_id,
      line: loc.line,
      column: loc.column,
    };
  }

  if (node.isString) {
    const strNode = node.toStringNode();
    if (strNode) {
      const val = strNode.stringValue;
      detail.string_value = val.length > 200 ? val.slice(0, 200) + '...' : val;
    }
  }

  return detail;
}

export function serializeOutgoingEdge(edge: IHeapEdge): OutgoingEdge {
  return {
    edge_name: String(edge.name_or_index),
    edge_type: edge.type,
    to_node: serializeNodeSummary(edge.toNode),
  };
}

export function serializeIncomingEdge(edge: IHeapEdge): IncomingEdge {
  return {
    edge_name: String(edge.name_or_index),
    edge_type: edge.type,
    from_node: serializeNodeSummary(edge.fromNode),
  };
}

const NODE_TYPE_BLOCK_LIST = new Set([
  'array',
  'native',
  'code',
  'synthetic',
  'hidden',
]);

const NODE_NAME_BLOCK_LIST = new Set([
  '(Startup object cache)',
  '(Global handles)',
  '(External strings)',
  '(Builtins)',
]);

export function isNodeWorthInspecting(node: IHeapNode): boolean {
  if (node.id <= 3) {
    return false;
  }
  if (NODE_TYPE_BLOCK_LIST.has(node.type)) {
    return false;
  }
  if (NODE_NAME_BLOCK_LIST.has(node.name)) {
    return false;
  }
  return true;
}

/**
 * Property names that mark a "freshness" timestamp on a TTL/warm cache wrapper
 * object (e.g. `{entries, loadedAt}`, `{items, timestamp}`). Their presence next
 * to a large array/Map means the collection was loaded as a point-in-time
 * snapshot, not appended to over time. Shared by cache-analysis (to recognize
 * the cache shape) and growth-signals (to suppress the append-only
 * false-positive on load-once caches). Feedback round 4 §B/§C.
 */
export const FRESHNESS_TIMESTAMP_PROPS: ReadonlySet<string> = new Set([
  'timestamp',
  'loadedAt',
  'loaded_at',
  'ts',
  'cachedAt',
  'cached_at',
  'fetchedAt',
  'fetched_at',
  'lastFetched',
  'lastLoaded',
  'lastUpdated',
  'updatedAt',
  'expiresAt',
  'expiry',
]);

/**
 * True when `node` (typically a large Array/Map) is held by a wrapper object
 * that also carries a freshness-timestamp sibling property — i.e. it is the data
 * side of a `{entries, loadedAt}`-style TTL/warm cache, loaded once rather than
 * grown unboundedly.
 */
export function hasFreshnessTimestampSibling(node: IHeapNode): boolean {
  for (const ref of node.referrers) {
    if (ref.type !== 'property') continue;
    const parent = ref.fromNode;
    if (!parent) continue;
    for (const edge of parent.references) {
      if (
        edge.type === 'property' &&
        FRESHNESS_TIMESTAMP_PROPS.has(String(edge.name_or_index))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Heuristic: does a (JSON-ish) string look like a cached *failure* response?
 * Cached error payloads are both wasted memory and a signal that an upstream
 * dependency is failing — surfacing them links a memory finding to a likely
 * correctness bug. Conservative: requires a JSON-object/array head plus an
 * explicit failure marker. Feedback round 4 §D.
 */
export function looksLikeFailurePayload(value: string): boolean {
  const head = value.length > 4096 ? value.slice(0, 4096) : value;
  const trimmed = head.trimStart();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false;
  return (
    /\bUNKNOWN_FAILURE\b/.test(head) ||
    /"status"\s*:\s*"[^"]*(?:FAILURE|FAILED|ERROR)/i.test(head) ||
    /"error"\s*:\s*"(?!null)[^"]+/i.test(head)
  );
}

export function filterLargestObjects(
  snapshot: IHeapSnapshot,
  filter: (node: IHeapNode) => boolean,
  limit: number,
): IHeapNode[] {
  let result: IHeapNode[] = [];
  snapshot.nodes.forEach(node => {
    if (!filter(node)) {
      return;
    }
    const size = node.retainedSize;
    let i: number;
    for (i = result.length - 1; i >= 0; --i) {
      if (result[i].retainedSize >= size) {
        result.splice(i + 1, 0, node);
        break;
      }
    }
    if (i < 0) {
      result.unshift(node);
    }
    result = result.slice(0, limit);
  });
  return result;
}

/**
 * Collapse heap nodes that are merely different VIEWS of the same dominator
 * subtree (e.g. on a single in-flight request: Client → Request → closure →
 * Promise → Context → Map all reporting the SAME retained size). Without this,
 * `largest_objects` returns ~20 rows that are all one subtree — pure noise and
 * wasted tokens (feedback §A.2).
 *
 * Two nodes are treated as the same subtree ONLY when (a) their retained sizes
 * are within `epsilon` of each other AND (b) one dominates the other within a
 * bounded dominator walk — so unrelated objects that merely share a byte count
 * are never collapsed. `candidates` must be pre-sorted by retained size desc;
 * the highest dominator (ancestor) is kept as the representative, annotated with
 * `mergedCount` = how many views were folded into it.
 */
export function collapseDominatorSubtrees(
  candidates: IHeapNode[],
  limit: number,
  opts: {epsilon?: number; maxWalk?: number} = {},
): Array<{node: IHeapNode; mergedCount: number}> {
  const epsilon = opts.epsilon ?? 0.99;
  const maxWalk = opts.maxWalk ?? 200;
  const dominates = (ancestor: IHeapNode, n: IHeapNode): boolean => {
    let cur: IHeapNode | null = n.dominatorNode ?? null;
    let steps = 0;
    while (cur && steps++ < maxWalk) {
      if (cur.id === ancestor.id) return true;
      cur = cur.dominatorNode ?? null;
    }
    return false;
  };
  const kept: Array<{node: IHeapNode; mergedCount: number}> = [];
  for (const c of candidates) {
    let merged = false;
    for (const k of kept) {
      const lo = Math.min(c.retainedSize, k.node.retainedSize);
      const hi = Math.max(c.retainedSize, k.node.retainedSize);
      const nearEqual = hi > 0 && lo / hi >= epsilon;
      if (nearEqual && (dominates(k.node, c) || dominates(c, k.node))) {
        // Same subtree: prefer the higher (ancestor) node as the representative.
        if (dominates(c, k.node)) {
          k.node = c;
        }
        k.mergedCount++;
        merged = true;
        break;
      }
    }
    if (!merged) {
      kept.push({node: c, mergedCount: 0});
    }
  }
  return kept.slice(0, limit);
}

export type OutputMode = 'full' | 'count' | 'ids';

export interface QueryNodesResult {
  total_count: number;
  nodes?: NodeSummary[];
  ids?: number[];
  timed_out?: boolean;
}

export function queryNodes(
  snapshot: IHeapSnapshot,
  filter: (node: IHeapNode) => boolean,
  opts: {
    limit: number;
    offset: number;
    outputMode: OutputMode;
    budget?: {tick: () => void};
  },
): QueryNodesResult {
  const {limit, offset, outputMode, budget} = opts;
  let timedOut = false;

  if (outputMode === 'count') {
    let total = 0;
    try {
      snapshot.nodes.forEach(node => {
        budget?.tick();
        if (filter(node)) total++;
      });
    } catch (e) {
      if (e instanceof ScanTimeoutError) timedOut = true;
      else throw e;
    }
    return {total_count: total, timed_out: timedOut || undefined};
  }

  // Collect all matching nodes sorted by retained size desc
  const sorted: IHeapNode[] = [];
  try {
    snapshot.nodes.forEach(node => {
      budget?.tick();
      if (!filter(node)) return;
      const size = node.retainedSize;
      let i: number;
      for (i = sorted.length - 1; i >= 0; --i) {
        if (sorted[i].retainedSize >= size) {
          sorted.splice(i + 1, 0, node);
          break;
        }
      }
      if (i < 0) {
        sorted.unshift(node);
      }
    });
  } catch (e) {
    if (e instanceof ScanTimeoutError) timedOut = true;
    else throw e;
  }

  const total_count = sorted.length;
  const sliced = sorted.slice(offset, offset + limit);

  if (outputMode === 'ids') {
    return {
      total_count,
      ids: sliced.map(n => n.id),
      timed_out: timedOut || undefined,
    };
  }

  return {
    total_count,
    nodes: sliced.map(serializeNodeSummary),
    timed_out: timedOut || undefined,
  };
}

/**
 * Dominator-deduped retained size for a set of nodes, with a BOUNDED upward
 * dominator walk (default 500 steps, mirroring auto-investigate's
 * `isDominatorAncestor` maxWalk). For each node we walk up its dominator chain
 * looking for another in-set ancestor; if one is found the node is dominated
 * (its bytes are already counted by that ancestor) so we skip it, otherwise we
 * add its retained size.
 *
 * Unlike `@memlab/core`'s `aggregateDominatorMetrics`, the walk is capped and
 * allocates no per-node Set, so a pathological deep dominator chain (e.g. a long
 * PromiseReaction linked list) cannot make this blow up. Trade-off: if a node's
 * nearest in-set dominator is deeper than `maxWalk`, we conservatively KEEP it
 * (treat it as maximal), which can OVER-count — so `exact` is returned `false`
 * whenever any node's walk was truncated, letting callers mark the figure as an
 * upper bound. Calls `tickAnalysis()` per node so it also honors the wall-clock
 * guardrail.
 */
export function boundedDominatorRetainedSize(
  ids: HeapNodeIdSet,
  snapshot: IHeapSnapshot,
  maxWalk = 500,
): {retained: number; exact: boolean} {
  let retained = 0;
  let exact = true;
  for (const id of ids) {
    tickAnalysis();
    const node = snapshot.getNodeById(id);
    if (!node) continue;
    let dominated = false;
    let truncated = false;
    let cur: IHeapNode | null = node.dominatorNode ?? null;
    let steps = 0;
    while (cur) {
      if (steps >= maxWalk) {
        truncated = true;
        break;
      }
      if (cur.id === node.id) break; // reached self
      if (ids.has(cur.id)) {
        dominated = true;
        break;
      }
      const next: IHeapNode | null = cur.dominatorNode ?? null;
      if (next && next.id === cur.id) break; // root self-loop
      cur = next;
      steps++;
    }
    if (!dominated) {
      retained += node.retainedSize;
      if (truncated) exact = false;
    }
  }
  return {retained, exact};
}

/**
 * One backing-store slot of a Map/Set/WeakMap: its true FixedArray index
 * (`name_or_index`) and the heap node it points at.
 */
export interface BackingSlot {
  idx: number;
  node: IHeapNode;
}

/**
 * One enumerated Map/WeakMap entry. `value` is null when the value slot held an
 * inline SMI (no heap edge) — see `enumerateMapEntries`.
 */
export interface CollectionEntry {
  key: IHeapNode;
  value: IHeapNode | null;
}

/**
 * Collect the object-valued slots of a Map/Set/WeakMap backing store, sorted by
 * their true FixedArray slot index.
 *
 * V8 stores entries in an OrderedHashMap/OrderedHashSet reachable via the
 * `table` (or `backing_store`) edge. Browser (Chromium) snapshots type the
 * key/value slot edges as `internal` with a numeric name (the array index);
 * Node snapshots type them `element`. The header counts and hash-chain links are
 * inline SMIs, which emit NO edge at all — so the slot indices are NOT
 * contiguous, and the GAPS are meaningful (they mark SMI-valued or deleted
 * slots). Returning the slots WITH their indices lets callers pair by index
 * instead of by position, which is what makes the pairing correct when some
 * values are SMIs (see `enumerateMapEntries`).
 */
export function collectBackingSlots(node: IHeapNode): BackingSlot[] {
  const out: BackingSlot[] = [];
  for (const edge of node.references) {
    const eName = String(edge.name_or_index);
    if (eName !== 'table' && eName !== 'backing_store') continue;
    const backing = edge.toNode;
    for (const te of backing.references) {
      // Skip the backing store's hidden-class pointer and any hidden edges; the
      // remaining element/internal edges are the real key/value slots.
      if (te.type === 'hidden' || String(te.name_or_index) === 'map') continue;
      const idx = Number(te.name_or_index);
      if (!Number.isFinite(idx)) continue;
      const target = te.toNode;
      // `the_hole` marks a deleted/empty backing-store slot; oddball roots
      // (id<=3) are not real entries. Do NOT skip `undefined`: an explicit
      // `undefined` value/element is a real entry, and dropping it would make it
      // indistinguishable from an inline-primitive gap (mis-reported as absent).
      if (target.id <= 3 || target.name === 'the_hole') {
        continue;
      }
      out.push({idx, node: target});
    }
    break;
  }
  out.sort((a, b) => a.idx - b.idx);
  return out;
}

/**
 * Enumerate a Map/WeakMap's (key, value) entries.
 *
 * V8 lays each entry out as consecutive slots `[key, value, chain]` (the chain
 * link is an inline SMI, so it emits no edge). We therefore pair a key with the
 * value in the immediately-following slot INDEX (`key.idx + 1`). When no slot
 * exists at `key.idx + 1`, the value was an inline SMI/primitive and we emit
 * `value: null` — instead of mispairing the key with the NEXT entry's key, which
 * is what naive "consecutive object edges = key,value" pairing does whenever a
 * Map has SMI values (a real correctness bug on browser heaps).
 */
export function enumerateMapEntries(node: IHeapNode): CollectionEntry[] {
  const slots = collectBackingSlots(node);
  const entries: CollectionEntry[] = [];
  let i = 0;
  while (i < slots.length) {
    const key = slots[i];
    const next = slots[i + 1];
    if (next && next.idx === key.idx + 1) {
      entries.push({key: key.node, value: next.node});
      i += 2;
    } else {
      // Value slot absent at key.idx+1 → the value was an inline SMI/primitive.
      entries.push({key: key.node, value: null});
      i += 1;
    }
  }
  return entries;
}

/** Enumerate a Set's elements (every occupied backing-store slot). */
export function enumerateSetElements(node: IHeapNode): IHeapNode[] {
  return collectBackingSlots(node).map(s => s.node);
}

/**
 * Property names that identify an individual record rather than describe its
 * content — always unique per instance, so INCLUDING them in a content
 * signature defeats duplicate detection (every record looks distinct). Excluded
 * by default from `objectContentSignature`. `id`/`__id`/`__ref` are Relay/GraphQL
 * data-id fields; `key`/`clientMutationId` are common per-instance keys.
 */
export const IDENTITY_PROPS: ReadonlySet<string> = new Set([
  'id',
  '__id',
  '__ref',
  'key',
  'clientMutationId',
]);

/**
 * A stable, shallow content signature for an object: the sorted set of property
 * names, each annotated with its scalar value (strings capped) or a marker for
 * object/array-valued properties. Two objects with the same signature are
 * structurally identical at one level — the basis for duplicate-record
 * detection (`memlab_duplicate_objects`) and ad-hoc dedup checks in eval.
 *
 * By default per-instance identity fields (`IDENTITY_PROPS`: id/__id/__ref/…) are
 * EXCLUDED so records that differ only by their data-id still collapse together
 * — pass `ignoreProps` to override the set (e.g. `new Set()` to include them).
 *
 * String, boolean, null and object-valued properties are captured (objects
 * generically as `o`, so nested content is not compared).
 *
 * Caveat — numeric values are NOT captured: the V8 heap-snapshot format does not
 * store the actual value of a number field (SMI nodes are `smi number`,
 * heap-numbers are `heap number` — the IEEE-754/int value is not accessible; see
 * `tools/get-value.ts`). A numeric property therefore contributes only a generic
 * `<name>=n` marker, so two objects differing ONLY in a numeric field hash to the
 * same signature and are reported as duplicates. Treat numeric-heavy records
 * accordingly (or compare their values via another tool).
 */
export function objectContentSignature(
  node: IHeapNode,
  opts: {maxStringLen?: number; ignoreProps?: ReadonlySet<string>} = {},
): string {
  const maxLen = opts.maxStringLen ?? 40;
  const ignore = opts.ignoreProps ?? IDENTITY_PROPS;
  const parts: string[] = [];
  for (const edge of node.references) {
    // Hidden-class ("map") and other internal edges are already excluded by the
    // `edge.type !== 'property'` guard above, so no explicit `map` name skip is
    // needed (it would only hide a legitimate user property literally named "map").
    if (edge.type !== 'property') continue;
    const name = String(edge.name_or_index);
    if (name === '__proto__') continue;
    if (ignore.has(name)) continue;
    const t = edge.toNode;
    if (t.isString) {
      const v = t.toStringNode()?.stringValue ?? '';
      parts.push(`${name}=s:${v.length > maxLen ? v.slice(0, maxLen) : v}`);
    } else if (t.type === 'number' || t.name === 'heap number') {
      // Numeric values are NOT recoverable from the snapshot format (SMI /
      // heap-number nodes carry no value — see get-value.ts), so we can only
      // record that the property is a number, not distinguish by value.
      parts.push(`${name}=n`);
    } else if (
      t.name === 'true' ||
      t.name === 'false' ||
      t.name === 'null' ||
      t.name === 'undefined'
    ) {
      parts.push(`${name}=${t.name}`);
    } else {
      parts.push(`${name}=o`);
    }
  }
  parts.sort();
  return parts.join('|');
}

/**
 * Best-effort detection of which app a Node snapshot came from, by tallying the
 * `/app(s)/<name>/` segment in bundle paths embedded throughout the heap (string
 * node values, function/script names). Returns the most common segment, or null
 * if nothing decisive is found (Feedback round 3 §3d).
 */
export function detectAppName(snapshot: IHeapSnapshot): string | null {
  const counts = new Map<string, number>();
  const re = /\/apps?\/([A-Za-z0-9_.-]{2,40})\//;
  const skip = new Set([
    'node_modules',
    'dist',
    'src',
    'build',
    'lib',
    'packages',
    'common',
    'shared',
  ]);
  snapshot.nodes.forEach(node => {
    const name = node.name;
    if (!name || name.indexOf('/app') === -1) return;
    const m = re.exec(name);
    if (!m) return;
    const seg = m[1];
    if (skip.has(seg)) return;
    counts.set(seg, (counts.get(seg) ?? 0) + 1);
  });
  let best: string | null = null;
  let bestN = 0;
  for (const [k, v] of counts) {
    if (v > bestN) {
      best = k;
      bestN = v;
    }
  }
  return bestN >= 3 ? best : null;
}

/**
 * Recognize retainer paths that route through runtime instrumentation — a
 * patched global `console`, OpenTelemetry context chains, structured loggers,
 * etc. Such paths are frequently reported as the GC owner even though the
 * *logical* owner (a module cache, an OTel logger, a source-map cache) lives
 * elsewhere and is only incidentally reachable via the instrumentation's
 * captured-closure → `context` → `previous` → `Context` chain. Returns a short
 * annotation when the path looks instrumentation-routed, else null
 * (Feedback round 3 §3a).
 */
export function instrumentationRetainerNote(
  steps: Array<{name: string; edgeName?: string}>,
): string | null {
  let viaConsole = false;
  let viaOtel = false;
  for (const s of steps) {
    const n = s.name ?? '';
    const e = s.edgeName ?? '';
    if (n === 'console' || e === 'console') viaConsole = true;
    if (/Logger|loggerConfigurator|DiagConsole/i.test(n)) viaConsole = true;
    if (/opentelemetry|@opentelemetry|otel/i.test(n) || /otel/i.test(e)) {
      viaOtel = true;
    }
  }
  // The misleading shape is console/logger → captured closure → Context chain
  // linked by `previous` pointers.
  const hasContextChain = steps.some(
    s => s.name === 'system / Context' || s.edgeName === 'previous',
  );
  if (viaConsole && hasContextChain) {
    return '(reached via patched `console` / instrumentation context chain — likely NOT the logical owner; the real owner is usually a module cache or logger reached another way)';
  }
  if (viaOtel && hasContextChain) {
    return '(reached via OpenTelemetry instrumentation context chain — likely NOT the logical owner)';
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'N/A';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function markdownTable(
  headers: string[],
  rows: string[][],
  alignRight?: Set<number>,
): string {
  // Compute column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)),
  );

  const pad = (s: string, w: number, right?: boolean) =>
    right ? s.padStart(w) : s.padEnd(w);

  const headerLine =
    '| ' +
    headers.map((h, i) => pad(h, widths[i], alignRight?.has(i))).join(' | ') +
    ' |';
  const separatorLine =
    '|' +
    widths
      .map((w, i) =>
        alignRight?.has(i) ? '-'.repeat(w + 1) + ':' : '-'.repeat(w + 2),
      )
      .map(s => (s.length < 3 ? s + '-' : s))
      .join('|') +
    '|';
  const dataLines = rows.map(
    row =>
      '| ' +
      row
        .map((cell, i) => pad(cell, widths[i], alignRight?.has(i)))
        .join(' | ') +
      ' |',
  );

  return [headerLine, separatorLine, ...dataLines].join('\n');
}

export function formatNodeInline(
  id: number,
  name: string,
  type: string,
  selfSize?: number,
): string {
  const displayName =
    selfSize != null ? truncateNodeName(name, type, selfSize, 80) : name;
  return `@${id} ${displayName} (${type})`;
}

/**
 * One step of a retainer path, root-first. `edgeName` is the name of the edge
 * that points INTO this node from its retainer (i.e. parent → this node, the
 * property / element / context slot through which the parent holds this node).
 * The GC root (first step) has no incoming edge. `collapsedBefore` records how
 * many uninteresting internal nodes were elided immediately above this node.
 */
export interface RetainerTreeStep {
  id: number;
  name: string;
  type: string;
  retainedSize?: number;
  selfSize?: number;
  edgeName?: string;
  collapsedBefore?: number;
  // Overrides the default "… N internal node(s) …" elision note. Used to label a
  // collapsed run of repeating async-continuation frames distinctly.
  collapsedNote?: string;
}

function formatEdgeLabel(name: string): string {
  const trimmed = name.length > 40 ? `${name.slice(0, 39)}…` : name;
  if (/^\d+$/.test(trimmed)) return `[${trimmed}]`; // array / element index
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return `.${trimmed}`; // property
  return trimmed; // synthetic edge (e.g. "[entry]", "<symbol>")
}

function retainerMarker(i: number, len: number): string {
  if (i === 0) return '   ← GC root';
  if (i === len - 1) return '   ← retained object';
  return '';
}

/**
 * Deep-trace fallback: a flat "ladder" with a constant left margin. Each node
 * sits at column 0 and a `↓` connector line carries the edge label / elision
 * note between nodes. Reads top→down = "retains", same as the indented tree, but
 * the indentation never grows — so a 20-hop chain still fits an 80-column
 * terminal where the nested tree would push the leaf off the right edge.
 */
function formatRetainerLadder(
  steps: RetainerTreeStep[],
  showSizes: boolean,
): string {
  const lines: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (i > 0) {
      // The connector carries the elision note (if any) and the edge that the
      // parent holds this node through — always show the edge when we have it.
      const parts = ['  ↓'];
      if (s.collapsedBefore && s.collapsedBefore > 0) {
        parts.push(
          `… ${s.collapsedNote ?? `${s.collapsedBefore} internal node(s)`} …`,
        );
      }
      if (s.edgeName != null) {
        parts.push(formatEdgeLabel(s.edgeName));
      }
      lines.push(parts.join(' '));
    }
    const size =
      showSizes && s.retainedSize != null
        ? `  — ${formatBytes(s.retainedSize)}`
        : '';
    const nodeStr = formatNodeInline(s.id, s.name, s.type, s.selfSize);
    lines.push(`${nodeStr}${size}${retainerMarker(i, steps.length)}`);
  }
  return lines.join('\n');
}

/**
 * Render a retainer path so it reads in a single, unambiguous direction: the GC
 * root is at the top, and **every node is retained by the one above it**. The
 * edge that connects a parent to its child is embedded in the connector
 * (`└─ .prop →` / `└─ [2] →`, ladder: `↓ .prop`), and sizes as `— <bytes>`.
 *
 * Shallow chains use a nested indented tree (one indent level = one hop).
 * **Deep chains automatically switch to a flat `↓` ladder** (controlled by
 * `maxTreeDepth`, default 8) so growing indentation never pushes the leaf node
 * off the right edge of a narrow terminal.
 *
 * This deliberately avoids the older inline style that mixed `←` (retained-by)
 * and `→` (references) arrows on the same line, which made the direction of a
 * trace genuinely hard to read in analysis output and diff summaries. Always
 * prefer this renderer when presenting a retainer chain to a human.
 */
export function formatRetainerTree(
  steps: RetainerTreeStep[],
  opts: {showSizes?: boolean; maxTreeDepth?: number} = {},
): string {
  const {showSizes = true, maxTreeDepth = 8} = opts;
  if (steps.length === 0) return '';
  // Past this depth the nested indentation gets too wide for a narrow terminal,
  // so fall back to the constant-margin ladder (user feedback).
  if (steps.length > maxTreeDepth) {
    return formatRetainerLadder(steps, showSizes);
  }
  const lines: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const isRoot = i === 0;
    const pad = isRoot ? '' : ' '.repeat(2 + 3 * (i - 1));
    if (s.collapsedBefore && s.collapsedBefore > 0) {
      lines.push(
        `${pad}└─ … ${s.collapsedNote ?? `${s.collapsedBefore} internal node(s)`} …`,
      );
    }
    // Embed the edge the parent holds this node through directly in the
    // connector (`└─ .prop →`, `└─ [2] →`) — it's the most actionable part of
    // the trace, and keeping it on the connector reads as "parent --edge--> child".
    const connector = isRoot
      ? ''
      : s.edgeName != null
        ? `└─ ${formatEdgeLabel(s.edgeName)} → `
        : '└─ ';
    const size =
      showSizes && s.retainedSize != null
        ? `  — ${formatBytes(s.retainedSize)}`
        : '';
    const nodeStr = formatNodeInline(s.id, s.name, s.type, s.selfSize);
    lines.push(
      `${pad}${connector}${nodeStr}${size}${retainerMarker(i, steps.length)}`,
    );
  }
  return lines.join('\n');
}

export function formatNodeSummaryTable(nodes: NodeSummary[]): string {
  const headers = ['ID', 'Name', 'Type', 'Self Size', 'Retained Size'];
  const rightCols = new Set([3, 4]);
  const rows = nodes.map(n => [
    `@${n.id}`,
    n.name,
    n.type,
    formatBytes(n.self_size),
    formatBytes(n.retained_size),
  ]);
  return markdownTable(headers, rows, rightCols);
}

export function formatQueryNodesResult(
  result: QueryNodesResult,
  offset?: number,
): string {
  const partial = result.timed_out
    ? '\n\n⚠ Scan hit its time budget and returned PARTIAL results (counts shown are a lower bound). Raise timeout_ms, add filters, or use an indexed tool — large browser heaps are slow to full-scan.'
    : '';
  if (result.nodes != null) {
    if (result.nodes.length === 0) {
      return `No matching nodes found (total: ${formatNumber(result.total_count)})${partial}`;
    }
    const lines = [`Total: ${formatNumber(result.total_count)} nodes\n`];
    lines.push(formatNodeSummaryTable(result.nodes));
    return lines.join('\n') + partial;
  }
  if (result.ids != null) {
    const lines = [
      `Total: ${formatNumber(result.total_count)} | Showing ${formatNumber(result.ids.length)} (offset ${offset ?? 0})`,
    ];
    lines.push(`IDs: ${result.ids.join(', ')}`);
    return lines.join('\n') + partial;
  }
  return `Total matching nodes: ${formatNumber(result.total_count)}${partial}`;
}

export function snapshotHeader(): string {
  const meta = getSnapshotMetadata();
  if (!meta) return '';
  const envLabel =
    meta.env === 'browser'
      ? 'Browser'
      : meta.env === 'node'
        ? 'Node.js'
        : 'Unknown';
  return `> Snapshot: ${meta.fileName} (${formatBytes(meta.totalSize)}, ${formatNumber(meta.nodeCount)} nodes, ${envLabel})`;
}

export function textResult(text: string) {
  return {content: [{type: 'text' as const, text}]};
}

export function toolResult(text: string) {
  const header = shouldEmitHeader() ? snapshotHeader() : '';
  const body = header ? `${header}\n\n${text}` : text;
  return {content: [{type: 'text' as const, text: body}]};
}

/**
 * Whether tools should omit "Suggested next steps" / "How to fix" trailers.
 * Honors the session-level `suppressSuggestions` config so callers can trim
 * repeated boilerplate tokens across a long investigation.
 */
export function suggestionsSuppressed(): boolean {
  return getSessionConfig().suppressSuggestions;
}

export function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

export function errorResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{type: 'text' as const, text: `Error: ${msg}`}],
    isError: true,
  };
}

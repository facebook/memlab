/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapEdge, IHeapNode, IHeapSnapshot} from '@memlab/core';
import {tickAnalysis} from './analysis-budget.js';
import {loadedCodeKind, scriptSourceStringData} from './heap-budget.js';
import {moduleRecords} from './module-registry.js';

/**
 * Record families that are recognizable by their own property names, so they
 * can be found on a minified build where every class is `t` or `e`.
 *
 * A node matches a family when it has ALL of the listed own properties. The
 * shapes are framework-level (React, Backbone-style collections, module
 * registry records, interaction-tracing event records), not app-specific.
 */
export interface ShapeFamily {
  group: string;
  family: string;
  props: ReadonlyArray<string>;
}

const TELEMETRY = 'telemetry event records';

export const SHAPE_FAMILIES: ReadonlyArray<ShapeFamily> = [
  {
    group: 'React',
    family: 'React fibers',
    props: ['alternate', 'child', 'memoizedProps', 'stateNode', 'return'],
  },
  {
    group: 'React',
    family: 'React hooks',
    props: ['memoizedState', 'baseState', 'baseQueue', 'queue', 'next'],
  },
  {
    group: 'React',
    family: 'React effects',
    props: ['create', 'deps', 'inst', 'next', 'tag'],
  },
  {
    group: 'React',
    family: 'React update queues',
    props: [
      'dispatch',
      'lanes',
      'lastRenderedReducer',
      'lastRenderedState',
      'pending',
    ],
  },
  {
    group: 'React',
    family: 'React update records',
    props: ['action', 'eagerState', 'hasEagerState', 'lane', 'next'],
  },
  {
    group: 'React',
    family: 'React elements',
    props: ['$$typeof', 'props', 'type', 'key', 'ref'],
  },
  {
    group: 'App data',
    family: 'Backbone-style collections (+ the models they dominate)',
    props: ['_models', '_index'],
  },
  {
    group: 'App data',
    family: 'listener records {callback, context}',
    props: ['callback', 'context'],
  },
  {group: 'Telemetry', family: TELEMETRY, props: ['event', 'timestamp']},
  {
    group: 'Telemetry',
    family: TELEMETRY,
    props: ['annotationKey', 'annotationValue', 'markerId'],
  },
  {
    group: 'Telemetry',
    family: TELEMETRY,
    props: ['data', 'instanceKey', 'markerId', 'name'],
  },
  {
    group: 'Telemetry',
    family: TELEMETRY,
    props: ['action', 'instanceKey', 'markerId', 'type'],
  },
  {
    group: 'Telemetry',
    family: TELEMETRY,
    props: ['instanceKey', 'markerId', 'type'],
  },
  {
    group: 'Telemetry',
    family: TELEMETRY,
    props: ['blockName', 'blockType', 'execUnitName', 'traceId'],
  },
  {
    group: 'Telemetry',
    family: TELEMETRY,
    props: ['detached', 'finalState', 'imgLoadStart'],
  },
  {
    group: 'Telemetry',
    family: TELEMETRY,
    props: ['children', 'hadLateMutationExpected', 'isRoot'],
  },
  {
    group: 'Telemetry',
    family: TELEMETRY,
    props: ['pagelet', 'pageletStack', 'spanType'],
  },
  {
    group: 'Telemetry',
    family: TELEMETRY,
    props: ['description', 'endTime', 'spanType', 'startTime'],
  },
  {
    group: 'Telemetry',
    family: TELEMETRY,
    props: ['addAnnotation', 'addAnnotationBoolean'],
  },
  {group: 'Telemetry', family: TELEMETRY, props: ['bgChecked', 'bgPixels']},
  {
    group: 'Telemetry',
    family: 'traced interactions',
    props: ['type', 'hasVcReport', 'completed', 'traceId'],
  },
  {
    group: 'Module system',
    family: 'module records',
    props: ['context', 'defaultExport', 'depPosition', 'dependencies', 'error'],
  },
  {
    group: 'Module system',
    family: 'module timing records',
    props: ['category', 'defined', 'dependencies', 'factoryEnd', 'factoryRun'],
  },
  {
    group: 'Module system',
    family: 'lazy-loader resource records',
    props: ['c', 'm', 'p', 'src', 'type'],
  },
  {
    group: 'Config',
    family: 'experiment / config records',
    props: ['configCode', 'configValue'],
  },
];

/** Families seeded from explicit nodes rather than shapes. */
export const MEMO_CACHE_FAMILY = 'function-property memo caches (fn.$$cache)';
export const WASM_FAMILY = 'WebAssembly modules and their memory';
export const REGISTRY_FAMILY =
  'module registry (module state reached only via it)';

const FAMILY_GROUP: ReadonlyMap<string, string> = new Map([
  [MEMO_CACHE_FAMILY, 'App data'],
  [WASM_FAMILY, 'WebAssembly'],
  [REGISTRY_FAMILY, 'Module system'],
  ...SHAPE_FAMILIES.map(f => [f.family, f.group] as [string, string]),
]);

export function familyGroup(family: string): string {
  return FAMILY_GROUP.get(family) ?? 'Other';
}

/** The DOM / Blink sub-family of a native node, or null if it is JS. */
export function domFamily(node: IHeapNode): string | null {
  const nm = node.name;
  const isNative =
    nm.startsWith('blink::') ||
    nm.startsWith('cppgc') ||
    nm.startsWith('Detached') ||
    (node.type === 'native' && !nm.startsWith('system'));
  if (!isNative) return null;
  if (nm.startsWith('Detached')) return 'detached DOM';
  if (
    nm.startsWith('<') ||
    /^(HTML|SVG)\w*(Element|Document)|^Text$|^Comment$|^DocumentFragment|^ShadowRoot/.test(
      nm,
    )
  ) {
    return 'DOM nodes';
  }
  if (
    /Layout|PhysicalBoxFragment|PhysicalFragment|InlineNode|InlineItem|FragmentItem/.test(
      nm,
    )
  ) {
    return 'layout tree and fragments';
  }
  if (
    /ComputedStyle|Style|CSS|RuleSet|RuleData|Selector|MatchedProperties/.test(
      nm,
    )
  ) {
    return 'style (computed style, CSS rules)';
  }
  if (/Paint|Display|Raster|Compositor|cc::|Layer|Scroll/.test(nm)) {
    return 'paint, layers, scrolling';
  }
  if (/Font|Glyph|Shape|Harfbuzz/.test(nm)) return 'fonts and text shaping';
  if (/Image|Bitmap|Resource|MemoryCache|Fetch/.test(nm)) {
    return 'images and resource cache';
  }
  if (/Performance|Timing|Observer/.test(nm)) {
    return 'performance entries and observers';
  }
  return 'other native';
}

const STRING_TYPES = new Set([
  'string',
  'concatenated string',
  'sliced string',
]);

/** Kind bucket for a node no family or owner explains. */
export function kindBucket(node: IHeapNode): string {
  const nm = node.name;
  if (STRING_TYPES.has(node.type)) return 'strings';
  if (node.type === 'closure' || nm.startsWith('system / Context')) {
    return 'closures and contexts';
  }
  if (
    node.type === 'object shape' ||
    nm === 'system / Map' ||
    nm.startsWith('system / DescriptorArray') ||
    nm.startsWith('system / TransitionArray')
  ) {
    return 'V8 hidden classes';
  }
  if (node.type === 'array' || nm === 'Array') return 'arrays';
  if (node.type === 'number' || node.type === 'heap number') return 'numbers';
  if (nm.startsWith('system /')) return 'V8 internals';
  return 'objects';
}

function ownPropNames(node: IHeapNode): Set<string> {
  const out = new Set<string>();
  for (const e of node.references) {
    if (e.type === 'property') out.add(String(e.name_or_index));
  }
  return out;
}

/** The first shape family whose props this object carries, or null. */
export function shapeFamilyOf(node: IHeapNode): string | null {
  if (node.type !== 'object') return null;
  let names: Set<string> | null = null;
  for (const f of SHAPE_FAMILIES) {
    names ??= ownPropNames(node);
    if (names.size < f.props.length) continue;
    let all = true;
    for (const p of f.props) {
      if (!names.has(p)) {
        all = false;
        break;
      }
    }
    if (all) return f.family;
  }
  return null;
}

/**
 * Node index -> family name for every SEED: shape-family matches plus the
 * explicit seeds (memo caches, Wasm modules and buffers, module registries).
 */
export function collectFamilySeeds(
  snapshot: IHeapSnapshot,
): Map<number, string> {
  const seeds = new Map<number, string>();
  const registries = new Set<number>();
  for (const rec of moduleRecords(snapshot).values()) {
    for (const e of rec.record.referrers) {
      if (e.type === 'property' && e.fromNode.type === 'object') {
        registries.add(e.fromNode.nodeIndex);
      }
    }
  }
  snapshot.nodes.forEach((node: IHeapNode) => {
    tickAnalysis();
    if (node.id <= 3) return;
    const nm = node.name;
    if (
      nm === 'system / CppGCManaged (WasmNativeModule)' ||
      nm === 'SharedArrayBuffer'
    ) {
      seeds.set(node.nodeIndex, WASM_FAMILY);
      return;
    }
    if (node.type === 'closure') {
      for (const e of node.references) {
        if (e.type === 'property' && e.name_or_index === '$$cache') {
          seeds.set(e.toNode.nodeIndex, MEMO_CACHE_FAMILY);
        }
      }
      return;
    }
    const fam = shapeFamilyOf(node);
    if (fam != null && !seeds.has(node.nodeIndex)) {
      seeds.set(node.nodeIndex, fam);
    }
  });
  for (const idx of registries) {
    if (!seeds.has(idx)) seeds.set(idx, REGISTRY_FAMILY);
  }
  return seeds;
}

/**
 * Resolves, for every node, the nearest seed on its dominator chain.
 * Memoized per node index; each chain is walked once.
 */
export class DominatorFamilyResolver {
  private readonly memo: Int32Array;
  private readonly names: string[] = [];
  private readonly nameIdx = new Map<string, number>();

  constructor(
    private readonly snapshot: IHeapSnapshot,
    seeds: ReadonlyMap<number, string>,
  ) {
    // -1 unknown, -2 no family, >=0 index into names.
    this.memo = new Int32Array(snapshot.nodes.length).fill(-1);
    for (const [idx, fam] of seeds) this.memo[idx] = this.intern(fam);
  }

  private intern(name: string): number {
    let i = this.nameIdx.get(name);
    if (i == null) {
      i = this.names.length;
      this.names.push(name);
      this.nameIdx.set(name, i);
    }
    return i;
  }

  familyOf(node: IHeapNode): string | null {
    const stack: number[] = [];
    let cur: IHeapNode | null = node;
    let res = -2;
    while (cur != null) {
      const m = this.memo[cur.nodeIndex];
      if (m !== -1) {
        res = m;
        break;
      }
      stack.push(cur.nodeIndex);
      const d: IHeapNode | null = cur.dominatorNode ?? null;
      if (
        d == null ||
        d.nodeIndex === cur.nodeIndex ||
        d.type === 'synthetic'
      ) {
        break;
      }
      cur = d;
    }
    for (const idx of stack) this.memo[idx] = res;
    return res >= 0 ? this.names[res] : null;
  }
}

// Edges that carry no meaning in a label (closure plumbing, backing stores).
const PLUMBING_EDGES: ReadonlySet<string> = new Set([
  'context',
  'table',
  'properties',
  'elements',
  'previous',
  'map',
  'shared',
  '__proto__',
]);

/**
 * Labels a node by the first meaningful owner on its SHORTEST retainer path:
 * `module:<Name>.<export>` when the path enters a module record, else
 * `global:<name>` for a window/global property, else `dom` / `root`.
 *
 * Works on minified builds because module names survive as record ids.
 */
export class PathOwnerLabeler {
  private readonly memo: Int32Array;
  private readonly stage: Int8Array;
  private readonly labels: string[] = [];
  private readonly labelIdx = new Map<string, number>();
  private readonly records = new Map<number, string>();

  constructor(snapshot: IHeapSnapshot) {
    this.memo = new Int32Array(snapshot.nodes.length).fill(-1);
    this.stage = new Int8Array(snapshot.nodes.length);
    for (const rec of moduleRecords(snapshot).values()) {
      this.records.set(rec.record.nodeIndex, rec.name);
    }
  }

  private intern(label: string): number {
    let i = this.labelIdx.get(label);
    if (i == null) {
      i = this.labels.length;
      this.labels.push(label);
      this.labelIdx.set(label, i);
    }
    return i;
  }

  labelOf(node: IHeapNode): string {
    const chain: IHeapNode[] = [];
    let cur: IHeapNode | null = node;
    while (cur != null && this.memo[cur.nodeIndex] === -1) {
      chain.push(cur);
      const e: IHeapEdge | null = cur.pathEdge ?? null;
      if (e == null || chain.length > 10_000) break;
      cur = e.fromNode;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = chain[i];
      const e = c.pathEdge;
      let label: string;
      // 0 open, 1 at a module record, 2 after exports, 3 final,
      // 4 at a global (one more edge is appended)
      let stage = 0;
      if (e == null) {
        label = 'root';
      } else {
        const from = e.fromNode;
        const pIdx = this.memo[from.nodeIndex];
        const pLabel = pIdx >= 0 ? this.labels[pIdx] : 'root';
        const pStage = pIdx >= 0 ? this.stage[from.nodeIndex] : 0;
        const en = String(e.name_or_index);
        const recName = this.records.get(c.nodeIndex);
        if (recName != null) {
          label = `module:${recName}`;
          stage = 1;
        } else if (pStage === 1) {
          if (en === 'exports' || en === 'defaultExport') {
            label = pLabel;
            stage = 2;
          } else {
            label = pLabel;
            stage = 3;
          }
        } else if (pStage === 2) {
          label = /^\d+$/.test(en) ? pLabel : `${pLabel}.${en}`;
          stage = 3;
        } else if (pStage === 3) {
          label = pLabel;
          stage = 3;
        } else if (pStage === 4) {
          label =
            PLUMBING_EDGES.has(en) || /^\d+$/.test(en)
              ? pLabel
              : `${pLabel}.${en}`;
          stage = PLUMBING_EDGES.has(en) ? 4 : 3;
        } else if (
          (from.name.startsWith('Window') ||
            from.name.includes('GlobalScope')) &&
          e.type === 'property'
        ) {
          label = `global:${en}`;
          stage = 4;
        } else if (
          pLabel === 'root' &&
          (c.name.startsWith('HTML') ||
            c.name.startsWith('blink::') ||
            c.name.startsWith('Document'))
        ) {
          label = 'dom';
        } else {
          label = pLabel;
          stage = pStage;
        }
      }
      this.memo[c.nodeIndex] = this.intern(label);
      this.stage[c.nodeIndex] = stage;
    }
    const m = this.memo[node.nodeIndex];
    return m >= 0 ? this.labels[m] : 'root';
  }
}

export interface PartitionRow {
  bytes: number;
  nodes: number;
}

export interface MemoryPartition {
  total: number;
  loadedCode: {code: number; bundle: number};
  /** family -> bytes, nodes */
  families: Map<string, PartitionRow>;
  /** DOM / Blink sub-family -> bytes, nodes */
  dom: Map<string, PartitionRow>;
  /** shortest-path owner -> bytes, nodes, by kind */
  owners: Map<string, PartitionRow & {kinds: Map<string, number>}>;
  /** per family: shortest-path owner -> bytes (only when drilled) */
  drill: Map<string, number> | null;
}

function add(map: Map<string, PartitionRow>, key: string, bytes: number): void {
  const row = map.get(key);
  if (row == null) map.set(key, {bytes, nodes: 1});
  else {
    row.bytes += bytes;
    row.nodes++;
  }
}

/**
 * An exclusive partition of the heap: every byte lands in exactly one row.
 *
 * 1. Seed families (shapes + explicit seeds); a node belongs to the nearest
 *    seed on its dominator chain.
 * 2. Native DOM/Blink nodes no family dominates go to DOM sub-families.
 * 3. Loaded code and bundle text is split out (reported, not partitioned).
 * 4. Everything else is labelled by its shortest-path owner (module export,
 *    global, dom, root) and a kind (strings, arrays, closures, ...).
 */
export function computeMemoryPartition(
  snapshot: IHeapSnapshot,
  drillFamily: string | null,
): MemoryPartition {
  const seeds = collectFamilySeeds(snapshot);
  const resolver = new DominatorFamilyResolver(snapshot, seeds);
  const labeler = new PathOwnerLabeler(snapshot);
  const scriptSource = scriptSourceStringData(snapshot);
  const families = new Map<string, PartitionRow>();
  const dom = new Map<string, PartitionRow>();
  const owners = new Map<string, PartitionRow & {kinds: Map<string, number>}>();
  const drill = drillFamily != null ? new Map<string, number>() : null;
  const drillRe =
    drillFamily != null
      ? new RegExp(
          // Lookarounds, not `\b`: a family name can start or end with a
          // non-word character (`(fn.$$cache)`), where `\b` never matches.
          `(?<![A-Za-z0-9_])${drillFamily.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`,
          'i',
        )
      : null;
  let total = 0;
  let code = 0;
  let bundle = 0;
  snapshot.nodes.forEach((node: IHeapNode) => {
    tickAnalysis();
    if (node.id <= 3 || node.type === 'synthetic') return;
    const size = node.self_size;
    total += size;
    const loaded = loadedCodeKind(node, scriptSource);
    if (loaded === 'code') {
      code += size;
      return;
    }
    if (loaded === 'bundle') {
      bundle += size;
      return;
    }
    const fam = resolver.familyOf(node);
    if (fam != null) {
      add(families, fam, size);
      if (drill != null && drillRe != null && drillRe.test(fam)) {
        const l = labeler.labelOf(node);
        drill.set(l, (drill.get(l) ?? 0) + size);
      }
      return;
    }
    const d = domFamily(node);
    if (d != null) {
      add(dom, d, size);
      return;
    }
    const owner = labeler.labelOf(node);
    let row = owners.get(owner);
    if (row == null) {
      row = {bytes: 0, nodes: 0, kinds: new Map()};
      owners.set(owner, row);
    }
    row.bytes += size;
    row.nodes++;
    const k = kindBucket(node);
    row.kinds.set(k, (row.kinds.get(k) ?? 0) + size);
  });
  return {total, loadedCode: {code, bundle}, families, dom, owners, drill};
}

/**
 * The shortest-path tree (parent = `pathEdge.fromNode`) in CSR form, with the
 * self bytes of every subtree. Loaded code and bundle text count 0, so subtree
 * sums are app memory. Unlike dominator subtrees, these PARTITION the heap: a
 * shared object belongs to exactly one parent, the one on its shortest path.
 */
export interface PathTree {
  parent: Int32Array;
  childStart: Int32Array;
  children: Int32Array;
  subtreeBytes: Float64Array;
  roots: number[];
}

const pathTreeCache = new WeakMap<IHeapSnapshot, PathTree>();

export function buildPathTree(snapshot: IHeapSnapshot): PathTree {
  const cached = pathTreeCache.get(snapshot);
  if (cached != null) return cached;
  const n = snapshot.nodes.length;
  const parent = new Int32Array(n).fill(-1);
  const self = new Float64Array(n);
  const counts = new Int32Array(n + 1);
  const scriptSource = scriptSourceStringData(snapshot);
  snapshot.nodes.forEach((node: IHeapNode) => {
    tickAnalysis();
    const i = node.nodeIndex;
    self[i] =
      node.type === 'synthetic' || loadedCodeKind(node, scriptSource) != null
        ? 0
        : node.self_size;
    const e = node.pathEdge;
    if (e != null && e.fromNode.nodeIndex !== i) {
      parent[i] = e.fromNode.nodeIndex;
      counts[parent[i] + 1]++;
    }
  });
  const childStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) childStart[i + 1] = childStart[i] + counts[i + 1];
  const fill = childStart.slice(0, n);
  const children = new Int32Array(childStart[n]);
  const roots: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = parent[i];
    if (p < 0) roots.push(i);
    else children[fill[p]++] = i;
  }
  // BFS order from the roots; accumulate subtree sums in reverse.
  const order = new Int32Array(n);
  const seen = new Uint8Array(n);
  let head = 0;
  let tail = 0;
  const walk = (): void => {
    while (head < tail) {
      const v = order[head++];
      for (let k = childStart[v]; k < childStart[v + 1]; k++) {
        const c = children[k];
        if (seen[c] === 0) {
          seen[c] = 1;
          order[tail++] = c;
        }
      }
    }
  };
  for (const r of roots) {
    seen[r] = 1;
    order[tail++] = r;
  }
  walk();
  // A shortest-path tree has no cycles, but a malformed snapshot could; a node
  // the walk never reached becomes a root, so its bytes are still counted.
  for (let i = 0; i < n && tail < n; i++) {
    if (seen[i] !== 0) continue;
    parent[i] = -1;
    roots.push(i);
    seen[i] = 1;
    order[tail++] = i;
    walk();
  }
  const subtreeBytes = self;
  for (let k = tail - 1; k >= 0; k--) {
    const v = order[k];
    const p = parent[v];
    if (p >= 0) subtreeBytes[p] += subtreeBytes[v];
  }
  const tree = {parent, childStart, children, subtreeBytes, roots};
  pathTreeCache.set(snapshot, tree);
  return tree;
}

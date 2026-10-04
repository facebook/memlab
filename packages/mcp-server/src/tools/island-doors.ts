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
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {tickAnalysis} from '../analysis-budget.js';
import {getSnapshot, getSnapshotByHandle} from '../heap-state.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  parseEphemeronEdge,
  toolResult,
} from '../utils.js';
import {collectDevRoots, type DevRoots} from './dev-artifacts.js';
import {devEdgeReason} from '../dev-edges.js';

/**
 * A live -> island edge: one reason the island is still reachable, and one
 * reference a fix has to remove.
 */
interface Door {
  /**
   * Up to `MAX_HOLDER_SAMPLES` distinct holder ids behind this row.
   *
   * Rows are keyed by holder class + edge + target class, so several distinct
   * objects can collapse into one. A fix has to name the holders it closes, and
   * one `@id` out of an unknown number is not enough to find the rest.
   */
  holderIds: number[];
  holderName: string;
  holderType: string;
  edgeName: string;
  targetId: number;
  targetName: string;
  isBlink: boolean;
  count: number;
}

/** Crossings that exist in the graph but do NOT retain, kept so the reasoning is visible. */
interface Excluded {
  devOnly: number;
  weak: number;
  deadKeyEphemeron: number;
}

/**
 * Holders that are part of the browser's own C++ bookkeeping rather than
 * application state. They cannot be fixed from JS, and listing them beside real
 * app references buries the actionable rows.
 */
const BLINK_HOLDER_RE =
  /^(blink::|C\+\+ |WindowProperties$|system \/ (Native)?Context)|cppgc/;

/**
 * The dead browsing context's own globals.
 */
const DEAD_CONTEXT_HOLDER_RE = /^Window \[JSGlobalObject\]|^WindowProperties$/;

/** Distinct holder ids kept per row — enough to go and look, not a second table. */
const MAX_HOLDER_SAMPLES = 4;

/**
 * V8 realm machinery rather than application state.
 *
 * A closed window's own builtins — `toString`, `keys`, `toJSON`, every accessor
 * on every prototype — are closures whose `context` edge points at that window's
 * detached `NativeContext`. There are hundreds of them, they are reachable from
 * the live graph through V8's shared structures, and none of them is a reference
 * an application can remove. Left in the app bucket they drowned the real doors
 * 300 to 1 on the first capture this ran against, which would have made the tool
 * worse than the single trace it replaces.
 */
function targetIsRealmMachinery(name: string): boolean {
  return /^(Detached )?system \//.test(name);
}

function isSyntheticRoot(node: IHeapNode): boolean {
  return node.type === 'synthetic' || node.id <= 3;
}

/**
 * The connected component of DETACHED nodes containing `seeds`, walked in both
 * directions. Direction matters: a detached subtree is reached from its root by
 * references, but the document is reached from a child by referrers, and a
 * one-directional walk silently returns a fraction of the island.
 */
function buildIsland(snapshot: IHeapSnapshot, seeds: IHeapNode[]): Set<number> {
  const island = new Set<number>();
  const stack: IHeapNode[] = [];
  for (const seed of seeds) {
    if (!island.has(seed.id)) {
      island.add(seed.id);
      stack.push(seed);
    }
  }
  while (stack.length > 0) {
    const node = stack.pop() as IHeapNode;
    tickAnalysis();
    node.forEachReference((edge: IHeapEdge) => {
      const to = edge.toNode;
      if (to == null || island.has(to.id)) return;
      if (!to.is_detached && !to.name.startsWith('Detached ')) return;
      island.add(to.id);
      stack.push(to);
    });
    for (const edge of node.referrers) {
      const from = edge.fromNode;
      if (from == null || island.has(from.id)) continue;
      if (!from.is_detached && !from.name.startsWith('Detached ')) continue;
      island.add(from.id);
      stack.push(from);
    }
  }
  return island;
}

/**
 * Everything reachable FORWARD from the seeds, seeds included.
 *
 * The island definition for a LIVE accumulator. "What are all the independent
 * references into this Map's value set?" is the same question `island_doors`
 * answers for a detached subtree — several holders, and fixing the nearest one
 * reclaims nothing — but the detached definition cannot express it.
 *
 * Referrers are deliberately NOT walked: the seeds' own retainers are what we
 * are trying to enumerate, and pulling them into the island would make every
 * door disappear.
 *
 * Capped, because a live object graph is not an island: a value that points
 * back at the app reaches most of the heap. Hitting the cap is reported as a
 * failure of the premise, not truncated silently.
 */
function buildReachableIsland(
  snapshot: IHeapSnapshot,
  seeds: IHeapNode[],
  maxNodes: number,
): {island: Set<number>; capped: boolean} {
  const island = new Set<number>();
  const stack: IHeapNode[] = [];
  for (const seed of seeds) {
    if (!island.has(seed.id)) {
      island.add(seed.id);
      stack.push(seed);
    }
  }
  let capped = false;
  while (stack.length > 0) {
    if (island.size >= maxNodes) {
      capped = true;
      break;
    }
    const node = stack.pop() as IHeapNode;
    tickAnalysis();
    node.forEachReference((edge: IHeapEdge) => {
      const to = edge.toNode;
      if (to == null || island.has(to.id) || to.id <= 3) return;
      if (edge.type === 'weak') return;
      if (!isDataEdge(edge, to)) return;
      island.add(to.id);
      stack.push(to);
    });
  }
  return {island, capped};
}

/**
 * Structural edges that leave the object's DATA and enter the realm.
 *
 * Without this filter the forward walk escapes immediately: one `__proto__`
 * hop reaches the prototype chain, then the constructor, then every builtin.
 * Measured on 403 seed objects, the unfiltered closure was 49,435 nodes and
 * produced 20,942 "doors" — `system / DescriptorArray`, `system / PropertyCell`,
 * `(shared function info)` — not one of which an application can remove.
 */
const STRUCTURAL_EDGE_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'map',
  'code',
  'shared',
  'feedback_cell',
  'function_data',
  'name_or_scope_info',
]);

/** V8 bookkeeping rather than application data. */
function isRealmNode(node: IHeapNode): boolean {
  return (
    node.type === 'code' ||
    node.type === 'synthetic' ||
    node.type === 'hidden' ||
    node.name.startsWith('system /') ||
    node.name.startsWith('(shared function info)') ||
    node.name.startsWith('(compiled code)')
  );
}

function isDataEdge(edge: IHeapEdge, to: IHeapNode): boolean {
  if (STRUCTURAL_EDGE_NAMES.has(String(edge.name_or_index))) return false;
  return !isRealmNode(to);
}

/**
 * The dominator subtree of the seeds: what they EXCLUSIVELY own.
 *
 * Every node here is reachable only through a seed, so the door list collapses
 * to the references into the seeds themselves — which is the right answer when
 * the question is "who holds this accumulator" rather than "what else touches
 * its contents".
 */
function buildDominatedIsland(
  snapshot: IHeapSnapshot,
  seeds: IHeapNode[],
): Set<number> {
  const childrenOf = new Map<number, number[]>();
  snapshot.nodes.forEach(node => {
    tickAnalysis();
    if (node.id <= 3) return;
    const dom = node.dominatorNode;
    if (dom == null || dom.id === node.id) return;
    let a = childrenOf.get(dom.id);
    if (!a) {
      a = [];
      childrenOf.set(dom.id, a);
    }
    a.push(node.id);
  });
  const island = new Set<number>();
  const stack: number[] = [];
  for (const seed of seeds) {
    if (!island.has(seed.id)) {
      island.add(seed.id);
      stack.push(seed.id);
    }
  }
  while (stack.length > 0) {
    const id = stack.pop() as number;
    tickAnalysis();
    for (const child of childrenOf.get(id) ?? []) {
      if (island.has(child)) continue;
      island.add(child);
      stack.push(child);
    }
  }
  return island;
}

/**
 * Walk forward from the GC roots, refusing to enter the island, and record
 * every edge that crosses into it. Those crossings are the complete set of
 * reasons the island is still alive.
 *
 * Three kinds of edge are refused, and each refusal is counted rather than
 * silently dropped — a reader has to be able to tell "no doors" from "the
 * filter hid them":
 *
 *  - **weak** edges do not retain;
 *  - **dev/automation roots** are treated as sinks, and **dev edges**
 *    (`_owner` on a DEV element, `_debug*`, Fast Refresh, dev-only modules)
 *    are not followed, so anything reachable only through them is not counted
 *    as production retention;
 *  - **WeakMap ephemeron** key->value edges are followed ONLY once the key is
 *    known reachable. This is conditional on purpose. Refusing them outright is
 *    wrong — a WeakMap value IS retained when its key is live — and a blanket
 *    exclusion hides exactly the case where a live key holds a value that points
 *    back into the island.
 */
function findDoors(
  snapshot: IHeapSnapshot,
  island: Set<number>,
  devRoots: DevRoots,
): {doors: Map<string, Door>; excluded: Excluded; liveNodes: number} {
  const reachedById = new Set<number>();
  const doors = new Map<string, Door>();
  const excluded: Excluded = {devOnly: 0, weak: 0, deadKeyEphemeron: 0};
  const stack: IHeapNode[] = [];
  // Targets of refused dev edges, where the dev-only walk below starts.
  const devEdgeTargets: IHeapNode[] = [];
  // Ephemeron edges whose key was not yet known reachable when we met them.
  let deferred: Array<{from: IHeapNode; edge: IHeapEdge; keyId: number}> = [];

  snapshot.nodes.forEach(node => {
    if (!isSyntheticRoot(node)) return;
    if (reachedById.has(node.id)) return;
    reachedById.add(node.id);
    if (!devRoots.byId.has(node.id)) stack.push(node);
  });

  const recordDoor = (from: IHeapNode, edge: IHeapEdge, to: IHeapNode) => {
    // V8 leaves backing stores and anonymous objects unnamed, and an empty
    // cell reads as a formatting bug rather than as "this holder has no
    // class".
    const holderName =
      from.name.length > 0 ? from.name : `(anonymous ${from.type})`;
    if (DEAD_CONTEXT_HOLDER_RE.test(holderName)) return;
    // A numeric index is per-ENTRY, so one accumulating container becomes one
    // row per element and the door list is just the population size. Measured
    // on a 400-entry Map: 400 rows of count 1, with the one real door (a
    // global holding a single value) buried among them. Collapsed, it is two
    // rows.
    const rawEdgeName = String(edge.name_or_index);
    const edgeName = /^\d+$/.test(rawEdgeName) ? '[i]' : rawEdgeName;
    // Raw NUL bytes used to separate these three fields. They are an
    // invisible character in a source file, and Sapling classifies the
    // whole file as BINARY because of them, so every diff that touches this
    // file renders as an unreviewable blob. `\u0000` is the same byte with
    // the same collision-proof property, spelled so it can be read.
    const key = `${holderName}\u0000${edgeName}\u0000${to.name}`;
    const existing = doors.get(key);
    if (existing != null) {
      existing.count++;
      if (
        existing.holderIds.length < MAX_HOLDER_SAMPLES &&
        !existing.holderIds.includes(from.id)
      ) {
        existing.holderIds.push(from.id);
      }
      return;
    }
    doors.set(key, {
      holderIds: [from.id],
      holderName,
      holderType: from.type,
      edgeName,
      targetId: to.id,
      targetName: to.name,
      isBlink:
        BLINK_HOLDER_RE.test(holderName) ||
        edgeName === 'cppgc_object' ||
        targetIsRealmMachinery(to.name) ||
        // Any `system /` holder, compiled code or shared function info. None
        // of these is a reference an application can remove, and on a LIVE
        // island they outnumber the real doors by orders of magnitude.
        isRealmNode(from),
      count: 1,
    });
  };

  const visit = (from: IHeapNode, edge: IHeapEdge): void => {
    const to = edge.toNode;
    if (to == null) return;
    if (edge.type === 'weak') {
      if (island.has(to.id)) excluded.weak++;
      return;
    }
    if (devEdgeReason(edge.name_or_index, from) != null) {
      if (island.has(to.id)) excluded.devOnly++;
      else devEdgeTargets.push(to);
      return;
    }
    const eph = parseEphemeronEdge(String(edge.name_or_index));
    if (eph != null && !reachedById.has(eph.keyId)) {
      deferred.push({from, edge, keyId: eph.keyId});
      return;
    }
    if (island.has(to.id)) {
      recordDoor(from, edge, to);
      return;
    }
    if (reachedById.has(to.id)) return;
    reachedById.add(to.id);
    if (!devRoots.byId.has(to.id)) stack.push(to);
  };

  const drain = (): void => {
    while (stack.length > 0) {
      const node = stack.pop() as IHeapNode;
      tickAnalysis();
      node.forEachReference((edge: IHeapEdge) => visit(node, edge));
    }
  };

  drain();
  // Fixpoint: a key can become reachable only after the edge that mentions it
  // was already walked past, so replay the deferred ephemerons until a full
  // pass adds nothing.
  for (;;) {
    const pending = deferred;
    deferred = [];
    let progressed = false;
    for (const item of pending) {
      tickAnalysis();
      if (!reachedById.has(item.keyId)) {
        deferred.push(item);
        continue;
      }
      progressed = true;
      visit(item.from, item.edge);
    }
    drain();
    if (!progressed || deferred.length === 0) break;
  }
  for (const item of deferred) {
    const to = item.edge.toNode;
    if (to != null && island.has(to.id)) excluded.deadKeyEphemeron++;
  }

  // Crossings into the island from anything reachable only through a dev root
  // or dev edge. Counting only the dev root's DIRECT pointers reported 0 for a
  // Fast Refresh path (`$RefreshSig$ -> allSignaturesByType -> getCustomHooks
  // -> ... -> div`), which read as "no dev retention" next to an empty door
  // list.
  const devVisited = new Set<number>();
  const devStack: IHeapNode[] = [];
  const pushDev = (n: IHeapNode) => {
    if (reachedById.has(n.id) && !devRoots.byId.has(n.id)) return;
    if (island.has(n.id) || devVisited.has(n.id)) return;
    devVisited.add(n.id);
    devStack.push(n);
  };
  for (const [rootId] of devRoots.byId) {
    const root = snapshot.getNodeById(rootId);
    if (root != null) pushDev(root);
  }
  for (const n of devEdgeTargets) pushDev(n);
  while (devStack.length > 0) {
    tickAnalysis();
    const node = devStack.pop() as IHeapNode;
    node.forEachReference((edge: IHeapEdge) => {
      const to = edge.toNode;
      if (to == null || edge.type === 'weak') return;
      if (island.has(to.id)) excluded.devOnly++;
      else pushDev(to);
    });
  }

  return {doors, excluded, liveNodes: reachedById.size};
}

export function registerIslandDoors(server: McpServer): void {
  server.tool(
    'memlab_island_doors',
    'List EVERY production-reachable reference into an island, not just the shortest one. `memlab_retainer_trace` answers "why is this object alive by ONE path"; an island normally has several independent holders, and fixing whichever happens to be nearest a GC root reclaims nothing because the next one still pins it.\n\n' +
      'The island can be a DETACHED subtree (`island_mode: "detached"`, the default) or a LIVE one: `"reachable"` takes everything the seeds reach, which is how to ask "what are all the independent references into this accumulator\'s value set?", and `"dominated"` takes what the seeds exclusively own, which answers "who holds this accumulator". Walks forward from the GC roots refusing to enter the island, so each edge that crosses in is one reference a fix must remove. Refuses weak edges, dev/automation roots (DevTools console, a11y cache, dev globals) and dev edges (React DEV `_owner`/`_debug*`, Fast Refresh, devtools modules), and follows a WeakMap key->value edge only when the key is itself reachable — conditionally, because a WeakMap value IS retained while its key is live. Every refusal is counted, so "no doors" is distinguishable from "the filter hid them". Run this BEFORE writing a fix, and again after, to show each door is closed.',
    {
      seed_class: z
        .string()
        .optional()
        .describe(
          'Class name to seed the island from, e.g. "Detached HTMLDocument". The island is the connected component of detached nodes containing the seeds.',
        ),
      seed_node_ids: z
        .array(z.number())
        .optional()
        .describe(
          'Explicit seed node ids, when the island is not identified by a class. LIVE nodes are allowed with `island_mode: "reachable"` or `"dominated"`.',
        ),
      island_mode: z
        .enum(['detached', 'reachable', 'dominated'])
        .optional()
        .default('detached')
        .describe(
          '"detached" (default): the connected component of DETACHED nodes around the seeds — the classic detached-DOM island, and the only mode that accepts a detached seed class. ' +
            '"reachable": everything reachable FORWARD from the seeds, which makes the same "close every door" analysis work on a LIVE accumulator — "what are all the independent references into this Map\'s value set?". Referrers are not walked, because the seeds\' own retainers are exactly what is being enumerated. ' +
            '"dominated": the seeds\' dominator subtree, i.e. what they EXCLUSIVELY own; every path in goes through a seed, so the doors collapse to the references into the seeds themselves — the right mode for "who holds this accumulator".',
        ),
      max_island_nodes: z
        .number()
        .optional()
        .default(200000)
        .describe(
          'Cap for `island_mode: "reachable"` (default 200,000). A live object graph is not an island: a value that points back at the app reaches most of the heap. Hitting the cap is reported as a failure of the premise rather than silently truncated.',
        ),
      include_blink: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Include crossings that are browser/V8 bookkeeping rather than application state: blink::*/cppgc holders, and the dead realm's own builtins, whose `context` edge points at its detached NativeContext (default false). None can be closed from JS; when the app-side list is empty they are the answer, and the summary says so either way.",
        ),
      limit: z
        .number()
        .optional()
        .describe('Maximum door rows to list (default 25).'),
      handle: z
        .string()
        .optional()
        .describe('Snapshot to analyze (defaults to the active one).'),
    },
    async ({
      seed_class,
      seed_node_ids,
      island_mode,
      max_island_nodes,
      include_blink,
      limit,
      handle,
    }) => {
      try {
        const snapshot =
          handle != null ? getSnapshotByHandle(handle) : getSnapshot();
        if (snapshot == null) {
          return errorResult(
            new Error(
              handle != null
                ? `Snapshot "${handle}" is not resident.`
                : 'No snapshot loaded. Use memlab_load_snapshot first.',
            ),
          );
        }
        const maxRows = limit ?? 25;

        const seeds: IHeapNode[] = [];
        if (seed_node_ids != null) {
          for (const id of seed_node_ids) {
            const node = snapshot.getNodeById(id);
            if (node != null) seeds.push(node);
          }
        }
        if (seed_class != null && seed_class !== '') {
          snapshot.nodes.forEach(node => {
            tickAnalysis();
            if (node.name === seed_class) seeds.push(node);
          });
        }
        if (seeds.length === 0) {
          return errorResult(
            new Error(
              'No seed nodes found. Pass `seed_class` (e.g. "Detached HTMLDocument") or `seed_node_ids`. Use memlab_detached_dom to find a starting point.',
            ),
          );
        }
        // In `detached` mode a live seed silently produces a large,
        // meaningless island: the seed joins the set, every detached
        // neighbour is pulled in behind it, and the result reads as a
        // confident measurement of nothing. Seeding on a live class returned a
        // 209,173-node "island" before this check. The other two modes DEFINE
        // the island from the seeds themselves, so a live seed is the point.
        const detachedSeeds = seeds.filter(
          n => n.is_detached || n.name.startsWith('Detached '),
        );
        if (island_mode === 'detached' && detachedSeeds.length === 0) {
          return errorResult(
            new Error(
              `All ${formatNumber(seeds.length)} seed(s) are LIVE, not detached. In \`island_mode: "detached"\` a live seed drags the whole detached graph in behind it and reports a large island that means nothing.\n\n` +
                'Either seed on a detached class (e.g. "Detached HTMLDocument") or on ids from `memlab_detached_dom`, or — if you meant to close every door into a LIVE accumulator — pass `island_mode: "reachable"` (everything the seeds reach) or `"dominated"` (what they exclusively own).',
            ),
          );
        }
        const usedSeeds = island_mode === 'detached' ? detachedSeeds : seeds;
        const skippedLiveSeeds =
          island_mode === 'detached' ? seeds.length - detachedSeeds.length : 0;

        let islandCapped = false;
        let island: Set<number>;
        if (island_mode === 'reachable') {
          const built = buildReachableIsland(
            snapshot,
            usedSeeds,
            max_island_nodes,
          );
          island = built.island;
          islandCapped = built.capped;
        } else if (island_mode === 'dominated') {
          island = buildDominatedIsland(snapshot, usedSeeds);
        } else {
          island = buildIsland(snapshot, usedSeeds);
        }
        let islandSelf = 0;
        for (const id of island) {
          const node = snapshot.getNodeById(id);
          if (node != null) islandSelf += node.self_size;
        }

        const devRoots = collectDevRoots(snapshot);
        const {doors, excluded, liveNodes} = findDoors(
          snapshot,
          island,
          devRoots,
        );

        const all = [...doors.values()].sort((a, b) => b.count - a.count);
        const appDoors = all.filter(d => !d.isBlink);
        const blinkDoors = all.filter(d => d.isBlink);
        const shown = include_blink === true ? all : appDoors;

        const lines: string[] = [
          '## Island doors',
          '',
          `Island (\`${island_mode}\`): **${formatNumber(island.size)} nodes / ${formatBytes(islandSelf)}** self, seeded from ${formatNumber(usedSeeds.length)} ${island_mode === 'detached' ? 'detached ' : ''}node(s)` +
            (skippedLiveSeeds > 0
              ? ` (${formatNumber(skippedLiveSeeds)} live seed(s) ignored)`
              : '') +
            '. ' +
            `Live graph walked: ${formatNumber(liveNodes)} nodes.`,
          '',
          ...(islandCapped
            ? [
                `> ⚠️ **The forward walk hit the ${formatNumber(max_island_nodes)}-node cap, so this is NOT a bounded island** and the door list below is incomplete. ` +
                  'That is usually the answer rather than a limit: the seeds reach back into the application, so "everything they reach" is most of the heap. ' +
                  'Narrow the seeds (the accumulator\'s VALUES rather than the accumulator), use `island_mode: "dominated"` for what they exclusively own, or raise `max_island_nodes` if you believe the structure really is that large.',
                '',
              ]
            : []),
          ...(island_mode === 'dominated'
            ? [
                '_Dominator subtree: every path into this set goes through a seed, so the doors below are the references into the SEEDS themselves — "who holds this accumulator", not "what else touches its contents". Use `island_mode: "reachable"` for the second question._',
                '',
              ]
            : []),
          `**${formatNumber(appDoors.length)} application-side door(s)**` +
            (blinkDoors.length > 0
              ? ` and ${formatNumber(blinkDoors.length)} browser/V8-internal one(s) (\`include_blink: true\` to list).`
              : '.'),
          '',
        ];

        if (shown.length > 0) {
          lines.push(
            markdownTable(
              ['Holder', 'Edge', 'Into', 'Kind', 'Edges'],
              shown
                .slice(0, maxRows)
                .map(d => [
                  `\`${d.holderName.slice(0, 46)}\` ` +
                    d.holderIds.map(id => `@${id}`).join(', ') +
                    (d.count > d.holderIds.length ? ', …' : ''),
                  `\`${d.edgeName.slice(0, 34)}\``,
                  d.targetName.slice(0, 40),
                  d.isBlink ? 'internal' : 'app',
                  formatNumber(d.count),
                ]),
              new Set([4]),
            ),
            '',
          );
          if (shown.length > maxRows) {
            lines.push(
              `_${formatNumber(shown.length - maxRows)} more door(s) not shown — raise \`limit\`._`,
              '',
            );
          }
        }

        if (appDoors.length === 0) {
          lines.push(
            blinkDoors.length > 0
              ? '> **No application-side doors.** Every remaining reference is browser/V8 bookkeeping ' +
                  '(pass `include_blink: true` to list them). JavaScript cannot close these — the ' +
                  'browsing context itself has not been torn down. Confirm by driving several cycles: if the ' +
                  'population stays at one rather than growing, this is one lingering context, not an accumulating leak.'
              : excluded.devOnly > 0
                ? `> **Dev-only: no production door.** All ${formatNumber(excluded.devOnly)} crossing(s) into the island ` +
                  'come through a dev/automation root or a dev edge (React DEV `_owner`/`_debug*`, Fast Refresh, a ' +
                  'devtools module). The island does not exist in a production build — do not write a product fix for it.'
                : '> **No doors found at all**, which means the island is not reachable from the GC roots ' +
                  'through any strong non-dev edge. Before reading that as "already collectable", check the ' +
                  'exclusion counts below — a zero here is far more often a filter that is too aggressive than ' +
                  'a genuinely unreachable island.',
            '',
          );
        } else {
          lines.push(
            `> **A fix must close all ${formatNumber(appDoors.length)} application-side door(s).** ` +
              'Closing one and re-measuring will show no change while any other remains, which reads ' +
              'like "the fix does not work" rather than "the fix is incomplete". Re-run this tool after ' +
              'the fix and expect the app-side list to be empty.',
            '',
          );
        }

        lines.push(
          '### Crossings that were refused',
          '',
          markdownTable(
            ['Reason', 'Crossings', 'Why it does not retain'],
            [
              [
                'weak edge',
                formatNumber(excluded.weak),
                'weak references never keep an object alive',
              ],
              [
                'dev/automation root or dev edge',
                formatNumber(excluded.devOnly),
                'DevTools console, a11y cache, dev globals, React DEV edges (`_owner`, `_debug*`), Fast Refresh and dev-only modules are absent in production',
              ],
              [
                'WeakMap, key unreachable',
                formatNumber(excluded.deadKeyEphemeron),
                'the value dies with the key; V8 collects value→key cycles',
              ],
            ],
            new Set([1]),
          ),
          '',
          '_Ephemerons are followed when the key IS reachable — a live key genuinely retains its ' +
            'value, and refusing the edge outright would hide that door._',
        );

        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

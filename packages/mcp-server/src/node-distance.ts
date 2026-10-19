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

/**
 * Hops from the snapshot root to every node over strong edges; -1 when only
 * weak edges reach it. 0 is the synthetic root, 1 `(GC roots)` and the page's
 * global objects, 2 the root categories (`(Handle scope)`, `(Stack roots)`,
 * …). Globals start at 1 because they are what application memory hangs
 * off: a retaining path should end at `window`, not continue into the many
 * engine handles that keep `window` itself alive. Cached per snapshot.
 */
const cache = new WeakMap<IHeapSnapshot, Int32Array>();

function isGlobalObject(node: IHeapNode): boolean {
  const name = node.name;
  return (
    name.includes('[JSGlobalObject]') ||
    name.includes('[JSGlobalProxy]') ||
    (node.type === 'native' && name.startsWith('Window / '))
  );
}

export function nodeDistances(snapshot: IHeapSnapshot): Int32Array {
  const hit = cache.get(snapshot);
  if (hit != null) return hit;
  const count = snapshot.nodes.length;
  const dist = new Int32Array(count).fill(-1);
  const queue = new Uint32Array(count);
  let tail = 0;
  dist[0] = 0;
  queue[tail++] = 0;
  const root = snapshot.nodes.get(0);
  root?.forEachReference((edge: IHeapEdge) => {
    const child = edge.toNode;
    if (child.type !== 'synthetic' && dist[child.nodeIndex] < 0) {
      dist[child.nodeIndex] = 1;
      queue[tail++] = child.nodeIndex;
    }
  });
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (isGlobalObject(node) && dist[node.nodeIndex] < 0) {
      dist[node.nodeIndex] = 1;
      queue[tail++] = node.nodeIndex;
    }
  });
  for (let head = 0; head < tail; ++head) {
    const idx = queue[head];
    const node = snapshot.nodes.get(idx);
    if (node == null) continue;
    const next = dist[idx] + 1;
    node.forEachReference((edge: IHeapEdge) => {
      if (edge.type === 'weak') return;
      const child = edge.toNode.nodeIndex;
      if (dist[child] >= 0) return;
      dist[child] = next;
      queue[tail++] = child;
    });
  }
  cache.set(snapshot, dist);
  return dist;
}

/** A node this close to the root, or closer, is a root (the root categories and above). */
export const ROOT_DISTANCE = 2;

export interface RetainerBranch {
  edgeName: string;
  edgeType: string;
  node: IHeapNode;
  distance: number;
  /** This node's own retainers; empty when it is a root. */
  retainers: RetainerBranch[];
  /** For a root: the global or root category one hop nearer the root. */
  heldBy?: IHeapNode;
  /** The node is already shown, with its paths, elsewhere in the tree. */
  joins?: boolean;
  /** A limit stopped the walk above this node before it reached a root. */
  truncated?: boolean;
}

function nearerRoot(
  node: IHeapNode,
  d: number,
  dist: Int32Array,
): IHeapNode | undefined {
  if (d <= 0) return undefined;
  const edge = node.findAnyReferrer(
    (e: IHeapEdge) => e.type !== 'weak' && dist[e.fromNode.nodeIndex] === d - 1,
  );
  return edge?.fromNode;
}

export interface RetainerTree {
  branches: RetainerBranch[];
  /** Root-terminated paths in the tree. */
  pathCount: number;
  limits: {depth: boolean; nodes: boolean; siblings: boolean};
}

/**
 * Every retaining path from `target` up to a root, as a tree, bounded by
 * depth, total nodes visited and retainers followed per node. Weak edges are
 * skipped, and at each node the retainers nearest a root are tried first.
 *
 * The node budget is shared out between siblings rather than spent
 * depth-first, so one owner's deep chain cannot starve a second owner out of
 * the tree. A branch that merges into a node already shown is kept, marked as
 * joining it, instead of being dropped for reaching no new root.
 */
export function retainerTree(
  snapshot: IHeapSnapshot,
  target: IHeapNode,
  maxDepth: number,
  maxNodes: number,
  maxSiblings: number,
): RetainerTree {
  const dist = nodeDistances(snapshot);
  const limits = {depth: false, nodes: false, siblings: false};
  const visiting = new Set<number>();
  // Nodes already shown with a path to a root below them.
  const rooted = new Set<number>();
  let pathCount = 0;
  // Walks a limit cut short, to tell a truncated branch from a rootless one.
  let stops = 0;

  const build = (
    node: IHeapNode,
    depth: number,
    budget: {left: number},
  ): RetainerBranch[] => {
    if (depth >= maxDepth) {
      limits.depth = true;
      stops++;
      return [];
    }
    const idx = node.nodeIndex;
    if (visiting.has(idx)) return [];
    if (budget.left <= 0) {
      limits.nodes = true;
      stops++;
      return [];
    }
    budget.left--;
    visiting.add(idx);

    const candidates: Array<{edge: IHeapEdge; d: number}> = [];
    node.forEachReferrer((edge: IHeapEdge) => {
      if (edge.type === 'weak') return;
      const d = dist[edge.fromNode.nodeIndex];
      if (d < 0) return;
      if (d - ROOT_DISTANCE < maxDepth - depth) {
        candidates.push({edge, d});
      } else {
        limits.depth = true;
      }
    });
    candidates.sort(
      (a, b) => a.d - b.d || a.edge.fromNode.id - b.edge.fromNode.id,
    );
    if (candidates.length > maxSiblings) limits.siblings = true;
    const chosen = candidates.slice(0, maxSiblings);

    const out: RetainerBranch[] = [];
    const pathsBefore = pathCount;
    chosen.forEach(({edge, d}, i) => {
      const from = edge.fromNode;
      const branch: RetainerBranch = {
        edgeName: String(edge.name_or_index),
        edgeType: edge.type,
        node: from,
        distance: d,
        retainers: [],
      };
      if (d <= ROOT_DISTANCE) {
        branch.heldBy = nearerRoot(from, d, dist);
      } else if (rooted.has(from.nodeIndex)) {
        branch.joins = true;
      } else {
        // Rounded up: with fewer nodes left than siblings, the first ones
        // still get a node each instead of all getting none.
        const share = {
          left: Math.ceil(budget.left / (chosen.length - i)),
        };
        const before = share.left;
        const stopsBefore = stops;
        branch.retainers = build(from, depth + 1, share);
        budget.left -= before - share.left;
        // A branch that never reached a root explains nothing, unless a limit
        // cut it short: then it is an owner the limits hid, and stays.
        if (branch.retainers.length === 0) {
          if (stops === stopsBefore) return;
          branch.truncated = true;
        }
      }
      if (d <= ROOT_DISTANCE || branch.joins) pathCount++;
      out.push(branch);
    });
    visiting.delete(idx);
    // Only a node with a real path below it can be joined.
    if (pathCount > pathsBefore) rooted.add(idx);
    return out;
  };

  const branches = build(target, 0, {left: maxNodes});
  return {branches, pathCount, limits};
}

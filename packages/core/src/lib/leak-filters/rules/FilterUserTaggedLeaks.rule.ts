/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {MemLabConfig} from '../../Config';
import type {IHeapEdge, IHeapNode, IHeapSnapshot, Nullable} from '../../Types';
import {LeakDecision, LeakObjectFilterRuleBase} from '../BaseLeakFilter.rule';

/**
 * leaked objects that are tagged by user code
 */
export class FilterUserTaggedLeaksRule extends LeakObjectFilterRuleBase {
  _taggedNodeIds: Set<number> = new Set();

  beforeFiltering(_config: MemLabConfig, snapshot: IHeapSnapshot): void {
    let memlabTrackerNode: Nullable<IHeapNode> = null;
    this._taggedNodeIds.clear();
    // find the memlab tracker object
    snapshot.nodes.forEach((node: IHeapNode) => {
      const nodeHasIdentifierProp =
        null !=
        node.findAnyReference((edge: IHeapEdge) => {
          return (
            edge.name_or_index === 'memlabIdentifier' &&
            edge.toNode.name === 'MemLabObjectTracker'
          );
        });

      if (nodeHasIdentifierProp) {
        memlabTrackerNode = node;
      }

      // if this is false, forEach finishes iteration
      return !nodeHasIdentifierProp;
    });

    // traverse the memlab tracker in heap to get all tagged nodes
    (memlabTrackerNode as Nullable<IHeapNode>)
      // heap: memlabTracker.tagToTrackedObjectsMap
      ?.getReferenceNode('tagToTrackedObjectsMap')
      // heap: memlabTracker.tagToTrackedObjectsMap.table
      ?.getReferenceNode('table', 'internal')
      ?.forEachReference((edge: IHeapEdge) => {
        // heap: trackedItem.taggedObjects.table
        const node = edge.toNode
          .getReferenceNode('taggedObjects')
          ?.getReferenceNode('table', 'internal');
        // traverse all weak edges in
        // trackedItem.taggedObjects.table
        node?.forEachReference((edge: IHeapEdge) => {
          if (edge.type === 'weak') {
            this._taggedNodeIds.add(edge.toNode.id);
          }
        });
      });
  }

  filter(config: MemLabConfig, node: IHeapNode): LeakDecision {
    return this.isReferencedByTaggedWeakRef(node) ||
      this.isReferencedByMemLabObjectTracker(node)
      ? LeakDecision.LEAK
      : LeakDecision.MAYBE_LEAK;
  }

  protected isReferencedByTaggedWeakRef(node: IHeapNode): boolean {
    return (
      node.findAnyReferrer((edge: IHeapEdge) => {
        if (edge.type !== 'weak') {
          return false;
        }
        const fromNode = edge.fromNode;
        if (fromNode == null || fromNode.name !== 'WeakRef') {
          return false;
        }
        return fromNode.getReference('refShouldRelease') != null;
      }) != null
    );
  }

  protected isReferencedByMemLabObjectTracker(node: IHeapNode): boolean {
    return this._taggedNodeIds.has(node.id);
  }
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import {utils} from '../..';
import type {
  AnyValue,
  IHeapEdge,
  IHeapNode,
  IHeapSnapshot,
  Nullable,
  Optional,
} from '../Types';

type AnyObject = Record<AnyValue, AnyValue>;

let uindex = 1;
function getUniqueID(): string {
  const randId = `${Math.random()}`;
  return `${process.pid}-${Date.now()}-${randId}-${uindex++}`;
}

/** @internal */
export default class MemLabTaggedStore {
  public taggedObjects: Record<string, WeakSet<AnyObject>>;

  private constructor() {
    this.taggedObjects = Object.create(null);
  }

  private static instance: Optional<MemLabTaggedStore>;
  public readonly id = getUniqueID();

  // make sure it's a singleton
  public static getInstance(): MemLabTaggedStore {
    if (!MemLabTaggedStore.instance) {
      MemLabTaggedStore.instance = new MemLabTaggedStore();
    }
    return MemLabTaggedStore.instance;
  }

  // tag an object with a mark
  public static tagObject<T>(o: T, tag: string): void {
    const store = MemLabTaggedStore.getInstance();
    if (!store.taggedObjects[tag]) {
      store.taggedObjects[tag] = new WeakSet();
    }
    store.taggedObjects[tag].add(o);
  }

  // check if any object in the heap snapshot has the mark
  // tagged by this MemLabTaggedStore in this execution context
  public static hasObjectWithTag(heap: IHeapSnapshot, tag: string): boolean {
    const curContextTagStoreID = MemLabTaggedStore.getInstance().id;
    let tagStore: Nullable<IHeapNode> = null;

    // get all MemLabTaggedStore instances in the heap snapshot
    const stores: IHeapNode[] = [];
    heap.nodes.forEach((node: IHeapNode) => {
      if (node.name === 'MemLabTaggedStore' && node.type === 'object') {
        stores.push(node);
      }
    });

    // if no tag store found
    if (stores.length === 0) {
      return false;

      // if there is only one store found
    } else if (stores.length === 1) {
      tagStore = stores[0];

      // if there are multiple MemLabTagStore instances
      // found in the heap snapshot
    } else if (stores.length > 1) {
      stores.forEach((node: IHeapNode) => {
        // in case multiple instances of MemLabTaggedStore exists
        // in the heap snapshot, we need to make sure that the
        // tag store is the one matching the current execution context
        let storeID = '';
        // match tag store id
        node.forEachReference(edge => {
          if (edge.name_or_index === 'id' && edge.toNode.isString) {
            storeID = edge.toNode.toStringNode()?.stringValue ?? '';
            return {stop: true};
          }
        });
        if (curContextTagStoreID === storeID) {
          tagStore = node;
        }
      });

      if (tagStore == null) {
        throw utils.haltOrThrow(
          'Multiple MemLabTagStore instances found in heap snapshot ' +
            'when checking object tags, please make sure only one memlab ' +
            'instance is running at a time and double check that memlab is ' +
            'not running in Jest concurrent mode.',
        );
      }
    }

    if (tagStore == null) {
      return false;
    }
    const store = tagStore as IHeapNode;

    // get tagStore.taggedObjects
    const taggedObjects = store.getReferenceNode('taggedObjects', 'property');
    if (taggedObjects == null) {
      return false;
    }

    // get taggedObjects[tag]
    const weakSet = taggedObjects.getReferenceNode(tag, 'property');
    if (weakSet == null) {
      return false;
    }

    // get weakSet.table
    const table = weakSet.getReferenceNode('table');
    if (table == null) {
      return false;
    }

    // check if the table has any weak reference to any object
    const ref = table.findAnyReference(
      (edge: IHeapEdge) =>
        edge.type === 'weak' && edge.toNode.name !== 'system / Oddball',
    );
    return ref != null;
  }
}

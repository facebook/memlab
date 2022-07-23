/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {AnyValue, IHeapSnapshot} from './Types';

import fs from 'fs-extra';
import path from 'path';
import v8 from 'v8';
import fileManager from './FileManager';
import utils from './Utils';

type AnyObject = Record<AnyValue, AnyValue>;

class MemLabTaggedStore {
  public taggedObjects: Record<string, WeakSet<AnyObject>>;
  constructor() {
    this.taggedObjects = Object.create(null);
  }
}
const store = new MemLabTaggedStore();

/**
 * Tags a string marker to an object instance, which can later be checked by
 * {@link hasObjectWithTag}. This API does not modify the object instance in
 * any way (e.g., no additional or hidden properties added to the tagged
 * object).
 *
 * @param o specify the object instance you want to tag, you cannot tag a
 * [primitive](https://developer.mozilla.org/en-US/docs/Glossary/Primitive).
 * @param tag marker name to tag on the object instance
 * @returns returns the tagged object instance (same reference as
 * the input argument `o`)
 * * **Examples**:
 * ```typescript
 * import type {IHeapSnapshot, AnyValue} from '@memlab/core';
 * import {config, getNodeInnocentHeap, tagObject} from '@memlab/core';
 *
 * test('memory test', async () => {
 *   config.muteConsole = true;
 *   const o1: AnyValue = {};
 *   let o2: AnyValue = {};
 *
 *   // tag o1 with marker: "memlab-mark-1", does not modify o1 in any way
 *   tagObject(o1, 'memlab-mark-1');
 *   // tag o2 with marker: "memlab-mark-2", does not modify o2 in any way
 *   tagObject(o2, 'memlab-mark-2');
 *
 *   o2 = null;
 *
 *   const heap: IHeapSnapshot = await getNodeInnocentHeap();
 *
 *   // expect object with marker "memlab-mark-1" exists
 *   expect(heap.hasObjectWithTag('memlab-mark-1')).toBe(true);
 *
 *   // expect object with marker "memlab-mark-2" can be GCed
 *   expect(heap.hasObjectWithTag('memlab-mark-2')).toBe(false);
 *
 * }, 30000);
 * ```
 */
export function tagObject<T extends object>(o: T, tag: string): T {
  if (!store.taggedObjects[tag]) {
    store.taggedObjects[tag] = new WeakSet();
  }
  store.taggedObjects[tag].add(o);
  return o;
}

export function dumpNodeHeapSnapshot(): string {
  const file = path.join(
    fileManager.generateTmpHeapDir(),
    `nodejs.heapsnapshot`,
  );
  v8.writeHeapSnapshot(file);
  return file;
}

/**
 * Take a heap snapshot of the current program state
 * and parse it as {@link IHeapSnapshot}. Notice that
 * this API does not calculate some heap analysis meta data
 * for heap analysis. But this also means faster heap parsing.
 *
 * @returns heap representation without heap analysis meta data.
 *
 * If you need to get the heap snapshot with heap analysis meta data
 * use {@link dumpNodeHeapSnapshot} and {@link getHeapFromFile},
 * for example:
 * ```typescript
 * import type {IHeapSnapshot} from '@memlab/core';
 * import {dumpNodeHeapSnapshot} from '@memlab/core';
 * import {getHeapFromFile} from '@memlab/heap-analysis';
 *
 * (async function () {
 *   const heapFile = dumpNodeHeapSnapshot();
 *   const heap: IHeapSnapshot = await getHeapFromFile(heapFile);
 * })();
 * ```
 */
export async function getNodeInnocentHeap(): Promise<IHeapSnapshot> {
  const file = dumpNodeHeapSnapshot();
  const snapshot = await utils.getSnapshotFromFile(file, {
    buildNodeIdIndex: true,
  });
  fs.unlink(file, () => {
    // do nothing
  });
  return snapshot;
}
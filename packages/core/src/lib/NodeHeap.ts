/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import type { AnyValue, IHeapSnapshot } from './Types';

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

export function tagObject(o: AnyObject, tag: string): AnyObject {
  if (!store.taggedObjects[tag]) {
    store.taggedObjects[tag] = new WeakSet();
  }
  store.taggedObjects[tag].add(o);
  return o;
}

export function dumpNodeHeapSnapshot(): string {
  const file = path.join(fileManager.generateTmpHeapDir(), `nodejs.heapsnapshot`);
  v8.writeHeapSnapshot(file);
  return file;
}

export async function getCurrentNodeHeap(): Promise<IHeapSnapshot> {
  const file = dumpNodeHeapSnapshot();
  const snapshot = await utils.getSnapshotFromFile(file, {buildNodeIdIndex: true});
  fs.unlink(file, () => {});
  return snapshot;
}

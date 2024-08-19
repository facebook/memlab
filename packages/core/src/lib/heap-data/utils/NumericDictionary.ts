/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @lightSyntaxTransform
 * @oncall web_perf_infra
 */

'use strict';

import {Nullable} from '../../Types';

// if the number is larger than this, we will use the slow store
const MAX_FAST_STORE_SIZE = 50_000_000;

type DirectMap = Map<number, number>;
type IndirectMap = Map<number, Nullable<DirectMap>>;

export default class NumericDictionary {
  private useFastStore = true;
  private fastStore: Nullable<DirectMap> = null;
  private slowStore: Nullable<IndirectMap> = null;
  private numberOfShards = 1;

  constructor(size: number) {
    this.useFastStore = size <= MAX_FAST_STORE_SIZE;
    if (this.useFastStore) {
      this.fastStore = new Map();
    } else {
      this.numberOfShards = Math.ceil(size / MAX_FAST_STORE_SIZE);
      this.slowStore = new Map();
    }
  }

  getNumOfShards(): number {
    return this.numberOfShards;
  }

  getShard(key: number): number {
    return Math.floor(key / MAX_FAST_STORE_SIZE);
  }

  has(key: number): boolean {
    if (this.useFastStore) {
      return this.fastStore?.has(key) ?? false;
    } else {
      const shard = this.getShard(key);
      const map = this.slowStore?.get(shard);
      return map?.has(key) ?? false;
    }
  }

  get(key: number): Nullable<number> {
    if (this.useFastStore) {
      return this.fastStore?.get(key) ?? null;
    } else {
      const shard = this.getShard(key);
      const map = this.slowStore?.get(shard);
      return map?.get(key) ?? null;
    }
  }

  set(key: number, value: number): void {
    if (this.useFastStore) {
      this.fastStore?.set(key, value);
    } else {
      const shard = this.getShard(key);
      let map = this.slowStore?.get(shard);
      if (!map) {
        map = new Map();
        this.slowStore?.set(shard, map);
      }
      map.set(key, value);
    }
  }
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @lightSyntaxTransform
 * @oncall memory_lab
 */

'use strict';

// V8's Set has a maximum capacity of 2^24 (16,777,216) elements.
// Chrome M148+ heap snapshots can exceed this, so we shard across
// multiple native Sets keyed by value range.
const DEFAULT_SHARD_CAPACITY = 5_000_000;

export default class NumericSet implements Iterable<number> {
  private shards: Map<number, Set<number>> = new Map();
  private _size = 0;
  private shardCapacity: number;

  constructor(iterable?: Iterable<number>) {
    this.shardCapacity = DEFAULT_SHARD_CAPACITY;
    if (iterable) {
      for (const value of iterable) {
        this.add(value);
      }
    }
  }

  private getShardKey(value: number): number {
    return Math.floor(value / this.shardCapacity);
  }

  add(value: number): this {
    const shardKey = this.getShardKey(value);
    let shard = this.shards.get(shardKey);
    if (!shard) {
      shard = new Set();
      this.shards.set(shardKey, shard);
    }
    const prevSize = shard.size;
    shard.add(value);
    if (shard.size > prevSize) {
      this._size++;
    }
    return this;
  }

  has(value: number): boolean {
    const shard = this.shards.get(this.getShardKey(value));
    return shard?.has(value) ?? false;
  }

  delete(value: number): boolean {
    const shard = this.shards.get(this.getShardKey(value));
    if (shard?.delete(value)) {
      this._size--;
      return true;
    }
    return false;
  }

  get size(): number {
    return this._size;
  }

  forEach(
    callback: (value: number, value2: number, set: NumericSet) => void,
  ): void {
    for (const shard of this.shards.values()) {
      for (const value of shard) {
        callback(value, value, this);
      }
    }
  }

  clear(): void {
    this.shards.clear();
    this._size = 0;
  }

  *[Symbol.iterator](): Iterator<number> {
    for (const shard of this.shards.values()) {
      yield* shard;
    }
  }
}

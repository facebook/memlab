/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {AnyValue} from '../core/types';

const globalScope: typeof globalThis =
  typeof window !== 'undefined' ? window : self;

const _weakMap: typeof WeakMap<AnyValue, AnyValue> | null =
  globalScope.WeakMap ?? null;
const _weakMapIsNative: boolean = isWeakMapNative();
const _weakSet: typeof WeakSet<AnyValue> | null = globalScope.WeakSet ?? null;
const _weakSetIsNative: boolean = isWeakSetNative();
const _weakRef: typeof WeakRef<AnyValue> | null = globalScope.WeakRef ?? null;
const _weakRefIsNative: boolean = isWeakRefNative();
const _weakAPIsAreNative: boolean =
  _weakMapIsNative && _weakSetIsNative && _weakRefIsNative;

export class WeakRefNoOp<T extends object | ReadonlyArray<unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_targetObject: T) {
    // to be overridden
  }
  deref(): T | undefined {
    return undefined;
  }
}

export class WeakSetNoOp<T extends object | ReadonlyArray<unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_iterable?: Iterable<T> | null) {
    // to be overridden
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  add(_value: T): this {
    return this;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  delete(_value: T): boolean {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  has(_value: T): boolean {
    return false;
  }
}

export class WeakMapNoOp<K extends object | ReadonlyArray<unknown>, V> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_iterable?: Iterable<[K, V]> | null) {
    // to be overridden
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  delete(_key: K): boolean {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  get(_key: K): V | undefined {
    return undefined;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  has(_key: K): boolean {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  set(_key: K, _value: V): this {
    return this;
  }
}

export type WeakMapOrNoOp<TK extends object, TV> =
  | WeakMap<TK, TV>
  | WeakMapNoOp<TK, TV>;
export type WeakSetOrNoOp<T extends object> = WeakSet<T> | WeakSetNoOp<T>;
export type WeakRefOrNoOp<T extends object> = WeakRef<T> | WeakRefNoOp<T>;

export type WeakMapOrFallback = typeof WeakMap | typeof WeakMapNoOp;
export type WeakSetOrFallback = typeof WeakSet | typeof WeakSetNoOp;
export type WeakRefOrFallback = typeof WeakRef | typeof WeakRefNoOp;

export function getNativeWeakMap(): typeof WeakMap | null {
  return _weakMapIsNative ? _weakMap : null;
}

export function getNativeWeakMapOrFallback(): WeakMapOrFallback {
  return _weakMapIsNative && _weakMap ? _weakMap : WeakMapNoOp;
}

export function getNativeWeakSet(): typeof WeakSet | null {
  return _weakSetIsNative ? _weakSet : null;
}

export function getNativeWeakSetOrFallback(): WeakSetOrFallback {
  return _weakSetIsNative && _weakSet ? _weakSet : WeakSetNoOp;
}

export function getNativeWeakRef(): typeof WeakRef | null {
  return _weakRefIsNative ? _weakRef : null;
}

export function getNativeWeakRefOrFallback(): WeakRefOrFallback {
  return _weakRefIsNative && _weakRef ? _weakRef : WeakRefNoOp;
}

function normalize(input: string): string | null {
  return typeof input.replace === 'function'
    ? input.replace(/\n/g, ' ').replace(/\s+/g, ' ')
    : null;
}

export function isWeakMapNative(): boolean {
  return (
    _weakMap !== null &&
    typeof _weakMap.toString === 'function' &&
    normalize(_weakMap.toString()) === 'function WeakMap() { [native code] }'
  );
}

export function isWeakSetNative(): boolean {
  return (
    _weakSet !== null &&
    typeof _weakSet.toString === 'function' &&
    normalize(_weakSet.toString()) === 'function WeakSet() { [native code] }'
  );
}

export function isWeakRefNative(): boolean {
  return (
    _weakRef !== null &&
    typeof _weakRef.toString === 'function' &&
    normalize(_weakRef.toString()) === 'function WeakRef() { [native code] }'
  );
}

export function isWeakAPINative(): boolean {
  return _weakAPIsAreNative;
}

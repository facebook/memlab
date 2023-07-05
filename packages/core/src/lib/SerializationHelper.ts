/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {
  IHeapNode,
  IHeapSnapshot,
  ISerializationHelper,
  ISerializedInfo,
  JSONifyArgs,
  JSONifyOptions,
  Nullable,
} from './Types';

import {setInternalValue} from './InternalValueSetter';
import constants from './Constant';

export class SerializationHelper implements ISerializationHelper {
  protected snapshot: Nullable<IHeapSnapshot> = null;

  setSnapshot(snapshot: IHeapSnapshot): void {
    this.snapshot = snapshot;
  }

  createOrMergeWrapper(
    info: ISerializedInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _node: IHeapNode,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _args: JSONifyArgs,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: JSONifyOptions,
  ): ISerializedInfo {
    return info;
  }
}

export default setInternalValue(
  SerializationHelper,
  __filename,
  constants.internalDir,
);

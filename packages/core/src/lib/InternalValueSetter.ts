/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import fs from 'fs';
import path from 'path';

/** @internal */
export abstract class InternalValueSetter<T> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  fillIn(_module: T): T {
    throw new Error('InternalValueSetter.fillIn is not implemented');
  }
}

/** @internal */
export function setInternalValue<T>(
  value: T,
  callerFilePath: string,
  internalFolderName: string,
): T {
  const callerDir = path.dirname(callerFilePath);
  const callerFile = path.basename(callerFilePath);
  const internalDir = path.join(callerDir, internalFolderName);
  const internalModulePath = path.join(internalDir, callerFile);
  if (!fs.existsSync(internalModulePath)) {
    return value;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const module = require(internalModulePath);
  const Constructor =
    typeof module.default === 'function' ? module.default : module;

  const setter = new Constructor();
  if (typeof setter.fillIn !== 'function') {
    return value;
  }
  const valueSetter = setter as InternalValueSetter<T>;
  return valueSetter.fillIn(value);
}

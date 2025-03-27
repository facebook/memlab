/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import {AnyValue, MemLabConfig, fileManager, utils} from '@memlab/core';
import {existsSync} from 'fs-extra';

export function validateHeapSnapshotFileOrThrow(file: AnyValue): string {
  if (typeof file !== 'string') {
    throw utils.haltOrThrow(
      `Heap snapshot file must be a string, but got ${typeof file}`,
    );
  }
  if (!file.endsWith('.heapsnapshot')) {
    throw utils.haltOrThrow(
      `Heap snapshot file must end with .heapsnapshot, but got ${file}`,
    );
  }
  if (!existsSync(file)) {
    throw utils.haltOrThrow(`Heap snapshot file ${file} does not exist`);
  }
  return file;
}

export function createTransientWorkDirFromSingleHeapSnapshot(
  file: string,
): string {
  const config = MemLabConfig.resetConfigWithTransientDir();
  fileManager.createOrOverrideVisitOrderMetaFileForExternalSnapshot(file);
  return config.workDir;
}

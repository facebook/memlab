/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/** Worker entry for `sidecar-prewarm`: parse one rung, write its sidecar. */

import {parentPort, workerData} from 'node:worker_threads';
import memlabCore from '@memlab/core';
import {
  buildSnapshotIndex,
  normalizeClassName,
  writeSidecar,
} from './snapshot-index.js';

const {sidecarBase, localPath} = workerData as {
  sidecarBase: string;
  localPath: string;
};

try {
  const snapshot = await memlabCore.utils.getSnapshotFromFile(localPath, {
    buildNodeIdIndex: true,
    verbose: false,
  });
  const failure = writeSidecar(
    sidecarBase,
    buildSnapshotIndex(snapshot, sidecarBase, normalizeClassName),
  );
  parentPort?.postMessage(
    failure == null ? {ok: true} : {ok: false, error: failure},
  );
} catch (e) {
  parentPort?.postMessage({ok: false, error: String(e)});
}

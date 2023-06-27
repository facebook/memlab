/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import {analysis, info, utils} from '../..';
import {AnyOptions, IHeapSnapshot, Optional} from '../../lib/Types';

/** @internal */
export async function getFullHeapFromFile(
  file: string,
): Promise<IHeapSnapshot> {
  return await loadProcessedSnapshot({file});
}

async function loadProcessedSnapshot(
  options: AnyOptions & {file?: Optional<string>} = {},
): Promise<IHeapSnapshot> {
  const opt = {buildNodeIdIndex: true, verbose: true};
  const file = options.file || utils.getSnapshotFilePathWithTabType(/.*/);
  const snapshot = await utils.getSnapshotFromFile(file as string, opt);
  analysis.preparePathFinder(snapshot);
  info.flush();
  return snapshot;
}

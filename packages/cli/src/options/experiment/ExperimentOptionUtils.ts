/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {ParsedArgs} from 'minimist';
import type {Nullable} from '@memlab/core';

import fs from 'fs';
import {fileManager} from '@memlab/core';

export function extractAndCheckWorkDirs(
  optionName: string,
  args: ParsedArgs,
): Nullable<string[]> {
  let dirs: string[] = [];
  const flagValue = args[optionName];
  if (!flagValue) {
    return null;
  }
  if (Array.isArray(flagValue)) {
    dirs = flagValue as string[];
  } else {
    dirs = [flagValue] as string[];
  }
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      fileManager.createDefaultVisitOrderMetaFile({
        workDir: dir,
      });
    }
  }
  return dirs;
}

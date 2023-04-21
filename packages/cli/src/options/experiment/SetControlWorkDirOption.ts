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
import type {MemLabConfig, Nullable} from '@memlab/core';

import fs from 'fs';
import {fileManager, BaseOption} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export default class SetControlWorkDirOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.CONTROL_WORK_DIR;
  }

  getDescription(): string {
    return 'set the working directory of the control run';
  }

  protected extractAndCheckWorkDirs(args: ParsedArgs): Nullable<string[]> {
    let dirs: string[] = [];
    const name = this.getOptionName();
    const flagValue = args[name];
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

  async parse(
    config: MemLabConfig,
    args: ParsedArgs,
  ): Promise<{controlWorkDirs?: Nullable<string[]>}> {
    const dirs = this.extractAndCheckWorkDirs(args);
    return {controlWorkDirs: dirs};
  }
}

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
import type {AnyRecord, MemLabConfig} from '@memlab/core';

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

  async parse(
    config: MemLabConfig,
    args: ParsedArgs,
  ): Promise<{controlWorkDir?: string}> {
    const name = this.getOptionName();
    const ret: AnyRecord = {};
    if (args[name]) {
      ret.controlWorkDir = args[name] as string;
      if (fs.existsSync(ret.controlWorkDir)) {
        fileManager.createDefaultVisitOrderMetaFile({
          workDir: ret.controlWorkDir,
        });
      }
    }
    return ret;
  }
}

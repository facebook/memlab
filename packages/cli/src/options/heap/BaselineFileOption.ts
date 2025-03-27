/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {ParsedArgs} from 'minimist';

import fs from 'fs';
import {BaseOption, MemLabConfig, utils} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export default class BaselineFileOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.BASELINE;
  }

  getDescription(): string {
    return 'set file path of the baseline heap snapshot';
  }

  getExampleValues(): string[] {
    return ['/tmp/baseline.heapsnapshot'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const name = this.getOptionName();
    if (!args[name]) {
      return;
    }
    const file = args[name];
    if (!fs.existsSync(file)) {
      utils.haltOrThrow(`Invalid snapshot file: ${file}`);
    }
    config.useExternalSnapshot = true;
    if (!config.externalSnapshotFilePaths) {
      config.externalSnapshotFilePaths = [];
    }
    config.externalSnapshotFilePaths[0] = file;
  }
}

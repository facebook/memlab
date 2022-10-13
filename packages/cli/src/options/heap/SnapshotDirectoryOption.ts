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

import fs from 'fs';
import {BaseOption, MemLabConfig, utils} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export default class SnapshotDirectoryOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.SNAPSHOT_DIR;
  }

  getDescription(): string {
    return 'set directory path containing all heap snapshots under analysis';
  }

  getExampleValues(): string[] {
    return ['/tmp/snapshots/'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const name = this.getOptionName();
    if (!args[name]) {
      return;
    }
    const dir = args[name];
    if (!fs.existsSync(dir)) {
      utils.haltOrThrow(`Invalid directory: ${dir}`);
    }
    config.externalSnapshotDir = dir;
    config.useExternalSnapshot = true;
  }
}

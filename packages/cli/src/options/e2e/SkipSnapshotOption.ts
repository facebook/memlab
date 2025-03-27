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
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export default class SkipSnapshotOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.SKIP_SNAPSHOT;
  }

  getDescription(): string {
    return 'skip taking heap snapshots';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      config.skipSnapshot = true;
    }
  }
}

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

import {BaseOption, MemLabConfig} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export default class CleanupSnapshotOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.CLEAN_UP_SNAPSHOT;
  }

  getDescription(): string {
    return 'clean up heap snapshots after running';
  }

  async parse(
    config: MemLabConfig,
    args: ParsedArgs,
  ): Promise<{cleanUpSnapshot: boolean}> {
    const name = this.getOptionName();
    return {
      cleanUpSnapshot: !!args[name],
    };
  }
}

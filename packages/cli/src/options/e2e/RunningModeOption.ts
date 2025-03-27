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
import {BaseOption, modes} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export default class RunningModeOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.RUN_MODE;
  }

  getDescription(): string {
    return 'set running mode';
  }

  getExampleValues(): string[] {
    return ['regular', 'measure', 'interaction-test'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      config.runningMode = modes.get(args['run-mode'], config);
    }
  }
}

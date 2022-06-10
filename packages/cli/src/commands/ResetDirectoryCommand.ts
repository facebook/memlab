/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {CLIOptions, Optional} from '@memlab/core';

import BaseCommand from '../BaseCommand';
import {fileManager, config, BaseOption} from '@memlab/core';
import SetWorkingDirectoryOption from '../options/SetWorkingDirectoryOption';

export default class ResetDirectoryCommand extends BaseCommand {
  getCommandName(): string {
    return 'reset';
  }

  getDescription(): string {
    return 'reset and initialize all directories';
  }

  getOptions(): BaseOption[] {
    return [new SetWorkingDirectoryOption()];
  }

  async run(options: CLIOptions): Promise<void> {
    const workDir = options.configFromOptions?.workDir as Optional<string>;
    fileManager.rmWorkDir({workDir});
    fileManager.initDirs(config, {workDir});
  }
}

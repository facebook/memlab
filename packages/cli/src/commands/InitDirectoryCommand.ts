/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {CLIOptions, Optional} from '@memlab/core';

import BaseCommand from '../BaseCommand';
import {config, fileManager, BaseOption} from '@memlab/core';
import SetWorkingDirectoryOption from '../options/SetWorkingDirectoryOption';

export default class InitDirectoryCommand extends BaseCommand {
  getCommandName(): string {
    return 'init-dir';
  }

  getDescription(): string {
    return 'initialize all directories';
  }

  isInternalCommand(): boolean {
    return true;
  }

  getOptions(): BaseOption[] {
    return [new SetWorkingDirectoryOption()];
  }

  async run(options: CLIOptions): Promise<void> {
    const workDir = options.configFromOptions?.workDir as Optional<string>;
    fileManager.initDirs(config, {workDir});
  }
}

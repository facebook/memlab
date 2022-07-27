/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {CLIOptions} from '@memlab/core';

import chalk from 'chalk';
import BaseCommand from '../BaseCommand';
import {config, info} from '@memlab/core';

export default class GetVersionCommand extends BaseCommand {
  getCommandName(): string {
    return 'version';
  }

  getDescription(): string {
    return 'Show the versions of all memlab packages installed';
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(options: CLIOptions): Promise<void> {
    const packages = config._packageInfo;
    info.topLevel('');
    for (const pkg of packages) {
      const version = chalk.grey(`@${pkg.version}`);
      info.topLevel(` ${pkg.name}${version}`);
      if (config.verbose && pkg.packageLocation) {
        info.lowLevel(`  ${pkg.packageLocation}`);
      }
    }
    info.topLevel('');
  }
}

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
import {registerPackage as registerPkgAPI} from '@memlab/api';
import {registerPackage as registerPkgCore} from '@memlab/core';
import {registerPackage as registerPkgHeapAnalysis} from '@memlab/heap-analysis';
import {registerPackage as registerPkgE2E} from '@memlab/e2e';

export default class GetVersionCommand extends BaseCommand {
  getCommandName(): string {
    return 'version';
  }

  getDescription(): string {
    return 'Show the versions of all memlab packages installed';
  }

  private async loadDepencyPackageInfo(): Promise<void[]> {
    // require all sub-packages to register package information
    // memlab and cli packages already registered in the bin file
    // the following sub-packages are registered here lazily to
    // avoid too many file operations
    return Promise.all([
      registerPkgAPI(),
      registerPkgCore(),
      registerPkgHeapAnalysis(),
      registerPkgE2E(),
    ]);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(options: CLIOptions): Promise<void> {
    await this.loadDepencyPackageInfo();
    const packages = [...config.packageInfo].sort((p1, p2) =>
      p1.name < p2.name ? 1 : -1,
    );
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

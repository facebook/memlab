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
import {MemLabConfig} from '@memlab/core';

import path from 'path';
import fs from 'fs';
import {info, utils, BaseOption} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export default class SetChromiumBinaryOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.CHROMIUM_BINARY;
  }

  getDescription(): string {
    return 'set the chromium binary for E2E run';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const name = this.getOptionName();
    const arg = args[name];
    if (arg) {
      const binaryPath = path.resolve(process.cwd(), arg);
      if (!fs.existsSync(binaryPath)) {
        throw utils.haltOrThrow(
          `Chromium binary does not exist: ${binaryPath}`,
        );
      }
      if (config.verbose) {
        info.lowLevel(`Using ${binaryPath} as Chromium binary for E2E run`);
      }
      config.puppeteerConfig.executablePath = binaryPath;
    }
  }
}

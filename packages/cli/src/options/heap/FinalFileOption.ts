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
import {OPTION_NAME} from "../constant";

export default class FinalFileOption extends BaseOption {
  getOptionName(): string {
    return OPTION_NAME.FINAL;
  }

  getDescription(): string {
    return 'set file path of the final heap snapshot';
  }

  getExampleValues(): string[] {
    return ['/tmp/final.heapsnapshot'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (!args.final) {
      return;
    }
    const file = args.final;
    if (!fs.existsSync(file)) {
      utils.haltOrThrow(`Invalid snapshot file: ${file}`);
    }
    config.useExternalSnapshot = true;
    if (!config.externalSnapshotFilePaths) {
      config.externalSnapshotFilePaths = [];
    }
    config.externalSnapshotFilePaths[2] = file;
  }
}

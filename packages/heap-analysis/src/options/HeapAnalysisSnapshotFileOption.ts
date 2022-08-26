/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {ParsedArgs} from 'minimist';

import fs from 'fs';
import {BaseOption, MemLabConfig, utils} from '@memlab/core';

export default class HeapAnalysisSnapshotFileOption extends BaseOption {
  getOptionName(): string {
    return 'snapshot';
  }

  getDescription(): string {
    return 'set file path of the heap snapshot under analysis';
  }

  getExampleValues(): string[] {
    return ['/tmp/file.heapsnapshot'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (!args.snapshot) {
      return;
    }
    const file = args.snapshot;
    if (!fs.existsSync(file)) {
      utils.haltOrThrow(`Invalid snapshot file: ${file}`);
    }
    config.useExternalSnapshot = true;
    config.externalSnapshotFilePaths[0] = file;
  }
}

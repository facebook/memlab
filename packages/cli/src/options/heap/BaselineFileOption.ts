/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';

import fs from 'fs';
import {BaseOption, MemLabConfig, utils} from '@memlab/core';

export default class BaselineFileOption extends BaseOption {
  getOptionName(): string {
    return 'baseline';
  }

  getDescription(): string {
    return 'set file path of the baseline heap snapshot';
  }

  getExampleValues(): string[] {
    return ['/tmp/baseline.heapsnapshot'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (!args.baseline) {
      return;
    }
    const file = args.baseline;
    if (!fs.existsSync(file)) {
      utils.haltOrThrow(`Invalid snapshot file: ${file}`);
    }
    config.useExternalSnapshot = true;
    if (!config.externalSnapshotFilePaths) {
      config.externalSnapshotFilePaths = [];
    }
    config.externalSnapshotFilePaths[0] = file;
  }
}

/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';

import fs from 'fs';
import {BaseOption, MemLabConfig, utils} from '@memlab/core';

export default class TargetFileOption extends BaseOption {
  getOptionName(): string {
    return 'target';
  }

  getDescription(): string {
    return 'set file path of the target heap snapshot';
  }

  getExampleValues(): string[] {
    return ['/tmp/target.heapsnapshot'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (!args.target) {
      return;
    }
    const file = args.target;
    if (!fs.existsSync(file)) {
      utils.haltOrThrow(`Invalid snapshot file: ${file}`);
    }
    config.useExternalSnapshot = true;
    if (!config.externalSnapshotFilePaths) {
      config.externalSnapshotFilePaths = [];
    }
    config.externalSnapshotFilePaths[1] = file;
  }
}

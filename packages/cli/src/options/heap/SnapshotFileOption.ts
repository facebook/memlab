/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';

import fs from 'fs';
import {BaseOption, MemLabConfig, utils} from '@memlab/core';

export default class SnapshotFileOption extends BaseOption {
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

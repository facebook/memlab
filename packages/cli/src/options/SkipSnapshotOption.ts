/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class SkipSnapshotOption extends BaseOption {
  getOptionName(): string {
    return 'skip-snapshot';
  }

  getDescription(): string {
    return 'skip taking heap snapshots';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args['skip-snapshot']) {
      config.skipSnapshot = true;
    }
  }
}

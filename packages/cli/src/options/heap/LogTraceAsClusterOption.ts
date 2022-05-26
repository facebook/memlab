/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class LogTraceAsClusterOption extends BaseOption {
  getOptionName(): string {
    return 'save-trace-as-unclassified-cluster';
  }

  getDescription(): string {
    return 'dump each retainer trace as an unclassified trace cluster';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      config.logUnclassifiedClusters = true;
    }
  }
}

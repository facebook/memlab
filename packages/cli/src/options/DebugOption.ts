/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class DebugOption extends BaseOption {
  getOptionName(): string {
    return 'debug';
  }

  getDescription(): string {
    return 'enable manual debugging';
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args['debug']) {
      config.isManualDebug = true;
    }
  }
}

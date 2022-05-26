/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {AnyRecord, MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class SetWorkingDirectoryOption extends BaseOption {
  getOptionName(): string {
    return 'work-dir';
  }

  getDescription(): string {
    return 'set the working directory of the current run';
  }

  async parse(
    config: MemLabConfig,
    args: ParsedArgs,
  ): Promise<{workDir?: string}> {
    const name = this.getOptionName();
    const ret: AnyRecord = {};
    if (args[name]) {
      ret.workDir = args[name];
    }
    return ret;
  }
}

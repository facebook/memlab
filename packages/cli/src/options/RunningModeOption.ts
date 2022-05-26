/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption, modes} from '@memlab/core';

export default class RunningModeOption extends BaseOption {
  getOptionName(): string {
    return 'run-mode';
  }

  getDescription(): string {
    return 'set running mode';
  }

  getExampleValues(): string[] {
    return ['regular', 'measure', 'interaction-test'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args['run-mode']) {
      config.runningMode = modes.get(args['run-mode'], config);
    }
  }
}

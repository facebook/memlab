/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class AppOption extends BaseOption {
  getOptionName(): string {
    return 'app';
  }

  getDescription(): string {
    return 'set name for onboarded web application';
  }

  getExampleValues(): string[] {
    return ['comet', 'ads-manager'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args.app) {
      config.targetApp = Array.isArray(args.app)
        ? args.app[args.app.length - 1]
        : args.app;
    }
  }
}

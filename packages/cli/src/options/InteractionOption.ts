/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class InteractionOption extends BaseOption {
  getOptionName(): string {
    return 'interaction';
  }

  getDescription(): string {
    return 'set name for onboarded interaction';
  }

  getExampleValues(): string[] {
    return ['watch', 'campaign-tab'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args.interaction) {
      config.targetTab = Array.isArray(args.interaction)
        ? args.interaction[args.interaction.length - 1]
        : args.interaction;
    }
  }
}

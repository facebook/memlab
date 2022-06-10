/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
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

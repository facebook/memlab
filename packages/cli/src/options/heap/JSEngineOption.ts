/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';

import {BaseOption, MemLabConfig, constant, utils} from '@memlab/core';

export default class JSEngineOption extends BaseOption {
  getOptionName(): string {
    return 'engine';
  }

  getDescription(): string {
    return 'set the JavaScript engine (default to v8)';
  }

  getExampleValues(): string[] {
    return ['v8', 'hermes'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (!args.engine) {
      return;
    }
    config.jsEngine = args.engine;
    config.specifiedEngine = true;
    if (constant.supportedEngines.indexOf(config.jsEngine) < 0) {
      utils.haltOrThrow(
        `Invalid engine: ${config.jsEngine} ` +
          `(supported engines: ${constant.supportedEngines.join(', ')})`,
      );
    }
  }
}

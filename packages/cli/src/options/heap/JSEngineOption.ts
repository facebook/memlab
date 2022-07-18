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

import {BaseOption, MemLabConfig, constant, utils} from '@memlab/core';

export default class JSEngineOption extends BaseOption {
  getOptionName(): string {
    return 'engine';
  }

  getDescription(): string {
    return 'set the JavaScript engine (default to V8)';
  }

  getExampleValues(): string[] {
    return ['V8', 'hermes'];
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

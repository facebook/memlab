/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {ParsedArgs} from 'minimist';
import {MemLabConfig, utils} from '@memlab/core';

import {BaseOption, TraceObjectMode} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';
import OversizeThresholdOption from './OversizeThresholdOption';

const optionMapping = new Map([
  ['selected-js-objects', TraceObjectMode.SelectedJSObjects],
  ['default', TraceObjectMode.Default],
]);

export default class TraceAllObjectsOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.TRACE_ALL_OBJECTS;
  }

  getDescription(): string {
    return (
      'dump retainer trace for all allocated objects (ignore the leak filter), ' +
      `available option modes: ${this.getAvailableOptions().join(', ')}`
    );
  }

  getAvailableOptions(): Array<string> {
    return Array.from(optionMapping.keys()).map(
      mode => `--${this.getOptionName()}=${mode}`,
    );
  }

  getMode(optionValue: string): TraceObjectMode {
    // if the user specified an option value (--flag=value instead of --flag)
    if (typeof optionValue === 'boolean') {
      return optionMapping.get('default') as TraceObjectMode;
    }
    if (!optionMapping.has(optionValue)) {
      throw utils.haltOrThrow(
        `Unknown option value ${optionValue}. ` +
          `Available options: ${this.getAvailableOptions().join(', ')}`,
      );
    }
    return optionMapping.get(optionValue) as TraceObjectMode;
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const optionValue = args[this.getOptionName()];
    if (optionValue == null) {
      return;
    }
    config.oversizeObjectAsLeak = true;
    const overSizeOptionName = new OversizeThresholdOption().getOptionName();
    // oversize option will set the oversize threshold
    if (!args[overSizeOptionName]) {
      config.oversizeThreshold = 0;
    }
    config.traceAllObjectsMode = this.getMode(optionValue);
  }
}

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
import type {MemLabConfig} from '@memlab/core';
import {BaseOption, utils} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export default class HeapParserDictFastStoreSizeOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.HEAP_PARSER_DICT_FAST_STORE_SIZE;
  }

  getDescription(): string {
    return (
      'the size threshold for swtiching from fast store to slower store in ' +
      'the heap snapshot parser. The default value is 5,000,000. If you get ' +
      'the `FATAL ERROR: invalid table size Allocation failed - JavaScript ' +
      'heap out of memory` error, try to decrease the threshold here'
    );
  }

  getExampleValues(): string[] {
    return ['500000', '1000000'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (this.getOptionName() in args) {
      const sizeThreshold = parseInt(args[this.getOptionName()], 10);
      if (!isNaN(sizeThreshold)) {
        if (sizeThreshold <= 0 || sizeThreshold > 10_000_000) {
          utils.haltOrThrow(
            `Invalid value for ${this.getOptionName()}: ${sizeThreshold}. ` +
              'Valid range is [1, 10_000_000]',
          );
        }
        config.heapParserDictFastStoreSize = sizeThreshold;
      }
    }
  }
}

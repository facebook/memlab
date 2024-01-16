/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */
import type {ParsedArgs} from 'minimist';
import {MemLabConfig} from '@memlab/core';

import {info, utils, BaseOption} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export default class SetChromiumProtocolTimeoutOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.CHROMIUM_PROTOCOL_TIMEOUT;
  }

  getDescription(): string {
    return (
      'set the protocol timeout for chromium connection (in ms). \n' +
      'The current default value is 180000, you may want to increase the ' +
      'timeout via this flag when the heap snapshot is ' +
      'too big (e.g., over 1GB) and the Page crashed with error: ' +
      "'ProtocolError: HeapProfiler.takeHeapSnapshot timed out'."
    );
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const name = this.getOptionName();
    const arg = args[name];
    if (arg) {
      const timeout = parseInt(arg, 10);
      if (Number.isNaN(timeout)) {
        utils.haltOrThrow(
          `Invalid Chromium protocol timeout value: ${arg}. ` +
            'It must be a number.',
        );
      }
      if (config.verbose) {
        info.lowLevel(`Set Chromium protocol timeout to ${timeout}.`);
      }
      config.puppeteerConfig.protocolTimeout = timeout;
    }
  }
}

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
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class SetUserAgentOption extends BaseOption {
  getOptionName(): string {
    return 'user-agent';
  }

  getDescription(): string {
    return (
      'set the UserAgent string in browser (for E2E interaction), ' +
      'otherwise it uses the default UserAgent from Chromium'
    );
  }

  getExampleValues(): string[] {
    return ['"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_2)"'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const optionName = this.getOptionName();
    if (args[optionName]) {
      config.defaultUserAgent = args[optionName];
    }
  }
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {Page} from 'puppeteer';
import {info} from '@memlab/core';
import BaseOperation from './BaseOperation';
import interactUtils from './InteractionUtils';

class WaitOperation extends BaseOperation {
  kind: string;
  timeout: number;

  constructor(timeout: number) {
    super();
    this.kind = 'wait';
    this.timeout = timeout;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async act(_page: Page): Promise<void> {
    info.lowLevel(`wait for ${this.timeout} ms ...`);
    await interactUtils.waitFor(this.timeout);
    return;
  }
}

export default WaitOperation;

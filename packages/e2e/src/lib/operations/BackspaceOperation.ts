/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import BaseOperation from './BaseOperation';
import type {Page} from 'puppeteer';

class BackspaceOperation extends BaseOperation {
  kind: string;

  constructor() {
    super();
    this.kind = 'backspace';
  }

  async act(page: Page): Promise<void> {
    await page.keyboard.press('Backspace');
  }
}

export default BackspaceOperation;

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import {Page} from 'puppeteer';
import BaseOperation from './BaseOperation';

class EnterOperation extends BaseOperation {
  kind: string;
  constructor() {
    super();
    this.kind = 'enter';
  }

  async act(page: Page): Promise<void> {
    await page.keyboard.press('Enter');
  }
}

export default EnterOperation;

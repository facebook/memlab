/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import BaseOperation from './BaseOperation';
import type {Page} from 'puppeteer-core';

export default class EscOperation extends BaseOperation {
  kind: string;

  constructor() {
    super();
    this.kind = 'escape';
  }

  async act(page: Page): Promise<void> {
    await page.keyboard.press('Escape');
  }
}

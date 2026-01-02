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
import {config} from '@memlab/core';

export default class BackOperation extends BaseOperation {
  kind: string;

  constructor() {
    super();
    this.kind = 'back';
  }

  async act(page: Page): Promise<void> {
    page.goBack({timeout: config.presenceCheckTimeout || 120000});
  }
}

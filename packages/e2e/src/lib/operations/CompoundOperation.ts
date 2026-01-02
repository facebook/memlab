/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {Page} from 'puppeteer-core';
import type {E2EOperation} from '@memlab/core';
import BaseOperation from './BaseOperation';

class CompoundOperation extends BaseOperation {
  kind: string;
  protected operations: E2EOperation[];
  constructor(operations = []) {
    super();
    this.kind = 'compound';
    this.operations = operations;
  }

  async act(page: Page): Promise<void> {
    for (const op of this.operations) {
      await op.act(page);
    }
  }
}

export default CompoundOperation;

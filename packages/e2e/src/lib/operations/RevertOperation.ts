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
import EscOperation from './EscOperation';
import type {OperationArgs} from '@memlab/core';
import BackOperation from './BackOperation';
import InteractionUtils from './InteractionUtils';

export default class RevertOperation extends BaseOperation {
  kind: string;

  constructor() {
    super();
    this.kind = 'revert';
  }

  async act(page: Page, opArgs: OperationArgs = {}): Promise<void> {
    let historyLen = opArgs.pageHistoryLength;
    if (Array.isArray(historyLen) && historyLen.length > 1) {
      historyLen = historyLen as number[];
      const len = historyLen.length as number;
      const count = historyLen[len - 1] as number;
      const prevCount = historyLen[len - 2] as number;
      let navCountFromPreviousOp = (count | 0) - (prevCount | 0);
      if (navCountFromPreviousOp > 0) {
        while (navCountFromPreviousOp > 0) {
          await new BackOperation().act(page);
          await InteractionUtils.waitFor(2000);
          --navCountFromPreviousOp;
        }
        return;
      }
    }
    await new EscOperation().act(page);
  }
}

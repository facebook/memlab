/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {Page} from 'puppeteer-core';

import {utils} from '@memlab/core';
import BaseOperation from './BaseOperation';
import interactUtils from './InteractionUtils';

type WaitForOptions = {
  waitForElementTo?: string;
};

/**
 * This operation waits for an element matching the given selector. It only
 * fails if the given selector does not come to exist within the timeout
 * specified in `checkIfPresent`. If you want to invert this behavior and wait
 * for it to disappear, pass the option `{waitForElementTo: 'disappear'}`.
 * Furthermore, if you want to ensure that the element not only comes to exist
 * but is visible (ie. neither `display:none` nor `visibility:hidden`) then pass
 * the option `{waitForElementTo: 'appear'}`.
 */
class WaitForElementOperation extends BaseOperation {
  kind: string;
  selector: string;
  waitForElementTo: string;

  constructor(selector: string, options: WaitForOptions = {}) {
    super();
    this.kind = 'wait-for-element';
    this.selector = selector;
    this.waitForElementTo = options.waitForElementTo || 'exist';
  }

  async act(page: Page): Promise<void> {
    this.log(`Waiting for \`${this.selector}\` to ${this.waitForElementTo}`);
    const waitForElementTo = this.waitForElementTo;
    switch (waitForElementTo) {
      case 'appear':
        if (!(await interactUtils.checkIfVisible(page, this.selector))) {
          utils.haltOrThrow(
            `Element \`${this.selector}\` did not become visible`,
          );
        }
        break;
      case 'exist':
        if (!(await interactUtils.checkIfPresent(page, this.selector))) {
          utils.haltOrThrow(`Cannot find element \`${this.selector}\``);
        }
        break;
      case 'disappear':
        if (!(await interactUtils.waitForDisappearance(page, this.selector))) {
          utils.haltOrThrow(`Element \`${this.selector}\` did not disappear`);
        }
        break;
    }
  }
}

export default WaitForElementOperation;

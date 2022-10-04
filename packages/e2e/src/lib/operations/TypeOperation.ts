/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import {Page} from 'puppeteer';
import {config} from '@memlab/core';
import BaseOperation from './BaseOperation';
import ClickOperation from './ClickOperation';
import interactUtils from './InteractionUtils';

type TypeOptions = {
  randomSuffix?: boolean;
  clear?: boolean;
  delay?: number;
};

class TypeOperation extends BaseOperation {
  kind: string;
  selector: string;
  inputText: string;
  clear: boolean;
  randomSuffix: boolean;
  delay: number;

  constructor(selector: string, inputText: string, args: TypeOptions = {}) {
    super();
    this.kind = 'type';
    this.selector = selector;
    this.inputText = inputText;
    this.clear = !!args.clear;
    this.randomSuffix = !!args.randomSuffix;
    this.delay = args.delay ?? 0;
  }

  private async clearInput(page: Page): Promise<void> {
    const click = new ClickOperation(this.selector, {clickCount: 3});
    await click.act(page);
    await page.keyboard.press('Backspace');
    await interactUtils.waitFor(100);
  }

  async act(page: Page): Promise<void> {
    if (this.clear) {
      await this.clearInput(page);
      await interactUtils.waitFor(2000);
    }
    const suffix = this.randomSuffix ? `${Math.random()}` : '';
    const textToType = this.inputText + suffix;
    this.log(`Typing "${textToType}"`);
    await page.type(this.selector, textToType, {delay: 100});
    await interactUtils.waitFor(config.waitAfterTyping);
    if (this.delay > 0) {
      await interactUtils.waitFor(this.delay);
    }
  }
}

export default TypeOperation;

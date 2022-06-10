/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {Page} from 'puppeteer';
import type {AnyOptions, Optional} from '@memlab/core';

import {info, config, utils} from '@memlab/core';
import BaseOperation from './BaseOperation';
import interactUtils from './InteractionUtils';

type PageFunction = (page: Page) => Promise<void>;
type IfPageFunction = (page: Page) => Promise<boolean>;

class ClickOperation extends BaseOperation {
  kind: string;
  selector: string;
  delay: Optional<number>;
  waitFor: Optional<string | PageFunction>;
  clickCount: Optional<number>;
  indexInMatches: Optional<number>;
  if: Optional<string | IfPageFunction>;

  constructor(
    selector: string,
    args: AnyOptions & {
      delay?: number;
      waitFor?: string | PageFunction;
      clickCount?: number;
      indexInMatches?: number;
      if?: string | IfPageFunction;
    } = {},
  ) {
    super();
    this.kind = 'click';
    this.selector = selector;
    this.delay = args.delay;
    this.optional = !!args.optional;
    this.waitFor = args.waitFor;
    this.clickCount = args.clickCount;
    this.indexInMatches = args.indexInMatches;
    // Takes a selector (string) to check if the selector is present or takes
    // a function and evaluates that function to conditionally do the click
    // operation
    this.if = args.if;
  }

  async _shouldClick(page: Page): Promise<boolean> {
    if (this.if == null) {
      return true;
    }

    let shouldClick: boolean;
    if (typeof this.if === 'string') {
      const element = await page.$(this.if);
      shouldClick = !!element;
      if (element != null) {
        await element.dispose();
      }
    } else if (typeof this.if === 'function') {
      shouldClick = await this.if(page);
    } else {
      throw utils.haltOrThrow(
        `ClickOperation: 'if' must be a string or function`,
      );
    }
    return shouldClick;
  }

  private useContains(): boolean {
    return this.selector.startsWith('contains:');
  }

  // click element with specified settings
  private async clickElement(page: Page): Promise<void> {
    const clickCount = this.clickCount || 1;

    if (!this.useContains() && this.indexInMatches == null) {
      await page.click(this.selector, {clickCount});
      return;
    }

    let elems;
    // if given a special contains-text selector
    if (this.useContains()) {
      const text = this.selector.slice('contains:'.length);
      elems = await interactUtils.getElementsContainingText(page, text);
    } else {
      elems = await page.$$(this.selector);
    }

    if (!elems || elems.length === 0) {
      utils.haltOrThrow(`selector not found: ${this.selector}`);
    }

    let idx = this.indexInMatches != null ? this.indexInMatches : 0;
    if (idx < 0) {
      idx = elems.length + idx;
    }
    if (idx < 0 || idx >= elems.length) {
      utils.haltOrThrow(`clicking ${idx + 1}-th element, which doesn't exist`);
    }
    await elems[idx].click({clickCount});
    await Promise.all(elems.map(e => e.dispose()));
  }

  async act(page: Page): Promise<void> {
    const shouldClick = await this._shouldClick(page);
    if (!shouldClick) {
      return;
    }

    const present = await interactUtils.checkIfPresent(
      page,
      this.selector,
      this.optional,
    );
    if (!present) {
      if (!this.optional) {
        utils.haltOrThrow(`Cannot find element ${this.selector}`);
      }
      return; // if optional element is not found
    }

    this.log(`clicking ${this.selector}`);
    await this.clickElement(page);

    // extra delay
    const delay =
      this.delay != null ? this.delay : config.defaultAfterClickDelay;
    await interactUtils.waitFor(delay);

    // waiting for elements
    if (this.waitFor != null) {
      if (typeof this.waitFor === 'string') {
        await interactUtils.waitForSelector(
          page,
          this.waitFor,
          'exist',
          this.optional,
        );
      } else if (typeof this.waitFor === 'function') {
        await this.waitFor(page);
      } else {
        info.error(`ClickOperation: 'waitFor' must be a string or function`);
      }
    }
  }
}

export default ClickOperation;

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
import type {OperationArgs} from '@memlab/core';
import {config, info} from '@memlab/core';
import BaseOperation from './BaseOperation';
import interactUtils from './InteractionUtils';

type ScrollOptions = {
  scrollUp?: boolean;
  scrollBack?: boolean;
};

class ScrollOperation extends BaseOperation {
  kind: string;
  strideLength: number;
  repeat: number;
  scrollDirection: number;
  scrollBack: boolean;
  constructor(strideLength: number, repeat = 1, opt: ScrollOptions = {}) {
    super();
    this.kind = 'scroll';
    this.strideLength = strideLength;
    this.repeat = repeat;
    // by default scroll down (1 means down, -1 means up)
    this.scrollDirection = opt.scrollUp ? -1 : 1;
    // by default scrollback to the beginning
    this.scrollBack =
      typeof opt.scrollBack === 'boolean' ? opt.scrollBack : true;
  }

  async act(page: Page, opArgs: OperationArgs = {}): Promise<void> {
    if (config.disableScroll || !config.runningMode.shouldScroll()) {
      return;
    }
    let repeat = this.repeat;
    let i = 0;
    let totalScrollDistance = 0;
    const direction = this.scrollDirection > 0 ? 'down' : 'up';
    info.lowLevel(`scrolling ${direction} ${repeat} times...`);
    const strideLength = this.scrollDirection * this.strideLength;
    while (repeat-- > 0) {
      totalScrollDistance += strideLength;
      await scroll(page, strideLength, ++i, opArgs);
    }
    if (this.scrollBack && totalScrollDistance > 0) {
      // scroll back to the top
      await scroll(page, -1 * totalScrollDistance, -1, opArgs);
    }
    return;
  }
}

async function scroll(
  page: Page,
  dist: number,
  idx = 0,
  opArgs: OperationArgs,
) {
  info.beginSection('scroll');
  await interactUtils.waitUntilLoaded(page, opArgs);
  if (idx > 1) {
    info.overwrite(`(${idx}x) scrolling ${dist}px...`);
  } else {
    info.overwrite(`scrolling ${dist}px...`);
  }

  await page.evaluate(dist => {
    try {
      window.scrollBy({top: dist});
    } catch (_e) {
      // to nothing
    }
  }, dist);
  await interactUtils.waitUntilLoaded(page, opArgs);
  await interactUtils.waitFor(config.waitAfterScrolling);
  info.endSection('scroll');
}

export default ScrollOperation;

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
import {config, utils} from '@memlab/core';
import type {Optional} from '@memlab/core';
import BaseOperation from './BaseOperation';
import interactUtils from './InteractionUtils';

type HoverOptions = {
  delay?: number;
  optional?: boolean;
  indexInMatches?: number;
};

class HoverOperation extends BaseOperation {
  kind: string;
  selector: string;
  delay: Optional<number>;
  indexInMatches: Optional<number>;
  constructor(selector: string, args: HoverOptions = {}) {
    super();
    this.kind = 'hover';
    this.selector = selector;
    this.delay = args.delay;
    this.optional = !!args.optional;
    this.indexInMatches = args.indexInMatches;
  }

  // hover over element with specified settings
  private async hoverOverElement(page: Page): Promise<void> {
    if (this.indexInMatches == null) {
      await page.hover(this.selector);
      return;
    }

    const elems = await page.$$(this.selector);

    if (!elems || elems.length === 0) {
      utils.haltOrThrow(`selector not found: ${this.selector}`);
    }

    let idx = this.indexInMatches;
    if (idx < 0) {
      idx = elems.length + idx;
    }
    if (idx < 0 || idx >= elems.length) {
      utils.haltOrThrow(
        `hovering over ${idx + 1}-th element, which doesn't exist`,
      );
    }
    await elems[idx].hover();
    await Promise.all(elems.map(e => e.dispose()));
  }

  async act(page: Page): Promise<void> {
    const present = await interactUtils.checkIfPresent(page, this.selector);
    if (!present && !this.optional) {
      utils.haltOrThrow(`Cannot find element ${this.selector}`);
    }

    if (present) {
      this.log(`hovering over ${this.selector}`);
      await this.hoverOverElement(page);
      const delay =
        this.delay != null ? this.delay : config.defaultAfterClickDelay;
      await interactUtils.waitFor(delay);
    }
  }
}

export default HoverOperation;

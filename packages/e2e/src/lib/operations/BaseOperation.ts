/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import {info, config} from '@memlab/core';
import interactUtils from './InteractionUtils';

import type {Page} from 'puppeteer';
import type {E2EOperation, OperationArgs} from '@memlab/core';

let opId = 1; // operation index used in debug mode

abstract class BaseOperation implements E2EOperation {
  public kind: string;
  public selector: string;
  protected optional = false;

  constructor() {
    this.kind = 'abstract';
    this.selector = '';
  }

  protected log(msg: string): void {
    if (config.verbose) {
      info.lowLevel(msg);
    } else {
      info.overwrite(msg);
    }
  }

  async do(page: Page, opArgs: OperationArgs = {}): Promise<void> {
    if (config.verbose && config.runningMode.shouldTakeScreenShot()) {
      await interactUtils.screenshot(page, `${++opId}-${this.kind}`);
    }
    if (this.selector !== '') {
      await interactUtils.waitForSelector(
        page,
        this.selector,
        'exist',
        this.optional,
      );
    }
    await this.act(page, opArgs);
    const isPageLoaded = opArgs.isPageLoaded;
    await interactUtils.waitUntilLoaded(page, {
      isPageLoaded,
      noWaitAfterPageLoad: true,
    });
    await interactUtils.waitFor(config.waitAfterOperation);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async act(_page: Page, _opArgs: OperationArgs = {}): Promise<void> {
    const error = new Error('BaseOperation.act can not be called.');
    error.stack;
    throw error;
  }
}

export default BaseOperation;

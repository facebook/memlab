/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */
import {Page} from 'puppeteer';
import {info, utils} from '@memlab/core';
import type {AnyFunction, AnyOptions, AnyValue} from '@memlab/core';
import BaseOperation from './BaseOperation';
import interactUtils from './InteractionUtils';

// Run a JS callback in web console
class RunJSCode extends BaseOperation {
  kind: string;
  private callback: AnyFunction;
  private repeat: number;
  private args: AnyValue[];

  constructor(
    callback: AnyFunction,
    opt: AnyOptions & {repeat?: number; args?: AnyValue[]} = {},
  ) {
    super();
    this.kind = 'run-js-code';
    this.callback = callback;
    this.repeat = opt.repeat != null && opt.repeat > 0 ? opt.repeat : 1;
    this.args = opt.args || [];
  }

  async act(page: Page): Promise<void> {
    try {
      let n = this.repeat;
      while (n-- > 0) {
        await page.evaluate(this.callback, ...this.args);
        await interactUtils.waitFor(1000);
      }
    } catch (e) {
      info.warning(utils.getError(e).message);
    }
  }
}

export default RunJSCode;

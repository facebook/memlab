/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {Page} from 'puppeteer';

import path from 'path';
import {config, utils} from '@memlab/core';
import BaseOperation from './BaseOperation';
import interactUtils from './InteractionUtils';

type UploadOptions = {
  delay?: number;
  file: string;
};

class UploadOperation extends BaseOperation {
  kind: string;
  selector: string;
  delay: number;
  file: string;

  constructor(selector: string, args: UploadOptions) {
    super();
    this.kind = 'upload';
    this.selector = selector;
    this.delay = args.delay ?? 0;
    this.file = path.join(config.inputDataDir, args.file);
  }

  async act(page: Page): Promise<void> {
    this.log(`uploading file ${this.file}...`);

    const uploadHandle = await page.$(this.selector);
    if (!uploadHandle) {
      throw utils.haltOrThrow(
        `upload failed, selector not found: ${this.selector}`,
      );
    }
    await uploadHandle.uploadFile(this.file);
    await page.evaluate(upload => {
      upload.dispatchEvent(new Event('change', {bubbles: true}));
    }, uploadHandle);
    await interactUtils.waitFor(2000);
    await uploadHandle.dispose();

    if (this.delay > 0) {
      await interactUtils.waitFor(this.delay);
    }
  }
}

export default UploadOperation;

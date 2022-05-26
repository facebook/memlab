/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */

import type {Page} from 'puppeteer';
import {config, ErrorHandling} from '@memlab/core';

export const testTimeout = 5 * 60 * 1000;

export const defaultAnalysisArgs = {args: {_: []}};

export const scenario = {
  app: (): string => 'test-spa',
  url: (): string => '',
  action: async (page: Page): Promise<void> =>
    await page.click('[data-testid="link-4"]'),
};

export const testSetup = (): void => {
  config.isTest = true;
  config.useXVFB = false;
  config.skipExtraOps = true;
  config.errorHandling = ErrorHandling.Throw;
};

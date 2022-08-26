/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {
  AnyOptions,
  CheckPageLoadCallback,
  IE2EScenarioVisitPlan,
  IE2EStepBasic,
} from '@memlab/core';
import path from 'path';
import type {Page} from 'puppeteer';
import BaseSynthesizer from '../BaseSynthesizer';
import ClickOperation from '../lib/operations/ClickOperation';
import interactUtils from '../lib/operations/InteractionUtils';

export default class TestSPAVisitSynthesizer extends BaseSynthesizer {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/explicit-module-boundary-types
  getBaseURL(_options: AnyOptions = {}) {
    const indexFile = path.join(
      __dirname,
      '..',
      '..',
      'static',
      'links',
      'index.html',
    );
    return `file://${indexFile}`;
  }

  getAppName(): string {
    return 'test-spa';
  }

  getNumberOfWarmup(): number {
    return 1;
  }

  getCookieFile(): string | null {
    return null;
  }

  getDomain(): string {
    return 'test.com';
  }

  getAvailableSteps(): IE2EStepBasic[] {
    const steps = [];
    for (let i = 1; i <= 8; ++i) {
      steps.push({
        name: `link-${i}`,
        url: '',
        interactions: [new ClickOperation(`[data-testid="link-${i}"]`)],
      });
    }
    return steps;
  }

  getDefaultStartStepName(): string {
    return 'link-1';
  }

  getAvailableVisitPlans(): IE2EScenarioVisitPlan[] {
    const plans = [this.synthesis('link-2', 'link-3', ['link-4'])];
    return plans;
  }

  getPageLoadChecker(): CheckPageLoadCallback {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return async (_page: Page) => {
      await interactUtils.waitFor(200);
      return true;
    };
  }
}

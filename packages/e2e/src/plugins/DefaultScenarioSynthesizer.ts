/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {
  AnyOptions,
  CheckPageLoadCallback,
  IE2EScenarioVisitPlan,
  IE2EStepBasic,
} from '@memlab/core';
import type {Page} from 'puppeteer';
import BaseSynthesizer from '../BaseSynthesizer';
import interactUtils from '../lib/operations/InteractionUtils';
import E2EUtils from '../lib/E2EUtils';

export default class DefaultScenarioSynthesizer extends BaseSynthesizer {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getBaseURL(_options: AnyOptions = {}): string {
    return '';
  }

  getAppName(): string {
    return E2EUtils.getScenarioAppName();
  }

  getNumberOfWarmup(): number {
    return 1;
  }

  getCookieFile(): string | null {
    return null;
  }

  getDomain(): string {
    return '';
  }

  getAvailableSteps(): IE2EStepBasic[] {
    return [];
  }

  getDefaultStartStepName(): string {
    return '';
  }

  getAvailableVisitPlans(): IE2EScenarioVisitPlan[] {
    return [];
  }

  getPageLoadChecker(): CheckPageLoadCallback {
    return async (page: Page) => {
      await interactUtils.waitFor(500);
      await page.waitForNavigation({
        waitUntil: 'networkidle0',
        timeout: this.config.waitForNetworkInDefaultScenario,
      });
      return true;
    };
  }
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import BaseMode from './BaseMode';
import fs from 'fs';
import path from 'path';

import type {Page} from 'puppeteer';
import type {E2EStepInfo, IE2EScenarioVisitPlan} from '../lib/Types';

// mode for running quick measurement or experiments
class MeasureMode extends BaseMode {
  shouldTakeScreenShot(): boolean {
    return false;
  }

  shouldTakeHeapSnapshot(): boolean {
    return false;
  }

  shouldExtraWaitForTarget(): boolean {
    return false;
  }

  shouldExtraWaitForFinal(): boolean {
    return false;
  }

  shouldRunExtraTargetOperations(): boolean {
    return false;
  }

  async getAdditionalMetrics(page: Page): Promise<E2EStepInfo['metrics']> {
    // number of DOM elements on the page
    const numDOMElements = await page.evaluate(
      () => document.getElementsByTagName('*').length,
    );
    return {numDOMElements};
  }

  postProcessData(visitPlan: IE2EScenarioVisitPlan): void {
    const filename = `metrics-${Date.now()}-${process.pid}.json`;
    const filepath = path.join(this.config.metricsOutDir, filename);
    const content = JSON.stringify(visitPlan.tabsOrder, null, 2);
    fs.writeFileSync(filepath, content, 'UTF-8');
  }
}

export default MeasureMode;

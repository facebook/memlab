/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import type {
  E2EStepInfo,
  Config,
  IE2EScenarioVisitPlan,
  Optional,
} from '../lib/Types';
import type {Page} from 'puppeteer';
import defaultConfig from '../lib/Config';

// the regular mode for conventional MemLab runs
class BaseMode {
  protected config: Config = defaultConfig;
  protected visitPlan: Optional<IE2EScenarioVisitPlan>;
  setConfig(config: Config): void {
    this.config = config;
  }

  beforeRunning(visitPlan: IE2EScenarioVisitPlan): void {
    this.visitPlan = visitPlan;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  shouldGC(_tabInfo?: E2EStepInfo): boolean {
    return !this.config.skipGC;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  shouldScroll(_tabInfo?: E2EStepInfo): boolean {
    return !this.config.skipScroll;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  shouldGetMetrics(_tabInfo?: E2EStepInfo): boolean {
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  shouldUseConciseConsole(_tabInfo?: E2EStepInfo): boolean {
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  shouldTakeScreenShot(_tabInfo?: E2EStepInfo): boolean {
    return !this.config.skipScreenshot;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  shouldTakeHeapSnapshot(_tabInfo?: E2EStepInfo): boolean {
    return !this.config.skipSnapshot;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  shouldExtraWaitForTarget(_tabInfo?: E2EStepInfo): boolean {
    if (this.visitPlan && this.visitPlan.type === 'repeat') {
      return false;
    }
    return !this.config.skipExtraOps;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  shouldExtraWaitForFinal(_tabInfo?: E2EStepInfo): boolean {
    if (this.visitPlan && this.visitPlan.type === 'repeat') {
      return false;
    }
    return !this.config.skipExtraOps;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  shouldRunExtraTargetOperations(_tabInfo?: E2EStepInfo): boolean {
    if (this.visitPlan && this.visitPlan.type === 'repeat') {
      return false;
    }
    return !this.config.skipExtraOps;
  }

  async getAdditionalMetrics(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _page: Page,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _tabInfo?: E2EStepInfo,
  ): Promise<E2EStepInfo['metrics']> {
    return {};
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  postProcessData(_visitPlan: IE2EScenarioVisitPlan): void {
    // for overriding
  }
}

export default BaseMode;

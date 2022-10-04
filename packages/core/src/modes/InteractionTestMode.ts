/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import BaseMode from './BaseMode';

// mode for running quick interaction test
class InteractionTestMode extends BaseMode {
  shouldGC(): boolean {
    return false;
  }

  shouldScroll(): boolean {
    return false;
  }

  shouldGetMetrics(): boolean {
    return false;
  }

  shouldUseConciseConsole(): boolean {
    return true;
  }

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
}

export default InteractionTestMode;

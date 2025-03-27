/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {config} from '@memlab/core';
import BaseOperation from './BaseOperation';
import CompoundOperation from './CompoundOperation';
import ScrollOperation from './ScrollOperation';

class TargetExtraOperation extends CompoundOperation {
  kind: string;
  operations: BaseOperation[];
  constructor(operations = []) {
    super(operations);
    this.kind = 'target-extra';

    if (config.runningMode.shouldRunExtraTargetOperations()) {
      // scroll the window by certain amount of pixels
      this.operations.push(
        new ScrollOperation(config.windowHeight, config.scrollRepeat),
      );
    }
  }
}

export default TargetExtraOperation;

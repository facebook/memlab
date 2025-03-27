/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import BackOperation from './operations/BackOperation';
import RevertOperation from './operations/RevertOperation';

const backStep = {
  name: 'back',
  url: '',
  interactions: [new BackOperation()],
};

const revertStep = {
  name: 'revert',
  url: '',
  interactions: [new RevertOperation()],
};

export default {
  backStep,
  revertStep,
};

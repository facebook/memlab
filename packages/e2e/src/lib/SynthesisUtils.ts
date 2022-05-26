/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
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

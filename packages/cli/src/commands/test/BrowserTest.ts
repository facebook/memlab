/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {Command, Nullable} from '@memlab/core';

import {config, ProcessManager, modes} from '@memlab/core';
import {defaultTestPlanner} from '@memlab/e2e';

let curTarget = 0;

function getCommand(app: string, interaction: string): Command {
  const cmd = `memlab`;
  const args = [
    'quick-interaction-test-single',
    `--app=${app}`,
    `--interaction=${interaction}`,
  ];
  const options = {msg: [cmd, ...args].join(' ')};
  return [cmd, args, options];
}

function nextCommand(): Nullable<Command> {
  const targets = defaultTestPlanner.getAllTargets();
  // we've started all tasks in process
  if (curTarget === targets.length) {
    return null;
  }
  const target = targets[curTarget++];
  // @ts-expect-error unnecessary arg
  return getCommand(target.app, target.interaction, target.warmup);
}

export function startInteractionTests(): void {
  config.runningMode = modes.get('interaction-test');
  const procManager = new ProcessManager();
  procManager.start(nextCommand);
}

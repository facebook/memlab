/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import {config, info, utils} from '@memlab/core';
import {testInBrowser} from '@memlab/api';

export async function runPageInteractionFromCLI(): Promise<void> {
  const start = Date.now();
  try {
    await testInBrowser();
  } catch (e) {
    const error = utils.getError(e);
    if (error.message.indexOf('cannot open display') < 0) {
      // fail due to other errors
      utils.haltOrThrow(error);
    }
    if (config.verbose) {
      info.lowLevel('failed to start Chrome with display, disabling xvfb...');
    }
    config.machineSupportsXVFB = false;
    config.disableXvfb();
    await testInBrowser();
  }

  const end = Date.now();
  info.topLevel(`total time: ${utils.getReadableTime(end - start)}`);
}

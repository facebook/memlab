/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import minimist, {ParsedArgs} from 'minimist';
import {utils} from '@memlab/core';
import commandDispatcher from './Dispatcher';

async function run(): Promise<void> {
  const argv: ParsedArgs = minimist(process.argv.slice(2));
  commandDispatcher.dispatch(argv);
}

// called from command line
if (require.main === module) {
  utils.callAsync(run);
}

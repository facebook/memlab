/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import minimist, {ParsedArgs} from 'minimist';
import {utils} from '@memlab/core';
import commandDispatcher from './Dispatcher';

export async function run(): Promise<void> {
  const argv: ParsedArgs = minimist(process.argv.slice(2));
  commandDispatcher.dispatch(argv);
}

if (require.main === module) {
  // called from command line
  utils.callAsync(run);
}

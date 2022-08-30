#!/usr/bin/env -S node --expose-gc --max-old-space-size=4096

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

// eslint-disable-next-line no-var
var cli = require('../dist/index');

// register the `@memlab/cli` package info
// so that `memlab version` get use the info
// eslint-disable-next-line fb-www/promise-termination
cli.registerPackage().then(() => {
  cli.run();
});

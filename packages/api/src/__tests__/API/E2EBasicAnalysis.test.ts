/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

/* eslint-disable @typescript-eslint/ban-ts-comment */

import {run} from '../../index';
import {PluginUtils} from '@memlab/heap-analysis';
import {
  defaultAnalysisArgs,
  scenario,
  testSetup,
  testTimeout,
} from './lib/E2ETestSettings';

beforeEach(testSetup);

function inject() {
  // @ts-ignore
  window.injectHookForLink3 = () => {
    // @ts-ignore
    window.__injectedValue3 = {};
  };
  // @ts-ignore
  window.injectHookForLink4 = () => {
    // @ts-ignore
    window.__injectedValue4 = {};
    const __injectedTimeoutValue1 = {v: 0};
    setTimeout(() => {
      __injectedTimeoutValue1.v = 1;
    }, 1);
  };
}

test(
  'E2E SPA test hooks work as expected',
  async () => {
    await run({scenario, evalInBrowserAfterInitLoad: inject});
    const snapshot = await PluginUtils.loadHeapSnapshot(defaultAnalysisArgs);

    let foundInjectedValueForLink3 = false;
    let foundInjectedValueForLink4 = false;
    let foundInjectedTimeoutValue1 = false;

    snapshot.edges.forEach(e => {
      if (e.name_or_index === '__injectedValue3') {
        foundInjectedValueForLink3 = true;
      }
      if (e.name_or_index === '__injectedValue4') {
        foundInjectedValueForLink4 = true;
      }
      if (e.name_or_index === '__injectedTimeoutValue1') {
        foundInjectedTimeoutValue1 = true;
      }
    });
    // link-3 is not clicked, so injectHookForLink3 is not executed
    expect(foundInjectedValueForLink3).toBe(false);
    // link-4 is clicked, so injectHookForLink3 should be executed
    expect(foundInjectedValueForLink4).toBe(true);
    // __injectedValue is a local variable, which should not be retained
    expect(foundInjectedTimeoutValue1).toBe(false);
  },
  testTimeout,
);

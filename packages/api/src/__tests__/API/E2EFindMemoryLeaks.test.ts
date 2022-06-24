/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

/* eslint-disable @typescript-eslint/ban-ts-comment */

import {run} from '../../index';
import {scenario, testSetup, testTimeout} from './lib/E2ETestSettings';

beforeEach(testSetup);

function injectDetachedDOMElements() {
  // @ts-ignore
  window.injectHookForLink4 = () => {
    const arr = [];
    for (let i = 0; i < 23; ++i) {
      arr.push(document.createElement('div'));
    }
    // @ts-ignore
    window.__injectedValue = arr;
    // @ts-ignore
    window._path_1 = {x: {y: document.createElement('div')}};
    // @ts-ignore
    window._path_2 = [document.createElement('div')];
  };
}

test(
  'leak detector can find detached DOM elements',
  async () => {
    const leaks = await run({
      scenario,
      evalInBrowserAfterInitLoad: injectDetachedDOMElements,
    });
    // detected all different leak trace cluster
    expect(leaks.length).toBe(3);
    // expect all traces are found
    expect(
      leaks.some(leak => JSON.stringify(leak).includes('__injectedValue')),
    );
    expect(leaks.some(leak => JSON.stringify(leak).includes('_path_1')));
    expect(leaks.some(leak => JSON.stringify(leak).includes('_path_2')));
  },
  testTimeout,
);

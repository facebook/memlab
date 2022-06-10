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

import path from 'path';
import {DetachedDOMElementAnalysis, run} from '../../index';
import {scenario, testSetup, testTimeout} from './lib/E2ETestSettings';

beforeEach(testSetup);

function inject() {
  // @ts-ignore
  window.injectHookForLink4 = () => {
    // @ts-ignore
    window.__injectedValue = document.createElement('table');
  };
}

test(
  'Detached DOM analysis works as expected',
  async () => {
    const result = await run({scenario, evalInBrowserAfterInitLoad: inject});
    // test analysis from auto loading
    let analysis = new DetachedDOMElementAnalysis();
    await analysis.run();
    let domElems = analysis.getDetachedElements();
    expect(
      domElems.some(node => node.name === 'Detached HTMLTableElement'),
    ).toBe(true);

    // test analysis from file
    const snapshotFile = path.join(result.config.curDataDir, 's3.heapsnapshot');
    analysis = new DetachedDOMElementAnalysis();
    await analysis.analyzeSnapshotFromFile(snapshotFile);
    domElems = analysis.getDetachedElements();
    expect(
      domElems.some(node => node.name === 'Detached HTMLTableElement'),
    ).toBe(true);
  },
  testTimeout,
);

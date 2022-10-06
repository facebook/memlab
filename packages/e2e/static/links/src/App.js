/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import React from 'react';

// Use the window.injectHookForLink{n} hook to inject objects
// to memory when link-{n} is triggered, for example:
//
//  window.injectHookForLink4 = () => {
//    console.log('inject link 4');
//  }

function getClosure(i) {
  return () => {
    const name = `page-${i}`;
    console.log(name + ' clicked');
    const hook = window[`injectHookForLink${i}`];
    if (typeof hook === 'function') {
      hook();
    }
  };
}

function App() {
  return (
    <div>
      {[1, 2, 3, 4, 5, 6, 7, 8].map(i => {
        const testid = `link-${i}`;
        const callback = getClosure(i);
        return (
          // eslint-disable-next-line jsx-a11y/no-static-element-interactions
          <div key={i} data-testid={testid} onClick={callback}>
            link-{i}
          </div>
        );
      })}
    </div>
  );
}

export default App;

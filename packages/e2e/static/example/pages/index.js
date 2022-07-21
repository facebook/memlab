/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 * @oncall ws_labs
 */

import Link from 'next/link';
import React from 'react';

export default function Home() {
  return (
    <>
      <div className="row">
        <div className="col-md-3">
          <Link href="/examples/detached-dom">
            <a>
              <h2>Example 1 &rarr;</h2>
            </a>
          </Link>
          <p>Detached DOM element</p>
        </div>
        <div className="col-md-3">
          <Link href="/examples/oversized-object">
            <a>
              <h2>Example 2 &rarr;</h2>
            </a>
          </Link>
          <p>Leaked event listener</p>
        </div>
      </div>
      <div className="row alert alert-secondary" role="alert">
        Make sure to open your <code>Console</code> tab in devtools.
      </div>
    </>
  );
}

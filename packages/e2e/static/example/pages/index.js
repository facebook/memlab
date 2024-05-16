/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import Link from 'next/link';
import React from 'react';

export default function Home() {
  return (
    <>
      <div className="row">
        <div className="col-md-3">
          <Link href="/examples/detached-dom">
            <h2>Example 1 &rarr;</h2>
          </Link>
          <p>Detached DOM element</p>
        </div>
        <div className="col-md-3">
          <Link href="/examples/oversized-object">
            <h2>Example 2 &rarr;</h2>
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

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import Head from 'next/head';
import React from 'react';

export default function Layout({children}) {
  return (
    <div className="container">
      <Head>
        <title>memlab examples</title>
        <meta
          name="description"
          content="Common memory leak examples and how to fix these leaks using memlab"
        />
      </Head>
      <div className="row">
        <h1>Let's fix memory leaks</h1>
        {children}
      </div>
    </div>
  );
}

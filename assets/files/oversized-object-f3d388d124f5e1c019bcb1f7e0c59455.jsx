/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * @nolint
 * @oncall web_perf_infra
 */

import Link from 'next/link';
import React, {useEffect} from 'react';

export default function OversizedObject() {
  const bigArray = Array(1024 * 1024 * 2).fill(0);

  const eventHandler = () => {
    // the eventHandler closure keeps a reference
    // to the bigArray in the outter scope
    console.log('Using hugeObject', bigArray);
  };

  useEffect(() => {
    // eventHandler is never unregistered
    window.addEventListener('custom-click', eventHandler);
  }, []);

  return (
    <div className="container">
      <div className="row">
        <Link href="/">Go back</Link>
      </div>
      <br />
      <div className="row">
        Object<code>bigArray</code>is leaked. Please check <code>Memory</code>{' '}
        tab in devtools
      </div>
    </div>
  );
}

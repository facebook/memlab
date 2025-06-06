/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * @nolint
 * @oncall memory_lab
 */

import Link from 'next/link';
import React from 'react';

export default function DetachedDom() {
  const addNewItem = () => {
    if (!window.leakedObjects) {
      window.leakedObjects = [];
    }
    for (let i = 0; i < 1024; i++) {
      window.leakedObjects.push(document.createElement('div'));
    }
    console.log(
      'Detached DOMs are created. Please check Memory tab in Chrome DevTools',
    );
  };

  return (
    <div className="container">
      <div className="row">
        <Link href="/">Go back</Link>
      </div>
      <br />
      <div className="row">
        <button type="button" className="btn" onClick={addNewItem}>
          Create detached DOMs
        </button>
      </div>
    </div>
  );
}

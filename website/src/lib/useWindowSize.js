/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {useEffect, useState} from 'react';

// deal with SSR
const _window =
  typeof window !== 'undefined'
    ? window
    : {
        addEventListener: () => {},
        removeEventListener: () => {},
        innerWidth: 0,
        innerHeight: 0,
      };

function getWindowSize() {
  const {innerHeight: height, innerWidth: width} = _window;
  return {
    width,
    height,
  };
}

export default function useWindowSize() {
  const [windowSize, setWindowSize] = useState(getWindowSize());

  useEffect(() => {
    function handleResize() {
      setWindowSize(getWindowSize());
    }

    _window.addEventListener('resize', handleResize);
    return () => _window.removeEventListener('resize', handleResize);
  }, []);

  return windowSize;
}

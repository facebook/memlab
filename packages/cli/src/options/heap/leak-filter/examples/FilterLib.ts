/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {IHeapSnapshot, utils} from '@memlab/core';

export function initMap(snapshot: IHeapSnapshot): Record<string, number> {
  const map = Object.create(null);
  snapshot.nodes.forEach(node => {
    if (node.type !== 'string') {
      return;
    }
    const str = utils.getStringNodeValue(node);
    if (str in map) {
      ++map[str];
    } else {
      map[str] = 1;
    }
  });
  return map;
}

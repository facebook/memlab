/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */
import type {AnyValue} from '@memlab/core';
import Script from '../../code-analysis/Script';

export function testScopeAnalysis(code: string, expectedScope: AnyValue): void {
  const script = new Script(code);
  const scope = script.getClosureScopeTree();
  expect(removeLoc(scope)).toEqual(removeLoc(expectedScope));
}

export function removeLoc(entity: AnyValue): AnyValue {
  const visited = new Set<AnyValue>();
  function remove(e: AnyValue) {
    if (!e || typeof e !== 'object' || visited.has(e)) {
      return;
    }
    visited.add(e);
    for (const k of Object.keys(e)) {
      if (k === 'loc') {
        delete e.loc;
      } else {
        remove(e[k]);
      }
    }
  }
  remove(entity);
  return entity;
}

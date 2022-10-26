/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import {testScopeAnalysis} from './lib';

const code = `
const v0 = 'abc';
function f() {
  const v1 = 'test';
  function f2() {
    let v2 = 123;
    console.log(v0, v1, v2);
  }
}
`;

const closureScope = {
  functionName: null,
  functionType: 'Program',
  nestedClosures: [
    {
      functionName: 'f',
      functionType: 'FunctionDeclaration',
      nestedClosures: [
        {
          functionName: 'f2',
          functionType: 'FunctionDeclaration',
          nestedClosures: [],
          usedVariablesFromParentScope: ['v1'],
          variablesDefined: ['v2'],
        },
      ],
      usedVariablesFromParentScope: ['v0'],
      variablesDefined: ['v1', 'f2'],
    },
  ],
  usedVariablesFromParentScope: [],
  variablesDefined: ['v0', 'f'],
};

test('simple scope analysis works as expected', async () => {
  testScopeAnalysis(code, closureScope);
});

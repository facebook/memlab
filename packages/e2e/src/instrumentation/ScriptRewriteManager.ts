/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall mitigation_infra
 */

import type {ParseResult} from '@babel/parser';
import type {File} from '@babel/types';
import type BaseAstTransform from './BaseAstTransform';

import {parse} from '@babel/parser';
import generate from '@babel/generator';
import TransformLoader from './TransformLoader';

export type RewriteScriptOption = {
  url?: string;
  resourceType?: string;
};

export default class ScriptRewriteManager {
  public async rewriteScript(
    code: string,
    options: RewriteScriptOption = {},
  ): Promise<string> {
    // parse code
    const ast: ParseResult<File> = parse(code, {
      sourceType: 'script',
    });
    // transform ast
    const transforms: BaseAstTransform[] = TransformLoader.loadAllTransforms();
    for (const transform of transforms) {
      await transform.transform(ast, options);
    }
    // generate code
    const generateResult = generate(ast);
    return generateResult.code;
  }
}

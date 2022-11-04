/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {ParseResult} from '@babel/core';
import type {RewriteScriptOption} from './ScriptRewriteManager';

import {utils} from '@memlab/core';

export default abstract class BaseAstTransform {
  public async transform(
    ast: ParseResult,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    options: RewriteScriptOption = {},
  ): Promise<void> {
    throw utils.haltOrThrow('BaseAstTransform.transform is not implemented');
  }
}

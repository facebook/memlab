/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type BaseAstTransform from './BaseAstTransform';

import InjectSourceInfoTranform from './transforms/InjectSourceInfoTranform';

export default class TransformLoader {
  public static loadAllTransforms(): BaseAstTransform[] {
    return [new InjectSourceInfoTranform()];
  }
}

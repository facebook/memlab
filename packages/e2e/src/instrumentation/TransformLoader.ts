/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type BaseAstTransform from './BaseAstTransform';

import InjectSourceInfoTransform from './transforms/InjectSourceInfoTransform';

export default class TransformLoader {
  public static loadAllTransforms(): BaseAstTransform[] {
    return [new InjectSourceInfoTransform()];
  }
}

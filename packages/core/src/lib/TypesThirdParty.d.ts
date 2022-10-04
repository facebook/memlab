/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

declare module 'babar' {
  interface BabarOption {
    color?: string;
    width?: number;
    height?: number;
    xFractions?: number;
    yFractions?: number;
    minY?: number;
    maxY?: number;
  }
  export default function babar(
    plotData: number[][],
    params: BabarOption,
  ): string;
}

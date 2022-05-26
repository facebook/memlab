/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 *
 * @format
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

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

declare module 'html-inline' {
  interface InlinerParams {
    basedir: string;
  }
  export default function Inliner(
    params: InlinerParams,
  ): NodeJS.ReadWriteStream;
}

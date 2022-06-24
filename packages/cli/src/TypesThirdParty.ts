/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

declare module 'html-inline' {
  interface InlinerParams {
    basedir: string;
  }
  export default function Inliner(
    params: InlinerParams,
  ): NodeJS.ReadWriteStream;
}

/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 *
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

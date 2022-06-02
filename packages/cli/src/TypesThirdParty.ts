/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
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

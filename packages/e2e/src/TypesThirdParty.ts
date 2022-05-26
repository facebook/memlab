/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 *
 * @format
 */
declare module 'xvfb' {
  interface XvfbParams {
    silent: boolean;
    xvfb_args: string[];
    timeout: number;
  }
  export default class Xvfb {
    constructor(params: XvfbParams);
    start: (callback: (error: Error) => unknown | null) => void;
    stop: (callback: (error: Error) => unknown | null) => void;
    startSync: () => void;
    stopSync: () => void;
    display: () => string;
  }
}

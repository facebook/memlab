/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall mitigation_infra
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

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {Command, Optional} from './Types';

import info from './Console';
import cp from 'child_process';
import os from 'os';

type Options = {
  msg?: string;
  processLimit?: number;
};

const DEFAULT_PROCESS_LIMIT = 1;

class ProcessManager {
  private procLimit = DEFAULT_PROCESS_LIMIT;
  private nProc = 0;
  // 1. periodically check for available free process
  // 2. start commands in process until all tasks are completed
  public start(
    nextCommand: () => Optional<Command>,
    options: Options = {},
  ): void {
    this.init(options);
    const timer: NodeJS.Timeout = setInterval(() => {
      if (!this.hasFreeProcess()) {
        return;
      }
      const cmd = nextCommand();
      // if next command is empty, stop the loop
      if (!cmd) {
        return clearInterval(timer);
      }
      this.runInProcess(...cmd);
    }, 100);
  }

  private init(options: Options = {}): void {
    this.procLimit = options.processLimit
      ? options.processLimit
      : (os.cpus().length / 9) | 0;
  }

  private hasFreeProcess(): boolean {
    return this.nProc < this.procLimit;
  }

  private freeProcess(): void {
    this.nProc--;
  }

  private runInProcess(
    cmd: string,
    args: string[],
    options: Options = {},
  ): void {
    if (options.msg) {
      info.lowLevel(options.msg);
    }
    const str = [cmd, ...args].join(' ');
    this.nProc++;
    const proc = cp.spawn(cmd, args);
    proc.on('exit', code => {
      info.lowLevel(`done: ${str}`);
      if (code !== 0) {
        info.error(`fail: ${str}`);
      }
      this.freeProcess();
    });
  }
}

export default ProcessManager;

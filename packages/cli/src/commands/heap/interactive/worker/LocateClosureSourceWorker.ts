/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {Optional} from '@memlab/core';
import type {ClosureScope} from '@memlab/e2e';

import fs from 'fs';
import cp from 'child_process';
import {isMainThread, workerData} from 'worker_threads';

import {config, info, fileManager, utils} from '@memlab/core';
import {ScriptManager} from '@memlab/e2e';

type ShellOptions = {
  dir?: Optional<string>;
  ignoreError?: Optional<boolean>;
  disconnectStdio?: Optional<boolean>;
};

export function runShell(command: string, options: ShellOptions = {}): string {
  const runningDir = options.dir ?? fileManager.getMonoRepoDir();
  const execOptions = {
    cwd: runningDir,
    shell: '/bin/bash',
    stdio: options.disconnectStdio
      ? []
      : [process.stdin, process.stdout, process.stderr],
  };
  let ret: Buffer | string = '';
  try {
    ret = cp.execSync(command, execOptions);
  } catch (ex) {
    if (config.verbose) {
      if (ex instanceof Error) {
        info.lowLevel(ex.message);
        info.lowLevel(ex.stack ?? '');
      }
    }
    if (options.ignoreError === true) {
      return '';
    }
    utils.haltOrThrow(`Error when executing command: ${command}`);
  }
  return ret && ret.toString('UTF-8');
}

type ClosureSrcWorkerInput = {
  url: string;
  closureVars: string[];
};

if (!isMainThread) {
  try {
    displaySourceCode();
  } catch (ex) {
    // do nothing
  }
}

async function displaySourceCode(): Promise<void> {
  const scriptManager = new ScriptManager();
  scriptManager.loadFromFiles();
  const {url, closureVars} = workerData as ClosureSrcWorkerInput;

  const code = scriptManager.loadCodeForUrl(url);
  const scope = scriptManager.getClosureScopeTreeForUrl(url);
  if (!code || !scope) {
    return;
  }

  const file = fileManager.getDebugSourceFile();
  fs.writeFileSync(file, code, 'UTF-8');

  iterateClosures(scope, closureScope => {
    const varSet = new Set(closureScope.variablesDefined);
    const found = closureVars.reduce((acc, v) => varSet.has(v) && acc, true);
    if (found && closureScope.loc) {
      const startLine = closureScope.loc.start.line;
      runShell(`code -g ${file}:${startLine}`, {disconnectStdio: true});
    }
    return found;
  });
}

function iterateClosures(
  scope: ClosureScope,
  callback: (s: ClosureScope) => boolean,
): boolean {
  if (callback(scope)) {
    return true;
  }
  for (const subScope of scope.nestedClosures) {
    if (iterateClosures(subScope, callback)) {
      return true;
    }
  }
  return false;
}

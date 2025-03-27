/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {ClosureScope} from '@memlab/e2e';

import fs from 'fs';
import {isMainThread, workerData} from 'worker_threads';

import {fileManager, utils} from '@memlab/core';
import {ScriptManager} from '@memlab/e2e';

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
      utils.runShell(`code -g ${file}:${startLine}`, {disconnectStdio: true});
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

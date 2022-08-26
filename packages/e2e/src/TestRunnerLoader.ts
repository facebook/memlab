/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import path from 'path';
import type {E2EScenarioSynthesizerConstructor} from '@memlab/core';
import {fileManager} from '@memlab/core';
import BaseSynthesizer from './BaseSynthesizer';

class TestRunnerLoader {
  load(): E2EScenarioSynthesizerConstructor[] {
    const ret: E2EScenarioSynthesizerConstructor[] = [];
    const dir = path.join(__dirname, 'plugins');
    fileManager.iterateAllFiles(dir, (file: string) => {
      if (!file.endsWith('Synthesizer.js')) {
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const importedEntity = require(file);
      if (!importedEntity.default) {
        return;
      }
      const constructor = importedEntity.default;
      if (
        typeof constructor !== 'function' ||
        !(constructor.prototype instanceof BaseSynthesizer)
      ) {
        return;
      }
      ret.push(constructor);
    });
    return ret;
  }
}

export default new TestRunnerLoader();

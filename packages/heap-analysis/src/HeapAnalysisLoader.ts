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

import fs from 'fs';
import path from 'path';
import {info, utils} from '@memlab/core';
import type BaseAnalysis from './BaseAnalysis';

export type HeapAnalysisLoaderOptions = {
  heapAnalysisPlugin?: Optional<string>;
  errorWhenPluginFailed?: boolean;
};

class HeapAnalysisLoader {
  private modules: Map<string, BaseAnalysis> = new Map();

  public loadAllAnalysis(
    options: HeapAnalysisLoaderOptions = {},
  ): Map<string, BaseAnalysis> {
    if (this.modules.size === 0) {
      // auto load all analysis modules
      this.modules = new Map();
      this.registerAnalyses(options);
    }
    return this.modules;
  }

  private registerAnalyses(options: HeapAnalysisLoaderOptions = {}): void {
    const modulesDir = path.resolve(__dirname, 'plugins');
    this.registerAnalysesFromDir(modulesDir);
    // register external analysis
    if (options.heapAnalysisPlugin != null) {
      const file = path.resolve(options.heapAnalysisPlugin);
      this.registerAnalysisFromFile(file, options);
    }
  }

  private registerAnalysesFromDir(
    modulesDir: string,
    options: HeapAnalysisLoaderOptions = {},
  ) {
    const moduleFiles = fs.readdirSync(modulesDir);
    for (const moduleFile of moduleFiles) {
      const modulePath = path.join(modulesDir, moduleFile);
      this.registerAnalysisFromFile(modulePath, options);
    }
  }

  private registerAnalysisFromFile(
    modulePath: string,
    options: HeapAnalysisLoaderOptions = {},
  ): void {
    // recursively import modules from subdirectories
    if (fs.lstatSync(modulePath).isDirectory()) {
      this.registerAnalysesFromDir(modulePath, options);
      return;
    }

    // only import modules files ends with with Analysis.js
    if (!modulePath.endsWith('Analysis.js')) {
      if (options.errorWhenPluginFailed) {
        const fileName = path.basename(modulePath);
        throw utils.haltOrThrow(
          `Analysis plugin file (${fileName}) must end with \`Analysis.js\``,
        );
      }
      return;
    }

    let commandName = null;
    let moduleInstance = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const module = require(modulePath);
      const moduleConstructor =
        typeof module.default === 'function' ? module.default : module;
      moduleInstance = new moduleConstructor();
      commandName = moduleInstance.getCommandName();
    } catch (err) {
      info.error('Failed to load analysis plugin: ' + modulePath);
      throw utils.haltOrThrow(utils.getError(err));
    }
    if (commandName != null) {
      if (this.modules.has(commandName)) {
        utils.haltOrThrow(`heap command ${commandName} is already registered`);
      }
      this.modules.set(commandName, moduleInstance);
    }
  }
}

export default new HeapAnalysisLoader();

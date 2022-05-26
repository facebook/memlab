/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import fs from 'fs';
import path from 'path';
import {utils} from '@memlab/core';
import type BaseAnalysis from './BaseAnalysis';

class HeapAnalysisLoader {
  private modules: Map<string, BaseAnalysis> = new Map();

  public loadAllAnalysis(): Map<string, BaseAnalysis> {
    if (this.modules.size === 0) {
      // auto load all analysis modules
      this.modules = new Map();
      this.registerAnalyses();
    }
    return this.modules;
  }

  private registerAnalyses(): void {
    const modulesDir = path.resolve(__dirname, 'plugins');
    this.registerAnalysesFromDir(modulesDir);
  }

  private registerAnalysesFromDir(modulesDir: string) {
    const moduleFiles = fs.readdirSync(modulesDir);
    for (const moduleFile of moduleFiles) {
      const modulePath = path.join(modulesDir, moduleFile);

      // recursively import modules from subdirectories
      if (fs.lstatSync(modulePath).isDirectory()) {
        this.registerAnalysesFromDir(modulePath);
        continue;
      }

      // only import modules files ends with with Analysis.js
      if (!moduleFile.endsWith('Analysis.js')) {
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const module = require(modulePath);
      const moduleConstructor =
        typeof module.default === 'function' ? module.default : module;
      const moduleInstance = new moduleConstructor();
      const commandName = moduleInstance.getCommandName();
      if (this.modules.has(commandName)) {
        utils.haltOrThrow(`heap command ${commandName} is already registered`);
      }
      this.modules.set(commandName, moduleInstance);
    }
  }
}

export default new HeapAnalysisLoader();

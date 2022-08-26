/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {Optional} from '@memlab/core';

import fs from 'fs';
import path from 'path';
import {fileManager, info, utils} from '@memlab/core';
import BaseCommand from './BaseCommand';
import GenerateCLIDocCommand from './commands/helper/GenerateCLIDocCommand';

export default class CommandLoader {
  protected isLoaded = false;
  protected OSSModules: Map<string, BaseCommand> = new Map();
  protected modules: Map<string, BaseCommand> = new Map();
  protected modulePaths: Map<string, string> = new Map();

  public getModules(): Map<string, BaseCommand> {
    if (!this.isLoaded) {
      this.registerCommands();
    }
    return this.modules;
  }

  public getModulePaths(): Map<string, string> {
    if (!this.isLoaded) {
      this.registerCommands();
    }
    return this.modulePaths;
  }

  public registerCommands() {
    const modulesDir = path.resolve(__dirname, 'commands');
    this.registerCommandsFromDir(modulesDir);
    this.postRegistration();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected shouldRegisterCommand(command: BaseCommand) {
    return true;
  }

  protected registerCommandsFromDir(modulesDir: string) {
    const moduleFiles = fs.readdirSync(modulesDir);
    for (const moduleFile of moduleFiles) {
      const modulePath = path.join(modulesDir, moduleFile);

      // recursively import modules from subdirectories
      if (fs.lstatSync(modulePath).isDirectory()) {
        this.registerCommandsFromDir(modulePath);
        continue;
      }

      // only import modules files ends with with Command.js
      if (!moduleFile.endsWith('Command.js')) {
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const module = require(modulePath);
      const moduleConstructor =
        typeof module.default === 'function' ? module.default : module;
      const moduleInstance = new moduleConstructor();
      if (!(moduleInstance instanceof BaseCommand)) {
        utils.haltOrThrow('loading a command that does not extend BaseCommand');
      }
      if (!this.shouldRegisterCommand(moduleInstance)) {
        continue;
      }
      const commandName = moduleInstance.getCommandName();
      const loadingOssCommand =
        !fileManager.isWithinInternalDirectory(modulePath);

      // reigster OSS commands
      if (loadingOssCommand) {
        this.OSSModules.set(commandName, moduleInstance);
      }

      // register all commands
      if (this.modules.has(commandName)) {
        // resolve conflict
        const ossCommandLoaded = !fileManager.isWithinInternalDirectory(
          this.modulePaths.get(commandName) as string,
        );

        if (ossCommandLoaded === loadingOssCommand) {
          // when both commands are open source or neither are open source
          info.midLevel(`MemLab command ${commandName} is already registered`);
        } else if (!ossCommandLoaded && loadingOssCommand) {
          // when open source command tries to overwrite non-open source command
          continue;
        }
      }
      this.modules.set(commandName, moduleInstance);
      this.modulePaths.set(commandName, modulePath);
    }
  }

  protected postRegistration(): void {
    const cliDocCommand = new GenerateCLIDocCommand();
    const instance = this.modules.get(
      cliDocCommand.getCommandName(),
    ) as Optional<GenerateCLIDocCommand>;
    if (instance) {
      instance.setModulesMap(this.OSSModules);
    }
  }
}

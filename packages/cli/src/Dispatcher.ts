/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {ParsedArgs} from 'minimist';
import type {AnyRecord, MemLabConfig} from '@memlab/core';

import {config, info} from '@memlab/core';
import BaseCommand from './BaseCommand';
import HelperCommand from './commands/helper/HelperCommand';
import universalOptions from './options/lib/UniversalOptions';
import CommandLoader from './CommandLoader';

type RunCommandOptions = {
  isPrerequisite?: boolean;
  commandIndex?: number;
  configFromOptions: AnyRecord;
};

const helperCommand = new HelperCommand();

class CommandDispatcher {
  private modules: Map<string, BaseCommand>;
  private executedCommands: Set<string> = new Set();
  private executingCommandStack: Array<string> = [];

  constructor() {
    // auto load all command modules
    const commandLoader = new CommandLoader();
    this.modules = commandLoader.getModules();
  }

  async dispatch(args: ParsedArgs): Promise<void> {
    // triggered by `memlab` (without specific command)
    if (!args._ || !(args._.length >= 1)) {
      info.error('\n  command argument missing');
      await this.helper(args);
      return;
    }
    const command = args._[0];
    // invalid command, e.g., `memlab xyz`
    if (!this.modules.has(command)) {
      await this.helper(args);
      return;
    }
    // `memlab <COMMAND> <SUB-COMMAND> -h`
    if (args.h || args.help) {
      await this.helper(args);
      return;
    }
    // `memlab help <COMMAND> <SUB-COMMAND>`
    if (command === helperCommand.getCommandName()) {
      await this.helper({...args, _: args._.slice(1)});
      return;
    }

    const module = this.modules.get(command) as BaseCommand;
    this.executedCommands = new Set();
    this.executingCommandStack = [];
    await this.runCommand(module, args);
  }

  async parseOptions(
    command: BaseCommand,
    config: MemLabConfig,
    args: ParsedArgs,
  ): Promise<AnyRecord> {
    const options = [...universalOptions, ...command.getOptions()];
    const configFromOptions = Object.create(null);
    for (const option of options) {
      const ret = await option.run(config, args);
      if (ret) {
        Object.assign(configFromOptions, ret);
      }
    }
    return configFromOptions;
  }

  private async runCommand(
    command: BaseCommand,
    args: ParsedArgs,
    runCmdOpt: RunCommandOptions = {configFromOptions: {}},
  ): Promise<void> {
    const commandName = command.getCommandName();

    // make sure commands on the prerequisite are only executed once
    if (this.executedCommands.has(commandName)) {
      return;
    }
    this.executingCommandStack.push(commandName);

    // execute prerequisites
    const prerequisites = command.getPrerequisites();
    for (const prereq of prerequisites) {
      const prereqName = prereq.getCommandName();
      if (this.executingCommandStack.indexOf(prereqName) > 0) {
        throw new Error(
          `circular prerequisite reference: ${commandName} <--> ${prereqName}`,
        );
      }
      await this.runCommand(prereq, args, {
        isPrerequisite: true,
        ...runCmdOpt,
      });
    }

    // parse command line options
    const c = await this.parseOptions(command, config, args);
    Object.assign(runCmdOpt.configFromOptions, c);

    const {configFromOptions} = runCmdOpt;
    // execute command
    await command.run({cliArgs: args, configFromOptions});

    if (runCmdOpt.isPrerequisite !== true) {
      // execute subcommands
      const commandIndex = (runCmdOpt.commandIndex ?? 0) + 1;
      const runSubCmdOpt = {...runCmdOpt, commandIndex};
      await this.runSubCommandIfAny(command, args, runSubCmdOpt);
    }

    this.executingCommandStack.pop();
    this.executedCommands.add(commandName);
  }

  async runSubCommandIfAny(
    command: BaseCommand,
    args: ParsedArgs,
    runCmdOpt: RunCommandOptions,
  ): Promise<void> {
    const subCommandIndex = runCmdOpt.commandIndex ?? 0;
    if (args._.length <= subCommandIndex) {
      return;
    }

    const subCommands = command.getSubCommands();
    for (const subCommand of subCommands) {
      if (subCommand.getCommandName() === args._[subCommandIndex]) {
        this.runCommand(subCommand, args, runCmdOpt);
        return;
      }
    }

    info.error(
      `Invalid sub-command \`${
        args._[subCommandIndex]
      }\` of \`${command.getCommandName()}\`\n`,
    );

    await this.helper(args, command);
  }

  private async helper(
    cliArgs: ParsedArgs,
    command: BaseCommand | null = null,
  ): Promise<void> {
    await helperCommand.run({
      modules: this.modules,
      command,
      cliArgs,
      indent: '  ',
    });
  }
}

export default new CommandDispatcher();

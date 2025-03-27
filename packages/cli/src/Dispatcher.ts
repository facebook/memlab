/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {ParsedArgs} from 'minimist';
import type {AnyRecord, AnyValue, MemLabConfig, Nullable} from '@memlab/core';

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

type CommandDispatcherOptions = {
  commandLoader?: CommandLoader;
};

const helperCommand = new HelperCommand();

export class CommandDispatcher {
  private modules: Map<string, BaseCommand>;
  private executedCommands: Set<string>;
  private executingCommandStack: Array<string>;

  constructor(options: CommandDispatcherOptions = {}) {
    this.resetData();
    // auto load all command modules
    const commandLoader = options.commandLoader ?? new CommandLoader();
    this.modules = commandLoader.getModules();
  }

  protected resetData() {
    this.executedCommands = new Set();
    this.executingCommandStack = [];
  }

  async dispatch(args: ParsedArgs): Promise<void> {
    this.resetData();
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
    const configFromOptions: AnyRecord = Object.create(null);
    for (const option of options) {
      const ret = await option.run(config, args);
      if (ret) {
        this.mergeConfigFromOptions(configFromOptions, ret);
      }
    }
    return configFromOptions;
  }

  private mergeConfigFromOptions(to: AnyRecord, from: AnyRecord): AnyRecord {
    for (const key in from) {
      if (Array.isArray(to[key]) && Array.isArray(from[key])) {
        // both are arrays, merge them
        this.mergeArrays(to[key] as AnyValue[], from[key] as AnyValue[]);
      } else if (from[key] == null || to[key] == null) {
        // one of them is null, use the other one
        to[key] = to[key] || from[key];
      } else {
        // both have existing values, first one wins
        info.warning(`Merge conflict CLI options key: ${key}`);
      }
    }
    return to;
  }

  private mergeArrays(arr1: Nullable<AnyValue[]>, arr2: Nullable<AnyValue[]>) {
    if (arr1 == null) {
      return arr2;
    }
    if (arr2 == null) {
      return arr1;
    }
    for (const v of arr2) {
      arr1.push(v);
    }
    return arr1;
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
    // recommand CLI command and flags
    config.setRunInfo('command', process.argv.slice(2).join(' '));

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
    // if the command will handle the sub-commands by itself
    if (subCommands == null) {
      return;
    }

    for (const subCommand of subCommands) {
      if (subCommand.getCommandName() === args._[subCommandIndex]) {
        await this.runCommand(subCommand, args, runCmdOpt);
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

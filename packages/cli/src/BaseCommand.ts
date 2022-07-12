/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {CLIOptions, Nullable} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export enum CommandCategory {
  COMMON = 'COMMON',
  DEV = 'DEV',
  MISC = 'MISC',
}

abstract class Command {
  getCommandName(): string {
    const className = this.constructor.name;
    throw new Error(`${className}.getCommandName is not implemented`);
  }

  // If you are trying to add a new CLI command in MemLab,
  // DO NOT OVERRIDE any property or method in below in this class.
  // These methods are intended for internal orchestration
  // purposes. All commands should extend BaseCommand,
  // which contains the overridable hooks.
  private parentCommand: Nullable<BaseCommand> = null;

  setParentCommand(parent: BaseCommand): void {
    this.parentCommand = parent;
  }

  getParentCommand(): Nullable<BaseCommand> {
    return this.parentCommand;
  }

  getFullCommand(): string {
    const prefix = this.parentCommand
      ? this.parentCommand.getFullCommand() + ' '
      : '';
    return prefix + this.getCommandName();
  }

  getFullOptionsFromPrerequisiteChain(): BaseOption[] {
    const self = this as unknown as BaseCommand;
    const uniqueOptions = new Map();
    const visitedCommands = new Set();
    const queue: BaseCommand[] = [self];
    const excludedOptions = new Set(
      self.getExcludedOptions().map(option => option.getOptionName()),
    );
    while (queue.length > 0) {
      const cur = queue.shift() as BaseCommand;
      const options = cur.getOptions();
      for (const option of options) {
        const optionName = option.getOptionName();
        if (excludedOptions.has(optionName)) {
          continue;
        }
        if (!uniqueOptions.has(optionName)) {
          uniqueOptions.set(optionName, option);
        }
      }
      visitedCommands.add(cur.getCommandName());
      for (const prereq of cur.getPrerequisites()) {
        if (!visitedCommands.has(prereq.getCommandName())) {
          queue.push(prereq);
        }
      }
    }
    return [...uniqueOptions.values()];
  }
}

export default class BaseCommand extends Command {
  // The following terminal command will initiate with this command
  // `memlab <command-name>`
  getCommandName(): string {
    const className = this.constructor.name;
    throw new Error(`${className}.getCommandName is not implemented`);
  }

  // get a list of examples
  // examples will be displayed in helper text
  getExamples(): string[] {
    return [];
  }

  // get command's category, commands under the same category
  // are grouped together in helper text
  getCategory(): CommandCategory {
    return CommandCategory.MISC;
  }

  // The description of this analysis will be printed by
  // `memlab` or `memlab help`
  getDescription(): string {
    const className = this.constructor.name;
    throw new Error(`${className}.getDescription is not implemented`);
  }

  // get a sequence of commands that must be executed before
  // running this command
  getPrerequisites(): BaseCommand[] {
    return [];
  }

  // internal command will not be listed in helper
  isInternalCommand(): boolean {
    return false;
  }

  // get options supported by this command
  getOptions(): BaseOption[] {
    return [];
  }

  // commands from getPrerequisites may propagate
  // options that does not make sense for the
  // current command, this returns the list of
  // options that should be excluded from helper text
  getExcludedOptions(): BaseOption[] {
    return [];
  }

  // get subcommands of this command
  // for example command 'A' has two sub-commands 'B' and 'C'
  // CLI supports running in terminal: `memlab A B` or `memlab A C`
  // The parent command will be executed before its subcommands
  getSubCommands(): BaseCommand[] {
    return [];
  }

  // Callback for `memlab <command-name>`
  // Do the memory analysis and print results in this callback
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(_options: CLIOptions): Promise<void> {
    const className = this.constructor.name;
    throw new Error(`${className}.run is not implemented`);
  }
}

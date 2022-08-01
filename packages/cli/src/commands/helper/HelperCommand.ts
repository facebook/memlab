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
import type {BaseOption, CLIOptions, Optional} from '@memlab/core';

import chalk from 'chalk';
import stringWidth from 'string-width';
import {config, info, utils} from '@memlab/core';
import commandOrder from './lib/CommandOrder';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import universalOptions from '../../options/lib/UniversalOptions';
import {heapConfig} from '@memlab/heap-analysis';

type HelperOption = CLIOptions & {
  modules: Map<string, BaseCommand>;
  command: BaseCommand | null;
  indent?: string;
  printOptions?: boolean;
};

export default class HelperCommand extends BaseCommand {
  private printedCommand: Set<string> = new Set();
  private universalOptions: BaseOption[] = universalOptions;

  // The following terminal command will initiate with this command
  // `memlab <command-name>`
  getCommandName(): string {
    return 'help';
  }

  // The description of this analysis will be printed by
  // `memlab` or `memlab help`
  getDescription(): string {
    return 'list all MemLab CLI commands or print helper text for a specific command';
  }

  getExamples(): string[] {
    return ['<COMMAND> [SUB-COMMANDS]'];
  }

  setUniversalOptions(options: BaseOption[]): void {
    this.universalOptions = options;
  }

  private printHeader(options: HelperOption): void {
    const indent = options.indent ?? '';
    info.topLevel(`\n${indent}memlab: memory leak detector for front-end JS\n`);
  }

  private printCommandCategories(options: HelperOption): void {
    for (const category in CommandCategory) {
      const item = commandOrder.find(item => item.category === category);
      const commandsToPrintFirst = heapConfig.isCliInteractiveMode
        ? []
        : item
        ? item.commands
        : [];
      this.printCategory(
        category as CommandCategory,
        commandsToPrintFirst,
        options,
      );
    }
  }

  private printCategoryHeader(
    category: CommandCategory,
    options: HelperOption,
  ): void {
    const indent = options.indent ?? '  ';
    const categoryName = category.toUpperCase();
    info.topLevel(chalk.bold(`${indent}${categoryName} COMMANDS`));
    info.topLevel('');
  }

  private printCategory(
    category: CommandCategory,
    commandsToPrintFirst: BaseCommand[],
    options: HelperOption,
  ): void {
    const commandsToPrint: BaseCommand[] = [];
    for (const command of commandsToPrintFirst) {
      const name = command.getCommandName();
      if (this.printedCommand.has(name)) {
        continue;
      }
      commandsToPrint.push(command);
      this.printedCommand.add(name);
    }
    // print other commands in this category
    for (const moduleEntries of options.modules) {
      const command = moduleEntries[1];
      if (category !== command.getCategory()) {
        continue;
      }
      if (command.isInternalCommand() && !config.verbose) {
        continue;
      }
      const name = command.getCommandName();
      if (this.printedCommand.has(name)) {
        continue;
      }
      commandsToPrint.push(command);
      this.printedCommand.add(name);
    }
    if (commandsToPrint.length === 0) {
      return;
    }
    this.printCategoryHeader(category, options);
    for (const command of commandsToPrint) {
      this.printCommand(command, options.indent);
    }
    info.topLevel('');
  }

  private getCommandOptionsSummary(command: BaseCommand, indent = ''): string {
    const options = command.getFullOptionsFromPrerequisiteChain();
    if (options.length === 0) {
      return '';
    }
    const width = Math.min(70, process.stdout.columns);
    let summary = '';
    let curLine = chalk.bold(`${indent}Options:`);
    for (const option of options) {
      const optionToAppend = ' --' + option.getOptionName();
      if (stringWidth(curLine + optionToAppend) > width) {
        summary += (summary.length > 0 ? '\n' : '') + curLine;
        curLine = indent + '        ';
      }
      curLine += optionToAppend;
    }
    return summary + (summary.length > 0 ? '\n' : '') + curLine;
  }

  private printOptions(command: BaseCommand, extraIndent = ''): void {
    const options = [
      ...command.getFullOptionsFromPrerequisiteChain(),
      ...this.universalOptions,
    ];
    if (options.length === 0) {
      return;
    }
    const indent = '  ' + extraIndent;
    info.topLevel('\n' + extraIndent + chalk.bold('COMMAND LINE OPTIONS'));
    const optionsText = [];
    for (const option of options) {
      let header = `--${option.getOptionName()}`;
      if (option.getOptionShortcut()) {
        header += `, -${option.getOptionShortcut()}`;
      }
      const desc = option.getDescription();
      optionsText.push({header, desc});
    }
    const headerLength = optionsText.reduce(
      (acc, cur) => Math.max(acc, cur.header.length),
      0,
    );
    for (const optionText of optionsText) {
      const header = chalk.green(optionText.header);
      const prefix = utils.repeat(' ', headerLength - optionText.header.length);
      const msg = `${indent}${prefix}${header}  ${optionText.desc}`;
      info.topLevel(`\n${msg}`);
    }
  }

  private printCommand(
    command: BaseCommand,
    extraIndent = '',
    printOptions = false,
  ): void {
    const indent = '  ' + extraIndent;
    const name = command.getFullCommand();
    const desc = utils.upperCaseFirstCharacter(command.getDescription());

    // get example
    const examples = command.getExamples();
    let example = '';
    if (examples.length > 0) {
      example = ' ' + examples[0].trim();
    }
    const cmd = chalk.green(`memlab ${name}${example}`);
    let msg = `${indent}${cmd}`;
    msg += `\n${indent}${desc}`;
    info.topLevel(msg);

    // print options info
    if (printOptions) {
      // print full options description
      this.printOptions(command, indent);
    } else {
      // print options list summary
      const options = this.getCommandOptionsSummary(command, indent);
      if (options.length > 0) {
        info.topLevel(chalk.grey(`${options}`));
      }
    }
    info.topLevel('');
  }

  private async printHelperTextForCommand(
    command: BaseCommand,
    options: HelperOption,
  ): Promise<void> {
    // print helper text for a specific command
    this.printCommand(command, options.indent, options.printOptions);

    // print helper text for its subcommands
    const subcommands = command.getSubCommands();
    const subOptions = {...options};
    subOptions.indent = (subOptions.indent || '') + ' ';
    for (const subcommand of subcommands) {
      subOptions.command = subcommand;
      await this.run(subOptions);
    }
  }

  private async printFullHelperTextForCommand(
    args: ParsedArgs,
    modules: Map<string, BaseCommand>,
  ): Promise<void> {
    // get the command to print
    let map = modules;
    let command: Optional<BaseCommand>;
    const commandNames = [...args._];
    while (commandNames.length > 0) {
      const name = commandNames.shift();
      if (!name) {
        break;
      }
      command = map.get(name);
      if (!command) {
        break;
      }
      const subCommands = command.getSubCommands();
      map = new Map(
        subCommands.map((cmd: BaseCommand) => [cmd.getCommandName(), cmd]),
      );
    }
    if (!command) {
      throw utils.haltOrThrow(
        `Could not find command: memlab ${args._.join(' ')}`,
      );
    }

    // print the helper text of the command
    info.topLevel('');
    this.printCommand(command, '', true);

    // print the helper text of the subcommands
    const subCommands = command.getSubCommands();
    if (subCommands.length > 0) {
      info.topLevel(chalk.bold('  SUB-COMMANDS\n'));
      for (const subCommand of subCommands) {
        this.printCommand(subCommand, '  ');
      }
    }
  }

  async run(options: HelperOption): Promise<void> {
    this.printedCommand.clear();
    if (options.command) {
      await this.printHelperTextForCommand(options.command, options);
    } else if (options.cliArgs && options.cliArgs._.length > 0) {
      await this.printFullHelperTextForCommand(
        options.cliArgs,
        options.modules,
      );
    } else {
      // print helper text for all commands
      this.printHeader(options);
      this.printCommandCategories(options);
    }
  }
}

// add the helper command into the common commands
commandOrder
  ?.find(item => item.category === CommandCategory.COMMON)
  ?.commands.push(new HelperCommand());

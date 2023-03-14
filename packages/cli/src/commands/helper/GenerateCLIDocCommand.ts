/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {BaseOption, CLIOptions, CommandOptionExample} from '@memlab/core';

import path from 'path';
import fs from 'fs-extra';
import docUtils from './lib/DocUtils';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import {config, fileManager, utils} from '@memlab/core';
import universalOptions from '../../options/lib/UniversalOptions';

export default class GenerateCLIDocCommand extends BaseCommand {
  private modules: Map<string, BaseCommand> = new Map();
  private generatedCommandInIndex: Set<string> = new Set();
  private universalOptions: BaseOption[] = universalOptions;

  getCommandName(): string {
    return 'gen-cli-doc';
  }

  getDescription(): string {
    return 'generate CLI markdown documentations';
  }

  isInternalCommand(): boolean {
    return true;
  }

  setModulesMap(modules: Map<string, BaseCommand>) {
    this.modules = modules;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(options: CLIOptions): Promise<void> {
    const docsDir = fileManager.getDocDir();
    const cliDocsDir = path.join(docsDir, 'cli');
    this.generateDocs(cliDocsDir);
  }

  private generateDocs(cliDocsDir: string): void {
    // first clean up the dir
    fs.removeSync(cliDocsDir);
    fs.mkdirSync(cliDocsDir);
    // create index markdown file
    const indexFile = path.join(cliDocsDir, 'CLI-commands.md');
    this.writeCommandCategories(indexFile);
  }

  private writeCommandCategories(docFile: string): void {
    this.writeTextWithNewLine(docFile, '# Command Line Interface');
    for (const category in CommandCategory) {
      const commandsToPrintFirst: BaseCommand[] = [];
      this.writeCategory(
        docFile,
        category as CommandCategory,
        commandsToPrintFirst,
      );
    }
  }

  private writeCategory(
    docFile: string,
    category: CommandCategory,
    commandsToPrintFirst: BaseCommand[],
  ): void {
    // commands defined in commandsToPrintFirst
    const commands: BaseCommand[] = [];
    for (const command of commandsToPrintFirst) {
      const name = command.getCommandName();
      if (this.generatedCommandInIndex.has(name)) {
        continue;
      }
      commands.push(command);
    }
    // other commands in this category
    for (const moduleEntries of this.modules) {
      const command = moduleEntries[1];
      if (category !== command.getCategory()) {
        continue;
      }
      if (command.isInternalCommand() && !config.verbose) {
        continue;
      }
      const name = command.getCommandName();
      if (this.generatedCommandInIndex.has(name)) {
        continue;
      }
      commands.push(command);
    }
    if (commands.length === 0) {
      return;
    }
    this.writeCategoryHeader(docFile, category);
    for (const command of commands) {
      this.writeCommand(docFile, command);
      this.generatedCommandInIndex.add(command.getCommandName());
    }
    this.writeTextWithNewLine(docFile, '');
  }

  private writeCategoryHeader(
    docFile: string,
    category: CommandCategory,
  ): void {
    const categoryName = category.toUpperCase();
    this.writeTextWithNewLine(docFile, `\n## ${categoryName} Commands\n`);
  }

  private writeCommand(
    docFile: string,
    command: BaseCommand,
    indent = '',
  ): void {
    const name = command.getFullCommand();
    const desc = utils.upperCaseFirstCharacter(command.getDescription().trim());
    const cmdDoc = command.getDocumenation().trim();

    // write command title
    this.writeTextWithNewLine(docFile, `\n###${indent} memlab ${name}\n`);

    // write description
    this.writeTextWithNewLine(docFile, `${desc}\n`);

    // write detailed command documentation
    if (cmdDoc.length > 0) {
      this.writeTextWithNewLine(docFile, `${cmdDoc}\n`);
    }

    // get example
    const examples = command.getExamples();
    const example: CommandOptionExample = examples[0] ?? '';
    // write command synopsis
    const cmd = docUtils.generateExampleCommand(name, example);
    this.writeCodeBlock(docFile, cmd, 'bash');

    // write command examples if there is any
    const exampleBlock = examples
      .slice(1)
      .map(example => docUtils.generateExampleCommand(name, example))
      .join('\n');
    if (exampleBlock.length > 0) {
      this.writeTextWithNewLine(docFile, '\n#### examples\n');
      this.writeCodeBlock(docFile, exampleBlock, 'bash');
    }

    // write options
    this.writeCommandOptions(docFile, command);

    const subCommands = command.getSubCommands();
    for (const subCommand of subCommands) {
      this.writeCommand(docFile, subCommand, indent + '#');
    }
  }

  private writeTextWithNewLine(docFile: string, content: string): void {
    this.touchFile(docFile);
    fs.appendFileSync(docFile, `${content}\n`, 'UTF-8');
  }

  private touchFile(docFile: string): void {
    if (!fs.existsSync(docFile)) {
      fs.writeFileSync(docFile, '', 'UTF-8');
    }
  }

  private writeCodeBlock(docFile: string, code: string, codeType = '') {
    let normalizedCode = code;
    while (normalizedCode.endsWith('\n')) {
      normalizedCode = normalizedCode.slice(0, normalizedCode.length - 1);
    }
    this.touchFile(docFile);
    fs.appendFileSync(
      docFile,
      '```' + codeType + '\n' + normalizedCode + '\n```\n',
      'UTF-8',
    );
  }

  private writeCommandOptions(docFile: string, command: BaseCommand): void {
    const options = [
      ...command.getFullOptionsFromPrerequisiteChain(),
      ...this.universalOptions,
    ];
    if (options.length === 0) {
      return;
    }
    this.writeTextWithNewLine(docFile, '\n**Options**:');
    const optionsText = [];
    for (const option of options) {
      let header = `**\`--${option.getOptionName()}\`**`;
      if (option.getOptionShortcut()) {
        header += `, **\`-${option.getOptionShortcut()}\`**`;
      }
      const desc = option.getDescription();
      optionsText.push({header, desc});
    }
    for (const optionText of optionsText) {
      const header = optionText.header;
      const msg = ` * ${header}: ${optionText.desc}`;
      this.writeTextWithNewLine(docFile, msg);
    }
  }
}

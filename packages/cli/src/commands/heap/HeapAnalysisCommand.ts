/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {BaseOption, CLIOptions, CommandOptionExample} from '@memlab/core';

import {info, utils} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import {heapAnalysisLoader} from '@memlab/heap-analysis';
import HeapAnalysisSubCommandWrapper from './HeapAnalysisSubCommandWrapper';
import {BaseAnalysis} from '@memlab/heap-analysis';
import HelperCommand from '../helper/HelperCommand';
import InitDirectoryCommand from '../InitDirectoryCommand';
import HeapAnalysisPluginOption from '../../options/heap/HeapAnalysisPluginOption';
import {ParsedArgs} from 'minimist';
import HeapParserDictFastStoreSizeOption from '../../options/heap/HeapParserDictFastStoreSizeOption';

export default class RunHeapAnalysisCommand extends BaseCommand {
  getCommandName(): string {
    return 'analyze';
  }

  getDescription(): string {
    return 'Run heap analysis on heap snapshots.\n';
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  getPrerequisites(): BaseCommand[] {
    return [new InitDirectoryCommand()];
  }

  getOptions(): BaseOption[] {
    return [
      new HeapAnalysisPluginOption(),
      new HeapParserDictFastStoreSizeOption(),
    ];
  }

  getSubCommands(): BaseCommand[] {
    const analyses = [...heapAnalysisLoader.loadAllAnalysis().values()];
    return analyses.map((analysis: BaseAnalysis) => {
      const ret = new HeapAnalysisSubCommandWrapper(analysis);
      // TODO: move this logic to command dispatcher
      ret.setParentCommand(this);
      return ret;
    });
  }

  getExamples(): CommandOptionExample[] {
    return ['<PLUGIN_NAME> [PLUGIN_OPTIONS]'];
  }

  private async errorIfNoSubCommand(
    args: ParsedArgs,
    analysisMap: Map<string, BaseAnalysis>,
  ): Promise<void> {
    if (args && args._.length >= 2 && analysisMap.has(args._[1])) {
      return;
    }

    const helper = new HelperCommand();
    const modules = new Map();
    for (const subCommand of this.getSubCommands()) {
      modules.set(subCommand.getCommandName(), subCommand);
    }
    const errMsg =
      args && args._.length < 2
        ? `\n  Heap analysis plugin name missing\n`
        : `\n  Invalid command \`memlab ${this.getCommandName()} ${
            args?._[1]
          }\`\n`;
    info.error(errMsg);
    await helper.run({cliArgs: args, modules, command: this});
    utils.haltOrThrow(errMsg, {printErrorBeforeHalting: false});
  }

  async run(options: CLIOptions): Promise<void> {
    // process command line arguments and load analysis modules
    const args = options.cliArgs;
    let plugin = options.configFromOptions?.heapAnalysisPlugin;
    if (plugin != null) {
      plugin = `${plugin}`;
    }
    const analysisMap = heapAnalysisLoader.loadAllAnalysis({
      heapAnalysisPlugin: plugin,
      errorWhenPluginFailed: true,
    });

    await this.errorIfNoSubCommand(args, analysisMap);
  }
}

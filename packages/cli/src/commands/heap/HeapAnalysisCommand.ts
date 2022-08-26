/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {CLIOptions} from '@memlab/core';

import {info, utils} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import {heapAnalysisLoader} from '@memlab/heap-analysis';
import HeapAnalysisSubCommandWrapper from './HeapAnalysisSubCommandWrapper';
import {BaseAnalysis} from '@memlab/heap-analysis';
import HelperCommand from '../helper/HelperCommand';
import InitDirectoryCommand from '../InitDirectoryCommand';

export default class RunHeapAnalysisCommand extends BaseCommand {
  getCommandName(): string {
    return 'analyze';
  }

  getDescription(): string {
    return 'Run heap analysis plugins';
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  getPrerequisites(): BaseCommand[] {
    return [new InitDirectoryCommand()];
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

  getExamples(): string[] {
    return ['<PLUGIN_NAME> [PLUGIN_OPTIONS]'];
  }

  async run(options: CLIOptions): Promise<void> {
    const args = options.cliArgs;
    const analysisMap = heapAnalysisLoader.loadAllAnalysis();
    if (!args || args._.length < 2 || !analysisMap.has(args._[1])) {
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
  }
}

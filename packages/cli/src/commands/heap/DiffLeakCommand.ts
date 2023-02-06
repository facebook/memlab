/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import {CLIOptions, utils} from '@memlab/core';
import {info} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import {BaseOption, config, analysis} from '@memlab/core';
import JSEngineOption from '../../options/heap/JSEngineOption';
import InitDirectoryCommand from '../InitDirectoryCommand';
import OversizeThresholdOption from '../../options/heap/OversizeThresholdOption';
import TraceAllObjectsOption from '../../options/heap/TraceAllObjectsOption';
import LogTraceAsClusterOption from '../../options/heap/LogTraceAsClusterOption';
import CleanLoggerDataCommand from '../CleanLoggerDataCommand';
import LeakFilterFileOption from '../../options/heap/leak-filter/LeakFilterFileOption';
import LeakClusterSizeThresholdOption from '../../options/heap/LeakClusterSizeThresholdOption';
import MLClusteringOption from '../../options/MLClusteringOption';
import MLClusteringLinkageMaxDistanceOption from '../../options/MLClusteringLinkageMaxDistanceOption';
import MLClusteringMaxDFOption from '../../options/MLClusteringMaxDFOption';
import SetControlWorkDirOption from '../../options/experiment/SetControlWorkDirOption';
import SetTreatmentWorkDirOption from '../../options/experiment/SetTreatmentWorkDirOption';

export default class CheckLeakCommand extends BaseCommand {
  getCommandName(): string {
    return 'diff-leaks';
  }

  getDescription(): string {
    return 'find new memory leaks by diffing control and test heap snapshots';
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  getPrerequisites(): BaseCommand[] {
    return [new InitDirectoryCommand(), new CleanLoggerDataCommand()];
  }

  getOptions(): BaseOption[] {
    return [
      new SetControlWorkDirOption().required(),
      new SetTreatmentWorkDirOption().required(),
      new JSEngineOption(),
      new LeakFilterFileOption(),
      new OversizeThresholdOption(),
      new LeakClusterSizeThresholdOption(),
      new TraceAllObjectsOption(),
      new LogTraceAsClusterOption(),
      new MLClusteringOption(),
      new MLClusteringLinkageMaxDistanceOption(),
      new MLClusteringMaxDFOption(),
    ];
  }

  async run(options: CLIOptions): Promise<void> {
    config.chaseWeakMapEdge = false;
    // double check parameters
    if (
      !options.configFromOptions?.controlWorkDirs ||
      !options.configFromOptions?.treatmentWorkDir
    ) {
      info.error('Please specify control and test working directory');
      throw utils.haltOrThrow('No control or test working directory specified');
    }
    // get parameters
    const controlWorkDirs = options.configFromOptions[
      'controlWorkDirs'
    ] as string[];
    const treatmentWorkDir = options.configFromOptions[
      'treatmentWorkDir'
    ] as string;
    // diff memory leaks
    await analysis.diffLeakByWorkDir({controlWorkDirs, treatmentWorkDir});
  }
}

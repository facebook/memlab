/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */
import type {ParsedArgs} from 'minimist';
import {BaseOption, CLIOptions} from '@memlab/core';
import type {CheckLeakCommandOptions} from './CheckLeakCommand';

import {analysis, info, config, runInfoUtils, utils} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
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
import SetMaxClusterSampleSizeOption from '../../options/SetMaxClusterSampleSizeOption';
import SetTraceContainsFilterOption from '../../options/heap/SetTraceContainsFilterOption';

export type WorkDirSettings = {
  controlWorkDirs: Array<string>;
  treatmentWorkDirs: Array<string>;
};

export default class CheckLeakCommand extends BaseCommand {
  private isMLClustering = false;
  private isMLClusteringSettingCache = false;

  protected useDefaultMLClusteringSetting(cliArgs: ParsedArgs): void {
    if (!MLClusteringOption.hasOptionSet(cliArgs)) {
      config.isMLClustering = this.isMLClustering;
      this.isMLClusteringSettingCache = config.isMLClustering;
    }
  }

  protected restoreDefaultMLClusteringSetting(cliArgs: ParsedArgs): void {
    if (!MLClusteringOption.hasOptionSet(cliArgs)) {
      config.isMLClustering = this.isMLClusteringSettingCache;
    }
  }

  constructor(options: CheckLeakCommandOptions = {}) {
    super();
    this.isMLClustering = !!options?.isMLClustering;
  }

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
      new SetControlWorkDirOption(),
      new SetTreatmentWorkDirOption(),
      new JSEngineOption(),
      new LeakFilterFileOption(),
      new OversizeThresholdOption(),
      new LeakClusterSizeThresholdOption(),
      new TraceAllObjectsOption(),
      new LogTraceAsClusterOption(),
      new MLClusteringOption(),
      new MLClusteringLinkageMaxDistanceOption(),
      new MLClusteringMaxDFOption(),
      new SetMaxClusterSampleSizeOption(),
      new SetTraceContainsFilterOption(),
    ];
  }

  protected getWorkDirs(options: CLIOptions): WorkDirSettings {
    // double check parameters
    if (
      !options.configFromOptions?.controlWorkDirs ||
      !options.configFromOptions?.treatmentWorkDirs
    ) {
      info.error('Please specify control and test working directory');
      throw utils.haltOrThrow('No control or test working directory specified');
    }
    // get parameters
    const controlWorkDirs = options.configFromOptions[
      'controlWorkDirs'
    ] as string[];
    const treatmentWorkDirs = options.configFromOptions[
      'treatmentWorkDirs'
    ] as string[];
    return {
      controlWorkDirs,
      treatmentWorkDirs,
    };
  }

  async run(options: CLIOptions): Promise<void> {
    config.chaseWeakMapEdge = false;
    const {controlWorkDirs, treatmentWorkDirs} = this.getWorkDirs(options);
    const {runMetaInfoManager} = runInfoUtils;
    runMetaInfoManager.setConfigFromRunMeta({
      workDir: treatmentWorkDirs[0],
      silentFail: true,
    });
    // diff memory leaks
    this.useDefaultMLClusteringSetting(options.cliArgs);
    await analysis.diffLeakByWorkDir({controlWorkDirs, treatmentWorkDirs});
    this.restoreDefaultMLClusteringSetting(options.cliArgs);
  }
}

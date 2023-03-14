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
import type {BaseOption, CLIOptions, Optional} from '@memlab/core';

import BaseCommand, {CommandCategory} from '../../BaseCommand';
import {analysis, config, fileManager, runInfoUtils} from '@memlab/core';
import BaselineFileOption from '../../options/heap/BaselineFileOption';
import FinalFileOption from '../../options/heap/FinalFileOption';
import JSEngineOption from '../../options/heap/JSEngineOption';
import SnapshotDirectoryOption from '../../options/heap/SnapshotDirectoryOption';
import TargetFileOption from '../../options/heap/TargetFileOption';
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
import CleanupSnapshotOption from '../../options/heap/CleanupSnapshotOption';
import SetWorkingDirectoryOption from '../../options/SetWorkingDirectoryOption';

export type CheckLeakCommandOptions = {
  isMLClustering?: boolean;
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
    return 'find-leaks';
  }

  getExamples(): string[] {
    return [
      '', // check memory leaks in the default working directory
      '--baseline /tmp/baseline.heapsnapshot --target /tmp/target.heapsnapshot --final /tmp/final.heapsnapshot',
      '--work-dir /memlab/working/dir/generated/by/memlab/',
      '--snapshot-dir /dir/containing/heapsnapshot/files/',
    ];
  }

  getDescription(): string {
    return 'find memory leaks in heap snapshots';
  }

  getDocumenation(): string {
    return `There are three ways to specify inputs for the \`memlab find-leaks\` command:
 1. \`--baseline\`, \`--target\`, \`--final\` specifies each snapshot input individually;
 2. \`--snapshot-dir\` specifies the directory that holds all three heap snapshot files (MemLab will assign baseline, target, and final based on alphabetic order of the file);
 3. \`--work-dir\` specifies the output working directory of the \`memlab run\` or the \`memlab snapshot\` command;

Please only use one of the three ways to specify the input.

You can also manually take heap snapshots in Chrome Devtools, save them to disk.
Then process them using this command with the CLI flags (either option 1
or option 2 mentioned above).
`;
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  getPrerequisites(): BaseCommand[] {
    return [new InitDirectoryCommand(), new CleanLoggerDataCommand()];
  }

  getOptions(): BaseOption[] {
    return [
      new BaselineFileOption(),
      new TargetFileOption(),
      new FinalFileOption(),
      new SnapshotDirectoryOption(),
      new JSEngineOption(),
      new LeakFilterFileOption(),
      new OversizeThresholdOption(),
      new LeakClusterSizeThresholdOption(),
      new TraceAllObjectsOption(),
      new LogTraceAsClusterOption(),
      new MLClusteringOption(),
      new MLClusteringLinkageMaxDistanceOption(),
      new MLClusteringMaxDFOption(),
      new CleanupSnapshotOption(),
      new SetWorkingDirectoryOption(),
    ];
  }

  async run(options: CLIOptions): Promise<void> {
    const workDir = options.configFromOptions?.workDir as Optional<string>;
    fileManager.initDirs(config, {workDir});
    const {runMetaInfoManager} = runInfoUtils;
    runMetaInfoManager.setConfigFromRunMeta({
      workDir,
      silentFail: true,
    });

    config.chaseWeakMapEdge = false;

    this.useDefaultMLClusteringSetting(options.cliArgs);
    await analysis.checkLeak();
    this.restoreDefaultMLClusteringSetting(options.cliArgs);

    const configFromOptions = options.configFromOptions ?? {};
    if (configFromOptions['cleanUpSnapshot']) {
      fileManager.removeSnapshotFiles();
    }
  }
}

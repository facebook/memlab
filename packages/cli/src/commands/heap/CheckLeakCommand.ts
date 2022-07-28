/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {CLIOptions} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import {BaseOption, config, analysis} from '@memlab/core';
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

export default class CheckLeakCommand extends BaseCommand {
  getCommandName(): string {
    return 'find-leaks';
  }

  getDescription(): string {
    return 'find memory leaks in heap snapshots';
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
    ];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(_options: CLIOptions): Promise<void> {
    config.chaseWeakMapEdge = false;
    await analysis.checkLeak();
  }
}

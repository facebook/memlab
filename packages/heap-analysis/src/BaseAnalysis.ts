/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {AnyValue} from '@memlab/core';
import type {HeapAnalysisOptions} from './PluginUtils';

import {BaseOption, config, utils, constant} from '@memlab/core';
import {defaultTestPlanner} from '@memlab/e2e';
import pluginUtils from './PluginUtils';

// Identify the target scenario and
// add its setting to Config
function loadScenarioConfig(): void {
  utils.loadTargetInfoFromRunMeta();
  if (
    config.targetApp === 'external' ||
    config.targetTab.startsWith(constant.namePrefixForScenarioFromFile)
  ) {
    return;
  }
  const synthesizer = defaultTestPlanner.getSynthesizer({needCookies: false});
  synthesizer
    .getNodeNameBlocklist()
    .forEach(name => config.nodeNameBlockList.add(name));
  synthesizer
    .getEdgeNameBlocklist()
    .forEach(name => config.edgeNameBlockList.add(name));
}

abstract class Analysis {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async process(_options: HeapAnalysisOptions): Promise<AnyValue> {
    const className = this.constructor.name;
    throw new Error(`${className}.process is not implemented`);
  }

  // DO NOT override this method
  public async run(
    options: HeapAnalysisOptions = pluginUtils.defaultAnalysisArgs,
  ): Promise<AnyValue> {
    loadScenarioConfig();
    return await this.process(options);
  }

  public async analyzeSnapshotFromFile(file: string): Promise<AnyValue> {
    return this.process({
      args: {
        _: [],
        snapshot: file,
        'snapshot-dir': '<MUST_PROVIDE_SNAPSHOT_DIR>',
      },
    });
  }

  public async analyzeSnapshotsInDirectory(
    directory: string,
  ): Promise<AnyValue> {
    return this.process({
      args: {
        _: [],
        snapshot: '<MUST_PROVIDE_SNAPSHOT_FILE>',
        'snapshot-dir': directory,
      },
    });
  }
}

class BaseAnalysis extends Analysis {
  // The following terminal command will initiate with this analysis
  // `memlab analyze <command-name>`
  getCommandName(): string {
    const className = this.constructor.name;
    throw new Error(`${className}.getCommandName is not implemented`);
  }

  // The description of this analysis will be printed by
  // `memlab analyze list`
  getDescription(): string {
    const className = this.constructor.name;
    throw new Error(`${className}.getDescription is not implemented`);
  }

  // Callback for `memlab analyze <command-name>`
  // Do the memory analysis and print results in this callback
  // The analysis should support:
  //  1) printing results on screen
  //  2) returning results via the return value
  protected async process(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: HeapAnalysisOptions,
  ): Promise<AnyValue> {
    const className = this.constructor.name;
    throw new Error(`${className}.process is not implemented`);
  }

  // override this method if you would like CLI to print the option info
  getOptions(): BaseOption[] {
    return [];
  }
}

export default BaseAnalysis;

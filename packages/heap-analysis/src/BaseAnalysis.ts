/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
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
  public async process(_options: HeapAnalysisOptions): Promise<void> {
    const className = this.constructor.name;
    throw new Error(`${className}.process is not implemented`);
  }

  /**
   * DO NOT override this method if you are implementing your own analysis
   * by extending {@link BaseAnalysis}.
   * @param options This is the auto-generated arguments passed to all the
   * `process` method that your self-defined heap analysis should implement.
   * You are not supposed to construct instances of this class.
   * @returns any type of value returned from the overridden `process` method
   * of the heap analysis instance. Each heap analysis class can define
   * different return value format.
   * @internal
   */
  public async run(
    options: HeapAnalysisOptions = pluginUtils.defaultAnalysisArgs,
  ): Promise<void> {
    loadScenarioConfig();
    return await this.process(options);
  }

  /**
   * Run heap analysis for a single heap snapshot file
   * @param file the absolute path of a `.heapsnapshot` file.
   * @returns this API returns void. To get the analysis results,
   * check out the documentation of the hosting heap analysis class and
   * call the analysis-specific API to get results after calling this method.
   * * **Example**:
   * ```typescript
   * const analysis = new StringAnalysis();
   * await anaysis.analyzeSnapshotFromFile(snapshotFile);
   * const stringPatterns = analysis.getTopDuplicatedStringsInCount();
   * ```
   */
  public async analyzeSnapshotFromFile(file: string): Promise<void> {
    return this.process({
      args: {
        _: [],
        snapshot: file,
        'snapshot-dir': '<MUST_PROVIDE_SNAPSHOT_DIR>',
      },
    });
  }

  /**
   * Run heap analysis for a series of heap snapshot files
   * @param directory the absolute path of the directory holding a series of
   * `.heapsnapshot` files, all snapshot files will be loaded and analyzed
   * in the alphanumerically ascending order of those snapshot file names.
   * @returns this API returns void. To get the analysis results,
   * check out the documentation of the hosting heap analysis class and
   * call the analysis-specific API to get results after calling this method.
   * * **Example**:
   * ```typescript
   * const analysis = new ShapeUnboundGrowthAnalysis();
   * await anaysis.analyzeSnapshotsInDirectory(snapshotDirectory);
   * const shapes = analysis.getShapesWithUnboundGrowth();
   * ```
   */
  public async analyzeSnapshotsInDirectory(directory: string): Promise<void> {
    return this.process({
      args: {
        _: [],
        snapshot: '<MUST_PROVIDE_SNAPSHOT_FILE>',
        'snapshot-dir': directory,
      },
    });
  }
}

/**
 *
 */
class BaseAnalysis extends Analysis {
  /**
   * Get the name of the heap analysis, which is also used to reference
   * the analysis in memlab command-line tool.
   *
   * The following terminal command will initiate with this analysis:
   * `memlab analyze <ANALYSIS_NAME>`
   *
   * @returns the name of the analysis
   * * **Examples**:
   * ```typescript
   * const analysis = new YourAnalysis();
   * const name = analysis.getCommandName();
   * ```
   */
  getCommandName(): string {
    const className = this.constructor.name;
    throw new Error(`${className}.getCommandName is not implemented`);
  }

  /**
   * Get the textual description of the heap analysis.
   * The description of this analysis will be printed by:
   * `memlab analyze list`
   *
   * @returns the description
   */
  getDescription(): string {
    const className = this.constructor.name;
    throw new Error(`${className}.getDescription is not implemented`);
  }

  /**
   * Callback for `memlab analyze <command-name>`.
   * Do the memory analysis and print results in this callback
   * The analysis should support:
   *  1) printing results on screen
   *  2) returning results via the return value
   * @param options This is the auto-generated arguments passed to all the
   * `process` method that your self-defined heap analysis should implement.
   * You are not supposed to construct instances of this class.
   */
  public async process(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    options: HeapAnalysisOptions,
  ): Promise<AnyValue> {
    const className = this.constructor.name;
    throw new Error(`${className}.process is not implemented`);
  }

  /**
   * override this method if you would like CLI to print the option info
   * @returns an array of command line options
   */
  getOptions(): BaseOption[] {
    return [];
  }
}

export default BaseAnalysis;

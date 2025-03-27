/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {AnyValue, BaseOption} from '@memlab/core';
import type {
  AnalyzeSnapshotResult,
  HeapAnalysisOptions,
  RunHeapAnalysisOptions,
} from './PluginUtils';

import {config, constant, fileManager, info, runInfoUtils} from '@memlab/core';
import {defaultTestPlanner} from '@memlab/e2e';
import pluginUtils from './PluginUtils';

// Identify the target scenario and
// add its setting to Config
function loadScenarioConfig(): void {
  runInfoUtils.runMetaInfoManager.setConfigFromRunMeta({silentFail: true});
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
    await this.process(options);
  }

  /**
   * Run heap analysis for a single heap snapshot file
   * @param file the absolute path of a `.heapsnapshot` file.
   * @param options optional configuration for the heap analysis run
   * @returns this API returns {@link AnalyzeSnapshotResult}, which contains
   * the logging file of analysis console output. Alternatively, to get more
   * structured analysis results, check out the documentation of the hosting
   * heap analysis class and call the analysis-specific API to get results
   * after calling this method.
   * * **Example**:
   * ```typescript
   * const analysis = new StringAnalysis();
   * // analysis console output is saved in result.analysisOutputFile
   * const result = await analysis.analyzeSnapshotFromFile(snapshotFile);
   * // query analysis-specific and structured results
   * const stringPatterns = analysis.getTopDuplicatedStringsInCount();
   * ```
   * Additionally, you can specify a working directory to where
   * the intermediate, logging, and final output files will be dumped:
   * ```typescript
   * const analysis = new StringAnalysis();
   * // analysis console output is saved in result.analysisOutputFile
   * // which is inside the specified working directory
   * const result = await analysis.analyzeSnapshotFromFile(snapshotFile, {
   *   // if the specified directory doesn't exist, memlab will create it
   *   workDir: '/tmp/your/work/dir',
   * });
   * ```
   */
  public async analyzeSnapshotFromFile(
    file: string,
    options: RunHeapAnalysisOptions = {},
  ): Promise<AnalyzeSnapshotResult> {
    if (options.workDir) {
      // set and init the new work dir
      config.defaultFileManagerOption = options;
    }

    const analysisOutputFile = fileManager.initNewHeapAnalysisLogFile();
    info.registerLogFile(analysisOutputFile);
    await this.process({
      args: {
        _: [],
        snapshot: file,
        'snapshot-dir': '<MUST_PROVIDE_SNAPSHOT_DIR>',
      },
    });
    info.unregisterLogFile(analysisOutputFile);
    return {analysisOutputFile};
  }

  /**
   * Run heap analysis for a series of heap snapshot files
   * @param directory the absolute path of the directory holding a series of
   * `.heapsnapshot` files, all snapshot files will be loaded and analyzed
   * in the alphanumerically ascending order of those snapshot file names.
   * @param options optional configuration for the heap analysis run
   * @returns this API returns {@link AnalyzeSnapshotResult}, which contains
   * the logging file of analysis console output. Alternatively, to get more
   * structured analysis results, check out the documentation of the hosting
   * heap analysis class and call the analysis-specific API to get results
   * after calling this method.
   * * **Example**:
   * ```typescript
   * const analysis = new ShapeUnboundGrowthAnalysis();
   * // analysis console output is saved in result.analysisOutputFile
   * const result = await analysis.analyzeSnapshotsInDirectory(snapshotDirectory);
   * // query analysis-specific and structured results
   * const shapes = analysis.getShapesWithUnboundGrowth();
   * ```
   * * Additionally, you can specify a working directory to where
   * the intermediate, logging, and final output files will be dumped:
   * ```typescript
   * const analysis = new ShapeUnboundGrowthAnalysis();
   * // analysis console output is saved in result.analysisOutputFile
   * // which is inside the specified working directory
   * const result = await analysis.analyzeSnapshotsInDirectory(snapshotDirectory, {
   *   // if the specified directory doesn't exist, memlab will create it
   *   workDir: '/tmp/your/work/dir',
   * });
   * ```
   */
  public async analyzeSnapshotsInDirectory(
    directory: string,
    options: RunHeapAnalysisOptions = {},
  ): Promise<AnalyzeSnapshotResult> {
    if (options.workDir) {
      // set and init the new work dir
      config.defaultFileManagerOption = options;
    }

    const analysisOutputFile = fileManager.initNewHeapAnalysisLogFile();
    info.registerLogFile(analysisOutputFile);
    await this.process({
      args: {
        _: [],
        snapshot: '<MUST_PROVIDE_SNAPSHOT_FILE>',
        'snapshot-dir': directory,
      },
    });
    info.unregisterLogFile(analysisOutputFile);
    return {analysisOutputFile};
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

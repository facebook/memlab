/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import {config, E2EStepInfo, RunMetaInfo} from '@memlab/core';

import fs from 'fs-extra';
import {FileManager, RunMetaInfoManager, utils} from '@memlab/core';
import BaseResultReader from './BaseResultReader';

/**
 * A utility entity to read all MemLab files generated from
 * baseline, target and final heap snapshots.
 *
 * The most useful feature of this class is when you have
 * three separate snapshots (baseline, target, and final)
 * that are not taken from MemLab, but you still would
 * like to use the `findLeaks` to detect memory leaks:
 *
 * ```javascript
 * const {SnapshotResultReader, findLeaks} = require('@memlab/api');
 *
 * // baseline, target, and final are file paths of heap snapshot files
 * const reader = SnapshotResultReader.fromSnapshots(baseline, target, final);
 * const leaks = await findLeaks(reader);
 * ```
 */
export default class SnapshotResultReader extends BaseResultReader {
  private baselineSnapshot: string;
  private targetSnapshot: string;
  private finalSnapshot: string;

  /**
   * build a result reader
   * @param workDir absolute path of the directory where the data
   * and generated files of the memlab run were stored
   */
  protected constructor(
    baselineSnapshot: string,
    targetSnapshot: string,
    finalSnapshot: string,
  ) {
    const fileManager = new FileManager();
    const workDir = fileManager.generateTmpHeapDir();
    fs.ensureDirSync(workDir);
    super(workDir);
    this.baselineSnapshot = baselineSnapshot;
    this.targetSnapshot = targetSnapshot;
    this.finalSnapshot = finalSnapshot;
    this.checkSnapshotFiles();
    this.createMetaFilesOnDisk(fileManager, workDir);
  }

  private createMetaFilesOnDisk(
    fileManager: FileManager,
    workDir: string,
  ): void {
    fileManager.initDirs(config, {workDir});
    const visitOrder = this.getInteractionSteps();
    const snapSeqFile = fileManager.getSnapshotSequenceMetaFile({workDir});
    fs.writeFileSync(snapSeqFile, JSON.stringify(visitOrder, null, 2), 'UTF-8');
  }

  private checkSnapshotFiles(): void {
    if (
      !fs.existsSync(this.baselineSnapshot) ||
      !fs.existsSync(this.targetSnapshot) ||
      !fs.existsSync(this.finalSnapshot)
    ) {
      throw utils.haltOrThrow(
        'invalid file path of baseline, target, or final heap snapshots',
      );
    }
  }

  /**
   * Build a result reader from baseline, target, and final heap snapshot files.
   * The three snapshot files do not have to be in the same directory.
   * @param baselineSnapshot file path of the baseline heap snapshot
   * @param targetSnapshot file path of the target heap snapshot
   * @param finalSnapshot file path of the final heap snapshot
   * @returns the ResultReader instance
   *
   * * **Examples**:
   * ```javascript
   * const {SnapshotResultReader, findLeaks} = require('@memlab/api');
   *
   * // baseline, target, and final are file paths of heap snapshot files
   * const reader = SnapshotResultReader.fromSnapshots(baseline, target, final);
   * const leaks = await findLeaks(reader);
   * ```
   */
  static fromSnapshots(
    baselineSnapshot: string,
    targetSnapshot: string,
    finalSnapshot: string,
  ): SnapshotResultReader {
    return new SnapshotResultReader(
      baselineSnapshot,
      targetSnapshot,
      finalSnapshot,
    );
  }

  /**
   * @internal
   */
  public static from(workDir = ''): BaseResultReader {
    throw utils.haltOrThrow('SnapshotResultReader.from is not supported');
    return new BaseResultReader(workDir);
  }

  /**
   * get all snapshot files related to this SnapshotResultReader
   * @returns an array of snapshot file's absolute path
   *
   * * **Examples**:
   * ```javascript
   * const {SnapshotResultReader} = require('@memlab/api');
   *
   * // baseline, target, and final are file paths of heap snapshot files
   * const reader = SnapshotResultReader.fromSnapshots(baseline, target, final);
   * const paths = reader.getSnapshotFiles();
   * ```
   */
  public getSnapshotFiles(): string[] {
    return [this.baselineSnapshot, this.targetSnapshot, this.finalSnapshot];
  }

  /**
   * @internal
   */
  public getSnapshotFileDir(): string {
    throw utils.haltOrThrow(
      'SnapshotResultReader getSnapshotFileDir() method is not supported',
    );
    return '';
  }

  /**
   * browser interaction step sequence
   * @returns an array of browser interaction step information
   *
   * * **Examples**:
   * ```javascript
   * const {SnapshotResultReader} = require('@memlab/api');
   *
   * // baseline, target, and final are file paths of heap snapshot files
   * const reader = SnapshotResultReader.fromSnapshots(baseline, target, final);
   * const paths = reader.getInteractionSteps();
   * ```
   */
  public getInteractionSteps(): E2EStepInfo[] {
    return this.fileManager.createVisitOrderWithSnapshots(
      this.baselineSnapshot,
      this.targetSnapshot,
      this.finalSnapshot,
    );
  }

  /**
   * @internal
   * general meta data of the browser interaction run
   * @returns meta data about the entire browser interaction
   *
   * * **Examples**:
   * ```javascript
   * const {SnapshotResultReader} = require('@memlab/api');
   *
   * // baseline, target, and final are file paths of heap snapshot files
   * const reader = SnapshotResultReader.fromSnapshots(baseline, target, final);
   * const metaInfo = reader.getRunMetaInfo();
   * ```
   */
  public getRunMetaInfo(): RunMetaInfo {
    return new RunMetaInfoManager().loadRunMetaExternalTemplate();
  }

  /**
   * @internal
   */
  public cleanup(): void {
    // do nothing
  }
}

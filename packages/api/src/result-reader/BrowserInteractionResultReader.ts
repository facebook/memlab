/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {E2EStepInfo, RunMetaInfo} from '@memlab/core';

import {utils} from '@memlab/core';
import fs from 'fs-extra';
import path from 'path';
import BaseResultReader from './BaseResultReader';

/**
 * A utility entity to read all generated files from
 * the directory holding the data and results from the
 * last browser interaction run
 */
export default class BrowserInteractionResultReader extends BaseResultReader {
  /**
   * build a result reader
   * @param workDir absolute path of the directory where the data
   * and generated files of the browser interaction run were stored
   * @returns the ResultReader instance
   */
  static from(workDir = ''): BrowserInteractionResultReader {
    return new BrowserInteractionResultReader(workDir);
  }

  /**
   * get all snapshot files
   * @returns an array of snapshot file's absolute path
   */
  public getSnapshotFiles(): string[] {
    this.check();
    const dataDir = this.fileManager.getCurDataDir({workDir: this.workDir});
    return fs
      .readdirSync(dataDir)
      .filter(file => file.endsWith('heapsnapshot'))
      .map(file => path.join(dataDir, file));
  }

  /**
   * get the directory holding all snapshot files
   * @returns the absolute path of the directory
   */
  public getSnapshotFileDir(): string {
    this.check();
    return this.fileManager.getCurDataDir({workDir: this.workDir});
  }

  /**
   * browser interaction step sequence
   * @returns an array of browser interaction step info
   */
  public getInteractionSteps(): E2EStepInfo[] {
    this.check();
    const metaFile = this.fileManager.getSnapshotSequenceMetaFile({
      workDir: this.workDir,
    });
    return utils.loadTabsOrder(metaFile);
  }

  /**
   * general meta data of the browser interaction run
   * @returns meta data about the entire browser interaction
   */
  public getRunMetaInfo(): RunMetaInfo {
    this.check();
    const metaFile = this.fileManager.getRunMetaFile({
      workDir: this.workDir,
    });
    return utils.loadRunMetaInfo(metaFile);
  }
}

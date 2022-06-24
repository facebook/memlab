/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import {utils, FileManager} from '@memlab/core';
import fs from 'fs-extra';

/**
 * A utility entity to read all generated files from
 * the directory holding the data and results from
 * a memlab run
 */
export default class BaseResultReader {
  /** @ignore */
  protected workDir: string;
  /** @ignore */
  protected fileManager: FileManager;
  /** @ignore */
  private isValid: boolean;

  /**
   * build a result reader
   * @param workDir absolute path of the directory where the data
   * and generated files of the memlab run were stored
   */
  protected constructor(workDir = '') {
    this.fileManager = new FileManager();
    if (workDir === '') {
      workDir = this.fileManager.getWorkDir();
    }
    this.workDir = workDir;
    this.check();
  }

  /** @ignore */
  protected check(): void {
    this.isValid = fs.existsSync(this.workDir);
    if (!this.isValid) {
      utils.haltOrThrow(`invalid/removed data directory: ${this.workDir}`);
    }
  }

  /**
   * build a result reader
   * @param workDir absolute path of the directory where the data
   * and generated files of the memlab run were stored
   * @returns the ResultReader instance
   */
  static from(workDir = ''): BaseResultReader {
    return new BaseResultReader(workDir);
  }

  /**
   * get the directory where the data and generated files of
   * the memlab run were stored
   * @returns absolute path of the directory
   */
  public getRootDirectory(): string {
    this.check();
    return this.workDir;
  }

  /**
   * clean up data/files generated from the memlab run
   */
  public cleanup(): void {
    if (!this.isValid) {
      return;
    }
    fs.removeSync(this.workDir);
    this.isValid = false;
  }
}

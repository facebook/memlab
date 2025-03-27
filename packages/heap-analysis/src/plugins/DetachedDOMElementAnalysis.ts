/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {AnalyzeSnapshotResult, HeapAnalysisOptions} from '../PluginUtils';
import type {IHeapNode} from '@memlab/core';

import {utils, BaseOption} from '@memlab/core';
import BaseAnalysis from '../BaseAnalysis';
import pluginUtils from '../PluginUtils';
import SnapshotFileOption from '../options/HeapAnalysisSnapshotFileOption';
import OutputOption from '../options/HeapAnalysisOutputOption';

export default class DetachedDOMElementAnalysis extends BaseAnalysis {
  getCommandName(): string {
    return 'detached-DOM';
  }

  /** @internal */
  getDescription(): string {
    return 'Get detached DOM elements';
  }

  /** @internal */
  getOptions(): BaseOption[] {
    return [new SnapshotFileOption(), new OutputOption()];
  }

  /** @internal */
  public async analyzeSnapshotsInDirectory(
    directory: string,
  ): Promise<AnalyzeSnapshotResult> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const d = directory;
    throw utils.haltOrThrow(
      `${this.constructor.name} does not support analyzeSnapshotsInDirectory`,
    );
  }

  private detachedElements: IHeapNode[] = [];

  public getDetachedElements(): IHeapNode[] {
    return this.detachedElements;
  }

  /** @internal */
  async process(options: HeapAnalysisOptions): Promise<void> {
    const snapshot = await pluginUtils.loadHeapSnapshot(options);
    this.detachedElements = pluginUtils.filterOutLargestObjects(
      snapshot,
      utils.isDetachedDOMNode,
    );
    pluginUtils.printNodeListInTerminal(this.detachedElements);
  }
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {HeapAnalysisOptions} from '../PluginUtils';
import type {IHeapNode} from '@memlab/core';

import {utils, BaseOption} from '@memlab/core';
import BaseAnalysis from '../BaseAnalysis';
import pluginUtils from '../PluginUtils';
import SnapshotFileOption from '../options/HeapAnalysisSnapshotFileOption';

export default class DetachedDOMElementAnalysis extends BaseAnalysis {
  getCommandName(): string {
    return 'detached-DOM';
  }

  getDescription(): string {
    return 'Get detached DOM elements';
  }

  getOptions(): BaseOption[] {
    return [new SnapshotFileOption()];
  }

  private detachedElements: IHeapNode[] = [];

  public getDetachedElements(): IHeapNode[] {
    return this.detachedElements;
  }

  async process(options: HeapAnalysisOptions): Promise<void> {
    const snapshot = await pluginUtils.loadHeapSnapshot(options);
    this.detachedElements = pluginUtils.filterOutLargestObjects(
      snapshot,
      utils.isDetachedDOMNode,
    );
    pluginUtils.printNodeListInTerminal(this.detachedElements);
  }
}

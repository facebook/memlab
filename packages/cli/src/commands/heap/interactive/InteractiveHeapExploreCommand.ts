/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {
  CLIOptions,
  IHeapNode,
  IHeapSnapshot,
  Optional,
  Nullable,
} from '@memlab/core';

import fs from 'fs-extra';
import BaseCommand, {CommandCategory} from '../../../BaseCommand';
import {BaseOption, utils, config} from '@memlab/core';
import SnapshotFileOption from '../../../options/heap/SnapshotFileOption';
import JSEngineOption from '../../../options/heap/JSEngineOption';
import {fileManager} from '@memlab/core';
import {heapConfig, loadHeapSnapshot} from '@memlab/heap-analysis';
import CliScreen from './ui-components/CliScreen';
import HeapNodeIdOption from '../../../options/HeapNodeIdOption';

export default class InteractiveHeapViewCommand extends BaseCommand {
  getCommandName(): string {
    return 'view-heap';
  }

  getDescription(): string {
    return 'interactive command to view a single heap snapshot';
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  getExamples(): string[] {
    return ['--snapshot <HEAP_SNAPSHOT_FILE>'];
  }

  getOptions(): BaseOption[] {
    return [
      new SnapshotFileOption(),
      new JSEngineOption(),
      new HeapNodeIdOption(),
    ];
  }

  // get the heap snapshot to view
  private async getHeap(options: CLIOptions): Promise<IHeapSnapshot> {
    // load single heap snapshot
    heapConfig.isCliInteractiveMode = true;
    await loadHeapSnapshot({args: options.cliArgs});

    // get heap
    const heap = heapConfig.currentHeap;
    if (!heap) {
      throw utils.haltOrThrow(
        'heap snapshot not found, please specify a heap snapshot ' +
          `via --${new SnapshotFileOption().getOptionName()}`,
      );
    }
    return heap;
  }

  private getNodeToFocus(heap: IHeapSnapshot): Nullable<IHeapNode> {
    let node = this.getAnyDetachedNode(heap);
    if (node) {
      return node;
    }
    node = this.getNodeWithLargestRetainedSize(heap);
    if (node) {
      return node;
    }
    return heap.nodes.get(heap.nodes.length - 1);
  }

  private getAnyDetachedNode(heap: IHeapSnapshot): Nullable<IHeapNode> {
    let ret: Nullable<IHeapNode> = null;
    heap.nodes.forEach(node => {
      if (utils.isDetachedDOMNode(node) || utils.isDetachedFiberNode(node)) {
        ret = node;
        return false;
      }
    });
    return ret;
  }

  private getNodeWithLargestRetainedSize(
    heap: IHeapSnapshot,
  ): Nullable<IHeapNode> {
    let ret: Nullable<IHeapNode> = null;
    let size = 0;
    heap.nodes.forEach(node => {
      if (node.retainedSize >= size && !utils.isRootNode(node)) {
        size = node.retainedSize;
        ret = node;
      }
    });
    return ret;
  }

  // get heap node to focus on
  private getHeapNode(heap: IHeapSnapshot): IHeapNode {
    let node: Optional<IHeapNode> = null;
    if (config.focusFiberNodeId >= 0) {
      node = heap.getNodeById(config.focusFiberNodeId);
    }
    if (!node) {
      node = this.getNodeToFocus(heap);
    }
    if (!node) {
      throw utils.haltOrThrow(
        'please specify a heap node ' +
          `via --${new HeapNodeIdOption().getOptionName()}`,
      );
    }
    return node;
  }

  async run(options: CLIOptions): Promise<void> {
    const workDir = options.configFromOptions?.workDir as Optional<string>;
    const reportOutDir = fileManager.getReportOutDir({workDir});
    fs.emptyDirSync(reportOutDir);

    const heap = await this.getHeap(options);
    const node = this.getHeapNode(heap);
    new CliScreen('memlab heap viewer', heap, node).start();
  }
}

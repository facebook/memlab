/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {
  BaseOption,
  CLIOptions,
  CommandOptionExample,
  IHeapSnapshot,
  Optional,
} from '@memlab/core';
import type {ComponentDataItem} from './ui-components/HeapViewUtils';
import type {ObjectCategory} from './ui-components/HeapViewController';

import fs from 'fs-extra';
import {fileManager, utils, config} from '@memlab/core';
import {heapConfig, loadHeapSnapshot} from '@memlab/heap-analysis';
import BaseCommand, {CommandCategory} from '../../../BaseCommand';
import SnapshotFileOption from '../../../options/heap/SnapshotFileOption';
import JSEngineOption from '../../../options/heap/JSEngineOption';
import CliScreen from './ui-components/CliScreen';
import HeapNodeIdOption from '../../../options/heap/HeapNodeIdOption';
import MLClusteringOption from '../../../options/MLClusteringOption';
import SetWorkingDirectoryOption from '../../../options/SetWorkingDirectoryOption';
import HeapParserDictFastStoreSizeOption from '../../../options/heap/HeapParserDictFastStoreSizeOption';

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

  getExamples(): CommandOptionExample[] {
    return ['--snapshot <HEAP_SNAPSHOT_FILE>'];
  }

  getOptions(): BaseOption[] {
    return [
      new SnapshotFileOption(),
      new JSEngineOption(),
      new HeapNodeIdOption(),
      new MLClusteringOption(),
      new SetWorkingDirectoryOption(),
      new HeapParserDictFastStoreSizeOption(),
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

  private async getNodesToFocus(heap: IHeapSnapshot): Promise<ObjectCategory> {
    const ret: ObjectCategory = new Map();
    const nodes = this.getNodesWithLargestRetainedSize(heap);
    ret.set('large-object', nodes);
    const detachedNodes = await this.getDetachedNodes(heap);
    ret.set('detached', detachedNodes);
    return ret;
  }

  private async getDetachedNodes(
    heap: IHeapSnapshot,
  ): Promise<ComponentDataItem[]> {
    const ret: ComponentDataItem[] = [];
    const idSet = new Set<number>();
    heap.nodes.forEach(node => {
      if (utils.isDetachedDOMNode(node) || utils.isDetachedFiberNode(node)) {
        idSet.add(node.id);
      }
    });
    // get a minimal set of objects to represent all the detached DOM elements
    const dominatorIds = utils.getConditionalDominatorIds(
      idSet,
      heap,
      () => true,
    );
    dominatorIds.forEach(id => {
      const node = heap.getNodeById(id);
      if (node) {
        ret.push({tag: 'Detached', heapObject: node});
      }
    });
    return ret;
  }

  private getNodesWithLargestRetainedSize(
    heap: IHeapSnapshot,
  ): ComponentDataItem[] {
    const sizeThreshold = 2 * 1024 * 1024; // 2MB
    const ret: ComponentDataItem[] = [];
    heap.nodes.forEach(node => {
      if (node.retainedSize >= sizeThreshold && !utils.isRootNode(node)) {
        ret.push({
          tag: `${utils.getReadableBytes(node.retainedSize)}`,
          heapObject: node,
        });
      }
    });
    return ret;
  }

  // get heap node to focus on
  private async getHeapNodes(heap: IHeapSnapshot): Promise<ObjectCategory> {
    if (config.focusFiberNodeId >= 0) {
      const node = heap.getNodeById(config.focusFiberNodeId);
      if (node) {
        const map: ObjectCategory = new Map();
        map.set('Chosen', [
          {
            tag: 'Chosen',
            heapObject: node,
          },
        ]);
        return map;
      }
    }

    const category = await this.getNodesToFocus(heap);
    if (category.size === 0) {
      throw utils.haltOrThrow(
        'please specify a heap node ' +
          `via --${new HeapNodeIdOption().getOptionName()}`,
      );
    }
    return category;
  }

  async run(options: CLIOptions): Promise<void> {
    const workDir = options.configFromOptions?.workDir as Optional<string>;
    fileManager.initDirs(config, {workDir, errorWhenAbsent: true});
    const reportOutDir = fileManager.getReportOutDir({workDir});
    fs.emptyDirSync(reportOutDir);

    const heap = await this.getHeap(options);
    const nodes = await this.getHeapNodes(heap);
    new CliScreen('memlab heap viewer', heap, nodes).start();
  }
}

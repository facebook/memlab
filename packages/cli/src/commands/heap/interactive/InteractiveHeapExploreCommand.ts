/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {
  CLIOptions,
  IHeapSnapshot,
  IHeapNode,
  Optional,
  Nullable,
} from '@memlab/core';
import type {ComponentDataItem} from './ui-components/HeapViewUtils';

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

  private getNodesToFocus(heap: IHeapSnapshot): ComponentDataItem[] {
    const nodes = this.getNodesWithLargestRetainedSize(heap);
    nodes.push(...this.getDetachedNodes(heap));
    return nodes;
  }

  private getDetachedNodes(heap: IHeapSnapshot): ComponentDataItem[] {
    const ret: ComponentDataItem[] = [];
    const idSet = new Set<number>();
    const idToNodeMap = new Map<number, IHeapNode>();
    heap.nodes.forEach(node => {
      if (utils.isDetachedDOMNode(node) || utils.isDetachedFiberNode(node)) {
        idSet.add(node.id);
        idToNodeMap.set(node.id, node);
      }
    });
    // get a minimal set of objects to represent all the detached DOM elements
    const dominatorIds = utils.getConditionalDominatorIds(
      idSet,
      heap,
      () => true,
    );
    dominatorIds.forEach(id => {
      let node: Nullable<IHeapNode> = null;
      if (idToNodeMap.has(id)) {
        node = idToNodeMap.get(id) as IHeapNode;
      } else {
        node = heap.getNodeById(id) as IHeapNode;
      }
      ret.push({tag: 'Detached', heapObject: node});
    });
    ret.sort(
      (item1, item2) =>
        (item2.heapObject?.retainedSize ?? 0) -
        (item1.heapObject?.retainedSize ?? 0),
    );
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
  private getHeapNodes(heap: IHeapSnapshot): ComponentDataItem[] {
    if (config.focusFiberNodeId >= 0) {
      const node = heap.getNodeById(config.focusFiberNodeId);
      if (node) {
        return [{heapObject: node}];
      }
    }

    const nodes = this.getNodesToFocus(heap);
    if (nodes.length === 0) {
      throw utils.haltOrThrow(
        'please specify a heap node ' +
          `via --${new HeapNodeIdOption().getOptionName()}`,
      );
    }
    return nodes;
  }

  async run(options: CLIOptions): Promise<void> {
    const workDir = options.configFromOptions?.workDir as Optional<string>;
    const reportOutDir = fileManager.getReportOutDir({workDir});
    fs.emptyDirSync(reportOutDir);

    const heap = await this.getHeap(options);
    const nodes = this.getHeapNodes(heap);
    new CliScreen('memlab heap viewer', heap, nodes).start();
  }
}

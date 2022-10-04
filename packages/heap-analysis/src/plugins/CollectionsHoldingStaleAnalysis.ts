/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {HeapAnalysisOptions} from '../PluginUtils';
import type {IHeapSnapshot, IHeapNode} from '@memlab/core';

import {info, utils, BaseOption} from '@memlab/core';
import BaseAnalysis from '../BaseAnalysis';
import pluginUtils from '../PluginUtils';
import chalk from 'chalk';
import SnapshotFileOption from '../options/HeapAnalysisSnapshotFileOption';

type CollectionStat = {
  collection: IHeapNode;
  staleChildren: IHeapNode[];
  childrenSize: number;
  staleRetainedSize: number;
};

function initCollectionStat(collection: IHeapNode): CollectionStat {
  return {
    collection,
    staleChildren: [],
    childrenSize: 0,
    staleRetainedSize: 0,
  };
}

function processCollectionChildren(node: IHeapNode): CollectionStat {
  const stat = initCollectionStat(node);
  const refs = node.references;
  for (const ref of refs) {
    ++stat.childrenSize;
    const elementNode = ref.toNode;
    if (
      !utils.isDetachedDOMNode(elementNode) &&
      !utils.isDetachedFiberNode(elementNode)
    ) {
      continue;
    }
    // update stat for the collection
    stat.staleChildren.push(elementNode);
    stat.staleRetainedSize += elementNode.retainedSize;
  }
  return stat;
}

function processMapOrSet(node: IHeapNode): CollectionStat {
  const tableEdge = utils.getEdgeByNameAndType(node, 'table');
  if (!tableEdge) {
    return initCollectionStat(node);
  }
  return processCollectionChildren(tableEdge.toNode);
}

export default class CollectionsHoldingStaleAnalysis extends BaseAnalysis {
  public getCommandName(): string {
    return 'collections-with-stale';
  }

  /** @internal */
  public getDescription(): string {
    return 'Analyze collections holding stale objects';
  }

  /** @internal */
  getOptions(): BaseOption[] {
    return [new SnapshotFileOption()];
  }

  /** @internal */
  public async analyzeSnapshotsInDirectory(directory: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const d = directory;
    throw utils.haltOrThrow(
      `${this.constructor.name} does not support analyzeSnapshotsInDirectory`,
    );
  }

  private staleCollectionMapper: Map<
    string,
    (node: IHeapNode) => CollectionStat
  > = new Map([
    ['Map', processMapOrSet],
    ['Set', processMapOrSet],
    ['Array', processCollectionChildren],
  ]);

  /** @internal */
  async process(options: HeapAnalysisOptions): Promise<void> {
    const snapshot = await pluginUtils.loadHeapSnapshot(options);
    const collectionsStat = this.getCollectionsWithStaleValues(snapshot);
    this.print(collectionsStat);
  }

  private getCollectionsWithStaleValues(
    snapshot: IHeapSnapshot,
  ): CollectionStat[] {
    info.overwrite('analyzing collections...');
    const collections: CollectionStat[] = [];

    // going through collection nodes
    snapshot.nodes.forEachTraceable((node: IHeapNode) => {
      const statCollector = this.staleCollectionMapper.get(node.name);
      if (!statCollector) {
        return;
      }
      const stat = statCollector(node);
      if (stat.staleChildren.length > 0) {
        collections.push(stat);
      }
    });
    return collections;
  }

  private print(collections: CollectionStat[]): void {
    const dot = chalk.grey('·');
    const head = chalk.yellow.bind(chalk);

    if (collections.length === 0) {
      info.success('Congratulations! No collections holding stale objects');
    } else {
      info.topLevel(head('\nCollections holding stale objects:'));
    }

    collections.sort((c1, c2) => c2.staleRetainedSize - c1.staleRetainedSize);
    collections = collections.slice(0, 20);
    for (const stat of collections) {
      const collection = stat.collection;
      const collectionSize = utils.getReadableBytes(collection.retainedSize);
      const staleChildrenSize = stat.staleChildren.length;
      const childrenSize = stat.childrenSize;
      const staleDesc = `${staleChildrenSize} out of ${childrenSize} elements are stale`;
      const name = chalk.blue(collection.name);
      const id = `(${chalk.grey('@' + collection.id)})`;
      const collectionDesc = `${name} ${id} ${collectionSize} (${staleDesc})`;

      let childrenIds = stat.staleChildren.map(node => `@${node.id}`);
      if (childrenIds.length > 10) {
        childrenIds = childrenIds.slice(0, 10);
        childrenIds.push('...');
      }
      const childrenDesc = chalk.grey(childrenIds.join(', '));
      info.topLevel(`\n${dot} ${collectionDesc}:`);
      info.topLevel(`  ${childrenDesc}`);
    }
  }
}

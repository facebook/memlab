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

import chalk from 'chalk';
import {info, utils, BaseOption, IHeapEdge} from '@memlab/core';
import BaseAnalysis from '../BaseAnalysis';
import pluginUtils from '../PluginUtils';
import type {IHeapSnapshot, IHeapNode} from '@memlab/core';
import SnapshotFileOption from '../options/HeapAnalysisSnapshotFileOption';

type ObjectPatterns = {
  [patternName: string]: (str: string) => boolean;
};

/**
 * duplicated object pattern information
 */
export type ObjectRecord = {
  /** number of duplicated objects with this pattern */
  n: number;
  /** aggregated retained sizes of all duplicated objects with this pattern */
  size: number;
  /** heap object ids of the duplicated JS objects */
  ids: string[];
  /** duplicated object pattern */
  obj: string;
};

type ObjectMap = {
  [key: string]: ObjectRecord;
};

type ObjectPatternStat = {
  [patternName: string]: ObjectPatternRecord;
};

type ObjectPatternRecord = {
  n: number;
  dupN: number;
  size: number;
  dupSize: number;
};

class ObjectShallowAnalysis extends BaseAnalysis {
  private topDupObjInCnt: ObjectRecord[] = [];
  private topDupObjInCntListSize = 10;
  private topDupObjInSize: ObjectRecord[] = [];
  private topDupObjInSizeListSize = 10;
  private objectPatternsStat: ObjectPatternStat = {};

  /**
   * get CLI command name for this memory analysis;
   * use it with `memlab analyze <ANALYSIS_NAME>` in CLI
   * @returns command name
   */
  getCommandName(): string {
    return 'object-shallow';
  }

  /**
   * get a textual description of the memory analysis
   * @returns textual description
   */
  getDescription(): string {
    return 'Get objects by key and value, without recursing into sub-objects';
  }

  /** @ignore */
  getOptions(): BaseOption[] {
    return [new SnapshotFileOption()];
  }

  /** @ignore */
  async process(options: HeapAnalysisOptions): Promise<void> {
    const snapshot = await pluginUtils.loadHeapSnapshot(options);
    const objectMap = this.getPreprocessedObjectMap(snapshot);
    this.calculateobjectPatternsStatistics(objectMap);
    this.calculateTopDuplicatedObjectsInCount(objectMap);
    this.calculateTopDuplicatedObjectsInSize(objectMap);
    this.print();
  }

  /**
   * get the top duplicated object in terms of duplicated object count
   * @returns an array of the top-duplicated objects' information
   */
  public getTopDuplicatedObjectInCount(): ObjectRecord[] {
    return this.topDupObjInCnt;
  }

  /** @ignore */
  private getPreprocessedObjectMap(snapshot: IHeapSnapshot) {
    info.overwrite('building object map...');
    const objectMap = Object.create(null);

    snapshot.nodes.forEach((node: IHeapNode) => {
      if (this.shouldIgnoreNode(node)) {
        return;
      }

      const obj = this.nodeToObject(node);
      const value = JSON.stringify(obj);
      objectMap[value] = objectMap[value] || {
        n: 0,
        size: 0,
        ids: [],
        obj: JSON.stringify(obj),
      };
      const record = objectMap[value];
      ++record.n;
      record.size += node.retainedSize;
      record.ids.push(node.id);
    });
    return objectMap;
  }

  /** @ignore */
  private nodeToObject(node: IHeapNode): unknown {
    type AlphaNumeric = string | number;
    const result: Record<
      AlphaNumeric,
      AlphaNumeric | Array<AlphaNumeric | null> | boolean | null
    > = {};

    for (const edge of node.references) {
      if (edge.type === 'property' && edge.name_or_index != '__proto__') {
        const key = edge.name_or_index;
        const value = edge.toNode;
        if (utils.isStringNode(value)) {
          result[key] = utils.getStringNodeValue(edge.toNode);
        } else if (value.type === 'number') {
          result[key] = utils.getNumberNodeValue(edge.toNode);
        } else if (value.type === 'boolean') {
          result[key] = utils.getBooleanNodeValue(edge.toNode);
        } else {
          // shallow analysis, just put the id as a string
          result[key] = 'REFERENCE_' + value.id;
        }
      }
    }
    return {class: node.name, object: result};
  }

  /** @ignore */
  private static objectPatternsToObserve: ObjectPatterns = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    'All objects': (_: string) => true,
  };

  /** @ignore */
  private shouldIgnoreNode(node: IHeapNode): boolean {
    let hasAHiddenReferrer = false;
    node.forEachReferrer((edge: IHeapEdge) => {
      if (edge.type === 'hidden') {
        hasAHiddenReferrer = true;
        return {stop: true};
      }
    });

    return !(
      !hasAHiddenReferrer &&
      node.type === 'object' &&
      node.name !== 'Array' &&
      node.name !== 'ArrayBuffer' &&
      node.name !== 'Set' &&
      node.name !== 'Map' &&
      !node.name.startsWith('Window') &&
      !node.name.startsWith('system /')
    );
  }

  /** @ignore */
  private textEllipsis(
    str: string,
    maxLength: number,
    {side = 'end', ellipsis = '...'} = {},
  ) {
    if (str.length > maxLength) {
      switch (side) {
        case 'start':
          return ellipsis + str.slice(-(maxLength - ellipsis.length));
        case 'end':
        default:
          return str.slice(0, maxLength - ellipsis.length) + ellipsis;
      }
    }
    return str;
  }

  /** @ignore */
  private rankRecords(
    objectMap: ObjectMap,
    compare: (a: ObjectRecord, b: ObjectRecord) => number,
    listSize: number,
  ): ObjectRecord[] {
    let rank: ObjectRecord[] = [];
    for (const [, record] of Object.entries(objectMap)) {
      if (record.n <= 1) {
        continue; // only care about duplicated objects
      }
      let i = 0;
      for (i = rank.length - 1; i >= 0; --i) {
        const item = rank[i];
        if (compare(item, record) >= 0) {
          rank.splice(i + 1, 0, record);
          break;
        }
      }
      if (i < 0) {
        rank.unshift(record);
      }
      rank = rank.slice(0, listSize);
    }
    return rank;
  }

  /** @ignore */
  private calculateTopDuplicatedObjectsInCount(objectMap: ObjectMap): void {
    info.overwrite('calculating top duplicated objects in count...');
    this.topDupObjInCnt = this.rankRecords(
      objectMap,
      (item1, item2) => item1.n - item2.n,
      this.topDupObjInCntListSize,
    );
  }

  /** @ignore */
  private calculateTopDuplicatedObjectsInSize(objectMap: ObjectMap): void {
    info.overwrite('calculating top duplicated objects in size...');
    this.topDupObjInSize = this.rankRecords(
      objectMap,
      (item1, item2) => item1.size - item2.size,
      this.topDupObjInSizeListSize,
    );
  }

  /** @ignore */
  private calculateobjectPatternsStatistics(objectMap: ObjectMap): void {
    info.overwrite('calculating statistics for specified object patterns...');

    const objectPatternStat = Object.create(null);
    for (const [str, record] of Object.entries(objectMap)) {
      patternLoop: for (const [patternName, patternCheck] of Object.entries(
        ObjectShallowAnalysis.objectPatternsToObserve,
      )) {
        if (!patternCheck(str)) {
          continue patternLoop;
        }
        objectPatternStat[patternName] = objectPatternStat[patternName] || {
          n: 0,
          dupN: 0,
          size: 0,
          dupSize: 0,
        };
        const item = objectPatternStat[patternName];
        item.n += record.n;
        item.size += record.size;
        if (record.n > 1) {
          item.dupN += record.n - 1;
          item.dupSize += (record.size * (record.n - 1)) / record.n;
        }
      }
    }
    this.objectPatternsStat = objectPatternStat;
  }

  /** @ignore */
  private print(): void {
    const sep = chalk.grey(', ');
    const colon = chalk.grey(': ');
    const beg = chalk.grey('[');
    const end = chalk.grey(']');
    const dot = chalk.grey('·');
    const head = chalk.yellow.bind(chalk);

    // print statistics of specified object patterns
    for (const [str, item] of Object.entries(this.objectPatternsStat)) {
      info.topLevel(head(`\n${str}`));
      let p = utils.getReadablePercent(item.dupN / item.n);
      info.topLevel(`${dot}Count: ${item.n} (${p} are duplicated)`);

      const size = utils.getReadableBytes(item.size);
      p = utils.getReadablePercent(item.dupSize / item.size);
      info.topLevel(`${dot}Size: ${size} (${p} are duplicated)`);
    }

    info.topLevel(head('\nTop duplicated objects in count'));
    let len = Math.min(15, this.topDupObjInCnt.length);
    for (let i = 0; i < len; ++i) {
      const item = this.topDupObjInCnt[i];
      const size = utils.getReadableBytes(item.size);
      const str = `"${chalk.blue(this.textEllipsis(item.obj, 100))}"`;
      info.topLevel(` ${dot}${beg}${item.n}${sep}${size}${end}${colon}${str}`);
    }

    len = Math.min(15, this.topDupObjInSize.length);
    info.topLevel(head('\nTop duplicated objects in size:'));
    for (let i = 0; i < len; ++i) {
      const item = this.topDupObjInSize[i];
      const size = utils.getReadableBytes(item.size);
      const str = `"${chalk.blue(this.textEllipsis(item.obj, 100))}"`;
      const exampleIds = item.ids.slice(0, 10).map((id: string) => `@${id}`);
      let examples = exampleIds.join(', ');
      if (exampleIds.length < item.ids.length) {
        examples += ' ...';
      }
      examples = chalk.grey(examples);
      info.topLevel(
        `\n ${dot}${beg}${size}${sep}${item.n}${end}${colon}${str}`,
      );
      info.topLevel(`    node examples: ${examples}`);
    }
  }
}

export default ObjectShallowAnalysis;

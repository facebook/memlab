/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {IHeapSnapshot, IHeapNode} from '@memlab/core';
import type {HeapAnalysisOptions} from '../PluginUtils';

import chalk from 'chalk';
import {info, utils, BaseOption} from '@memlab/core';
import BaseAnalysis from '../BaseAnalysis';
import pluginUtils from '../PluginUtils';
import SnapshotFileOption from '../options/HeapAnalysisSnapshotFileOption';

type StringPatterns = {
  [patternName: string]: (str: string) => boolean;
};

type StringMap = {
  [str: string]: StringRecord;
};

type StringPatternStat = {
  [patternName: string]: StringPatternRecord;
};

type StringPatternRecord = {
  n: number;
  dupN: number;
  size: number;
  dupSize: number;
};

/**
 * duplicated string pattern information
 */
export type StringRecord = {
  /** number of duplicated strings with this pattern */
  n: number;
  /** aggregated retained sizes of all duplicated strings with this pattern */
  size: number;
  /** heap object ids of the duplicated string */
  ids: string[];
  /** duplicated string pattern */
  str?: string;
};

/**
 * This analysis finds duplicated string instance in JavaScript heap
 * and rank them based on the duplicated string size and count.
 */
export default class StringAnalysis extends BaseAnalysis {
  private topDupStrInCnt: StringRecord[] = [];
  private topDupStrInCntListSize = 10;
  private topDupStrInSize: StringRecord[] = [];
  private topDupStrInSizeListSize = 10;
  private stringPatternsStat: StringPatternStat = {};

  /**
   * get the top duplicated string in terms of duplicated string count
   * @returns an array of the top-duplicated strings' information
   */
  public getTopDuplicatedStringsInCount(): StringRecord[] {
    return this.topDupStrInCnt;
  }

  /**
   * collect statistics for specified string patterns
   * pattern name -> string pattern checker
   */
  private static stringPatternsToObserve: StringPatterns = {
    // all strings (excluding sliced strings)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    'All strings': (_: string) => true,

    'Relay DataID': (str: string) => {
      return str.startsWith('Uzpf');
    },

    'Relay DataID composite': (str: string) => {
      return /^\d+\{"/.test(str);
    },

    // example: "{"query_id":-7401558440803739294,"serialized":"z5_eJztfQ...
    'Relay query': (str: string) => {
      return str.startsWith('{"query_id":');
    },

    'Relay client string': (str: string) => {
      return str.startsWith('client:');
    },

    // example: n00je7tq arfg74bv qs9ysxi8 k77z8yql i09qtzwb n7fi1qx3
    'Element class name': (str: string) => {
      const arr = str.split(' ');
      if (arr.length < 6) {
        return false;
      }
      for (const s of arr) {
        if (s.length !== 8) {
          return false;
        }
      }
      return true;
    },
  };

  /**
   * get CLI command name for this memory analysis;
   * use it with `memlab analyze <ANALYSIS_NAME>` in CLI
   * @returns command name
   */
  public getCommandName(): string {
    return 'string';
  }

  /**
   * get a textual description of the memory analysis
   * @returns textual description
   * @internal
   */
  public getDescription(): string {
    return 'Find duplicated string instances in heap';
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

  private static shouldIgnoreNode(node: IHeapNode): boolean {
    if (!utils.isStringNode(node) || utils.isSlicedStringNode(node)) {
      return true;
    }

    // ignore strings retained by code
    const dominators = utils.getAllDominators(node);
    const hasCodeDominator = dominators.reduce(
      (prev, cur) => prev && cur.type !== 'code',
      true,
    );
    return !hasCodeDominator;
  }

  /** @internal */
  async process(options: HeapAnalysisOptions): Promise<void> {
    const snapshot = await pluginUtils.loadHeapSnapshot(options);
    const stringMap = this.getPreprocessedStringMap(snapshot);
    this.calculateStringPatternsStatistics(stringMap);
    this.calculateTopDuplicatedStringsInCount(stringMap);
    this.calculateTopDuplicatedStringsInSize(stringMap);
    this.print();
  }

  private getPreprocessedStringMap(snapshot: IHeapSnapshot): StringMap {
    info.overwrite('building string map...');
    const stringMap = Object.create(null);

    // going through string nodes
    snapshot.nodes.forEach((node: IHeapNode) => {
      if (StringAnalysis.shouldIgnoreNode(node)) {
        return;
      }

      const strValue = utils.getStringNodeValue(node);
      stringMap[strValue] = stringMap[strValue] || {
        n: 0,
        size: 0,
        ids: [],
      };
      const record = stringMap[strValue];
      ++record.n;
      record.size += node.retainedSize;
      record.ids.push(node.id);
    });
    return stringMap;
  }

  private rankRecords(
    stringMap: StringMap,
    compare: (a: StringRecord, b: StringRecord) => number,
    listSize: number,
  ): StringRecord[] {
    let rank: StringRecord[] = [];
    for (const [str, record] of Object.entries(stringMap)) {
      if (record.n <= 1) {
        continue; // only care about duplicated strings
      }
      let i = 0;
      for (i = rank.length - 1; i >= 0; --i) {
        const item = rank[i];
        if (compare(item, record) >= 0) {
          rank.splice(i + 1, 0, {str, ...record});
          break;
        }
      }
      if (i < 0) {
        rank.unshift({str, ...record});
      }
      rank = rank.slice(0, listSize);
    }
    return rank;
  }

  private calculateTopDuplicatedStringsInCount(stringMap: StringMap): void {
    info.overwrite('calculating top duplicated strings in count...');
    this.topDupStrInCnt = this.rankRecords(
      stringMap,
      (item1, item2) => item1.n - item2.n,
      this.topDupStrInCntListSize,
    );
  }

  private calculateTopDuplicatedStringsInSize(stringMap: StringMap): void {
    info.overwrite('calculating top duplicated strings in size...');
    this.topDupStrInSize = this.rankRecords(
      stringMap,
      (item1, item2) => item1.size - item2.size,
      this.topDupStrInSizeListSize,
    );
  }

  private calculateStringPatternsStatistics(stringMap: StringMap): void {
    info.overwrite('calculating statistics for specified string patterns...');

    const strPatternStat = Object.create(null);
    for (const [str, record] of Object.entries(stringMap)) {
      patternLoop: for (const [patternName, patternCheck] of Object.entries(
        StringAnalysis.stringPatternsToObserve,
      )) {
        if (!patternCheck(str)) {
          continue patternLoop;
        }
        strPatternStat[patternName] = strPatternStat[patternName] || {
          n: 0,
          dupN: 0,
          size: 0,
          dupSize: 0,
        };
        const item = strPatternStat[patternName];
        item.n += record.n;
        item.size += record.size;
        if (record.n > 1) {
          item.dupN += record.n - 1;
          item.dupSize += (record.size * (record.n - 1)) / record.n;
        }
      }
    }
    this.stringPatternsStat = strPatternStat;
  }

  private print(): void {
    const sep = chalk.grey(', ');
    const colon = chalk.grey(': ');
    const beg = chalk.grey('[');
    const end = chalk.grey(']');
    const dot = chalk.grey('·');
    const head = chalk.yellow.bind(chalk);

    // print statistics of specified string patterns
    for (const [str, item] of Object.entries(this.stringPatternsStat)) {
      info.topLevel(head(`\n${str}`));
      let p = utils.getReadablePercent(item.dupN / item.n);
      info.topLevel(`${dot}Count: ${item.n} (${p} are duplicated)`);

      const size = utils.getReadableBytes(item.size);
      p = utils.getReadablePercent(item.dupSize / item.size);
      info.topLevel(`${dot}Size: ${size} (${p} are duplicated)`);
    }

    info.topLevel(head('\nTop duplicated strings in count'));
    for (let i = 0; i < this.topDupStrInCnt.length; ++i) {
      const item = this.topDupStrInCnt[i];
      const size = utils.getReadableBytes(item.size);
      const str = `"${chalk.blue(item.str)}"`;
      info.topLevel(` ${dot}${beg}${item.n}${sep}${size}${end}${colon}${str}`);
    }

    info.topLevel(head('\nTop duplicated strings in size:'));
    for (let i = 0; i < this.topDupStrInSize.length; ++i) {
      const item = this.topDupStrInSize[i];
      const size = utils.getReadableBytes(item.size);
      const str = `"${chalk.blue(item.str)}"`;
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

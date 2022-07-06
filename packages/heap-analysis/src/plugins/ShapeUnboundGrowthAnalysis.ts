/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {IHeapSnapshot, Nullable} from '@memlab/core';
import type {HeapAnalysisOptions} from '../PluginUtils';

import chalk from 'chalk';
import {BaseOption, config, info, serializer, utils} from '@memlab/core';
import SnapshotDirectoryOption from '../options/HeapAnalysisSnapshotDirectoryOption';
import BaseAnalysis from '../BaseAnalysis';
import pluginUtils from '../PluginUtils';

type ShapesInfo = {
  [shape: string]: ShapeInfo;
};

type ShapeInfo = {
  shape: string;
  n: number;
  examples: number[];
  size: number;
  ids: Set<number>;
};

type ShapeSummary = {
  shape: string;
  counts: number[];
  sizes: number[];
  examples: number[];
};

export default class ShapeUnboundGrowthAnalysis extends BaseAnalysis {
  private shapesOfInterest: Nullable<Set<string>> = null;
  private shapesWithUnboundGrowth: ShapeSummary[] = [];

  public getCommandName(): string {
    return 'unbound-shape';
  }

  /** @internal */
  public getDescription(): string {
    return 'Get shapes with unbound growth';
  }

  /** @internal */
  getOptions(): BaseOption[] {
    return [new SnapshotDirectoryOption()];
  }

  /** @internal */
  public async analyzeSnapshotFromFile(file: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const f = file;
    throw utils.haltOrThrow(
      `${this.constructor.name} does not support analyzeSnapshotFromFile`,
    );
  }

  public getShapesWithUnboundGrowth(): ShapeSummary[] {
    return this.shapesWithUnboundGrowth;
  }

  /** @internal */
  public async process(options: HeapAnalysisOptions): Promise<void> {
    let list: ShapeSummary[] = await pluginUtils.snapshotMapReduce(
      this.getShapesInfo.bind(this),
      this.getSummary,
      options,
    );

    this.retrieveShapesOfInterest(list);

    list = await pluginUtils.snapshotMapReduce(
      this.getShapesInfo.bind(this),
      this.getSummary,
      options,
    );
    this.shapesOfInterest = null;
    this.shapesWithUnboundGrowth = list;
    this.print(list);
  }

  private retrieveShapesOfInterest(list: ShapeSummary[]): void {
    this.shapesOfInterest = new Set();
    for (const summary of list) {
      this.shapesOfInterest.add(summary.shape);
    }
  }

  private getShapesInfo(snapshot: IHeapSnapshot): ShapesInfo {
    const population: ShapesInfo = Object.create(null);
    const shapes = this.shapesOfInterest;

    // group objects based on their shapes
    snapshot.nodes.forEach(node => {
      if (
        (node.type !== 'object' && !utils.isStringNode(node)) ||
        config.nodeIgnoreSetInShape.has(node.name)
      ) {
        return;
      }
      const key: string = serializer.summarizeNodeShape(node, {color: true});
      if (shapes && !shapes.has(key)) {
        return;
      }

      population[key] =
        population[key] ||
        ({
          shape: key,
          n: 0,
          examples: [] as number[],
          ids: new Set<number>(),
        } as ShapeInfo);

      const record = population[key];
      ++record.n;
      if (record.examples.length < 3) {
        record.examples.push(node.id);
      }

      if (shapes && shapes.has(key)) {
        record.ids.add(node.id);
      }
    });

    if (shapes) {
      for (const record of Object.values(population)) {
        record.size = pluginUtils.aggregateDominatorMetrics(
          record.ids,
          snapshot,
          () => true,
          node => node.retainedSize,
        );
        record.ids = new Set();
      }
    }

    return population;
  }

  private getSummary(ShapesInfoList: ShapesInfo[]): ShapeSummary[] {
    const shapes = Object.create(null);
    for (const population of ShapesInfoList) {
      for (const key in population) {
        shapes[key] = shapes[key] || {
          decrease: false,
          increase: false,
          counts: [],
          sizes: [],
          examples: [],
        };

        if (shapes[key].decrease) {
          continue;
        }
        const counts = shapes[key].counts;
        const n = population[key].n;
        if (counts.length > 0 && counts[counts.length - 1] > n) {
          shapes[key].decrease = true;
          continue;
        }
        if (counts.length > 0 && counts[counts.length - 1] < n) {
          shapes[key].increase = true;
        }
        counts.push(n);
        shapes[key].sizes.push(population[key].size);

        const examples = shapes[key].examples;
        examples.push(population[key].examples[0]);
      }
    }

    const result = [];
    for (const key in shapes) {
      if (!shapes[key].increase) {
        continue;
      }
      if (shapes[key].decrease || shapes[key].counts.length <= 1) {
        continue;
      }
      const counts = shapes[key].counts;
      if (counts[counts.length - 1] < 1000) {
        continue;
      }
      const examples = shapes[key].examples;
      const sizes = shapes[key].sizes;
      result.push({shape: key, counts, examples, sizes});
    }

    result.sort(
      (v1, v2) =>
        v2.counts[v2.counts.length - 1] - v1.counts[v1.counts.length - 1],
    );

    return result;
  }

  private print(list: ShapeSummary[]): void {
    const colon = chalk.grey(': ');
    const sep = chalk.grey(' > ');
    const sep2 = chalk.grey(', ');
    const dot = chalk.grey('· ');

    for (const item of list) {
      const shapeStat = [];
      for (let i = 0; i < item.counts.length; ++i) {
        let size = utils.getReadableBytes(item.sizes[i]);
        size = chalk.grey(size);
        shapeStat.push(`${item.counts[i]} (${size})`);
      }
      const countHistory = shapeStat.join(sep);
      const examples = item.examples.map(v => `@${v}`).join(sep2);
      const msg = `${dot}${item.shape}${colon}${countHistory}${colon}${examples}`;
      info.topLevel(msg);
    }
  }
}

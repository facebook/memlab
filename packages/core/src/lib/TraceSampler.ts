/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import config from './Config';
import info from './Console';
import utils from './Utils';

export type TraceSamplerOption = {
  maxSample?: number;
};

export default class TraceSampler {
  // the max number of traces after sampling
  private maxCount = config.maxSamplesForClustering;
  private processed = 0;
  private selected = 0;
  private population = -1;

  constructor(n: number, options: TraceSamplerOption = {}) {
    this.maxCount = options.maxSample ?? config.maxSamplesForClustering;
    this.init(n);
  }

  public init(n: number) {
    this.processed = 0;
    this.selected = 0;
    this.population = n;
    this.calculateSampleRatio(n);
  }

  private calculateSampleRatio(n: number): number {
    const sampleRatio = Math.min(1, this.maxCount / n);
    if (sampleRatio < 1) {
      info.warning('Sampling trace due to a large number of traces:');
      info.lowLevel(` Number of Traces: ${n}`);
      info.lowLevel(
        ` Sampling Ratio: ${utils.getReadablePercent(sampleRatio)}`,
      );
    }
    return sampleRatio;
  }

  /**
   * The caller decide to give up sampling this time.
   * This `giveup` and the `sample` method in aggregation should be
   * called `this.population` times.
   *
   * For example, if `giveup` is called n1 times,
   * and `sample` is called n2 times, then n1 + n2 === this.population.
   */
  public giveup(): void {
    ++this.processed;
  }

  /**
   * This sample method should be called precisely this.population times.
   * @returns true if this sample should be taken
   */
  public sample(): boolean {
    if (this.processed >= this.population) {
      throw utils.haltOrThrow(
        `processing ${this.processed + 1} samples but total population is ${
          this.population
        }`,
      );
    }
    // use large number to mod here to avoid too much console I/O
    if (!config.isContinuousTest && this.processed % 771 === 0) {
      const percent = utils.getReadablePercent(
        this.processed / this.population,
      );
      info.overwrite(
        `progress: ${this.processed} / ${this.population} (${percent})`,
      );
    }
    const dynamicRatio =
      (this.maxCount - this.selected) / (this.population - this.processed);
    // increase the counter indicating how many samples has been processed
    ++this.processed;
    if (Math.random() <= dynamicRatio) {
      ++this.selected;
      return true;
    }
    return false;
  }
}

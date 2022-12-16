/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

'use strict';

import type {E2EStepInfo, PlotMemoryOptions} from '../Types';

import babar from 'babar';
import config from '../Config';
import info from '../Console';
import utils from '../Utils';
import fileManager from '../FileManager';

class MemoryBarChart {
  plotMemoryBarChart(options: PlotMemoryOptions = {}) {
    const plotData = this.loadPlotData(options);
    // normalize plot data
    const minY = 1;
    const maxY = plotData.reduce((m, v) => Math.max(m, v[1]), 0) * 1.15;
    const yFractions = 1;
    const yLabelWidth =
      1 +
      Math.max(
        minY.toFixed(yFractions).length,
        maxY.toFixed(yFractions).length,
      );
    const maxWidth = process.stdout.columns - 10;
    const idealWidth = Math.max(2 * plotData.length + 2 * yLabelWidth, 10);
    const plotWidth = Math.min(idealWidth, maxWidth);

    info.topLevel('Memory usage across all steps:');
    info.topLevel(
      babar(plotData, {
        color: 'green',
        width: plotWidth,
        height: 10,
        xFractions: 0,
        yFractions,
        minY,
        maxY,
      }),
    );
    info.topLevel('');
  }

  private loadPlotDataFromTabsOrder(tabsOrder: E2EStepInfo[]): number[][] {
    for (const tab of tabsOrder) {
      if (!(tab.JSHeapUsedSize > 0)) {
        if (config.verbose) {
          info.error('Memory usage data incomplete');
        }
        return [];
      }
    }
    const plotData = tabsOrder.map((tab, idx) => [
      idx + 1,
      ((tab.JSHeapUsedSize / 100000) | 0) / 10,
    ]);

    // the graph component cannot handle an array with a single element
    while (plotData.length < 2) {
      plotData.push([plotData.length + 1, 0]);
    }
    return plotData;
  }

  private loadPlotDataFromWorkDir(options: PlotMemoryOptions = {}): number[][] {
    const tabsOrder = utils.loadTabsOrder(
      fileManager.getSnapshotSequenceMetaFile(options),
    );
    return this.loadPlotDataFromTabsOrder(tabsOrder);
  }

  private loadPlotData(options: PlotMemoryOptions = {}): number[][] {
    // plot data for a single run
    if (!options.controlWorkDir && !options.testWorkDir) {
      return this.loadPlotDataFromWorkDir(options);
    }
    // plot data for control and test run
    const controlPlotData = this.loadPlotDataFromWorkDir({
      workDir: options.controlWorkDir,
    });
    const testPlotData = this.loadPlotDataFromWorkDir({
      workDir: options.testWorkDir,
    });
    // merge plot data
    return this.mergePlotData([controlPlotData, testPlotData]);
  }

  private mergePlotData(plotDataArray: Array<number[][]>) {
    const plotData = [];
    let xIndex = 1; // starts from 1
    for (let i = 0; i < plotDataArray.length; ++i) {
      const data = plotDataArray[i];
      for (const [, yValue] of data) {
        plotData.push([xIndex++, yValue]);
      }
      // push blank separators
      if (i < plotDataArray.length - 1) {
        for (let k = 0; k < 3; ++k) {
          plotData.push([xIndex++, 0]);
        }
      }
    }
    return plotData;
  }
}

export default new MemoryBarChart();

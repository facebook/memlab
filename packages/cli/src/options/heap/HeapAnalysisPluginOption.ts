/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {ParsedArgs} from 'minimist';
import {AnyRecord, MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';
import optionConstants from '../lib/OptionConstant';

export default class HeapAnalysisPluginOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.HEAP_ANALYSIS_PLUGIN_FILE;
  }

  getDescription(): string {
    return (
      'specify the external heap analysis plugin file ' +
      '(must be a vanilla JS file ended with `Analysis.js` suffix)'
    );
  }

  async parse(
    config: MemLabConfig,
    args: ParsedArgs,
  ): Promise<{workDir?: string}> {
    const name = this.getOptionName();
    const ret: AnyRecord = {};
    const heapAnalysisPlugin = args[name];
    if (heapAnalysisPlugin) {
      ret.heapAnalysisPlugin = heapAnalysisPlugin;
    }
    return ret;
  }
}

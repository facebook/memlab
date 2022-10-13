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
import type {MemLabConfig} from '@memlab/core';
import {BaseOption, utils} from '@memlab/core';
import {E2EUtils} from '@memlab/e2e';
import optionConstants from '../lib/OptionConstant';

export default class ScenarioFileOption extends BaseOption {
  getOptionName(): string {
    return optionConstants.optionNames.SCENARIO;
  }

  getDescription(): string {
    return 'set file path loading test scenario';
  }

  getExampleValues(): string[] {
    return ['/tmp/scenario.js'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    const name = this.getOptionName();
    if (args[name]) {
      const scenarioFile = args[name] as string;
      // load scenario file and get target app name
      config.scenario = utils.loadScenario(scenarioFile);
      config.targetApp = E2EUtils.getScenarioAppName(config.scenario);
    }
  }
}

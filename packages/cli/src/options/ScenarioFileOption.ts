/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption, utils} from '@memlab/core';
import {E2EUtils} from '@memlab/e2e';

export default class ScenarioFileOption extends BaseOption {
  getOptionName(): string {
    return 'scenario';
  }

  getDescription(): string {
    return 'set file path loading test scenario';
  }

  getExampleValues(): string[] {
    return ['/tmp/scenario.js'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args.scenario) {
      config.scenarioFile = args.scenario as string;
      // load scenario file and get target app name
      const scenario = utils.loadScenario(config.scenarioFile);
      config.targetApp = E2EUtils.getScenarioAppName(scenario);
    }
  }
}

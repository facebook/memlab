/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

'use strict';

import type {
  AnyOptions,
  Cookies,
  IE2EScenarioSynthesizer,
  IE2EScenarioVisitPlan,
  E2EScenarioSynthesizerConstructor,
  IScenario,
  Optional,
  Nullable,
} from '@memlab/core';
import fs from 'fs';
import path from 'path';
import {utils, config as defaultConfig} from '@memlab/core';
import testRunnerLoader from '../../TestRunnerLoader';
import type {MemLabConfig} from '@memlab/core';
import E2EUtils from '../E2EUtils';

type VisitPlanPack = {
  visitPlan: IE2EScenarioVisitPlan;
  cookies: Cookies;
  synthesizer: IE2EScenarioSynthesizer;
};

type TestPlanOptions = {
  config?: MemLabConfig;
};

export class TestPlanner {
  private synthesizers: Map<string, IE2EScenarioSynthesizer>;
  private visitPlan: IE2EScenarioVisitPlan;
  private cookies: Cookies;
  private scenario: Optional<IScenario>;
  private origin: Nullable<string>;
  private synthesizer: IE2EScenarioSynthesizer;
  private config: MemLabConfig;

  constructor(options: TestPlanOptions = {}) {
    this.config = options.config ?? defaultConfig;
    this.synthesizers = new Map();
    this.scenario = null;
  }

  private initSynthesizers(): void {
    if (this.synthesizers.size > 0) {
      return;
    }
    this.synthesizers = new Map();
    const runners = testRunnerLoader.load();
    runners.forEach((Constructor: E2EScenarioSynthesizerConstructor) => {
      const synthesizer = new Constructor(this.config);
      this.synthesizers.set(synthesizer.getAppName(), synthesizer);
    });
  }

  getVisitPlan(): IE2EScenarioVisitPlan {
    this.init();
    return this.visitPlan;
  }

  getCookies(): Cookies {
    this.init();
    return this.cookies;
  }

  // get origin defined in config
  getOrigin(): Nullable<string> {
    this.init();
    return this.origin;
  }

  getSynthesizer(options: AnyOptions = {}): IE2EScenarioSynthesizer {
    this.init(options);
    return this.synthesizer;
  }

  // preload synthesizer before other meta data is ready
  // this is mainly used for getting synthesizer settings
  preloadSynthesizer(): IE2EScenarioSynthesizer {
    const targetApp = this.config.targetApp;
    this.initSynthesizers();
    if (!this.synthesizers.has(targetApp)) {
      utils.haltOrThrow(`unknown app: ${targetApp}`);
    }
    return this.synthesizers.get(targetApp) as IE2EScenarioSynthesizer;
  }

  private init(options: AnyOptions = {}): void {
    this.initSynthesizers();
    const {visitPlan, cookies, synthesizer} = this.generateVisitPlan(options);
    this.visitPlan = visitPlan;
    this.cookies = cookies;
    this.origin = synthesizer.getOrigin();
    this.synthesizer = synthesizer;
  }

  private prepareSynthesizer(): IE2EScenarioSynthesizer {
    if (this.config.scenario) {
      this.scenario = this.config.scenario;
    } else {
      // otherwise no action since no scenario definition provided
      // config.targetTab and config.targetApp should be set
    }

    if (this.scenario) {
      this.config.targetTab = utils.getScenarioName(this.scenario);
      this.config.targetApp = E2EUtils.getScenarioAppName(this.scenario);
    }

    if (!this.synthesizers.has(this.config.targetApp)) {
      utils.haltOrThrow(`unknown app: ${this.config.targetApp}`);
    }

    const synthesizer = this.synthesizers.get(
      this.config.targetApp,
    ) as IE2EScenarioSynthesizer;

    // if running from a scenario file, register this
    // new scenario in the synthesizer
    if (this.scenario) {
      synthesizer.injectPlan(this.config.targetTab, this.scenario);
    }

    return synthesizer;
  }

  private generateVisitPlan(options: AnyOptions = {}): VisitPlanPack {
    const synthesizer = this.prepareSynthesizer();
    const visitPlan = synthesizer.synthesisForTarget(this.config.targetTab);

    this.assignSnapshotIds(visitPlan);
    this.setSnapshotMode(visitPlan);
    const cookies =
      options.needCookies === false
        ? []
        : this.loadCookies(visitPlan, synthesizer);

    return {visitPlan, cookies, synthesizer};
  }

  loadCookies(
    visitPlan: IE2EScenarioVisitPlan,
    synthesizer: IE2EScenarioSynthesizer,
  ): Cookies {
    if (this.scenario && this.scenario.cookies) {
      const cookies = this.scenario.cookies();
      return this.populateDomainInCookiesFromScenario(cookies, this.scenario);
    }
    let cookieFile = synthesizer.getCookieFile(visitPlan);

    // if no cookie file is specified
    if (cookieFile == null && this.config.externalCookiesFile == null) {
      return [];
    }

    cookieFile =
      this.config.externalCookiesFile ??
      path.join(this.config.persistentDataDir, cookieFile as string);
    if (!fs.existsSync(cookieFile)) {
      utils.haltOrThrow(`cookie file doesn't exist: ${cookieFile}`);
    }

    const cookies = JSON.parse(fs.readFileSync(cookieFile, 'UTF-8')) as Cookies;
    return this.populateDomainInCookies(
      cookies,
      synthesizer.getDomain(),
      synthesizer.getDomainPrefixes(),
    );
  }

  private populateDomainInCookiesFromScenario(
    cookies: Cookies,
    scenario: IScenario,
  ): Cookies {
    const ret = [];
    const url = new URL(scenario.url());
    const domain = '.' + url.hostname.split('.').slice(1).join('.');
    for (const cookie of cookies) {
      if (cookie.domain) {
        ret.push({...cookie});
      } else {
        ret.push({...cookie, domain});
      }
    }
    return ret;
  }

  private populateDomainInCookies(
    cookies: Cookies,
    domain: string,
    domainPrefixes: string[],
  ): Cookies {
    const cookiesTemplate = cookies;
    const ret = [];
    const prefixes = new Set(['', ...domainPrefixes]);
    for (const prefix of prefixes) {
      for (const cookie of cookiesTemplate) {
        ret.push({...cookie, domain: `${prefix}${domain}`});
      }
    }
    return ret;
  }

  private setSnapshotMode(visitPlan: IE2EScenarioVisitPlan): void {
    if (!this.config.isFullRun) {
      return;
    }
    const tabsOrder = visitPlan.tabsOrder;
    for (const tab of tabsOrder) {
      tab.snapshot = true;
    }
  }

  private assignSnapshotIds(visitPlan: IE2EScenarioVisitPlan): void {
    const tabsOrder = visitPlan.tabsOrder;
    let snapshotId = 1;
    for (const tab of tabsOrder) {
      tab.idx = snapshotId++;
    }
  }

  getAppNames(): string[] {
    this.initSynthesizers();
    const names = [];
    for (const synthesizer of this.synthesizers.values()) {
      names.push(synthesizer.getAppName());
    }
    return names;
  }

  getTargetNames(appName: string, options: AnyOptions = {}): string[] {
    this.initSynthesizers();
    if (!this.synthesizers.has(appName)) {
      utils.haltOrThrow(`unknown app: ${appName}`);
    }
    const synthesizer = this.synthesizers.get(
      appName,
    ) as IE2EScenarioSynthesizer;
    return synthesizer.getAvailableTargetNames(options);
  }

  getAllTargets(
    options: AnyOptions = {},
  ): {app: string; interaction: string}[] {
    this.initSynthesizers();
    const ret = [];
    const apps = this.getAppNames();
    for (const app of apps) {
      const interactions = this.getTargetNames(app, options);
      for (const interaction of interactions) {
        ret.push({app, interaction});
      }
    }
    return ret;
  }
}

export default new TestPlanner();

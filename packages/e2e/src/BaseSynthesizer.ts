/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @lightSyntaxTransform
 * @oncall memory_lab
 */
import type {
  AnyOptions,
  Config,
  E2EOperation,
  E2EStepInfo,
  IE2EScenarioVisitPlan,
  E2ESynthesizerOptions,
  IScenario,
  IE2EStepBasic,
  InteractionsCallback,
  IE2EScenarioSynthesizer,
  CheckPageLoadCallback,
  Nullable,
  PageSetupCallback,
  Undefinable,
} from '@memlab/core';
import type {Page} from 'puppeteer-core';

import {utils} from '@memlab/core';
import SynthesisUtils from './lib/SynthesisUtils';
import interactUtils from './lib/operations/InteractionUtils';
import E2EUtils from './lib/E2EUtils';

// for debugging only
const skipAllScreenshot = false;

class BaseSynthesizer implements IE2EScenarioSynthesizer {
  protected config: Config;
  protected steps: Map<string, IE2EStepBasic>;
  private _repeatIntermediate: number;
  protected plans: Map<string, IE2EScenarioVisitPlan>;

  constructor(config: Config) {
    this.config = config;
    this.init();
    this.postInit();
    // define steps
    this.steps = new Map();
    for (const step of this.getAvailableSteps()) {
      this.steps.set(step.name, step);
    }
    this.injectBuiltInSteps();
    this._repeatIntermediate = 1;
    // define visit plans
    this.plans = new Map();
    for (const plan of this.getAvailableVisitPlans()) {
      this.plans.set(plan.name, plan);
    }
  }

  private injectBuiltInSteps(): void {
    const backStep = SynthesisUtils.backStep;
    this.steps.set(backStep.name, backStep);
    const revertStep = SynthesisUtils.revertStep;
    this.steps.set(revertStep.name, revertStep);
  }

  private repeatIntermediate(n: number): void {
    this._repeatIntermediate = n;
  }

  protected init(): void {
    this.repeatIntermediate(this.config.repeatIntermediateTabs);
  }

  protected postInit(): void {
    // for overriding
  }

  getAppName(): string {
    const error = new Error('BaseSynthesizer.getAppName is not implemented');
    error.stack;
    throw error;
  }

  getOrigin(): Nullable<string> {
    const domain = this.getDomain();
    if (domain === '' || domain == null) {
      return null;
    }
    if (domain.startsWith('.')) {
      return `https://${domain.substring(1)}`;
    }
    return `https://${domain}`;
  }

  getDomain(): string {
    const error = new Error('BaseSynthesizer.getDomain is not implemented');
    error.stack;
    throw error;
  }

  getDomainPrefixes(): string[] {
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getCookieFile(_visitPlan: IE2EScenarioVisitPlan): string | null {
    const error = new Error('BaseSynthesizer.getCookieFile is not implemented');
    error.stack;
    throw error;
  }

  getAvailableSteps(): IE2EStepBasic[] {
    const error = new Error(
      'BaseSynthesizer.getAvailableSteps is not implemented',
    );
    error.stack;
    throw error;
  }

  getNodeNameBlocklist(): string[] {
    return [];
  }

  getEdgeNameBlocklist(): string[] {
    return [];
  }

  getDefaultStartStepName(): string {
    const error = new Error(
      'BaseSynthesizer.getDefaultStartStepName is not implemented',
    );
    error.stack;
    throw error;
  }

  injectPlan(stepName: string, scenario: IScenario): void {
    this.plans.set(stepName, this.synthesisForScenario(scenario));
  }

  // given a target step name, returns the visit order sequence
  synthesisForTarget(stepName: string): IE2EScenarioVisitPlan {
    if (!this.plans.has(stepName)) {
      utils.haltOrThrow(`target ${stepName} is unknown to synthesizers`);
    }
    return this.plans.get(stepName) as IE2EScenarioVisitPlan;
  }

  // return a list of visit plans for the target app
  getAvailableVisitPlans(): IE2EScenarioVisitPlan[] {
    const error = new Error(
      'BaseSynthesizer.getAvailableVisitPlans is not implemented',
    );
    error.stack;
    throw error;
  }

  getAvailableTargetNames(
    opt: AnyOptions & {
      filterCb?: (node: IE2EScenarioVisitPlan) => boolean;
    } = {},
  ): string[] {
    const filterCb = opt.filterCb;
    let plans = Array.from(this.plans.values());
    if (filterCb) {
      plans = plans.filter(filterCb);
    }
    return plans.map(plan => plan.name);
  }

  // get the default number of warmups
  getNumberOfWarmup(): number {
    return 1;
  }

  // get the URL of the target app
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getBaseURL(_options: AnyOptions = {}) {
    return 'https://www.facebook.com';
  }

  private getNormalizedBaseURL(options: AnyOptions = {}) {
    const url = utils.normalizeBaseUrl(this.getBaseURL(options));
    return url;
  }

  // get URL parameters
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getURLParameters(_options: AnyOptions = {}) {
    return '';
  }

  // get default (mobile) device name
  // if nothing specified, it's considered running in desktop / laptop
  getDevice(): string {
    return 'pc';
  }

  // append additional interactions based on step info
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getExtraOperationsForStep(_stepInfo: E2EStepInfo): E2EOperation[] {
    return [];
  }

  // get default callback for checking page load
  getPageLoadChecker(): CheckPageLoadCallback {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return async (_page: Page) => {
      await interactUtils.waitFor(this.config.delayWhenNoPageLoadCheck);
      return true;
    };
  }

  getPageSetupCallback(): PageSetupCallback {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return async (_page: Page) => {
      return;
    };
  }

  synthesis(
    baseline: string,
    target: string,
    intermediates: string[],
    options: E2ESynthesizerOptions = {},
  ): IE2EScenarioVisitPlan {
    const type = options.type;
    if (!type || type === 'standard') {
      return this.synthesisStandard(baseline, target, intermediates, options);
    }
    if (type === 'simple') {
      return this.synthesisSimple(baseline, target, options);
    }
    if (type === 'repeat') {
      return this.synthesisRepeat(baseline, target, intermediates, options);
    }
    if (type === 'init-page-load') {
      return this.synthesisInitialPageLoad(target, intermediates, options);
    }
    throw utils.haltOrThrow(`unknown visit plan type: ${type}`);
  }

  private getActualNumberOfWarmup(): number {
    return this.getNumberOfWarmup() + (this.config.isContinuousTest ? 1 : 0);
  }

  private synthesisInitPart(
    baseline: string,
    target: string,
    options: E2ESynthesizerOptions,
  ): E2EStepInfo[] {
    // default start from the home tab
    const start = options.start || this.getDefaultStartStepName();
    const visitOrder = [];
    // first visit the start step
    visitOrder.push(this.getAction(start, 'init'));
    // if provided, some initial setup to prepare states or data
    if (options.setupSteps) {
      for (const stepName of options.setupSteps) {
        visitOrder.push(this.getAction(stepName));
      }
    }
    // if provided, warm up with specified steps
    if (options.warmupSteps) {
      for (const stepName of options.warmupSteps) {
        visitOrder.push(this.getAction(stepName));
      }
    } else {
      // by default, warm up the baseline and target onces
      visitOrder.push(this.getAction(baseline));
      visitOrder.push(this.getAction(target));
    }
    return visitOrder;
  }

  private synthesisFinalPart(
    visitOrder: E2EStepInfo[],
    baseline: string,
    intermediates: string[],
    options: E2ESynthesizerOptions = {},
  ): void {
    // visit intermediate steps twice
    for (let i = 0; i < this._repeatIntermediate; i++) {
      for (const step of intermediates) {
        visitOrder.push(this.getAction(step));
      }
    }

    // visit the final step
    const final = options.final || baseline;
    visitOrder.push(this.getAction(final, 'final'));

    // if provided, some cleanup to restore states
    if (options.cleanupSteps) {
      for (const stepName of options.cleanupSteps) {
        visitOrder.push(this.getAction(stepName));
      }
    }
  }

  // synthesis for a new type of memory stress testing
  // that repeats a series of steps
  private synthesisRepeat(
    baseline: string,
    target: string,
    _: string[] | null,
    options: E2ESynthesizerOptions = {},
  ): IE2EScenarioVisitPlan {
    const visitOrder = this.synthesisInitPart(baseline, target, options);

    // visit baseline
    visitOrder.push(this.getAction(baseline, 'baseline'));

    let repeat =
      options.repeat != null ? options.repeat : this.config.stressTestRepeat;
    if (options.repeatSteps) {
      while (repeat-- > 0) {
        for (const step of options.repeatSteps) {
          visitOrder.push(this.getAction(step));
        }
      }
    } else {
      while (repeat-- > 0) {
        // repeatedly visit the baseline and target
        visitOrder.push(this.getAction(target));
        visitOrder.push(this.getAction(baseline));
      }
    }
    visitOrder.push(this.getAction(target, 'target'));

    // if provided, some cleanup to restore states
    if (options.cleanupSteps) {
      for (const stepName of options.cleanupSteps) {
        visitOrder.push(this.getAction(stepName));
      }
    }

    return {
      name: options.name || `${baseline}-${target}`,
      appName: this.getAppName(),
      type: 'repeat',
      newTestUser: !!options.newTestUser,
      device: this.getDevice(),
      baseURL: this.getNormalizedBaseURL(options),
      URLParameters: this.getURLParameters(options),
      tabsOrder: visitOrder,
      numOfWarmup: this.getActualNumberOfWarmup(),
      dataBuilder: options.dataBuilder,
      isPageLoaded: this.getPageLoadChecker(),
      pageSetup: this.getPageSetupCallback(),
    };
  }

  private synthesisStandard(
    baseline: string,
    target: string,
    intermediates: string[],
    options: E2ESynthesizerOptions = {},
  ): IE2EScenarioVisitPlan {
    const visitOrder = this.synthesisInitPart(baseline, target, options);

    // actually visit the baseline and target
    visitOrder.push(this.getAction(baseline, 'baseline'));
    visitOrder.push(this.getAction(target, 'target'));
    // intermediate steps, final step, and cleanup steps
    this.synthesisFinalPart(visitOrder, baseline, intermediates, options);

    return {
      name: options.name || target,
      appName: this.getAppName(),
      type: 'standard',
      newTestUser: !!options.newTestUser,
      device: this.getDevice(),
      baseURL: this.getNormalizedBaseURL(options),
      URLParameters: this.getURLParameters(options),
      tabsOrder: visitOrder,
      numOfWarmup: this.getActualNumberOfWarmup(),
      dataBuilder: options.dataBuilder,
      isPageLoaded: this.getPageLoadChecker(),
      pageSetup: this.getPageSetupCallback(),
    };
  }

  private processStepUrl(url: string): string {
    let ret = url;
    while (ret.startsWith('/')) {
      ret = ret.substring(1);
    }
    return ret;
  }

  private synthesisForScenario(scenario: IScenario): IE2EScenarioVisitPlan {
    const visitOrder = [];
    const url = this.processStepUrl(scenario.url());
    const startStep = {
      name: 'page-load',
      url,
      interactions: [],
    };

    if (!scenario.action) {
      visitOrder.push(this.getActionFromStep(startStep, 'target'));
    } else {
      // first visit the start step
      visitOrder.push(this.getActionFromStep(startStep, 'baseline'));

      const actionStep = {
        name: 'action-on-page',
        url,
        interactions: [scenario.action],
      };

      const revertStep = {
        name: 'revert',
        url,
        interactions: [scenario.back],
      } as IE2EStepBasic;

      const getRevertStep = (stepType?: Undefinable<string>): E2EStepInfo =>
        scenario.back
          ? this.getActionFromStep(revertStep, stepType)
          : this.getAction(SynthesisUtils.revertStep.name, stepType);

      const repeat = scenario.repeat ? scenario.repeat() : 0;
      for (let i = 0; i < repeat; ++i) {
        visitOrder.push(this.getActionFromStep(actionStep));
        visitOrder.push(getRevertStep());
      }

      visitOrder.push(this.getActionFromStep(actionStep, 'target'));
      visitOrder.push(getRevertStep('final'));
    }

    return {
      name: utils.getScenarioName(scenario),
      appName: E2EUtils.getScenarioAppName(scenario),
      type: 'scenario',
      newTestUser: false,
      device: this.getDevice(),
      baseURL: this.getNormalizedBaseURL(),
      URLParameters: this.getURLParameters(),
      tabsOrder: visitOrder,
      numOfWarmup: this.getActualNumberOfWarmup(),
      dataBuilder: null,
      isPageLoaded: scenario.isPageLoaded ?? this.getPageLoadChecker(),
      pageSetup: this.getPageSetupCallback(),
      scenario,
    };
  }

  private synthesisSimple(
    start: string,
    target: string,
    options: E2ESynthesizerOptions = {},
  ): IE2EScenarioVisitPlan {
    const visitOrder = [];
    // first visit the start step
    visitOrder.push(this.getAction(start, 'baseline'));

    visitOrder.push(this.getAction(target, 'target'));
    visitOrder.push(this.getAction(SynthesisUtils.revertStep.name, 'final'));

    return {
      name: options.name || target,
      appName: this.getAppName(),
      type: 'simple',
      newTestUser: !!options.newTestUser,
      device: this.getDevice(),
      baseURL: this.getNormalizedBaseURL(options),
      URLParameters: this.getURLParameters(options),
      tabsOrder: visitOrder,
      numOfWarmup: this.getActualNumberOfWarmup(),
      dataBuilder: options.dataBuilder,
      isPageLoaded: this.getPageLoadChecker(),
      pageSetup: this.getPageSetupCallback(),
    };
  }

  private synthesisInitialPageLoad(
    target: string,
    intermediates: string[],
    options: E2ESynthesizerOptions = {},
  ): IE2EScenarioVisitPlan {
    const visitOrder = [];
    // visit the target page/tab
    visitOrder.push(this.getAction(target, 'target'));

    if (intermediates.length > 0) {
      // intermediate steps, final step, and cleanup steps
      if (!options.final) {
        throw utils.haltOrThrow(
          `${target}-init-load doesn't have a final step`,
        );
      }
      this.synthesisFinalPart(
        visitOrder,
        options.final,
        intermediates,
        options,
      );
    }

    return {
      name: options.name || `${target}-init-load`,
      appName: this.getAppName(),
      type: 'init-page-load',
      newTestUser: !!options.newTestUser,
      device: this.getDevice(),
      baseURL: this.getNormalizedBaseURL(options),
      URLParameters: this.getURLParameters(options),
      tabsOrder: visitOrder,
      numOfWarmup: this.getActualNumberOfWarmup(),
      dataBuilder: options.dataBuilder,
      isPageLoaded: this.getPageLoadChecker(),
      pageSetup: this.getPageSetupCallback(),
    };
  }

  private getActionFromStep(
    step: IE2EStepBasic,
    type?: string,
    snapshot?: boolean,
    screenshot?: boolean,
  ): E2EStepInfo {
    const action = {...step};
    return this.fillInInfo(action, type, snapshot, screenshot);
  }

  private getAction(
    stepName: string,
    type?: string,
    snapshot?: boolean,
    screenshot?: boolean,
  ): E2EStepInfo {
    const step = this.steps.get(stepName);
    if (!step) {
      throw utils.haltOrThrow(`step ${stepName} doesn't exist`);
    }
    return this.getActionFromStep(step, type, snapshot, screenshot);
  }

  // by default take snapshot for baseline, target, and final step
  protected shouldTakeSnapshot(option: AnyOptions & {type?: string}): boolean {
    const type = option.type;
    return type === 'baseline' || type === 'target' || type === 'final';
  }

  // by default every step takes one screenshot
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected shouldTakeScreenshot(_option: AnyOptions): boolean {
    return true;
  }

  private fillInInfo(
    actionBasic: IE2EStepBasic,
    type?: string,
    snapshot?: boolean,
    screenshot?: boolean,
  ): E2EStepInfo {
    const action = {...actionBasic} as E2EStepInfo;

    // fill in snapshot and screenshot instructions
    if (typeof snapshot !== 'boolean') {
      snapshot = this.shouldTakeSnapshot({action, type});
    }
    if (typeof screenshot !== 'boolean') {
      screenshot = this.shouldTakeScreenshot({action, type});
    }
    action.snapshot = this.config.skipSnapshot ? false : snapshot;
    action.screenshot = skipAllScreenshot ? false : screenshot;
    if (type && type !== 'init') {
      action.type = type;
    }
    const interactions = action.interactions;

    // fill in extra interactions
    if (!Array.isArray(interactions)) {
      action.interactions = [interactions];
    }
    action.interactions = (
      action.interactions as Array<E2EOperation | InteractionsCallback>
    ).concat(this.getExtraOperationsForStep(action));

    // make sure action.url is normalized
    while (action.url.startsWith('/')) {
      action.url = action.url.substring(1);
    }
    return action;
  }
}

export default BaseSynthesizer;

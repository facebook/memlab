/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {Page, Browser} from 'puppeteer';
import type {ParsedArgs} from 'minimist';
import {
  AnyFunction,
  E2EStepInfo,
  IScenario,
  RunMetaInfo,
  XvfbType,
  Optional,
} from '@memlab/core';

import {
  info,
  utils,
  browserInfo,
  config as defaultConfig,
  MemLabConfig,
} from '@memlab/core';
import {
  defaultTestPlanner,
  TestPlanner,
  Xvfb,
  E2EInteractionManager,
} from '@memlab/e2e';
import {BaseAnalysis} from '@memlab/heap-analysis';

type APIOptions = {
  // NOTE: cannot pass in a different config instance
  //       before refactoring the codebase to not use the global config
  testPlanner?: TestPlanner;
  cache?: boolean;
  config?: MemLabConfig;
  evalInBrowserAfterInitLoad?: AnyFunction;
};

type RunOptions = {
  scenario?: IScenario;
  cookiesFile?: string;
  evalInBrowserAfterInitLoad?: AnyFunction;
  snapshotForEachStep?: boolean;
};

type RunResult = {
  config: MemLabConfig;
  tabsOrder: E2EStepInfo[];
  metaInfo: RunMetaInfo;
};

function setConfigByRunOptions(
  config: MemLabConfig,
  options: RunOptions,
): void {
  config.isFullRun = !!options.snapshotForEachStep;
}

export async function run(options: RunOptions = {}): Promise<RunResult> {
  const config = MemLabConfig.resetConfigWithTranscientDir();
  setConfigByRunOptions(config, options);
  config.externalCookiesFile = options.cookiesFile;
  config.scenario = options.scenario;
  const testPlanner = new TestPlanner({config});
  const {evalInBrowserAfterInitLoad} = options;
  await warmup({testPlanner, config, evalInBrowserAfterInitLoad});
  await testInBrowser({testPlanner, config, evalInBrowserAfterInitLoad});
  return {
    config,
    tabsOrder: utils.loadTabsOrder(),
    metaInfo: utils.loadRunMetaInfo(),
  };
}

export async function takeSnapshots(
  options: RunOptions = {},
): Promise<RunResult> {
  const config = MemLabConfig.resetConfigWithTranscientDir();
  setConfigByRunOptions(config, options);
  config.externalCookiesFile = options.cookiesFile;
  config.scenario = options.scenario;
  const testPlanner = new TestPlanner();
  const {evalInBrowserAfterInitLoad} = options;
  await testInBrowser({testPlanner, config, evalInBrowserAfterInitLoad});
  return {
    config,
    tabsOrder: utils.loadTabsOrder(),
    metaInfo: utils.loadRunMetaInfo(),
  };
}

export async function analyze(
  runResult: RunResult,
  heapAnalyzer: BaseAnalysis,
  args: ParsedArgs = {_: []},
): Promise<void> {
  await heapAnalyzer.run({args});
}

export async function warmup(options: APIOptions = {}): Promise<void> {
  const config = options.config ?? defaultConfig;
  if (config.verbose) {
    info.lowLevel(`Xvfb: ${config.useXVFB}`);
  }
  const testPlanner = options.testPlanner ?? defaultTestPlanner;
  try {
    if (config.skipWarmup) {
      return;
    }
    const browser = await utils.getBrowser({warmup: true});

    const visitPlan = testPlanner.getVisitPlan();
    config.setDevice(visitPlan.device);

    const numOfWarmup = visitPlan.numOfWarmup || 3;
    const promises = [];
    for (let i = 0; i < numOfWarmup; ++i) {
      promises.push(browser.newPage());
    }
    const pages = await Promise.all(promises);
    info.beginSection('warmup');
    await Promise.all(
      pages.map(async page => {
        await setupPage(page, {cache: false});
        const interactionManager = new E2EInteractionManager(page);
        await interactionManager.warmupInPage();
      }),
    ).catch(err => {
      info.error(err.message);
    });
    info.endSection('warmup');

    await utils.closePuppeteer(browser, pages, {warmup: true});
  } catch (ex) {
    const error = utils.getError(ex);
    utils.checkUninstalledLibrary(error);
    throw ex;
  }
}

export async function setupPage(
  page: Page,
  options: APIOptions = {},
): Promise<void> {
  const config = options.config ?? defaultConfig;
  const testPlanner = options.testPlanner ?? defaultTestPlanner;
  if (config.emulateDevice) {
    await page.emulate(config.emulateDevice);
  }

  if (config.defaultUserAgent) {
    await page.setUserAgent(config.defaultUserAgent);
  }

  // set login session
  await page.setCookie(...testPlanner.getCookies());
  const cache = options.cache ?? true;
  await page.setCacheEnabled(cache);

  // automatically accept dialog
  page.on('dialog', async dialog => {
    await dialog.accept();
  });
}

function autoDismissDialog(page: Page, options: APIOptions = {}): void {
  const config = options.config ?? defaultConfig;
  page.on('dialog', async dialog => {
    if (config.verbose) {
      info.lowLevel(`Browser dialog: ${dialog.message()}`);
    }
    await dialog.dismiss();
  });
}

async function initBrowserInfoInConfig(
  browser: Browser,
  options: APIOptions = {},
): Promise<void> {
  const config = options.config ?? defaultConfig;
  browserInfo.setPuppeteerConfig(config.puppeteerConfig);
  const version = await browser.version();
  browserInfo.setBrowserVersion(version);
  if (config.verbose) {
    info.lowLevel(JSON.stringify(browserInfo, null, 2));
  }
}

export async function testInBrowser(options: APIOptions = {}): Promise<void> {
  const config = options.config ?? defaultConfig;
  if (config.verbose) {
    info.lowLevel(`Xvfb: ${config.useXVFB}`);
  }

  const testPlanner = options.testPlanner ?? defaultTestPlanner;
  let interactionManager: E2EInteractionManager | null = null;
  let xvfb: XvfbType | null = null;
  try {
    xvfb = Xvfb.startIfEnabled();
    const browser = await utils.getBrowser();
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    interactionManager = new E2EInteractionManager(page);

    if (options.evalInBrowserAfterInitLoad) {
      interactionManager.setEvalFuncAfterInitLoad(
        options.evalInBrowserAfterInitLoad,
      );
    }

    const visitPlan = testPlanner.getVisitPlan();
    config.setDevice(visitPlan.device);

    autoDismissDialog(page);
    await initBrowserInfoInConfig(browser);

    browserInfo.monitorWebConsole(page);

    await setupPage(page, options);

    await interactionManager.visitAndGetSnapshots(options);
    await utils.closePuppeteer(browser, [page]);
  } catch (ex) {
    const error = utils.getError(ex);
    utils.checkUninstalledLibrary(error);
    info.error(error.message);
  } finally {
    if (interactionManager) {
      interactionManager.clearCDPSession();
    }
    if (xvfb) {
      xvfb.stop((err: Optional<Error>) => {
        if (err) {
          utils.haltOrThrow(err);
        }
      });
    }
  }
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {
  AnyFunction,
  E2EOperation,
  E2EStepInfo,
  InteractionsCallback,
  OperationArgs,
  Optional,
  MemLabConfig,
} from '@memlab/core';
import type {CDPSession, Page} from 'puppeteer';

import fs from 'fs';
import path from 'path';
import E2EUtils from './lib/E2EUtils';
import {utils, info, serializer, browserInfo, config} from '@memlab/core';
import interactUtils from './lib/operations/InteractionUtils';
import defaultTestPlanner, {TestPlanner} from './lib/operations/TestPlanner';
import NetworkManager from './NetworkManager';

type SingleOp = E2EOperation | InteractionsCallback;
type Ops = SingleOp | SingleOp[];

type PageInteractOptions = {
  config?: MemLabConfig;
  testPlanner?: TestPlanner;
};

const {
  logMetaData,
  setPermissions,
  logTabProgress,
  maybeWaitForConsoleInput,
  applyAsyncWithRetry,
  compareURL,
  waitExtraForTab,
  checkURL,
  injectPageReloadChecker,
  checkPageReload,
  dispatchOperation,
  clearConsole,
  getNavigationHistoryLength,
  checkLastSnapshotChunk,
  getURLParameter,
} = E2EUtils;

export default class E2EInteractionManager {
  private cdpsession: Optional<CDPSession>;
  private page: Page;
  private pageHistoryLength: number[] = [];
  private evalFuncAfterInitLoad: AnyFunction | null = null;
  private networkManager: NetworkManager;

  constructor(page: Page) {
    this.page = page;
    this.networkManager = new NetworkManager(page);
  }

  public async getCDPSession(): Promise<CDPSession> {
    if (!this.cdpsession) {
      this.cdpsession = await this.page.target().createCDPSession();
      this.networkManager.setCDPSession(this.cdpsession);
    }
    return this.cdpsession;
  }

  public clearCDPSession(): void {
    this.cdpsession = null;
  }

  public setEvalFuncAfterInitLoad(func: AnyFunction | null): void {
    this.evalFuncAfterInitLoad = func;
  }

  protected async initialLoad(
    page: Page,
    url: string,
    opArgs: OperationArgs = {},
  ): Promise<void> {
    if (config.verbose) {
      info.lowLevel(`loading: ${url}`);
    }
    info.overwrite('Connecting to web server...');
    await page.goto(url, {
      timeout: config.initialPageLoadTimeout,
      waitUntil: 'load',
    });
    // wait extra 10s in continuous test env for the initial page load
    if (config.isContinuousTest) {
      await interactUtils.waitFor(10000);
    }
    if (this.evalFuncAfterInitLoad) {
      await page.evaluate(this.evalFuncAfterInitLoad);
    }
    await interactUtils.waitUntilLoaded(page, opArgs);
  }

  private async beforeInteractions(): Promise<void> {
    if (config.instrumentJS) {
      const session = await this.getCDPSession();
      this.networkManager.setCDPSession(session);
      await this.networkManager.interceptScript();
    }

    if (config.verbose) {
      const browserVersion = await this.page.browser().version();
      info.lowLevel(`Browser version: ${browserVersion}`);
      const nodeVersion = process.version;
      info.lowLevel(`Node.js version: ${nodeVersion}`);
    }
  }

  public async visitAndGetSnapshots(
    options: PageInteractOptions = {},
  ): Promise<void> {
    const visitPlan = options.testPlanner
      ? options.testPlanner.getVisitPlan()
      : defaultTestPlanner.getVisitPlan();

    const runConfig = options.config ?? config;
    // notify the running mode the current visit plan
    runConfig.runningMode.beforeRunning(visitPlan);
    logMetaData(visitPlan);
    await setPermissions(this.page, defaultTestPlanner.getOrigin());
    await this.beforeInteractions();
    const baseURL = utils.normalizeBaseUrl(visitPlan.baseURL);

    await this.startTrackingHeap();
    for (let i = 0; i < visitPlan.tabsOrder.length; i++) {
      info.beginSection(`step-${i}`);
      if (runConfig.verbose) {
        info.lowLevel(new Date().toString());
      }
      const tab = visitPlan.tabsOrder[i];
      const subUrl = tab.url.substr(tab.url.startsWith('/') ? 1 : 0);
      const url = `${baseURL}${subUrl}` + getURLParameter(tab, visitPlan);
      logTabProgress(i, visitPlan);

      await maybeWaitForConsoleInput(i + 1);

      const opArgs = {
        isPageLoaded: visitPlan.isPageLoaded,
        scenario: visitPlan.scenario,
      };
      await applyAsyncWithRetry(
        this.getPageStatistics,
        this,
        [url, tab, opArgs],
        {
          retry: runConfig.interactionFailRetry,
        },
      );

      // dump browser console output in a readable file
      browserInfo.dump();

      info.nextLine();
      info.endSection(`step-${i}`);
    }

    // show progress on console
    info.topLevel(
      serializer.summarizeTabsOrder(visitPlan.tabsOrder, {
        color: true,
        progress: visitPlan.tabsOrder.length,
      }) + '\n',
    );

    // serialize the meta data again (with more runtime and browser info)
    logMetaData(visitPlan, {final: true});

    // dump browser console output in a readable file
    browserInfo.dump();
  }

  public async warmupInPage(): Promise<void> {
    const visitPlan = defaultTestPlanner.getVisitPlan();
    const baseURL = visitPlan.baseURL;

    const len = visitPlan.tabsOrder.length;
    const visited = Object.create(null);

    // randomize order
    const tabs = utils.shuffleArray<E2EStepInfo>(
      Array.from(visitPlan.tabsOrder),
    );
    const multipler = config.warmupRepeat;
    for (let i = 0; i < len * multipler; ++i) {
      const tab = tabs[i % len];
      visited[tab.name] |= 0;
      if (++visited[tab.name] > multipler) {
        continue;
      }

      // print current progress
      if (config.isContinuousTest || config.verbose) {
        let progress = `[${i + 1}/${len * multipler}]`;
        progress = `${progress}: warming up web server (${tab.name})...`;
        info.lowLevel(progress);
      } else {
        info.progress(i, len * multipler, {message: 'Warming up web server'});
      }

      // print url
      const urlParams = getURLParameter(tab, visitPlan);
      const url = `${baseURL}${tab.url}${urlParams}`;
      if (config.verbose) {
        info.lowLevel(`url: ${url}`);
      }
      // warm up page
      await this.visitPage(url, {
        mute: true,
        isPageLoaded: visitPlan.isPageLoaded,
      });

      compareURL(this.page, url);
    }
  }

  private async visitPage(
    url: string,
    options: OperationArgs = {},
  ): Promise<void> {
    try {
      await this.page.goto(url, {
        timeout: config.warmupPageLoadTimeout,
        waitUntil: 'domcontentloaded',
      });
      await interactUtils.waitUntilLoaded(this.page, options);
    } catch (ex) {
      info.overwrite(utils.getError(ex).message);
    }
  }

  private async getPageStatistics(
    url: string,
    tabInfo: E2EStepInfo,
    opArgs: OperationArgs = {},
  ): Promise<void> {
    if (config.verbose) {
      info.lowLevel('url: ' + url);
    }

    // visit the URL of the first step
    if (tabInfo.idx === 1) {
      await applyAsyncWithRetry(
        this.initialLoad,
        this,
        [this.page, url, opArgs],
        {
          retry: config.initialLoadFailRetry,
          delayBeforeRetry: 3000,
        },
      );
      // only use the interactions for steps other than the first step
    } else if (tabInfo.interactions) {
      await this.interactWithPage(this.page, tabInfo.interactions, opArgs);
    }

    if (tabInfo.type === 'final' || tabInfo.type === 'target') {
      await waitExtraForTab(tabInfo);
    }

    checkURL(this.page, url);

    // inject marker, which checks if the page is reloaded
    if (tabInfo.idx === 1) {
      // call setup callback if the scenario has one
      const setup = opArgs.scenario?.setup;
      if (setup) {
        await setup(this.page);
      }
      await injectPageReloadChecker(this.page);
    } else {
      await checkPageReload(this.page);
    }

    await this.fullGC(tabInfo);

    // collect metrics
    await this.collectMetrics(tabInfo);

    // take screenshot
    const screenShotIdx = tabInfo.screenshot ? tabInfo.idx : 0;
    if (config.runningMode.shouldTakeScreenShot(tabInfo) && screenShotIdx > 0) {
      await interactUtils.screenshot(this.page, screenShotIdx);
    }

    // take heap snapshot
    const snapshotIdx = tabInfo.snapshot ? tabInfo.idx : 0;
    if (config.runningMode.shouldTakeHeapSnapshot(tabInfo) && snapshotIdx > 0) {
      const snapshotFile = path.join(
        config.curDataDir,
        `s${snapshotIdx}.heapsnapshot`,
      );
      await this.saveHeapSnapshotToFile(snapshotFile);
    }

    if (tabInfo.postInteractions) {
      await this.interactWithPage(this.page, tabInfo.postInteractions, opArgs);
    }
  }

  private async interactWithPage(
    page: Page,
    operations: Ops,
    opArgs: OperationArgs = {},
  ): Promise<void> {
    const args = {...opArgs, pageHistoryLength: this.pageHistoryLength};
    if (typeof operations === 'function') {
      await operations(page, args);
      await interactUtils.waitUntilLoaded(page, args);
    } else if (Array.isArray(operations)) {
      for (const op of operations) {
        await this.interactWithPage(page, op, args);
      }
    } else if (operations.kind) {
      await dispatchOperation(page, operations, args);
    } else {
      utils.throwError(new Error('unknown operation'));
    }
  }

  private async startTrackingHeap(): Promise<void> {
    if (config.verbose) {
      info.lowLevel('Start tracking JS heap');
    }
    const session = await this.getCDPSession();
    await session.send('HeapProfiler.enable');
  }

  private async writeSnapshotFileFromCDPSession(
    file: string,
    session: CDPSession,
  ) {
    const writeStream = fs.createWriteStream(file, {encoding: 'UTF-8'});
    let lastChunk = '';
    const dataHandler = (data: {chunk: string}) => {
      writeStream.write(data.chunk);
      lastChunk = data.chunk;
    };

    const progressHander = (data: {
      done: number;
      total: number;
      finished: boolean;
    }) => {
      const percent = ((100 * data.done) / data.total) | 0;
      if (!config.isContinuousTest) {
        info.overwrite(`heap snapshot ${percent}% complete`);
      }
    };

    session.on('HeapProfiler.addHeapSnapshotChunk', dataHandler);
    session.on('HeapProfiler.reportHeapSnapshotProgress', progressHander);

    // start taking heap snapshot
    await session.send('HeapProfiler.takeHeapSnapshot', {
      reportProgress: true,
      captureNumericValue: true,
    });

    checkLastSnapshotChunk(lastChunk);
    session.removeListener('HeapProfiler.addHeapSnapshotChunk', dataHandler);
    session.removeListener(
      'HeapProfiler.reportHeapSnapshotProgress',
      progressHander,
    );
    writeStream.end();
  }

  private async saveHeapSnapshotToFile(file: string): Promise<void> {
    info.beginSection('heap snapshot');
    const start = Date.now();
    const session = await this.getCDPSession();
    await this.writeSnapshotFileFromCDPSession(file, session);
    const spanMs = Date.now() - start;
    if (config.verbose) {
      info.lowLevel(`duration: ${utils.getReadableTime(spanMs)}`);
    }

    info.overwrite('snapshot saved to disk');
    info.endSection('heap snapshot');
  }

  private async fullGC(tabInfo: E2EStepInfo): Promise<void> {
    if (!config.runningMode.shouldGC(tabInfo)) {
      return;
    }
    if (config.clearConsole) {
      await clearConsole(this.page);
      info.overwrite('running a full GC (clear console)...');
    } else {
      info.overwrite('running a full GC...');
    }

    // force GC 6 times to release feedback_cells
    await this.forceGC(6);
  }

  private async forceGC(repeat = 1): Promise<void> {
    const client = await this.getCDPSession();
    for (let i = 0; i < repeat; i++) {
      await client.send('HeapProfiler.collectGarbage');
      // wait for a while and let GC do the job
      await interactUtils.waitFor(200);
    }
    await interactUtils.waitFor(config.waitAfterGC);
  }

  private async collectMetrics(tabInfo: E2EStepInfo) {
    // collect navigation history info
    const historyLength = await getNavigationHistoryLength(this.page);
    this.pageHistoryLength.push(historyLength);

    if (!config.runningMode.shouldGetMetrics(tabInfo)) {
      return;
    }
    await this.forceGC();

    // collect heap size
    const builtInMetrics = await this.page.metrics();
    const size = utils.getReadableBytes(builtInMetrics.JSHeapUsedSize);
    info.midLevel(`Heap size: ${size}`);
    tabInfo.JSHeapUsedSize = builtInMetrics.JSHeapUsedSize ?? 0;

    // collect additional metrics
    const metrics = await config.runningMode.getAdditionalMetrics(
      this.page,
      tabInfo,
    );
    for (const key of Object.keys(metrics)) {
      if (Object.prototype.hasOwnProperty.call(tabInfo, key)) {
        info.warning(`overwriting metrics: ${key}`);
      }
    }
    tabInfo.metrics = metrics;
  }
}

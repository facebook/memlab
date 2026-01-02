/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {
  AnyOptions,
  AnyValue,
  E2EOperation,
  E2EStepInfo,
  IE2EScenarioVisitPlan,
  IScenario,
  Nullable,
  OperationArgs,
  runInfoUtils,
  RunMetaInfo,
} from '@memlab/core';
import type {CDPSession, Page} from 'puppeteer-core';

import fs from 'fs';
import {utils, info, serializer, browserInfo, config} from '@memlab/core';
import BaseOperation from './operations/BaseOperation';
import interactUtils from './operations/InteractionUtils';
import {constant, setInternalValue} from '@memlab/core';

type ExceptionHandler = (ex: Error) => void;

function checkLastSnapshotChunk(chunk: string): void {
  const regex = /\}\s*$/;
  if (!regex.test(chunk)) {
    utils.throwError(
      new Error(
        'resolved `HeapProfiler.takeHeapSnapshot` before writing the last chunk',
      ),
    );
  }
}

// get URL parameter for a specific step
function getURLParameter(
  tab: E2EStepInfo,
  visitPlan: IE2EScenarioVisitPlan,
): string {
  const params = visitPlan.URLParameters;
  const stepParams =
    tab.urlParams
      ?.map(({name, value}) => [name, value].map(encodeURIComponent).join('='))
      .join('&') ?? '';
  let ret =
    params +
    (params.length > 0 && stepParams.length > 0 ? '&' : '') +
    stepParams;
  if (ret.length > 0 && !ret.startsWith('?')) {
    ret = '?' + ret;
  }
  return ret;
}

function compareURL(page: Page, url: string): void {
  if (!config.verbose) {
    return;
  }
  const actual = unescape(page.url());
  url = unescape(url);
  if (!utils.isURLEqual(url, actual)) {
    info.warning('URL changed:');
    info.lowLevel(` Expected: ${url}`);
    info.lowLevel('----');
    info.lowLevel(` Actual:   ${actual}`);
    info.lowLevel('');
  }
}

function logTabProgress(i: number, visitPlan: IE2EScenarioVisitPlan): void {
  const len = visitPlan.tabsOrder.length;
  const tab = visitPlan.tabsOrder[i];
  const progress = `[${i + 1}/${len}]`;
  const tabType = tab.type ? `(${tab.type})` : '';
  const msg = `${progress} visiting ${tab.name} ${tabType}`;
  if (config.verbose) {
    info.topLevel(msg);
  }
  info.topLevel(
    serializer.summarizeTabsOrder(visitPlan.tabsOrder, {
      color: true,
      progress: i,
    }),
  );
  browserInfo.addMarker(`[memlab]: ${msg}`);
}

function serializeVisitPlan(visitPlan: IE2EScenarioVisitPlan): void {
  fs.writeFileSync(
    config.snapshotSequenceFile,
    JSON.stringify(visitPlan.tabsOrder, null, 2),
    {encoding: 'utf8'},
  );
}

function logMetaData(
  visitPlan: IE2EScenarioVisitPlan,
  opt: AnyOptions & {final?: boolean} = {},
): void {
  // save the visiting info to disk
  serializeVisitPlan(visitPlan);
  // save the run meta info to disk
  const runMeta: RunMetaInfo = {
    app: config.targetApp,
    type: visitPlan.type,
    interaction: config.targetTab,
    browserInfo,
  };
  runInfoUtils.runMetaInfoManager.saveRunMetaInfo(runMeta);
  // additional post processing of collected data
  if (opt.final) {
    config.runningMode.postProcessData(visitPlan);
  }
}

async function setPermissions(
  page: Page,
  origin: Nullable<string>,
): Promise<void> {
  if (origin === '' || origin == null) {
    return;
  }
  const browser = page.browser();
  const context = browser.defaultBrowserContext();
  await context.overridePermissions(origin, config.grantedPermissions);
}

// check if the URL is correct
function checkURL(page: Page, intendedURL: string): void {
  compareURL(page, intendedURL);
}

async function injectPageReloadChecker(page: Page): Promise<void> {
  await page.evaluate(() => {
    // @ts-expect-error TODO: add Window shim type
    window.__memlab_check_reload = 1;
  });
}

async function checkPageReload(page: Page): Promise<void> {
  // @ts-expect-error TODO: add Window shim type
  const flag = await page.evaluate(() => window.__memlab_check_reload);
  if (flag !== 1) {
    utils.haltOrThrow(
      'The page is reloaded. MemLab cannot analyze heap across page reloads. ' +
        'Please remove window.reload() calls, page.goto() calls, ' +
        'or any reload logic.',
    );
  }
}

async function maybeWaitForConsoleInput(stepId: number): Promise<void> {
  if (config.isManualDebug) {
    await info.waitForConsole(
      `Press Enter (or Return) to continue step-${stepId}:`,
    );
  }
}

async function applyAsyncWithGuard(
  f: (...args: AnyValue[]) => Promise<AnyValue>,
  self: AnyValue,
  args: AnyValue[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  exceptionHandler: ExceptionHandler = (_ex: Error): void => {
    /*noop*/
  },
): Promise<AnyValue> {
  let ret: AnyValue;
  try {
    ret = await f.apply(self, args);
  } catch (ex) {
    await exceptionHandler(utils.getError(ex));
  }
  return ret;
}

async function applyAsyncWithRetry(
  f: (...args: AnyValue[]) => Promise<AnyValue>,
  self: AnyValue,
  args: AnyValue[],
  options: AnyOptions & {retry?: number; delayBeforeRetry?: number} = {},
): Promise<void> {
  options.retry = options.retry || 0;
  const retry = options.retry;
  const exceptionHandler: ExceptionHandler = async ex => {
    if (retry <= 0 || config.verbose) {
      // if the browser UI is enabled, MemLab should wait for a while
      // so we can have a chance to manually inspect the page
      if (config.openDevtoolsConsole) {
        await interactUtils.waitFor(config.delayBeforeExitUponException);
      }
      utils.haltOrThrow(utils.getError(ex), {
        printCallback: () => {
          info.warning('interaction fail');
        },
      });
    }
    info.warning(`interaction fail, making ${retry} more attempt(s)...`);
    if (!!options.delayBeforeRetry && options.delayBeforeRetry > 0) {
      await interactUtils.waitFor(options.delayBeforeRetry);
    }

    if (options.retry) {
      options.retry--;
    }

    await applyAsyncWithRetry(f, self, args, options);
  };
  await applyAsyncWithGuard(f, self, args, exceptionHandler);
}

async function clearConsole(page: Page): Promise<void> {
  if (config.clearConsole) {
    await page.evaluate(() => {
      try {
        console.clear();
      } catch {
        // do nothing
      }
    });
  }
}

async function dispatchOperation(
  page: Page,
  operation: E2EOperation,
  opArgs: OperationArgs,
): Promise<void> {
  if (!(operation instanceof BaseOperation)) {
    throw utils.haltOrThrow(`unknown operation: ${operation}`);
  }
  await operation.do(page, opArgs);
}

async function waitExtraForTab(tabInfo: E2EStepInfo): Promise<void> {
  let delay = 0;
  const mode = config.runningMode;
  if (tabInfo.type === 'target') {
    if (!mode.shouldExtraWaitForTarget(tabInfo)) {
      return;
    }
    delay += config.extraWaitingForTarget;
  } else if (tabInfo.type === 'final') {
    if (!mode.shouldExtraWaitForFinal(tabInfo)) {
      return;
    }
    delay += config.extraWaitingForFinal;
  }

  // wait for extra time
  if (delay > 0) {
    info.overwrite(`wait extra ${delay / 1000}s for ${tabInfo.type} page...`);
    await interactUtils.waitFor(delay);
  }
}

async function getNavigationHistoryLength(page: Page): Promise<number> {
  return await page.evaluate(() => {
    let ret = -1;
    try {
      ret = history.length;
    } catch (e) {
      // do nothing
    }
    return ret;
  });
}

// const allocFile = path.join(config.curDataDir, 'Heap-alloc.json');
// await startTrackingHeapAllocation(page, allocFile);
async function startTrackingHeapAllocation(
  page: Page,
  file: string,
): Promise<CDPSession> {
  const heap = '';
  fs.writeFileSync(file, heap, {encoding: 'utf8'});
  info.lowLevel('tracking heap allocation...');
  const cdpSession = await page.target().createCDPSession();
  cdpSession.on('HeapProfiler.addHeapSnapshotChunk', data => {
    fs.appendFileSync(file, data.chunk, {encoding: 'utf8'});
  });
  await cdpSession.send('HeapProfiler.startTrackingHeapObjects', {
    trackAllocations: true,
  });
  await interactUtils.waitFor(30000);
  return cdpSession;
}

function getScenarioAppName(scenario: Nullable<IScenario> = null): string {
  if (!scenario || !scenario.app) {
    return getScenarioDefaultAppName();
  }
  return scenario.app();
}

function getScenarioDefaultAppName(): string {
  return 'default-app-for-scenario';
}

export default setInternalValue(
  {
    applyAsyncWithGuard,
    applyAsyncWithRetry,
    checkLastSnapshotChunk,
    checkPageReload,
    checkURL,
    clearConsole,
    compareURL,
    dispatchOperation,
    getNavigationHistoryLength,
    getScenarioAppName,
    getURLParameter,
    injectPageReloadChecker,
    logMetaData,
    logTabProgress,
    maybeWaitForConsoleInput,
    serializeVisitPlan,
    setPermissions,
    startTrackingHeapAllocation,
    waitExtraForTab,
  },
  __filename,
  constant.internalDir,
);

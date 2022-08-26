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

import {info, config} from '@memlab/core';
import path from 'path';

import type {Page, ElementHandle} from 'puppeteer';
import type {CheckPageLoadCallback, OperationArgs} from '@memlab/core';

function waitFor(delay: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, delay);
  });
}

async function WaitUntilCallbackReturnsTrue(
  page: Page,
  isPageLoaded: CheckPageLoadCallback,
  options: OperationArgs = {},
): Promise<void> {
  if (options.showProgress) {
    info.overwrite('waiting for page load...');
  }
  let isSuccessful = false;
  const failedURLs = options.failedURLs ?? Object.create(null);
  const url = new URL(page.url());
  if (failedURLs[url.pathname]) {
    return await waitFor(config.delayWhenNoPageLoadCheck);
  }

  // retry check for at most 10 minutes
  for (let i = 0; i < 10 * 60 * 50; ++i) {
    // now check
    let doneOrError: boolean | string;
    try {
      doneOrError = await isPageLoaded(page);
    } catch {
      break;
    }

    // if Check succeed
    if (doneOrError === true) {
      isSuccessful = true;
      break;
    } else if (typeof doneOrError === 'string') {
      // if error during page load check
      return info.warning(`Checking page load got: ${doneOrError}`);
    }

    // Check page load is not successful yet, check again
    await waitFor(200);
  }

  if (!isSuccessful) {
    if (!options.mute) {
      info.overwrite(
        `Check timeout '${url.pathname}' set wait: ${config.delayWhenNoPageLoadCheck}ms`,
      );
    }
    failedURLs[url.pathname] = true;
  }

  if (!options.noWaitAfterPageLoad) {
    await waitFor(config.waitAfterPageLoad);
  }
}

async function waitUntilLoaded(
  page: Page,
  options: OperationArgs = {},
): Promise<void> {
  // manual delay supercedes page load checker
  let delay = options.delay ?? 0;
  if (delay > 0) {
    if (!options.mute && delay > 2000) {
      info.overwrite(`wait for ${delay / 1000}s`);
    }
    await waitFor(delay);
    return;
  }

  // check page load with specified checker
  const isPageLoaded = options.isPageLoaded;
  if (isPageLoaded) {
    await WaitUntilCallbackReturnsTrue(page, isPageLoaded, options);
    return;
  }

  // if nothing is specified, use default delay
  delay = config.delayWhenNoPageLoadCheck;
  if (!options.mute && delay > 2000) {
    info.overwrite(`wait for ${delay / 1000}s`);
  }
  await waitFor(delay);
}

async function screenshot(page: Page, name: string | number): Promise<void> {
  if (config.isContinuousTest) {
    return;
  }
  const screenshotFile = path.join(config.curDataDir, `screenshot-${name}.png`);
  info.overwrite('taking screenshot...');
  await page.screenshot({path: screenshotFile});
}

function getWaitTimeout(optional: boolean) {
  if (optional) {
    return 3000;
  }
  return config.presenceCheckTimeout || 60000;
}

async function waitForSelector(
  page: Page,
  selector: string,
  whatToWaitForSelectorToDo = 'exist',
  optional = false,
): Promise<boolean> {
  const timeout = getWaitTimeout(optional);
  let waitConfig = null;
  switch (whatToWaitForSelectorToDo) {
    case 'appear':
      waitConfig = {
        visible: true, // ie. not `display:none` or `visibility:hidden`
      };
      break;
    case 'disappear':
      waitConfig = {
        hidden: true, // ie. `display:none`, `visibility:hidden`, or removed
      };
      break;
    case 'exist': // ie. existent, whether visible or not; default config.
      break;
  }

  info.overwrite(`wait for ${selector} to ${whatToWaitForSelectorToDo}`);

  if (selector.startsWith('contains:')) {
    return await keepTryingUntil(async () => {
      const text = selector.slice('contains:'.length);
      const elems = await getElementsContainingText(page, text);
      if (!elems || elems.length === 0) {
        return false;
      }
      await Promise.all(elems.map(e => e.dispose()));
      return true;
    }, timeout);
  }

  try {
    const elem = await page.waitForSelector(selector, {...waitConfig, timeout});
    if (elem) {
      await elem.dispose();
    }
    return true;
  } catch {
    return false;
  }
}

async function keepTryingUntil(
  checkCallback: () => Promise<boolean>,
  timeout = 2000,
): Promise<boolean> {
  const startTimestamp = Date.now();
  let currentTimestamp = Date.now();
  while (currentTimestamp - startTimestamp < timeout) {
    const flag = await checkCallback();
    if (flag) {
      return true;
    }
    await waitFor(200);
    currentTimestamp = Date.now();
  }
  return false;
}

async function checkIfPresent(
  page: Page,
  selector: string,
  optional = false,
): Promise<boolean> {
  return waitForSelector(page, selector, 'exist', optional);
}

async function checkIfVisible(
  page: Page,
  selector: string,
  optional = false,
): Promise<boolean> {
  return waitForSelector(page, selector, 'appear', optional);
}

async function waitForDisappearance(
  page: Page,
  selector: string,
  optional = false,
): Promise<boolean> {
  return waitForSelector(page, selector, 'disappear', optional);
}

async function getElementsContainingText(
  page: Page,
  text: string,
): Promise<ElementHandle<Element>[]> {
  const xpath = `//*[not(self::script)][contains(text(), '${text}')]`;
  const elements = await page.$x(xpath);
  return elements;
}

export default {
  checkIfPresent,
  checkIfVisible,
  getElementsContainingText,
  screenshot,
  waitFor,
  waitForDisappearance,
  waitForSelector,
  WaitUntilCallbackReturnsTrue,
  waitUntilLoaded,
};

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {IHeapSnapshot} from '@memlab/core';
import type {Page} from 'puppeteer';

import fs from 'fs';
import path from 'path';
import {config, info, utils} from '@memlab/core';
const puppeteer = config.isFB
  ? require('puppeteer-core')
  : require('puppeteer');

export async function isExpectedSnapshot(
  leakInjector: () => void,
  checkSnapshotCb: (snapshot: IHeapSnapshot) => boolean,
): Promise<void> {
  const snapshot = await getHeapSnapshot(leakInjector);
  expect(checkSnapshotCb(snapshot)).toBe(true);
}

function getHeapDirPrefix(): string {
  const dir = path.join(config.dataBaseDir, 'gen-files');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
  return dir;
}

async function saveSnapshotToFile(page: Page, file: string): Promise<void> {
  info.lowLevel(`saving heap snapshot to file ${file}`);
  let heap = '';
  const devtoolsProtocolClient = await page.target().createCDPSession();
  devtoolsProtocolClient.on('HeapProfiler.addHeapSnapshotChunk', data => {
    heap += data.chunk;
  });
  await devtoolsProtocolClient.send('HeapProfiler.takeHeapSnapshot', {
    reportProgress: false,
    captureNumericValue: true,
  });

  return new Promise<void>((resolve, reject) => {
    fs.writeFile(file, heap, 'UTF-8', err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

const TEST_URL = 'about:blank';

async function dumpHeap(
  snapshotFile: string,
  leakInjector: () => void,
): Promise<void> {
  const browser = await puppeteer.launch(config.puppeteerConfig);
  const page = await browser.newPage();
  // set page size
  await page.setViewport({
    width: 1680,
    height: 1050,
    deviceScaleFactor: 1,
  });

  // visit page
  await page.goto(TEST_URL);

  // insert a memory leak object
  await page.evaluate(leakInjector);

  // take a heap snapshot
  await saveSnapshotToFile(page, snapshotFile);
  await browser.close();
}

let fileId = 0;

async function getHeapSnapshot(
  leakInjector: () => void,
): Promise<IHeapSnapshot> {
  const snapshotFile = path.join(
    getHeapDirPrefix(),
    `snapshot-${Date.now()}-${fileId++}.json`,
  );
  await dumpHeap(snapshotFile, leakInjector);

  // parse the heap
  const opt = {buildNodeIdIndex: true};
  const snapshot = await utils.getSnapshotFromFile(snapshotFile, opt);
  return snapshot;
}

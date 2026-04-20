/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import fs from 'fs';

// Duck-typed CDP session. Playwright's CDPSession and Puppeteer's CDPSession
// both implement this shape for the events we care about. Handlers use
// `unknown` so the interface is structurally compatible with both vendors'
// strongly-typed overloads.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface CDPLike {
  send(method: string, params?: any): Promise<any>;
  on(event: string, handler: (payload: any) => void): any;
  off?(event: string, handler: (payload: any) => void): any;
  removeListener?(event: string, handler: (payload: any) => void): any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type ChunkEvent = {chunk: string};
type ProgressEvent = {done: number; total: number; finished?: boolean};

function detach(
  session: CDPLike,
  event: string,
  handler: (payload: unknown) => void,
): void {
  if (typeof session.off === 'function') {
    session.off(event, handler);
    return;
  }
  if (typeof session.removeListener === 'function') {
    session.removeListener(event, handler);
  }
}

/**
 * Drive HeapProfiler via a CDP session and stream the snapshot to disk.
 * Works with any CDPLike session (Playwright or Puppeteer).
 */
export async function writeHeapSnapshot(
  session: CDPLike,
  filePath: string,
  options: {onProgress?: (percent: number) => void} = {},
): Promise<void> {
  const writeStream = fs.createWriteStream(filePath, {encoding: 'utf8'});
  let lastChunk = '';

  const onChunk = (data: ChunkEvent) => {
    writeStream.write(data.chunk);
    lastChunk = data.chunk;
  };
  const onProgress = (data: ProgressEvent) => {
    if (options.onProgress) {
      const percent = ((100 * data.done) / Math.max(1, data.total)) | 0;
      options.onProgress(percent);
    }
  };

  session.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  session.on('HeapProfiler.reportHeapSnapshotProgress', onProgress);

  try {
    await session.send('HeapProfiler.takeHeapSnapshot', {
      reportProgress: !!options.onProgress,
      captureNumericValue: true,
    });
  } finally {
    detach(session, 'HeapProfiler.addHeapSnapshotChunk', onChunk as never);
    detach(
      session,
      'HeapProfiler.reportHeapSnapshotProgress',
      onProgress as never,
    );
    await new Promise<void>(resolve => writeStream.end(() => resolve()));
  }

  if (!/\}\s*$/.test(lastChunk)) {
    throw new Error(
      'resolved HeapProfiler.takeHeapSnapshot before writing the last chunk',
    );
  }
}

/**
 * Force a series of full GCs so memlab's leak detection sees a clean final
 * snapshot. Mirrors the 6x cycle used in @memlab/e2e.
 */
export async function forceFullGC(
  session: CDPLike,
  options: {repeat?: number; waitBetweenMs?: number; waitAfterMs?: number} = {},
): Promise<void> {
  const repeat = options.repeat ?? 6;
  const wait = options.waitBetweenMs ?? 200;
  const waitAfter = options.waitAfterMs ?? 500;
  for (let i = 0; i < repeat; i++) {
    await session.send('HeapProfiler.collectGarbage');
    await new Promise(r => setTimeout(r, wait));
  }
  await new Promise(r => setTimeout(r, waitAfter));
}

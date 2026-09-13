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

/** Minimal CDP session shape shared by Playwright and Puppeteer. */
export interface CDPLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  on(event: string, handler: (payload: any) => void): unknown;
  off?(event: string, handler: (payload: any) => void): unknown;
  removeListener?(event: string, handler: (payload: any) => void): unknown;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

type ChunkEvent = {chunk: string};
type ProgressEvent = {done: number; total: number; finished?: boolean};

export type GCOptions = {
  /** Number of collectGarbage passes before the final snapshot. Default 6. */
  repeat?: number;
  /** Delay between passes, in milliseconds. Default 200. */
  waitBetweenMs?: number;
  /** Delay after the final pass, in milliseconds. Default 500. */
  waitAfterMs?: number;
};

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

/** Stream a V8 heap snapshot to disk via CDP. */
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

/** Force a full GC cycle and clear the DevTools console retention. */
export async function forceFullGC(
  session: CDPLike,
  options: GCOptions = {},
): Promise<void> {
  const repeat = options.repeat ?? 6;
  const wait = options.waitBetweenMs ?? 200;
  const waitAfter = options.waitAfterMs ?? 500;
  await session.send('Runtime.discardConsoleEntries').catch(() => undefined);
  for (let i = 0; i < repeat; i++) {
    await session.send('HeapProfiler.collectGarbage');
    await new Promise(r => setTimeout(r, wait));
  }
  await new Promise(r => setTimeout(r, waitAfter));
}

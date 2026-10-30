# Heap snapshot capture code

## Puppeteer

Capture the heap of a Puppeteer `page` through the Chrome DevTools Protocol.
This is how memlab captures snapshots: run garbage collection a few times,
then stream the snapshot chunks to a file.

```javascript
const fs = require('fs');

async function takeHeapSnapshot(page, file) {
  const session = await page.createCDPSession();
  await session.send('HeapProfiler.enable');
  for (let i = 0; i < 3; i++) {
    await session.send('HeapProfiler.collectGarbage');
  }
  const out = fs.createWriteStream(file, {encoding: 'utf8'});
  const onChunk = ({chunk}) => out.write(chunk);
  session.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await session.send('HeapProfiler.takeHeapSnapshot', {
    reportProgress: false,
    captureNumericValue: true,
  });
  session.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await new Promise(resolve => out.end(resolve));
  await session.detach();
}
```

## Playwright (Chromium)

Playwright exposes the same protocol through `newCDPSession`. It only works
when the browser is Chromium:

```javascript
const fs = require('fs');

async function takeHeapSnapshot(page, file) {
  const session = await page.context().newCDPSession(page);
  await session.send('HeapProfiler.enable');
  for (let i = 0; i < 3; i++) {
    await session.send('HeapProfiler.collectGarbage');
  }
  const out = fs.createWriteStream(file, {encoding: 'utf8'});
  const onChunk = ({chunk}) => out.write(chunk);
  session.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await session.send('HeapProfiler.takeHeapSnapshot', {
    reportProgress: false,
    captureNumericValue: true,
  });
  session.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await new Promise(resolve => out.end(resolve));
  await session.detach();
}
```

## Feed snapshots from a test into memlab's leak detector

Take three snapshots in the test: before the interaction (baseline), after it
(target), and after undoing it (final). Then:

```javascript
const {findLeaksBySnapshotFilePaths} = require('@memlab/api');

async function findLeaksInTestSnapshots() {
  return findLeaksBySnapshotFilePaths(
    '/tmp/baseline.heapsnapshot',
    '/tmp/target.heapsnapshot',
    '/tmp/final.heapsnapshot',
  );
}
```

The command line equivalent is
`memlab find-leaks --baseline <file> --target <file> --final <file>`. For the
directory layout memlab writes and reads, see
[Integrate with Test Frameworks](https://meta.github.io/memlab/docs/guides/integrate-with-e2e-frameworks).

## Node.js

```javascript
const v8 = require('v8');

// Returns the file name. Without an argument, the file goes into the current
// directory with a timestamped name.
const file = v8.writeHeapSnapshot('/tmp/app.heapsnapshot');
```

From a `worker_threads` worker's parent, `worker.getHeapSnapshot()` returns a
readable stream of the worker's heap snapshot. (On old Node.js releases this
call can hang; there, call `v8.writeHeapSnapshot()` inside the worker, which
writes that thread's heap.)

```javascript
const fs = require('fs');
const {pipeline} = require('stream/promises');

async function writeWorkerHeapSnapshot(worker, file) {
  const stream = await worker.getHeapSnapshot();
  await pipeline(stream, fs.createWriteStream(file));
}
```

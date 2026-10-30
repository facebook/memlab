---
name: memlab-memory-tests
description: Write automated memory leak tests with memlab. Use it for Node.js unit tests that assert an object was garbage collected (takeNodeMinimalHeap, tagObject, hasObjectWithClassName), for browser leak tests in CI that run a memlab scenario through @memlab/api and fail when leaks are found, and for checking heap snapshots from Playwright, Cypress or Puppeteer tests. Use when the user wants a regression test for a memory leak, asks how to assert that memory is released, or wants memory leak checks in Jest, Mocha, node:test or a CI pipeline.
license: MIT
compatibility: Requires Node.js. Browser tests need the memlab or @memlab/api npm package, which downloads Chromium through Puppeteer, plus Chromium's system libraries on CI machines.
metadata:
  homepage: https://meta.github.io/memlab/docs/guides/integration-and-file-structure
  repository: https://github.com/meta/memlab
---

# Memory leak tests with memlab

Pick the kind of test from what has to stay leak-free:

| Code under test | Test |
|---|---|
| A Node.js module, class or server code | [Heap assertion in a unit test](#nodejs-heap-assertions) |
| A web UI interaction | [memlab scenario run from the test job](#browser-leak-tests-in-ci) |
| An existing Playwright, Cypress or Puppeteer test | [Snapshots from the existing test](#snapshots-from-an-existing-e2e-test) |

## Node.js heap assertions

`takeNodeMinimalHeap()` from `@memlab/core` snapshots the current process and
returns a queryable heap. Assert that the object you released is gone:

```javascript
// widget.memory.test.js (Jest; node:test and Mocha work the same way)
const {config, takeNodeMinimalHeap, tagObject} = require('@memlab/core');
const {Widget} = require('./widget');

test('Widget is released after dispose()', async () => {
  config.muteConsole = true;

  let widget = new Widget();
  tagObject(widget, 'widget-under-test'); // marks it without changing it
  widget.dispose();
  widget = null;

  const heap = await takeNodeMinimalHeap();
  expect(heap.hasObjectWithTag('widget-under-test')).toBe(false);
}, 30000);
```

```bash
npm install --save-dev @memlab/core
```

- `tagObject(obj, tag)` + `heap.hasObjectWithTag(tag)` checks one specific
  instance. `heap.hasObjectWithClassName('Widget')` checks that no instance of
  the class is left; `heap.getAnyObjectWithClassName('Widget')` returns one to
  inspect. `heap.hasObjectWithPropertyName(name)` checks for any object with
  that property.
- Drop **every** reference the test holds (set variables to `null`) before
  taking the heap, or the test itself keeps the object alive.
- Taking and parsing a snapshot takes from under a second to many seconds,
  depending on heap size. Give the test a generous timeout, and keep these
  tests in their own file so the rest of the suite stays fast.
- For retained sizes, use `takeNodeFullHeap()` from `@memlab/heap-analysis`.
  The minimal heap skips that computation to parse faster.
- When the assertion fails, find out what still holds the object: save a
  snapshot with `dumpNodeHeapSnapshot()` from `@memlab/core` and inspect it
  (see the `memlab-analyze-heap-snapshot` skill).

## Browser leak tests in CI

Write a scenario for the interaction (see the `memlab-find-web-leaks` skill),
then run it from the test job with `@memlab/api` and fail on leaks:

```javascript
// settings-dialog.memory.test.js
const {run} = require('@memlab/api');
const scenario = require('./scenarios/settings-dialog');

test('settings dialog does not leak', async () => {
  const {leaks} = await run({
    scenario,
    skipWarmup: true, // skip the server warm-up visits
    consoleMode: 'CONTINUOUS_TEST', // no progress animation in CI logs
    workDir: '/tmp/memlab/settings-dialog', // must exist; keep it as a CI artifact
  });
  expect(leaks.length).toBe(0);
}, 10 * 60 * 1000);
```

```bash
npm install --save-dev @memlab/api
```

- `run` returns `{leaks, runResult}`. `leaks` is the list of clustered leak
  traces; an empty list means no leaks were found. The work directory has the
  snapshots and screenshots (`data/cur/`) and the readable traces
  (`data/out/leaks.txt`). Upload it from CI so a failure can be investigated.
- Create `workDir` before calling `run` (for example with
  `fs.mkdirSync(dir, {recursive: true})`).
- `run` launches headless Chromium through Puppeteer. On Linux CI images,
  install Chromium's shared libraries, or set `chromiumBinary` to a browser the
  image already has.
- The CLI equivalent is
  `memlab run --scenario <file> --work-dir <dir> --sc`, where `--sc` is the
  continuous-test console mode. Assert on the result in a script with
  `BrowserInteractionResultReader` and `findLeaks` from `@memlab/api`.
- Keep one interaction per scenario, so a failure points at one feature.

## Snapshots from an existing E2E test

Take three Chromium heap snapshots in the existing test: baseline (before the
interaction), target (after it) and final (after undoing it). The
`memlab-capture-heap-snapshots` skill has a CDP helper for Puppeteer and
Playwright. Then:

```javascript
const {findLeaksBySnapshotFilePaths} = require('@memlab/api');

const leaks = await findLeaksBySnapshotFilePaths(baselineFile, targetFile, finalFile);
expect(leaks.length).toBe(0);
```

## Keep the tests stable

- memlab's default leak rule (detached DOM elements and unmounted React
  components) has few false positives. A custom `leakFilter` that reports
  "everything above N bytes" needs a threshold with headroom.
- If heap size varies a lot between runs, `memlab measure --scenario <file>`
  runs the scenario several times to show how much is noise.
- When a known leak can't be fixed yet, exclude its cluster in `leakFilter`
  with a comment linking the issue, instead of disabling the test.

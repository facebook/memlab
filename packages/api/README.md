# @memlab/api

The memlab API for Node.js. Use it to run memlab from code, for example from
a continuous test job, instead of through the `memlab` CLI.

It drives a web page in Chromium through [Puppeteer](https://pptr.dev/), takes
JavaScript heap snapshots, finds memory leaks, and runs heap analyses. Results
come back as objects you can inspect, assert on, or store.

## Install

```bash
npm install @memlab/api
```

## Find memory leaks in a web page

A [test scenario](https://meta.github.io/memlab/docs/api/core/src/interfaces/IScenario)
describes the page to load (`url`), the interaction you suspect leaks memory
(`action`), and how to undo it (`back`). `run` loads the page, runs the
interaction, takes a heap snapshot after each step, and returns the leaks it
found, clustered by retainer trace:

```javascript
const {run} = require('@memlab/api');

(async function () {
  const scenario = {
    url: () => 'https://www.google.com/maps/@37.386427,-122.0428214,11z',
    action: async page => await page.click('text/Hotels'),
    back: async page => await page.click('[aria-label="Close"]'),
  };
  const {leaks} = await run({scenario});
})();
```

`action` and `back` receive a Puppeteer
[`Page`](https://pptr.dev/api/puppeteer.page), so anything Puppeteer can do,
your scenario can do.

## Take snapshots now, find leaks later

`takeSnapshots` runs the browser part only. Pass its result to `findLeaks`
when you want the leaks:

```javascript
const {findLeaks, takeSnapshots} = require('@memlab/api');

(async function () {
  const scenario = {
    url: () => 'https://www.facebook.com',
  };
  const result = await takeSnapshots({scenario, consoleMode: 'SILENT'});
  const leaks = await findLeaks(result, {consoleMode: 'CONTINUOUS_TEST'});
})();
```

## Find leaks in snapshots taken elsewhere

If another tool took the heap snapshots, for example a Playwright or Cypress
test, pass the three files to memlab directly:

```javascript
const {SnapshotResultReader, findLeaks} = require('@memlab/api');

// baseline, target, and final are paths to .heapsnapshot files
const reader = SnapshotResultReader.fromSnapshots(baseline, target, final);
const leaks = await findLeaks(reader);
```

`findLeaksBySnapshotFilePaths(baseline, target, final)` does the same in one
call. See
[Integrate with Test Frameworks](https://meta.github.io/memlab/docs/guides/integrate-with-e2e-frameworks)
for the files memlab expects.

## Run a heap analysis

Every analysis from
[`@memlab/heap-analysis`](https://www.npmjs.com/package/@memlab/heap-analysis)
is re-exported here. `analyze` runs one on the snapshots from a run:

```javascript
const {analyze, takeSnapshots, StringAnalysis} = require('@memlab/api');

(async function () {
  const scenario = {
    url: () => 'https://www.facebook.com',
  };
  const result = await takeSnapshots({scenario});
  const analysis = new StringAnalysis();
  await analyze(result, analysis);
})();
```

## Read the results of a run

A run writes its heap snapshots, screenshots, browser console output, and
leak traces to a working directory (set it with the `workDir` option).
`BrowserInteractionResultReader` reads them back:

```javascript
const {BrowserInteractionResultReader} = require('@memlab/api');

const result = BrowserInteractionResultReader.from('/path/to/work/dir/');

// absolute paths of all heap snapshot files
const files = result.getSnapshotFiles();

// everything the page printed to the browser console
const metaInfo = result.getRunMetaInfo();
console.log(metaInfo.browserInfo._consoleMessages.join('\n'));

// delete the results when you are done
result.cleanup();
```

## Main exports

| Export | What it does |
| --- | --- |
| `run` | Take snapshots of a scenario and find leaks in one call |
| `takeSnapshots` | Run a scenario in the browser and save its heap snapshots |
| `warmupAndTakeSnapshots` | Warm up the app's server first, then take snapshots |
| `findLeaks` | Find and cluster leaks in the snapshots of a run |
| `findLeaksBySnapshotFilePaths` | Find leaks in three snapshot files |
| `analyze` | Run a heap analysis on the snapshots of a run |
| `BrowserInteractionResultReader`, `SnapshotResultReader` | Read the results of a run from disk |
| `config`, `takeNodeMinimalHeap`, `dumpNodeHeapSnapshot` | Re-exported from [`@memlab/core`](https://www.npmjs.com/package/@memlab/core) |

The full reference is in the
[API documentation](https://meta.github.io/memlab/docs/api/api/src/).

## Online Resources

* [Official Website and Demo](https://meta.github.io/memlab)
* [Documentation](https://meta.github.io/memlab/docs/intro)
* [Set up Continuous Test](https://meta.github.io/memlab/docs/guides/integration-and-file-structure)

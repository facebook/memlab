---
id: 'integration-and-file-structure'
---

# Set up Continuous Test

Setting up a continuous testing service that finds web memory leaks with memlab
consists of a few parts:
 1. Prepare [test scenarios](../api/core/src/interfaces/IScenario) that
 cover key interactions of the web app under test.
 2. Trigger test runs either through
[memlab command line interface](../cli/CLI-commands.md#memlab-run) in bash or
through [memlab API](../api/api/src/functions/run).
 3. Collect memory leak results dumped in the disk.

## Write Test Scenarios

Follow the instructions in this [tutorial](./01-detached-dom.mdx).

## Run Tests

**Run in CLI**: Your test job can run the test scenarios via the
memlab command line interface, for example:
```bash
memlab run --scenario /path/to/test/scenario/file.js \
  --work-dir /path/to/save/memlab/run/results/
```
Use the `--work-dir` option to specify a directory where you want
memlab to dump browser interaction meta data (e.g., screenshots and heap
snapshots).

**Run in Node.js**: Alternatively, if your test job is written in node.js,
you can invoke memlab APIs:
```typescript
const {run} = require('@memlab/api');
const scenario = require('/path/to/test/scenario/file.js');
const fs = require('fs-extra');

(async function () {
  const workDir = '/path/to/save/memlab/run/results/';
  // make sure the working directory exists
  fs.mkdirsSync(workDir);
  const result = await run({scenario, workDir});
})();
```

## Collect Results

After the memlab run completes, all results and meta data will be saved in the
specified working directory, which includes the following sub-directories
and files:

```bash
/path/to/save/memlab/run/results/
├── data
│   ├── cur
│   │   ├── browser-info.txt    # browser web console output
│   │   ├── console-log.txt     # memlab terminal logging
│   │   ├── leaks.txt           # text summary of clustered memory leaks
│   │   ├── run-meta.json       # meta data of memlab run and browser configuration
│   │   ├── s1.heapsnapshot     # heap snapshot after the url callback (initial page load)
│   │   ├── s2.heapsnapshot     # heap snapshot after the action callback (after target interaction)
│   │   ├── s3.heapsnapshot     # heap snapshot after the back callback (after reverting target interaction)
│   │   ├── screenshot-1.png    # web page screenshot after the url callback (initial page load)
│   │   ├── screenshot-2.png    # web page screenshot after the action callback (after target interaction)
│   │   ├── screenshot-3.png    # web page screenshot after the back callback (after reverting target interaction)
│   │   └── snap-seq.json       # meta data about each browser interaction step
│   ├── logger
│   │   ├── trace-clusters
│   │   │   ├── @1846905.json   # meta data for one of memory leak trace cluster
│   │   │   ...
│   │   └── trace-jsons
│   │       ├── @1846905.json   # detailed JSON trace of a representative memory leak trace
│   │       ...                 # of a leak trace cluster, this can be used for trace visualization
...
```

To read results, use the
[built-in result reader](../api/api/src/classes/BrowserInteractionResultReader)
or write your own script or library if the test job is running on a different
runtime.

```typescript
const {BrowserInteractionResultReader} = require('@memlab/api');

const workDir = '/path/to/save/memlab/run/results/';
const result = BrowserInteractionResultReader.from(workDir);

// get absolute paths of all snapshot files
const files = result.getSnapshotFiles();

// print all browser web console output
const metaInfo = result.getRunMetaInfo();
console.log(metaInfo.browserInfo._consoleMessages.join('\n'));

// clean up the results
result.cleanup();
```

For more APIs on the built-in result reader, click
[here](../api/api/src/classes/BrowserInteractionResultReader).

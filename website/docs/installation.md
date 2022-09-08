# Installation

```bash
npm install -g memlab
```

## Prequisites

- [Node.js](https://nodejs.org/) version 14 or above
- [Npm](https://docs.npmjs.com/)


## Commands
To check if the installation completed, run `memlab help` in your console,
you should see helper text as follows (view the documentation
for each command [here](./cli/CLI-commands.md)):
```
$ memlab help

  memlab: memory leak detector for front-end JS

  COMMON COMMANDS

    memlab run --scenario <TEST_SCENARIO_FILE>
    Find memory leaks in web apps
    Options: --work-dir --headful --full --skip-screenshot --skip-gc
             --skip-scroll --skip-extra-ops --local-puppeteer
             --scenario --device --disable-xvfb --leak-filter
             --trace-object-size-above
             --ignore-leak-cluster-size-below --trace-all-objects
             --save-trace-as-unclassified-cluster --ml-clustering
             --ml-linkage-max-dist --ml-clustering-max-df

    memlab list
    List all test scenarios

    memlab trace --node-id=<HEAP_OBJECT_ID>
    Report retainer trace of a specific node, use with --nodeId
    Options: --snapshot --snapshot-dir --engine --node-id

    memlab find-leaks
    Find memory leaks in heap snapshots
    Options: --baseline --target --final --snapshot-dir --engine
             --leak-filter --trace-object-size-above
             --ignore-leak-cluster-size-below --trace-all-objects
             --save-trace-as-unclassified-cluster --ml-clustering
             --ml-linkage-max-dist --ml-clustering-max-df --work-dir

    memlab analyze <PLUGIN_NAME> [PLUGIN_OPTIONS]
    Run heap analysis plugins
    Options: --work-dir

    memlab help <COMMAND> [SUB-COMMANDS]
    List all MemLab CLI commands or print helper text for a specific command

    memlab heap --snapshot <HEAP_SNAPSHOT_FILE>
    Interactive command to explore a single heap snapshot
    Options: --snapshot --engine


  MISC COMMANDS

    memlab version
    Show the versions of all memlab packages installed

    memlab reset
    Reset and initialize all directories
    Options: --work-dir

    memlab measure --scenario <TEST_SCENARIO_FILE>
    Run test scenario in measure mode
    Options: --headful --run-num --app --interaction --full
             --skip-snapshot --skip-screenshot --skip-gc --skip-scroll
             --skip-extra-ops --run-mode --local-puppeteer --scenario
             --device --disable-xvfb --work-dir

    memlab warmup --scenario <TEST_SCENARIO_FILE>
    Warm up the target app
    Options: --headful --app --interaction --run-mode
             --local-puppeteer --scenario --device --disable-xvfb
             --skip-warmup --work-dir

    memlab get-default-work-dir
    Query the default working directory

    memlab snapshot --scenario <TEST_SCENARIO_FILE>
    Interact with web app and take heap snapshots
    Options: --headful --app --interaction --full --skip-snapshot
             --skip-screenshot --skip-gc --skip-scroll
             --skip-extra-ops --run-mode --local-puppeteer --scenario
             --device --disable-xvfb --work-dir

    memlab warmup-and-snapshot
    Warm up server and take heap snapshots
    Options: --work-dir --headful --app --interaction --run-mode
             --local-puppeteer --scenario --device --disable-xvfb
             --skip-warmup --full --skip-snapshot --skip-screenshot
             --skip-gc --skip-scroll --skip-extra-ops
```

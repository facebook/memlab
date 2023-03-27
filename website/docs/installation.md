# Installation

```bash
npm install -g memlab
```

## Prequisites

- [Node.js](https://nodejs.org/) version 16 or above
- [Npm](https://docs.npmjs.com/)

:::note
To build from the [Git respository](https://github.com/facebook/memlab) on Windows,
please use Git Bash.
:::

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
             --scenario --device --user-agent --disable-xvfb
             --disable-web-security --rewrite-js --log-script --worker
             --leak-filter --trace-object-size-above
             --ignore-leak-cluster-size-below --trace-all-objects
             --save-trace-as-unclassified-cluster --ml-clustering
             --ml-linkage-max-dist --ml-clustering-max-df
             --clean-up-snapshot

    memlab list
    List all test scenarios

    memlab trace --node-id=<HEAP_OBJECT_ID>
    Report retainer trace of a specific node, use with --nodeId
    Options: --snapshot --snapshot-dir --engine --node-id

    memlab find-leaks
    Find memory leaks in heap snapshots

      There are three ways to specify inputs for the `memlab find-leaks` command:
       1. `--baseline`, `--target`, `--final` specifies each snapshot input individually;
       2. `--snapshot-dir` specifies the directory that holds all three heap snapshot files (MemLab will assign baseline, target, and final based on
      alphabetic order of the file);
       3. `--work-dir` specifies the output working directory of the `memlab run` or the `memlab snapshot` command;

      Please only use one of the three ways to specify the input.
    Options: --baseline --target --final --snapshot-dir --engine
             --leak-filter --trace-object-size-above
             --ignore-leak-cluster-size-below --trace-all-objects
             --save-trace-as-unclassified-cluster --ml-clustering
             --ml-linkage-max-dist --ml-clustering-max-df
             --clean-up-snapshot --work-dir

    memlab analyze <PLUGIN_NAME> [PLUGIN_OPTIONS]
    Run heap analysis plugins
    Options: --work-dir

    memlab help <COMMAND> [SUB-COMMANDS]
    List all MemLab CLI commands or print helper text for a specific command

    memlab diff-leaks
    Find new memory leaks by diffing control and test heap snapshots
    Options: --control-work-dir --treatment-work-dir --engine
             --leak-filter --trace-object-size-above
             --ignore-leak-cluster-size-below --trace-all-objects
             --save-trace-as-unclassified-cluster --ml-clustering
             --ml-linkage-max-dist --ml-clustering-max-df --work-dir

    memlab heap --snapshot <HEAP_SNAPSHOT_FILE>
    Interactive command to explore a single heap snapshot
    Options: --snapshot --engine

    memlab view-heap --snapshot <HEAP_SNAPSHOT_FILE>
    Interactive command to view a single heap snapshot
    Options: --snapshot --engine --node-id --ml-clustering --work-dir


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
             --device --user-agent --disable-xvfb
             --disable-web-security --rewrite-js --log-script
             --work-dir

    memlab warmup --scenario <TEST_SCENARIO_FILE>
    Warm up the target app
    Options: --headful --app --interaction --run-mode
             --local-puppeteer --scenario --device --user-agent
             --disable-xvfb --disable-web-security --skip-warmup
             --rewrite-js --log-script --work-dir

    memlab get-default-work-dir
    Query the default working directory

    memlab snapshot --scenario <TEST_SCENARIO_FILE>
    Interact with web app and take heap snapshots
    Options: --headful --app --interaction --full --skip-snapshot
             --skip-screenshot --skip-gc --skip-scroll
             --skip-extra-ops --run-mode --local-puppeteer --scenario
             --device --user-agent --disable-xvfb
             --disable-web-security --rewrite-js --log-script --worker
             --work-dir

    memlab warmup-and-snapshot
    Warm up server and take heap snapshots
    Options: --work-dir --headful --app --interaction --run-mode
             --local-puppeteer --scenario --device --user-agent
             --disable-xvfb --disable-web-security --skip-warmup
             --rewrite-js --log-script --full --skip-snapshot
             --skip-screenshot --skip-gc --skip-scroll
             --skip-extra-ops --worker
```

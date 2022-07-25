# Installation

```bash
npm install -g memlab
```

## Prequisites

- [Node.js](https://nodejs.org/) version 14 or above:
  - When installing Node.js, you are recommended to check all checkboxes related to dependencies.
- [Npm](https://docs.npmjs.com/)


## Commands
To check if the installation complete, run `memlab help` in your console, you should see helper text as follows:
```bash
$ memlab help

  memlab: memory leak detector for front-end JS

  COMMON COMMANDS

    memlab run --app=comet --interaction=watch
    Find memory leaks in web apps
    Options: --work-dir --app --interaction --run-mode
             --local-puppeteer --scenario --device --disable-xvfb
             --skip-warmup --full --skip-snapshot --skip-screenshot
             --skip-gc --skip-scroll --skip-extra-ops --baseline
             --target --final --snapshot-dir --engine
             --oversize-threshold --trace-all-objects
             --save-trace-as-unclassified-cluster

    memlab list
    List all test scenarios

    memlab trace --node-id=@3123123
    Report retainer trace of a specific node, use with --node-id
    Options: --snapshot --snapshot-dir --engine --node-id

    memlab find-leaks
    Find memory leaks in heap snapshots
    Options: --baseline --target --final --snapshot-dir --engine
             --oversize-threshold --trace-all-objects
             --save-trace-as-unclassified-cluster --work-dir

    memlab analyze <PLUGIN_NAME> [PLUGIN_OPTIONS]
    Run heap analysis plugins
    Options: --work-dir

    memlab help <COMMAND> [SUB-COMMANDS]
    List all memlab CLI commands or print helper text for a specific command
```

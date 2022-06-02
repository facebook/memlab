## MemLab

A memory leak detector for V8 and Hermes

### CLI Usage

Install the CLI

```
npm install -g @memlab/cli
```

Find memory leaks in Google Maps:

```
memlab run --scenario packages/e2e/src/plugins/scenarios/test-google-maps.js
```

Commands:
```
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

    memlab report --nodeId=@3123123
    Report retainer trace of a specific node, use with --nodeId
    Options: --snapshot --snapshot-dir --engine --nodeId

    memlab explore
    Find memory leaks in heap snapshots
    Options: --baseline --target --final --snapshot-dir --engine
             --oversize-threshold --trace-all-objects
             --save-trace-as-unclassified-cluster --work-dir

    memlab analyze <PLUGIN_NAME> [PLUGIN_OPTIONS]
    Run heap analysis plugins
    Options: --work-dir

    memlab help <COMMAND> [SUB-COMMANDS]
    List all MemLab CLI commands or print helper text for a specific command
```


### Test
```
npm run test
```

### Development

First build the project as follows

```
npm install
npm run build
```

Then keep this helper script running to ensure that local changes are picked up 
and compiled automatically during development

```
npm run dev
```

NOTE: To run the memlab cli locally, make sure to prefix the memlab command with
npx from within the memlab repo e.g. `npx memlab`

## License
memlab is MIT licensed, as found in the [LICENSE](LICENSE) file.

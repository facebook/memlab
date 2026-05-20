---
id: 'integrate-with-e2e-frameworks'
---

# Integrate with Test Frameworks

This guide explains how to integrate MemLab with an existing E2E testing
framework such as
[Playwright](https://github.com/microsoft/playwright) or
[Cypress](https://github.com/cypress-io/cypress).

MemLab uses [Puppeteer](https://github.com/puppeteer/puppeteer)
to interact with the browser and collect
JavaScript heap snapshots for memory leak detection. If your organization
already uses a different E2E testing framework like Playwright or Cypress,
you can reuse that framework for browser interactions and pipe the
intermediate results to MemLab for memory leak detection.


## Get Files Consumable by MemLab
In your existing E2E testing framework, you need to implement an API that takes
JS heap snapshots from the browser. For example, Playwright supports connecting
to the browser's DevTools via the Chrome DevTools
Protocol ([link](https://playwright.dev/docs/api/class-cdpsession)),
which you can use to take JS heap snapshots from Chromium. Here is
a [code reference](https://github.com/facebook/memlab/blob/df78f1123c971ba46275fac5d0acaf4e58b0513c/packages/e2e/src/E2EInteractionManager.ts#L331) showing how memlab uses Puppeteer to collect
heap snapshots from Chromium.

The API could look like this (as an example):
```javascript
await takeJSHeapSnapshot(page, tag);
```
`tag` is one of `baseline`, `target`, or `final`. These three snapshots
correspond to [`SBP`, `STP`, `SFP`](https://facebook.github.io/memlab/docs/how-memlab-works)
respectively.

Your `takeJSHeapSnapshot` API should write files in the format expected by
MemLab. Here is the complete directory structure required by the MemLab
core API to find memory leaks.

```bash
/path/to/dump/
└── data
    └── cur
        ├── run-meta.json       # (optional) metadata for the memlab run and browser configuration
        ├── s1.heapsnapshot     # heap snapshot after the url callback (initial page load)
        ├── s2.heapsnapshot     # heap snapshot after the action callback (after target interaction)
        ├── s3.heapsnapshot     # heap snapshot after the back callback (after reverting target interaction)
        └── snap-seq.json       # metadata about each browser interaction step
```

To see examples of these files, run any MemLab test scenario and
look in the directory: `$(memlab get-default-work-dir)/data/cur`

In your test code, insert `takeJSHeapSnapshot` calls at the appropriate
points to collect the three snapshots and write them to disk.

## Pipe Files into MemLab
Once your `takeJSHeapSnapshot` implementation has written the heap snapshots
and metadata files to disk, you can find memory leaks using the
[memlab core API](https://facebook.github.io/memlab/docs/api/api/src/functions/findLeaksBySnapshotFilePaths):

```javascript
const {findLeaks, BrowserInteractionResultReader} = require('@memlab/api');

(async function () {
  const reader = BrowserInteractionResultReader.from('/path/to/dump/');
  const leaks = await findLeaks(reader);
})();
```

## Specification of `snap-seq.json`

The `snap-seq.json` file encodes the browser interaction data and heap
snapshot details that the Memlab leak detector needs in order to identify
memory leaks.

Here's a sample `snap-seq.json` file. It's an array of objects, where each
object represents a browser interaction step.
To detect memory leaks, MemLab requires at least three steps labeled
`baseline`, `target`, and `final`, in that order. For details on why
three snapshots are needed,
see [How memlab Works](https://facebook.github.io/memlab/docs/how-memlab-works).

```json
[
  {
    "name": "page-load",
    "snapshot": true,
    "type": "baseline",
    "idx": 1,
    "JSHeapUsedSize": 33872820
  },
  {
    "name": "action-on-page",
    "snapshot": true,
    "type": "target",
    "idx": 2,
    "JSHeapUsedSize": 44172336
  },
  {
    "name": "revert",
    "snapshot": true,
    "type": "final",
    "idx": 3,
    "JSHeapUsedSize": 43304156
  }
]
```

Now let's take a look at the JSON encoding of a specific step:
```json
{
  "name": "page-load",
  "snapshot": true,
  "type": "baseline",
  "idx": 1,
  "JSHeapUsedSize": 33872820
}
```

* `name` is a human-readable name for the interaction step, used for documentation purposes.
* `"snapshot": true` indicates that a heap snapshot was captured after this E2E interaction step. If `false`, MemLab skips this step when loading and diffing heap snapshots.
* `type` should be one of: `baseline`, `target`, or `final`. See [How memlab Works](https://facebook.github.io/memlab/docs/how-memlab-works) for their meanings.
* `idx` is the index of the interaction step. MemLab uses this index to load the corresponding heap snapshot file using the naming convention `s${idx}.heapsnapshot` when `snapshot` is `true`. For example, when `idx` is `1`, MemLab looks for `s1.heapsnapshot` in the same directory as the `snap-seq.json` file.
* `JSHeapUsedSize` is an optional field that records the total heap size in bytes after this E2E interaction step completes. If all steps include this field, MemLab generates a chart showing memory usage across steps before listing detected memory leaks in the terminal.


## Specification of `run-meta.json` (Optional)
The `run-meta.json` file is an optional JSON file created by MemLab's E2E
front-end. You can have your E2E testing framework generate this
file as well. It logs metadata about MemLab's operation, including Chromium
startup arguments, information about the web app under test, and CLI
commands used. While this file is not used directly during MemLab's memory
leak detection, it can be valuable for associating detected
memory leaks with the configuration of the tested web app and browser.
For example, some memory leaks only appear under specific configurations
such as mobile view. This information can be useful when building a UI
to display memory leaks alongside the app and browser configuration
that produced them.

```json
{
  "app": "default-app-for-scenario",
  "type": "scenario",
  "interaction": "test-google-maps.js",
  "browserInfo": {
    "_browserVersion": "HeadlessChrome/101.0.4950.0",
    "_puppeteerConfig": {
      "headless": true,
      "devtools": true,
      "userDataDir": "/tmp/memlab/data/profile",
      "args": [
        "--no-sandbox",
        "--disable-notifications",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--js-flags=\"--no-move-object-start\"",
        "--enable-precise-memory-info",
        "browser-test",
        "--display=:100"
      ],
      "defaultViewport": {
        "width": 1680,
        "height": 1080,
        "deviceScaleFactor": 1
      }
    },
    "_consoleMessages": [
      "console output line 1",
      "console output line 2",
    ]
  },
  "extraInfo": {
    "command": "run --scenario /home/jacksongl/scripts/test-google-maps.js"
  }
}
```
All those fields are optional:

* `app`: Specifies the name of the application, in this case, "default-app-for-scenario".
* `type`: Describes the type of test, here it is "scenario".
* `interaction`: The file name of the E2E test scenario file.

* `browserInfo`: Contains metadata about the browser used for the test:
  * `_browserVersion`: The version of the browser used, for example, `HeadlessChrome/101.0.4950.0`.
  * `_puppeteerConfig`: The Puppeteer configuration (MemLab uses Puppeteer for browser interaction):
    * `headless`: Whether the browser runs in headless mode.
    * `devtools`: Whether DevTools are opened when interacting with the page.
    * `userDataDir`: The path to the browser's user profile data directory.
    * `args`: An array of additional arguments to be passed to the browser instance.
    * `defaultViewport`: An object specifying the default viewport's width, height, and device scale factor.
  * `_consoleMessages`: An array of messages outputted in the console during the test run.

* `extraInfo`: Contains additional information regarding the test run:
  * `command`: The command executed to initiate the test run, in this case, `memlab run --scenario /home/jacksongl/scripts/test-google-maps.js`.

## Discussions

For questions and discussions, please check out issue
[#35](https://github.com/facebook/memlab/issues/35),
[#15](https://github.com/facebook/memlab/issues/15), and
[#14](https://github.com/facebook/memlab/issues/14).

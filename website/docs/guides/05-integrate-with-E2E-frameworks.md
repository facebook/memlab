---
id: 'integrate-with-e2e-frameworks'
---

# Integrate with Test Frameworks

This is a guide on how to integrate MemLab with other existing E2E testing
framework (such as
[Playwright](https://github.com/microsoft/playwright) or
[Cypress](https://github.com/cypress-io/cypress)).

MemLab uses [Puppeteer](https://github.com/puppeteer/puppeteer)
to interact with web browser and collect
JavaScript heap snapshots for memory leak detection. If your organization
is already using other E2E teesting framework such as Playwright or Cypress,
you would want to reuse the existing framework for E2E testing and pipe the
intermediate results to MemLab for memory leak detection.


## Get Files Consumable by MemLab
For your existing E2E testing framework, you need to implement an API that takes
JS heap snapshots from the browser. (E.g., playwright supports connecting with
the Browser's DevTools via the Chrome DevTools
Protocol ([link](https://playwright.dev/docs/api/class-cdpsession)).
So you can leverage this to take JS heap snapshots from Chromium. Here is
the [code pointer](https://github.com/facebook/memlab/blob/df78f1123c971ba46275fac5d0acaf4e58b0513c/packages/e2e/src/E2EInteractionManager.ts#L331) of how memlab uses puppeteer to collect
the heap snapshots from Chromium.

The API could look like this (as an example):
```javascript
await takeJSHeapSnapshot(page, tag);
```
`tag` is one of the tags: `baseline`, `target`, `final`, these three snapshots
is equivalent to [`SBP`, `STP`, `SBP'`](https://facebook.github.io/memlab/docs/how-memlab-works)
respectively.

Your `takeJSHeapSnapshot` API should dump files in certain format on disk.
Here is a complete list of files and directory structure required by MemLab
core API for finding memory leaks.

```bash
/path/to/dump/
└── data
    └── cur
        ├── run-meta.json       # (optional) meta data of memlab run and browser configuration
        ├── s1.heapsnapshot     # heap snapshot after the url callback (initial page load)
        ├── s2.heapsnapshot     # heap snapshot after the action callback (after target interaction)
        ├── s3.heapsnapshot     # heap snapshot after the back callback (after reverting target interaction)
        └── snap-seq.json       # meta data about each browser interaction step
```

To get examples of those meta files, run a random MemLab test scenario and
view those files under this directory: `$(memlab get-default-work-dir)/data/cur`

In your specific testing framework's test code, you can insert those
`takeJSHeapSnapshot` API calls in your playwright test code to collect the
three snapshots and get file dumped onto disk.

## Pipe Files into MemLab
Once you have the `takeJSHeapSnapshot` implementation dumped heap snapshots
and meta files onto disk, you can find memory leaks with this
[memlab core API](https://facebook.github.io/memlab/docs/api/modules/api_src/#findleaksrunresult):

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

Here's a sample `snap-seq.json` file. It's an array that contains
a series of objects, where each object represents a browser interaction step.
To detect memory leaks, we require a minimum of three steps labeled
as `baseline`, `target`, and `final`, in that sequence. For a detailed
understanding of why Memlab requires three snapshots,
please refer to [this doc](https://facebook.github.io/memlab/docs/how-memlab-works).

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

* `name` is a human-readable name for the interaction step, this is mainly for documentation or comment purpose.
* `"snapshot": true` indicates that a heap snapshot has been captured after this E2E interaction step. If this field is `false`, Memlab will ignore this E2E interaction step when loading and diffing heap snapshots.
* `type` should be one of the following values: `baseline`, `target`, or `final`. Refer to [this link](https://facebook.github.io/memlab/docs/how-memlab-works) for their meanings.
* `idx` denotes the index of the given interaction. Memlab utilizes this index to identify and load the corresponding heap snapshot using the template `s${idx}.heapsnapshot` when `snapshot` is `true`. For instance, in this specific case, Memlab will attempt to locate `s1.heapsnapshot` in the same directory as the `snap-seq.json` file, given that `idx` is `1`.
* `JSHeapUsedSize` is an optional field that logs the total heap size in bytes after the completion of this E2E interaction step. If all interaction steps include the `JSHeapUsedSize` field, Memlab will generate a pixel chart displaying memory usage variations across different steps before listing the detected memory leaks on the terminal.


## Specification of `run-meta.json` (Optional)
The `run-meta.json` file is an optional JSON file created by Memlab's E2E
front-end. You can optionally make your E2E testing framework generate such
a file. It logs metadata related to Memlab's operation, including Chromium
startup arguments, information about the web-app under test, and any CLI
commands. While this file isn't directly utilized during MemLab's memory
leak detection process, it may be valuable later for associating detected
memory leaks with the configuration of the tested web-app and browser.
For example, sometimes memory leaks only show up in specific configuration
such as mobile view. Those information could be useful to display when you
build a UI system to display all the memory leaks and their underlying app
and browser information.

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
* `interaction`: The file name of the the E2E test scenario file.

* `browserInfo`: Contains metadata about the browser used for the test:
  * `_browserVersion`: The version of the browser used, for example, `HeadlessChrome/101.0.4950.0`.
  * `_puppeteerConfig`: The configuration for Puppeteer (MemLab uses Puppeteer as its browser interaction front-end):
    * `headless`: A boolean indicating whether the browser runs in headless mode.
    * `devtools`: A boolean that specifies if devtools are opened when interacting with the page.
    * `userDataDir`: The path to the browser-generated test user profile data directory.
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

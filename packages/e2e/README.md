# @memlab/e2e

memlab's browser automation layer. It drives Chromium through
[Puppeteer](https://pptr.dev/), runs the steps of a test scenario, and records
what memlab needs to find memory leaks: a JavaScript heap snapshot after each
step, screenshots, the browser console output, and metadata about the run.

You rarely need to depend on this package directly.
[`memlab run`](https://www.npmjs.com/package/memlab) and
[`@memlab/api`](https://www.npmjs.com/package/@memlab/api) use it for you. It
is published separately so the other memlab packages can share it.

## Install

```bash
npm install @memlab/e2e
```

## What a run does

For a [test scenario](https://meta.github.io/memlab/docs/api/core/src/interfaces/IScenario)
with `url`, `action`, and `back` callbacks, the browser run:

1. Launches Chromium, headless by default.
2. Calls `beforeInitialPageLoad`, sets `cookies`, and loads the page returned
   by `url`. Then it calls `setup` once. After this and every later step, it
   waits until `isPageLoaded` returns true or, without that callback, until
   the page has had no network connections for 500ms.
3. Takes the **baseline** heap snapshot.
4. Calls `action`, the interaction you suspect leaks memory, and takes the
   **target** heap snapshot.
5. Calls `back` to undo the interaction and takes the **final** heap snapshot.
   With `repeat`, it runs `action` and `back` extra times first.

Before each snapshot it runs garbage collection in the page, and on the target
and final pages it does extra interactions such as scrolling and waiting.
Comparing the three snapshots finds objects that were allocated by `action`
but are still alive after `back`. See
[How memlab Works](https://meta.github.io/memlab/docs/how-memlab-works).

## What it writes

Results go to the working directory (`--work-dir`, or
`memlab get-default-work-dir`):

```
data/cur/
├── s1.heapsnapshot     # baseline: after the initial page load
├── s2.heapsnapshot     # target: after action
├── s3.heapsnapshot     # final: after back
├── screenshot-1.png    # one screenshot per step
├── ...
├── browser-info.txt    # browser console output
├── run-meta.json       # browser and run configuration
└── snap-seq.json       # one entry per interaction step
```

Another E2E framework, such as Playwright or Cypress, can write these files
itself and hand them to memlab. See
[Integrate with Test Frameworks](https://meta.github.io/memlab/docs/guides/integrate-with-e2e-frameworks)
for the format of `snap-seq.json` and `run-meta.json`.

## Browser options

These `memlab run` and `memlab snapshot` options are handled here:

| Option | Effect |
| --- | --- |
| `--headful` | Show the browser window |
| `--device <name>` | Emulate a device, for example a phone |
| `--user-agent <ua>` | Override the browser's user agent |
| `--chromium-binary <path>` | Use a specific Chromium build |
| `--full` | Take a heap snapshot after every step, not just the three above |
| `--skip-gc`, `--skip-scroll`, `--skip-extra-ops`, `--skip-screenshot` | Skip parts of each step to make a run faster |
| `--display-leak-outlines` | Outline leaked components on the page (with `--headful`), using [`@memlab/lens`](https://www.npmjs.com/package/@memlab/lens) |
| `--disable-xvfb` | Don't use a virtual display for headful runs on Linux |
| `--protocol-timeout <ms>` | Allow more time for very large heap snapshots |

The full list is in the
[CLI reference](https://meta.github.io/memlab/docs/cli/CLI-commands#memlab-run).

## Online Resources

* [Official Website and Demo](https://meta.github.io/memlab)
* [Documentation](https://meta.github.io/memlab/docs/intro)
* [Test scenario reference](https://meta.github.io/memlab/docs/api/core/src/interfaces/IScenario)

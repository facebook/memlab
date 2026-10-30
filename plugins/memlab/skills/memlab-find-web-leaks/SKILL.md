---
name: memlab-find-web-leaks
description: Find memory leaks in a web app with memlab. Write a test scenario (url, action, back) that drives the page in Chromium through Puppeteer, run `memlab run`, read the clustered leak traces, and fix the code that keeps detached DOM elements, unmounted React components or other objects alive. Use when the user asks to check a page, component, modal, dialog, route or user flow for memory leaks, to write a memlab scenario, to set up memory leak tests for a web app, or to find out why memory is not released after a UI interaction is undone.
license: MIT
compatibility: Requires Node.js and the memlab npm package (npm install -g memlab, or npx memlab). memlab downloads its own Chromium on install. Needs network access to the page under test.
metadata:
  homepage: https://meta.github.io/memlab/docs/intro
  repository: https://github.com/meta/memlab
---

# Find memory leaks in a web app with memlab

memlab loads the page, takes a heap snapshot, runs the interaction you suspect
(`action`), undoes it (`back`), and takes two more snapshots. Objects that
`action` allocated and that are still alive after `back` are leak candidates.
By default memlab reports detached DOM elements and unmounted React Fiber
nodes, grouped into clusters by retainer trace.

## 1. Install

```bash
npm install -g memlab   # or prefix every command with npx: npx memlab run ...
memlab version
```

## 2. Write the scenario

Save a file such as `scenario.js`. Pick **one** interaction, and make `back`
its exact inverse:

```javascript
// scenario.js
module.exports = {
  // Page to load first. memlab takes the baseline snapshot here.
  url: () => 'http://localhost:3000/',

  // The interaction suspected of leaking. Target snapshot after this.
  action: async page => {
    await page.click('[data-testid="open-settings"]');
    await page.waitForSelector('[data-testid="settings-dialog"]');
  },

  // Undo the interaction without reloading. Final snapshot after this.
  back: async page => {
    await page.click('[data-testid="close-settings"]');
    await page.waitForSelector('[data-testid="settings-dialog"]', {hidden: true});
  },
};
```

Rules that keep the result valid:

- **No reloads in `action` or `back`.** `page.goto()`, `page.reload()`,
  `location.reload()` or a link that does a full page load start a new heap.
  memlab detects this and stops with "The page is reloaded. MemLab cannot
  analyze heap across page reloads." Client-side route changes are fine.
- **`back` must really undo `action`.** If the dialog stays open, its objects
  are still in use and nothing is reported (or everything is).
- **`page` is a Puppeteer `Page`.** memlab 2.x uses Puppeteer 24: only use
  methods from the [Puppeteer API](https://pptr.dev/api/puppeteer.page).
  `page.waitForXPath()` no longer exists. Puppeteer locators have no
  `count()` or `first()`; use `page.$$(selector)` to count elements.
- **`await` every Puppeteer call.**
- **Log in with `cookies` (or in `setup`), not in `action`.** Work done in
  `action` that `back` doesn't undo shows up as leaks.
- **Keep it minimal.** Add other callbacks only when needed. `repeat` is only
  for stress tests.

All scenario callbacks, with examples, are in
[references/scenario-api.md](references/scenario-api.md).

## 3. Run

```bash
memlab run --scenario scenario.js
```

When it fails or gets stuck, add `--verbose` for stack traces, `--headful` to
watch the browser, or `--debug` to pause after each step. Leave them off
otherwise. `--work-dir <dir>` saves the run somewhere other than the default
working directory (`memlab get-default-work-dir`).

## 4. Read the result

```
MemLab found 1 leak(s)
--Similar leaks in this run: 4--
--Retained size of leaked objects: 8.3MB--
[Window] (native) @35847 [8.3MB]
  --20 (element)--->  [InternalNode] (native) @130981728 [8.3MB]
  --1 (element)--->  [EventListener] (native) @131009888 [8.3MB]
  --1 (element)--->  [V8EventListener] (native) @224808192 [8.3MB]
  --1 (element)--->  [eventHandler] (closure) @168079 [8.3MB]
  --context (internal)--->  [<function scope>] (object) @181905 [8.3MB]
  --bigArray (variable)--->  [Array] (object) @182925 [8.3MB]
```

- Each block is a **cluster** of leaks with similar retainer traces, sorted by
  retained size. "Similar leaks" is how many leaked objects share it.
- A trace starts at a GC root and ends at the leaked object. Each line is
  `--edge (edge type)--->  [node name] (node type) @id [retained size]`.
- **Find the link to break**: scan for the first names that come from the
  app (a closure, property or variable name) rather than the browser or the
  framework. Above, the `eventHandler` closure is still registered as an event
  listener, and its scope holds `bigArray`. The fix is to remove the listener
  when the UI closes.
- Traces are much easier to read when the app serves unminified code or keeps
  readable names.
- The text report is saved in the working directory as `data/out/leaks.txt`.
  `memlab run` also copies it to `data/cur/leaks.txt`, next to the three
  snapshots `s1`–`s3.heapsnapshot`. Runs through `@memlab/api` leave it only in
  `data/out/`.

## 5. When the trace isn't enough

- `memlab trace --node-id <id>`: the retainer trace for one object.
- `memlab view-heap --snapshot <file>`: interactive heap browser.
- **Nothing reported but memory still grows?** The built-in detector only
  reports detached DOM and unmounted Fiber nodes. Run
  `memlab find-leaks --trace-all-objects` to treat every object `action`
  allocated as a leak, and narrow it with `--trace-object-size-above <bytes>`.
  To keep a custom rule, add a `leakFilter` to the scenario.
- `memlab analyze unbound-object` (and the other `memlab analyze` plugins)
  works on the snapshots from the last run.
- For an interactive investigation of the saved snapshots, use the
  `memlab-analyze-heap-snapshot` skill or the memlab MCP server.

## 6. Fix and confirm

Change the code at the link you found, rebuild the app, and run the same
scenario again. The cluster should be gone or its retained size much smaller.
Report the trace before and after the fix.

To keep the check running in CI, see the `memlab-memory-tests` skill or the
[continuous test guide](https://meta.github.io/memlab/docs/guides/integration-and-file-structure).

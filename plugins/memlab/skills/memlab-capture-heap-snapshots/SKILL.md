---
name: memlab-capture-heap-snapshots
description: Capture JavaScript heap snapshots (.heapsnapshot files) for memory analysis from Chrome or Edge, Puppeteer, Playwright, Node.js, Electron or React Native (Hermes), including a series of snapshots that shows what grows over repeated interactions. Use when the user needs a heap snapshot, a heap dump of a Node.js process or one taken near out-of-memory, wants to measure memory growth or a suspected leak, or asks how to take snapshots in a test so memlab can analyze them.
license: MIT
compatibility: Browser capture needs a Chromium-based browser (Chrome, Edge, or the Chromium that Puppeteer or Playwright launches). Node.js capture needs Node.js 12+ (v8.writeHeapSnapshot and --heapsnapshot-signal).
metadata:
  homepage: https://meta.github.io/memlab/docs/mcp-server#getting-a-heap-snapshot
  repository: https://github.com/meta/memlab
---

# Capture JavaScript heap snapshots

A heap snapshot is a full dump of a JavaScript heap: every object, the
references between them, and their sizes. memlab, Chrome DevTools and the
memlab MCP server all read the same `.heapsnapshot` format.

## Decide what to capture first

- **"What is using memory?"** One snapshot, taken when memory is high.
- **"Is something leaking?"** Several snapshots from the **same** page or
  process: no reload and no restart in between, with the suspect interaction
  repeated between captures. A single snapshot can't show growth.
- Take snapshots from a build that matches the problem. Development builds
  (React development mode, hot reload, source-map tooling) hold extra memory a
  production build doesn't.

## Browser (Chrome, Edge)

**By hand**: DevTools → **Memory** → **Heap snapshot** → **Take snapshot**,
then right-click the snapshot → **Save...**. DevTools runs garbage collection
before each snapshot. Use a profile without extensions (or a guest window):
extensions add their own objects to the page's heap.

**From an agent, with the memlab MCP server**: start the browser with
`--remote-debugging-port=9222`, then call `memlab_capture` with `out_dir` and a
`label`. It also captures the page's dedicated workers, which a page snapshot
never includes. `list_targets: true` lists the pages it can attach to, and
`url_filter` picks one. A saved capture can later be referred to as
`checkpoint:<label>` wherever a snapshot path is accepted.

**From Puppeteer or Playwright test code** (Chromium only): use a CDP session.
See [references/capture-code.md](references/capture-code.md) for a
copy-paste helper that runs garbage collection and streams the snapshot to a
file.

## Node.js

- **From code**: `require('v8').writeHeapSnapshot()` writes a snapshot into
  the current directory and returns the file name. Pass a path to choose it.
- **From outside, on demand**: start with
  `node --heapsnapshot-signal=SIGUSR2 app.js`, then run `kill -USR2 <pid>`
  each time you want a snapshot.
- **Just before running out of memory**: start with
  `node --heapsnapshot-near-heap-limit=3 app.js` (Node.js 14.18+/15.1+). It
  writes up to 3 snapshots as the heap approaches its limit.
- **Interactively**: start with `node --inspect app.js`, open
  `chrome://inspect`, and use the Memory tab as in a browser.
- **In a memlab test**: `dumpNodeHeapSnapshot()` from `@memlab/core` writes a
  snapshot to a temp folder and returns its path.

Writing a snapshot pauses the process and can temporarily need about as much
memory again as the heap itself. Don't take one from a production server that
is already close to its memory limit unless you can afford the pause.

## Electron

- Renderer processes: open DevTools in the window and use the Memory tab.
- Main process: it is Node.js, so use `v8.writeHeapSnapshot()`, or start the
  app with `--inspect` and attach from `chrome://inspect`.

## React Native (Hermes)

Open the debugger for the app (React Native DevTools) and take a heap snapshot
from its Memory panel. memlab reads Hermes snapshots too.

## memlab itself

`memlab run --scenario <file>` and `memlab snapshot --scenario <file>` drive
a page in Chromium and save `s1.heapsnapshot` (baseline), `s2.heapsnapshot`
(after the action) and `s3.heapsnapshot` (after undoing it) under
`$(memlab get-default-work-dir)/data/cur/`. See the `memlab-find-web-leaks`
skill for writing the scenario.

## Capture a series that shows growth

1. Load the page or start the process. Run the interaction a few times to warm
   up caches and lazy-loaded code.
2. Take snapshot 0.
3. Repeat the interaction N times (for example 10), returning to the starting
   state each time. Take the next snapshot. Do this 3–5 times.
4. Optional but valuable: leave the app idle for a minute, run GC, and take a
   final "settle" snapshot. Growth that disappears here was work in flight, not
   a leak.
5. Name the files in order and record the cycle count, for example
   `rung_00_c000.heapsnapshot`, `rung_01_c010.heapsnapshot`, ... memlab's
   series tools read the cycle count from that naming.

Then analyze them with `memlab_sequence_analysis` or `memlab_leak_report`
(`paths` in order), or diff two of them with `memlab_diff_snapshots`. The
`memlab-analyze-heap-snapshot` skill covers the analysis.

## Before sharing a snapshot

A heap snapshot contains every string in memory: tokens, cookies, user data,
API responses. Treat it as sensitive. `memlab anonymize --snapshot <in>
--output <out>` (or the MCP tool `memlab_anonymize_snapshot`) writes a copy
with user data redacted that still works for analysis. Run it again with
`--audit-only` on the output to see anything left in the clear before you
share it.

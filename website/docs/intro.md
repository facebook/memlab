---
sidebar_position: 1
---

# Why memlab

One of the challenges in building a single-page application (SPA) like
Facebook.com is to test and check memory leaks at scale.
Manually triggering, finding, and analyzing memory leaks is tedious
and inefficient, especially considering the number of changes that go live
continuously. We built memlab to automate and ease the process in
[continuous tests](./guides/integration-and-file-structure).

## Features
memlab is a memory testing framework for JS in browsers. It supports
defining a [test scenario](./api/interfaces/core_src.IScenario)
(using [Puppeteer API](https://pptr.dev/api/puppeteer.page#methods))
that teaches memlab how to interact with your Single-page Application (SPA),
memlab can handle the rest for memory leak checking automatically:
 * Interact with browser and take JavaScript heap snapshots
 * Analyze heap snapshots and filter out memory leaks
 * Aggregate and group similar memory leaks
 * Generate retainer traces for memory debugging

For more details on how memlab finds memory leaks, please check out
[this link](./how-memlab-works).

-----------------

Other features provided by memlab:

 * **Object-oriented heap traversing API** - Supports [self-defined memory leak
   detector](./api/interfaces/core_src.ILeakFilter) and programmatically
   analyzing JS heap snapshots taken from
   Chromium-based browsers, Node.js, Electron.js, and Hermes
 * **Memory CLI toolbox** - Built-in [CLI toolbox](./cli/CLI-commands#memlab-analyze)
   and [APIs](./api/classes/heap_analysis_src.BaseAnalysis) for finding memory
   optimization opportunities (not necessarily memory leaks)
 * **Memory assertions in Node.js** - Enables unit test or running node.js
   program to take a heap snapshot of its own state, do self memory checking,
   and write memory assertions
   ([doc](api/interfaces/core_src.IHeapSnapshot#hasobjectwithclassnameclassname))

Trying out memlab:
- [Install the npm package](./installation) and read the
  [Getting Started](/docs/getting-started) section
- Use the node.js [APIs](/docs/api)

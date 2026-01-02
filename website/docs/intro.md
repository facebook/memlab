---
sidebar_position: 1
---

# Why memlab

One of the challenges with building a single-page application (SPA) like
Facebook.com is to test and check for memory leaks at scale.
Manually triggering, finding, and analyzing memory leaks is tedious
and inefficient, especially considering the number of changes that go live
continuously. We built memlab to automate and ease the process in
[continuous tests](./guides/04-continuous-test.md).

## Features
Memlab is a memory testing framework for JavaScript. It supports
defining a [test scenario](./api/core/src/interfaces/IScenario)
(using [Puppeteer API](https://pptr.dev/api/puppeteer.page#methods))
that teaches Memlab how to interact with your Single-page Application (SPA),
Memlab can handle the rest for memory leak checking automatically:
 * Interact with browser and take JavaScript heap snapshots
 * Analyze heap snapshots and filter out memory leaks
 * Aggregate and group similar memory leaks
 * Generate retainer traces for memory debugging

For more details on how memlab finds memory leaks, please check out
[this link](./how-memlab-works.md).

-----------------

Other features provided by memlab:

 * **Object-oriented heap traversing API** - Supports [self-defined memory leak
   detector](./api/core/src/interfaces/ILeakFilter) and programmatically
   analyzing JS heap snapshots taken from
   Chromium-based browsers, Node.js, Electron.js, and Hermes.
 * **Memory CLI toolbox** - Built-in [CLI toolbox](./cli/CLI-commands.md#memlab-analyze)
   and [APIs](./api/heap-analysis/src/classes/BaseAnalysis) for finding memory
   optimization opportunities (not necessarily memory leaks)
 * **Memory assertions in Node.js** - Enables unit tests or running node.js
   programs to take a heap snapshot of their own state, do self memory checking,
   and write memory assertions
   ([doc](./api/core/src/interfaces/IHeapSnapshot#hasobjectwithclassname))

Trying out memlab:
- [Install the npm package](./installation.md) and read the
  [Getting Started](./getting-started.md) section
- Use the node.js [APIs](./api/index.md)

Read this [engineering blog post](https://engineering.fb.com/2022/09/12/open-source/memlab/)
on how MemLab is used at Meta.

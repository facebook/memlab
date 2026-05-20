---
sidebar_position: 1
---

# Why memlab

One of the biggest challenges when building a single-page application (SPA) like
Facebook.com is testing for memory leaks at scale.
Manually triggering, finding, and analyzing memory leaks is tedious
and inefficient, especially given the volume of changes that go live
continuously. We built memlab to automate this process for
[continuous testing](./guides/04-continuous-test.md).

## Features
Memlab is a memory testing framework for JavaScript. You define a
[test scenario](./api/core/src/interfaces/IScenario)
(using the [Puppeteer API](https://pptr.dev/api/puppeteer.page#methods))
that describes how to interact with your single-page application (SPA),
and memlab handles the rest automatically:
 * Interact with browser and take JavaScript heap snapshots
 * Analyze heap snapshots and filter out memory leaks
 * Aggregate and group similar memory leaks
 * Generate retainer traces for memory debugging

For more details on how memlab finds memory leaks, see
[How memlab Works](./how-memlab-works.md).

-----------------

Other features provided by memlab:

 * **Object-oriented heap traversal API** - Supports [custom memory leak
   detectors](./api/core/src/interfaces/ILeakFilter) and programmatic
   analysis of JS heap snapshots taken from
   Chromium-based browsers, Node.js, Electron.js, and Hermes.
 * **Memory CLI toolbox** - Built-in [CLI toolbox](./cli/CLI-commands.md#memlab-analyze)
   and [APIs](./api/heap-analysis/src/classes/BaseAnalysis) for finding memory
   optimization opportunities (not necessarily memory leaks).
 * **Memory assertions in Node.js** - Lets unit tests or Node.js
   programs take a heap snapshot of their own state, perform self-checks,
   and write memory assertions
   ([doc](./api/core/src/interfaces/IHeapSnapshot#hasobjectwithclassname)).

To try memlab:
- [Install the npm package](./installation.md) and follow the
  [Getting Started](./getting-started.md) guide.
- Use the Node.js [APIs](./api/index.md).

Read this [engineering blog post](https://engineering.fb.com/2022/09/12/open-source/memlab/)
to learn how MemLab is used at Meta.

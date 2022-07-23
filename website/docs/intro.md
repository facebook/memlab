---
sidebar_position: 1
---

# Introduction

## Why did we build memlab?

One of the challenges in building a single-page application (SPA) like
Facebook.com is to monitor & detect memory leaks at scale. Especially
considering the number of changes that go live continuously, we built
memlab that automates memory leak detection.

## What is memlab?
memlab is a memory testing framework for JS in browsers.

If you define a [test scenario](./api/interfaces/core_src.IScenario)
(using [Puppeteer API](https://pptr.dev/api/puppeteer.page#methods))
teaching memlab how to interact with your Single-page Application (SPA),
memlab can handle the rest automatically:
 * Interact with browser
 * Take JavaScript heap snapshots
 * Analyze heap snapshots and filter out memory leaks
 * Aggregate and group memory leaks
 * Generate retainer traces for memory leaks

This can be useful if you want to set up continuous tests finding
and reporting memory leaks in your SPA.

## What else can memlab do?
 * **Object-oriented heap traversing API** - Supports self-defined memory leak
   detector and programmatically analyzing JS heap snapshots taken from
   Chromium-based browsers, Node.js, Electron.js, and Hermes
 * **Memory CLI toolbox** - Built-in toolbox and APIs for finding memory
   optimization opportunities (not necessarily memory leaks)
 * **Memory assertions in Node.js** - Enables unit test or running node.js
   program to take a heap snapshot of its own state, do self memory checking,
   or write advanced memory assertions

If you feel curious to test it out on your own:
- Head over to the [Getting Started](/docs/getting-started) section
- Want to learn more about the [APIs](/docs/api)?

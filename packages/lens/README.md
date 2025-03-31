# MemLens

## What is this?

MemLens is a debugging tool that helps identify memory leaks in React applications. It tracks:

- Detached DOM elements that are no longer connected to the document but still held in memory
- Unmounted React Fiber nodes that haven't been properly cleaned up
- Memory usage patterns and growth over time

The tool provides:

1. Real-time memory monitoring through the browser console
2. Visual representation of problematic DOM elements and React components
3. Memory usage statistics and trends

This can help developers identify:
- Components that aren't properly cleaned up

## How to Build?

```bash
webpack
```

## How to Test?

1. Install Playwright

```bash
npx playwright install
npx playwright install-deps
```

2. Run the test

```bash
npm run test:e2e
```

3. Test manually by copying and pasting the content of `dist/run.bundle.js`
into web console


## TODO List
 * Note that document.querySelectorAll('*') only captures DOM elements on the DOM tree
   * So the DOM tree scanning and component name analysis must be done in a frequent interval (every 10s or so)
 * Extensible framework for tracking additional metadata
 * Auto diffing and counting detached Element and unmounted Fiber nodes
   * being able to summarize the leaked components that was not reported (this can reduce the report overhead)
 * Improve the DOM visualizer - only visualize the common ancestors of the detached DOM elements and unmounted fiber nodes
 * Improving the scanning efficiency so that the overhead is minimal in production environment
 * Improve the fiber tree traversal efficiency (there are redundant traversals right now)
 * Not only keep track of detached DOM elements, but also keep track of unmounted fiber nodes in WeakMap and WeakSet
 * DOM visualizer is leaking canvas DOM elements after each scan
 * Monitor event listener leaks?
 * Real-time memory usage graphs
 * Real-time component count and other react memory scan obtained stats graphs
 * Component re-render heat maps
 * Interactive component tree navigation
 * Browser extension integration
 * centralized config file
 * centralized exception handling

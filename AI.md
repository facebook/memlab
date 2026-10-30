# MemLab AI Assistant Guide

This document provides guidance for AI assistants (like ChatGPT, GitHub Copilot, Cursor, etc.) on how to correctly use and explain MemLab, a JavaScript memory leak detection framework.

Step-by-step workflows for the common tasks are also packaged as [Agent Skills](./plugins/memlab/skills): analyzing a heap snapshot, finding leaks in a web app, capturing heap snapshots, and writing memory leak tests. Claude Code users can install them together with the MCP server as the [memlab plugin](./plugins/memlab).

## Overview

MemLab is an end-to-end testing and analysis framework for identifying JavaScript memory leaks and optimization opportunities. It works by:
1. Starting a headless Chrome browser
2. Interacting with web pages using Puppeteer
3. Taking JavaScript heap snapshots at different stages
4. Analyzing and diffing heap snapshots to detect memory leaks

## Choosing the Right MemLab Tool

Pick the tool from what the user has and what they want to know:

| The user wants to... | Use |
|---|---|
| Find leaks caused by an interaction in a web app | A [scenario file](#2-scenario-file-structure) and `memlab run --scenario <file>`, or `run()` from `@memlab/api` |
| Understand a heap snapshot they already have | The [MCP server](#mcp-server-for-ai-assisted-heap-analysis), or `memlab view-heap --snapshot <file>` / `memlab analyze <plugin> --snapshot <file>` |
| Find leaks in snapshots taken by another test framework (Playwright, Cypress, ...) | `memlab find-leaks --baseline <file> --target <file> --final <file>`, or `findLeaksBySnapshotFilePaths()` from `@memlab/api` |
| Assert in a Node.js unit test that an object was released | `takeNodeMinimalHeap()` from `@memlab/core` (see [Memory Assertions in Node.js](#memory-assertions-in-nodejs)) |
| Run leak detection in CI | `@memlab/api` in a test job (see [Programmatic API](#programmatic-api)) |
| See leaked DOM elements and React components on the live page | [`@memlab/lens`](https://www.npmjs.com/package/@memlab/lens), an in-browser overlay |

## Getting a Heap Snapshot

MemLab reads `.heapsnapshot` files from Chromium-based browsers, Node.js, Electron and Hermes. Ways to get one:

- **Chrome DevTools**: Memory tab → **Heap snapshot** → **Take snapshot**, then right-click the snapshot and choose **Save...**.
- **memlab**: `memlab run` and `memlab snapshot` save their snapshots under `$(memlab get-default-work-dir)/data/cur/`.
- **A running Chrome**: start Chrome with `--remote-debugging-port=9222 --user-data-dir=<temp dir>` and call the MCP tool `memlab_capture`. Chrome 136 and later ignore the port flag on the default profile. It also snapshots the page's dedicated workers.
- **Node.js**: call `require('v8').writeHeapSnapshot()` from the program, or start it with `node --heapsnapshot-signal=SIGUSR2 app.js` and run `kill -USR2 <pid>` when you want a snapshot.
- **Electron**: use DevTools for renderer processes; the main process is Node.js, so use `v8.writeHeapSnapshot()`.
- **React Native (Hermes)**: take a heap snapshot from the Memory panel of the debugger attached to the app.

To find a leak, take snapshots before and after the interaction, or a series of snapshots while the interaction repeats. A single snapshot shows what is in memory, not what is growing.

## Core Principles

### 1. Three-Phase Testing Model

MemLab follows a three-phase interaction model:

- **Baseline (BP)**: Initial page load via `url()` callback → snapshot `SBP`
- **Target (TP)**: Action/interaction via `action()` callback → snapshot `STP`
- **Final (FP)**: Revert/cleanup via `back()` callback → snapshot `SFP`

**Leak Detection Formula**: `(STP \ SBP) ∩ SFP`

Objects are considered leaked if they:
- Were allocated during the `action` phase (present in STP but not SBP)
- Remain in memory after the `back` phase (present in SFP)

### 2. Scenario File Structure

A scenario file is a JavaScript module that exports an object implementing the `IScenario` interface:

```javascript
module.exports = {
  url: () => string,           // Required: initial page URL
  action: async (page) => {},  // Recommended: interaction that may cause leaks
  back: async (page) => {},    // Recommended: revert to baseline state
  // Optional callbacks:
  cookies: () => Cookies[],    // Authentication cookies
  setup: async (page) => {},   // Setup after initial page load
  beforeInitialPageLoad: async (page) => {}, // Setup before page load
  isPageLoaded: async (page) => boolean,     // Custom page-load check
  leakFilter: (node, snapshot, leakedNodeIds) => boolean, // Custom leak detection
  beforeLeakFilter: (snapshot, leakedNodeIds) => {},      // One-time init before leakFilter
  retainerReferenceFilter: (edge, snapshot, isReferenceUsedByDefault) => boolean, // Filter retainer trace edges
  repeat: () => number,       // Extra action/back cycles (only for stress testing)
};
```

**Important**: Only `url()` is strictly required. For most scenarios, `url()`, `action()`, and `back()` are all you need. Only use other optional callbacks (`setup`, `cookies`, `beforeInitialPageLoad`, `isPageLoaded`, `leakFilter`, `beforeLeakFilter`, `retainerReferenceFilter`, `repeat`) when they are necessary for your specific use case. Keep scenarios simple and focused.

**Note on `repeat()`**: The `repeat()` callback should **only** be used when users explicitly want to stress test memory by repeating the action/back cycle multiple times. For normal memory leak detection, there is no need to define `repeat()` - MemLab will run the scenario once by default.

## Critical Guidelines for AI Assistants

### ⚠️ TOP PRIORITY: Puppeteer Page API Usage

**CRITICAL RULE**: The `page` parameter in all test scenario callbacks (`action`, `back`, `setup`, `beforeInitialPageLoad`, etc.) is a **Puppeteer Page object**.

**You MUST:**
- ✅ Only use valid Puppeteer Page APIs that exist in the official documentation
- ✅ Refer to the [Puppeteer Page API documentation](https://pptr.dev/category/introduction) when generating code
- ✅ Verify API names, method signatures, and parameters match the official Puppeteer v24 API (for MemLab v2.x.x) or v22 API (for MemLab v1.x.x)

**You MUST NOT:**
- ❌ Hallucinate or invent API methods that don't exist
- ❌ Use deprecated or removed APIs (e.g., `page.waitForXPath()` in Puppeteer v24)
- ❌ Assume methods exist without checking the documentation
- ❌ Mix APIs from different versions or frameworks

**Common Valid Puppeteer Page APIs** (refer to [full documentation](https://pptr.dev/api/puppeteer.page)):
- `page.click(selector, options)`
- `page.type(selector, text, options)`
- `page.waitForSelector(selector, options)`
- `page.waitForNavigation(options)`
- `page.evaluate(pageFunction, args)`
- `page.$(selector)` and `page.$$(selector)`
- `page.locator(selector)` (Puppeteer v24+) - See [Locator API documentation](https://pptr.dev/api/puppeteer.locator)
- `page.goto(url, options)` - **BUT DO NOT USE IN `action()` OR `back()`** (see rule #1 in DON'T section)

**Common Valid Puppeteer Locator APIs** (refer to [full documentation](https://pptr.dev/api/puppeteer.locator)):
Locators are available in Puppeteer v24+ and provide a more robust way to interact with elements. They automatically retry actions and check preconditions.

- `page.locator(selector).click(options)` - Click the located element (with automatic retries)
- `page.locator(selector).fill(value, options)` - Fill input fields (automatically detects input type)
- `page.locator(selector).hover(options)` - Hover over the located element
- `page.locator(selector).scroll(options)` - Scroll the located element into view
- `page.locator(selector).wait(options)` - Wait for the locator to get a serialized value
- `page.locator(selector).waitHandle(options)` - Wait for the locator to get a handle
- `page.locator(selector).setTimeout(timeout)` - Set timeout for locator actions
- `page.locator(selector).setVisibility(visibility)` - Set visibility requirements
- `page.locator(selector).setWaitForEnabled(value)` - Wait for input elements to be enabled
- `page.locator(selector).setWaitForStableBoundingBox(value)` - Wait for stable bounding box

**Example using Locators:**
```javascript
// ✅ GOOD: Using locators (Puppeteer v24+)
action: async (page) => {
  await page.locator('#button').click();
  await page.locator('input[name="email"]').fill('user@example.com');
  await page.locator('text/Submit').click();
},
```

**🚨 HARD RULE: Puppeteer Locators DO NOT have `count()` or `first()` methods**

**CRITICAL**: Puppeteer's `page.locator()` return value does **NOT** have `.count()` or `.first()` methods. These methods do not exist in the Puppeteer Locator API.

**❌ WRONG - DO NOT USE:**
```javascript
// ❌ BAD: These methods DO NOT EXIST on Puppeteer locators
const loc = page.locator(selector).setTimeout(1500);
if (await loc.count()) {  // ❌ .count() does NOT exist
  await loc.first().click({timeout: 1500});  // ❌ .first() does NOT exist
  return true;
}
```

**✅ CORRECT alternatives:**
```javascript
// ✅ GOOD: Use locator directly (it handles retries automatically)
await page.locator(selector).setTimeout(1500).click();

// ✅ GOOD: Optional click. Locator actions (click, fill, waitHandle, ...)
// throw a TimeoutError if the element never appears; they never return null.
try {
  await page.locator(selector).setTimeout(1500).click();
} catch (e) {
  if (e.name !== 'TimeoutError') {
    throw e;
  }
}

// ✅ GOOD: Use page.$$() if you need to count elements
const elements = await page.$$(selector);
if (elements.length > 0) {
  await elements[0].click();
}
```

**You MUST**: Always verify the exact API methods available on Puppeteer Locators by checking the [Puppeteer Locator API documentation](https://pptr.dev/api/puppeteer.locator). Never assume methods like `count()` or `first()` exist without verification.

When in doubt, always check the [Puppeteer Page API documentation](https://pptr.dev/api/puppeteer.page) and [Puppeteer Locator API documentation](https://pptr.dev/api/puppeteer.locator) before suggesting any `page.*` or locator method calls.

### ✅ DO: Correct Scenario Patterns

**1. Include the three core callbacks for most scenarios:**
```javascript
module.exports = {
  url: () => 'https://example.com',
  action: async (page) => {
    await page.click('#button');
  },
  back: async (page) => {
    await page.click('#close');
  },
};
```

**2. Use proper Puppeteer selectors:**
- Prefer stable selectors (IDs, data attributes) over CSS classes
- Use `text/` prefix for text-based selection: `page.click('text/Close')`
- Wait for elements when necessary: `await page.waitForSelector('#element')`

**3. Ensure `back()` truly reverts state:**
```javascript
// ✅ GOOD: back() closes the widget opened by action()
action: async (page) => {
  await page.click('#open-modal');
},
back: async (page) => {
  await page.click('[aria-label="Close"]');
},

// ❌ BAD: back() doesn't actually revert the action
action: async (page) => {
  await page.click('#open-modal');
},
back: async (page) => {
  // Reloads the page instead of closing the modal; memlab stops the run
  await page.goto('https://example.com');
},
```

**4. Handle authentication properly:**
```javascript
// ✅ GOOD: Use cookies() for authentication
module.exports = {
  url: () => 'https://app.example.com',
  cookies: () => [
    {name: 'session', value: 'token123', domain: '.example.com'},
  ],
  action: async (page) => { /* ... */ },
  back: async (page) => { /* ... */ },
};

// ❌ BAD: Don't do login in action() - it pollutes the baseline
action: async (page) => {
  await page.type('#username', 'user');
  await page.type('#password', 'pass');
  await page.click('#login');
  // Now the actual action...
},
```

**Alternative**: If cookies are not available, you can perform login in the `setup()` callback. The `setup()` callback executes after the initial page load (from `url()`) and before the baseline snapshot, so it may navigate, for example through a login redirect. However, using `cookies()` is preferred when possible.

**5. Use `leakFilter` for custom detection:**
```javascript
// ✅ GOOD: Filter oversized objects
module.exports = {
  url: () => 'https://example.com',
  action: async (page) => { /* ... */ },
  back: async (page) => { /* ... */ },
  leakFilter: (node, snapshot, leakedNodeIds) => {
    // Report objects larger than 1MB as leaks
    return node.retainedSize > 1024 * 1024;
  },
};
```

**6. Only use `repeat()` for stress testing:**
```javascript
// ✅ GOOD: Only use repeat() when explicitly stress testing memory
module.exports = {
  url: () => 'https://example.com',
  action: async (page) => { /* ... */ },
  back: async (page) => { /* ... */ },
  repeat: () => 10,  // Repeat action/back cycle 10 more times for stress testing
};

// ✅ GOOD: For normal leak detection, omit repeat() - MemLab runs once by default
module.exports = {
  url: () => 'https://example.com',
  action: async (page) => { /* ... */ },
  back: async (page) => { /* ... */ },
  // No repeat() needed for normal use
};
```

**Important**: There is **no need** to define the `repeat()` callback in a scenario unless the user explicitly wants to stress test memory by repeating the action/back cycle multiple times. For normal memory leak detection, MemLab will run the scenario once by default, and adding `repeat()` is unnecessary complexity.

**7. Use `isPageLoaded` for custom page-load detection:**
```javascript
// ✅ GOOD: Wait for specific content before considering page loaded
module.exports = {
  url: () => 'https://example.com',
  action: async (page) => { /* ... */ },
  back: async (page) => { /* ... */ },
  isPageLoaded: async (page) => {
    await page.waitForNavigation({
      waitUntil: 'networkidle2',
      timeout: 5000,
    });
    return true;
  },
};
```

**8. Use `beforeLeakFilter` for one-time initialization before leak filtering:**
```javascript
// ✅ GOOD: Pre-compute data before filtering leaks
let importantIds;
module.exports = {
  url: () => 'https://example.com',
  action: async (page) => { /* ... */ },
  back: async (page) => { /* ... */ },
  beforeLeakFilter: (snapshot, leakedNodeIds) => {
    // one-time setup before leakFilter is called for each node
    importantIds = new Set([...leakedNodeIds].filter(id => {
      const node = snapshot.getNodeById(id);
      return node && node.retainedSize > 500000;
    }));
  },
  leakFilter: (node, snapshot, leakedNodeIds) => {
    return importantIds.has(node.id);
  },
};
```

**9. Use `retainerReferenceFilter` to customize retainer traces:**
```javascript
// ✅ GOOD: Exclude noisy references from retainer traces
module.exports = {
  url: () => 'https://example.com',
  action: async (page) => { /* ... */ },
  back: async (page) => { /* ... */ },
  retainerReferenceFilter: (edge, snapshot, isReferenceUsedByDefault) => {
    // exclude React Fiber internal references from retainer traces
    if (edge.name_or_index.toString().startsWith('__reactFiber$')) {
      return false;
    }
    return true;
  },
};
```

### ❌ DON'T: Common Mistakes

**1. Don't reload or navigate away in `action()` or `back()`:**
```javascript
// ❌ BAD: page.goto() and page.reload() load a new document with a fresh JS heap.
// memlab detects the reload after the baseline snapshot and stops the run:
// "The page is reloaded. MemLab cannot analyze heap across page reloads."

// ❌ BAD in back()
back: async (page) => {
  await page.goto('https://example.com'); // Reloads the page!
},

// ❌ BAD in action()
action: async (page) => {
  await page.goto('https://example.com/other'); // Reloads the page!
  await page.reload(); // Also reloads the page!
},

// ✅ GOOD: Use in-page interactions only
back: async (page) => {
  await page.click('#close-button'); // In-page interaction
},

action: async (page) => {
  await page.click('#open-modal'); // In-page interaction
  await page.waitForSelector('#content'); // Wait for content to load
},

// ✅ GOOD: url() sets the page for the initial load
url: () => 'https://example.com',
```

**Important**: After the baseline snapshot, anything that loads a new document breaks the heap comparison. In `action()` and `back()`, avoid:
- `page.goto()`
- `page.reload()`
- `page.evaluate(() => location.reload())` or assigning `location.href`
- Clicking a link or submitting a form that does a full page load

Client-side route changes in a single-page app (a click that updates the URL without reloading the page) are in-page interactions and are fine. `beforeInitialPageLoad()` and `setup()` run before the baseline snapshot, so navigating there doesn't break leak detection; the page `setup()` ends on becomes the baseline.

**2. Don't forget to wait for async operations:**
```javascript
// ❌ BAD: Action may complete before element is ready
action: async (page) => {
  page.click('#button'); // Missing await
  page.click('#next');   // Missing await
},

// ✅ GOOD: Always await async operations
action: async (page) => {
  await page.click('#button');
  await page.waitForSelector('#next');
  await page.click('#next');
},
```

**3. Don't leave out `action()` when you want leak detection:**
```javascript
// ❌ BAD: Without action(), memlab loads url() and takes a single heap
// snapshot. There is no baseline or final snapshot to diff, so no leaks
// are reported.
module.exports = {
  url: () => 'https://example.com',
};

// ✅ GOOD: To test whether visiting a page leaks, make visiting it the
// action() and leaving it the back(), using in-app navigation
module.exports = {
  url: () => 'https://example.com',
  action: async (page) => {
    await page.click('a[href="/settings"]'); // Client-side route change
    await page.waitForSelector('#settings-page');
  },
  back: async (page) => {
    await page.click('a[href="/"]');
    await page.waitForSelector('#home-page');
  },
};
```

A `url()`-only scenario is still useful with `memlab snapshot` when you want one heap snapshot to inspect with `memlab analyze <plugin> --snapshot <file>` or the MCP server.

**4. Don't use minified code without source maps:**
- MemLab's retainer traces are much more readable with unminified code
- Always recommend users serve unminified code or source maps for debugging

**5. Don't forget to dispose Puppeteer handles:**
```javascript
// ❌ BAD: Element handles can cause memory leaks
action: async (page) => {
  const element = await page.$('#button');
  // Element handle not disposed
},

// ✅ GOOD: Dispose handles or use direct methods
action: async (page) => {
  await page.click('#button'); // Direct method, no handle needed
  // OR
  const element = await page.$('#button');
  await element.click();
  await element.dispose(); // Explicitly dispose
},
```

## API Usage Patterns

### Programmatic API

When generating code that uses MemLab programmatically, the following functions are available from `@memlab/api`:

**`run(options?)`** — Full end-to-end: takes snapshots and finds leaks:
```typescript
import {run} from '@memlab/api';

const scenario = {
  url: () => 'https://example.com',
  action: async (page) => {
    await page.click('#button');
  },
  back: async (page) => {
    await page.click('#close');
  },
};

const {leaks, runResult} = await run({scenario});
console.log(`Found ${leaks.length} memory leaks`);
```

**`takeSnapshots(options?)`** — Take heap snapshots without leak detection:
```typescript
import {takeSnapshots} from '@memlab/api';

const result = await takeSnapshots({scenario});
// result is a BrowserInteractionResultReader
const snapshotFiles = result.getSnapshotFiles();
```

**`warmupAndTakeSnapshots(options?)`** — Warm up the server, then take snapshots:
```typescript
import {warmupAndTakeSnapshots} from '@memlab/api';

const result = await warmupAndTakeSnapshots({scenario});
```

**`findLeaks(runResult, options?)`** — Find leaks from a previous snapshot run:
```typescript
import {findLeaks, takeSnapshots} from '@memlab/api';

const result = await takeSnapshots({scenario});
const leaks = await findLeaks(result);
```

**`findLeaksBySnapshotFilePaths(baseline, target, final, options?)`** — Find leaks from three explicit snapshot files:
```typescript
import {findLeaksBySnapshotFilePaths} from '@memlab/api';

const leaks = await findLeaksBySnapshotFilePaths(
  '/path/to/baseline.heapsnapshot',
  '/path/to/target.heapsnapshot',
  '/path/to/final.heapsnapshot',
);
```

**`analyze(runResult, heapAnalyzer, args?)`** — Run a heap analysis plugin:
```typescript
import {analyze, takeSnapshots, StringAnalysis} from '@memlab/api';

const result = await takeSnapshots({scenario});
await analyze(result, new StringAnalysis());
```

**Result Readers:**
- `BrowserInteractionResultReader` — reads results from a `run()` or `takeSnapshots()` call
- `SnapshotResultReader` — reads results from standalone snapshot files:
```typescript
import {SnapshotResultReader, findLeaks} from '@memlab/api';

const reader = SnapshotResultReader.fromSnapshots(
  '/path/to/baseline.heapsnapshot',
  '/path/to/target.heapsnapshot',
  '/path/to/final.heapsnapshot',
);
const leaks = await findLeaks(reader);
```

### CLI Usage

When suggesting CLI commands:

```bash
# Full end-to-end leak detection (most common)
memlab run --scenario path/to/scenario.js

# Take snapshots only (no leak detection)
memlab snapshot --scenario path/to/scenario.js

# Warm up server and take snapshots
memlab warmup-and-snapshot --scenario path/to/scenario.js

# Find leaks from existing snapshots
memlab find-leaks --snapshot-dir ./snapshots
memlab find-leaks --baseline s1.heapsnapshot --target s2.heapsnapshot --final s3.heapsnapshot

# Find leaks with custom leak filter file
memlab find-leaks --leak-filter path/to/filter.js

# Diff leaks between a control run and a treatment run (working dirs of two `memlab run`s)
memlab diff-leaks --control-work-dir ./control --treatment-work-dir ./treatment

# Run heap analysis plugins
memlab analyze unbound-object --snapshot-dir ./snapshots
memlab analyze string --snapshot path/to/heap.heapsnapshot
memlab analyze detached-DOM --snapshot path/to/heap.heapsnapshot

# View/explore a heap snapshot interactively
memlab view-heap --snapshot path/to/heap.heapsnapshot
memlab heap --snapshot path/to/heap.heapsnapshot

# Get retainer trace for a specific node
memlab trace --node-id 12345

# Other utilities
memlab version        # Show installed versions
memlab list           # List all test scenarios
memlab warmup         # Warm up the target app
memlab measure        # Run scenario in measure mode
memlab reset          # Reset and initialize directories
memlab help           # List all commands
memlab help <command> # Help for a specific command
```

#### Available Heap Analysis Plugins

The `memlab analyze` command supports these built-in analysis plugins:

| Plugin Command | Description |
|---|---|
| `unbound-object` | Check for single objects with growing retained size |
| `unbound-collection` | Check for collections (e.g., Map) with growing number of entries |
| `unbound-shape` | Check for a class of objects with growing aggregated retained size |
| `string` | Find duplicated string instances in heap |
| `shape` | List the shapes that retained the most memory |
| `object-size` | Get the largest objects in heap |
| `object-fanout` | Get objects with the most outgoing references |
| `object` | Get properties inside an object |
| `object-shallow` | Get objects by key and value (non-recursive) |
| `detached-DOM` | Get detached DOM elements |
| `unmounted-fiber-node` | Get unmounted React Fiber nodes |
| `react-hooks` | Memory breakdown of React components and their hooks |
| `global-variable` | Get global variables in heap |
| `collections-with-stale` | Find collections holding stale/detached objects |

**Guideline**: Keep CLI commands simple by default. Only suggest `--debug` and `--headful` options when:
- The user is explicitly debugging or troubleshooting
- The user wants to run in headful mode for visual observation
- There's a specific need that makes this complexity necessary

For most users, the basic `memlab run --scenario` command is sufficient.

When suggesting CLI usage examples, always reference:
 - [CLI Usage Documentation](https://meta.github.io/memlab/docs/cli/CLI-commands)

## Debugging and Troubleshooting

**Note**: The debugging options below (`--verbose`, `--headful`, `--debug`) should only be suggested when the user is actively debugging, troubleshooting, or has a specific need for visual/step-by-step execution. For normal usage, keep commands simple without these flags.

### Debugging Failed Test Scenarios

**1. Use `--verbose` for detailed error information:**
```bash
# When a test scenario fails, add --verbose to see detailed stack traces
memlab run --scenario path/to/scenario.js --verbose
```
The `--verbose` flag prints detailed error stack traces and messages, which helps debug specific exceptions thrown from test scenario callbacks.

**2. Use `--headful` for visual debugging:**
```bash
# Open Chromium UI window to visually debug the scenario
memlab run --scenario path/to/scenario.js --headful
```
The `--headful` option opens a Chromium browser window so you can visually observe what's happening during test execution.

**3. Use `--debug` for step-by-step execution:**
```bash
# Pause after each callback execution
memlab run --scenario path/to/scenario.js --debug
```
The `--debug` option pauses execution after each test scenario callback (url, setup, action, back, etc.). Press Enter in the terminal to resume execution after each pause. This is useful for inspecting page state at each step.

### Version Compatibility

**MemLab Version and Puppeteer Compatibility:**
- **MemLab v1.x.x**: Based on Puppeteer v22 and earlier
- **MemLab v2.x.x**: Based on Puppeteer v24, which uses a newer Chromium version

**Recommendation**: Upgrade to MemLab v2.x.x for better compatibility and newer Chromium features. Check your current version with:
```bash
memlab version
```

**Important**: In MemLab v2.x.x, test scenario callbacks that use the Puppeteer `page` parameter can only use Puppeteer APIs available in Puppeteer v24. Some older APIs have been deprecated and removed:
- ❌ `page.waitForXPath()` - deprecated and removed
- ✅ Use `page.waitForSelector()` or `page.locator()` instead - See [Locator API documentation](https://pptr.dev/api/puppeteer.locator)

When generating code for MemLab v2.x.x, ensure you're using Puppeteer v24-compatible APIs. Refer to the [Puppeteer v24 migration guide](https://pptr.dev/) for API changes.

## Built-in Leak Detection

MemLab's default leak detector considers objects as leaks if they:
1. Were allocated during `action()` (present in STP but not SBP)
2. Remain after `back()` (present in SFP)
3. Are either:
   - Detached DOM elements, OR
   - Unmounted React Fiber nodes

**Important**: Objects that are intentionally cached/retained are NOT considered leaks by default. Use `leakFilter` to detect other types of leaks.

## Memory Assertions in Node.js

When generating code for Node.js memory assertions:

```typescript
import {takeNodeMinimalHeap, config} from '@memlab/core';
import type {IHeapSnapshot} from '@memlab/core';

test('memory assertion', async () => {
  config.muteConsole = true;

  let obj = new MyClass();
  let heap: IHeapSnapshot = await takeNodeMinimalHeap();

  expect(heap.hasObjectWithClassName('MyClass')).toBe(true);

  obj = null;
  heap = await takeNodeMinimalHeap();

  expect(heap.hasObjectWithClassName('MyClass')).toBe(false);
});
```

## Key Concepts to Explain

When explaining MemLab to users:

1. **Retainer Traces**: Show the reference chain from GC root to leaked object. Breaking any link in the chain allows garbage collection.

2. **Heap Snapshots**: V8/Hermes heap snapshots are decoded and queryable via the `IHeapSnapshot` API.

3. **Leak Clustering**: Similar leaks are automatically grouped to reduce noise in reports.

4. **Scenario Isolation**: Each scenario should test one specific interaction pattern.

5. **Baseline Importance**: The baseline snapshot (SBP) is crucial - it filters out objects that existed before the action.

## MCP Server for AI-Assisted Heap Analysis

The `@memlab/mcp-server` package is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that lets AI assistants load JavaScript heap snapshots and investigate them in conversation. It has more than 150 tools and works with any MCP client (Claude Code, Codex, Cursor, Windsurf, VS Code, and others). Use it when the user already has a `.heapsnapshot` file, or when a `memlab run` report needs a deeper look than the leak trace gives.

For a step-by-step investigation method (triage, investigation paths by symptom, how to present retainer chains), see the [MCP Investigation Skill](./packages/mcp-server/MCP_SKILL.md). For every tool and option, see the [MCP server README](./packages/mcp-server/README.md).

### Setup

Add the server to the MCP client's configuration:

```json
{
  "mcpServers": {
    "memlab": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@memlab/mcp-server"],
      "env": {
        "NODE_OPTIONS": "--max-old-space-size=8192"
      }
    }
  }
}
```

Or register it from the command line:

```bash
# Claude Code
claude mcp add memlab -e NODE_OPTIONS=--max-old-space-size=8192 -- npx -y @memlab/mcp-server

# Codex CLI
codex mcp add memlab --env NODE_OPTIONS=--max-old-space-size=8192 -- npx -y @memlab/mcp-server
```

**Always keep `--max-old-space-size=8192` (or higher).** The server keeps the whole parsed heap graph in memory, which takes several times the snapshot's file size. With less memory, `memlab_load_snapshot` refuses large snapshots to avoid crashing the server.

### Without an MCP client: `memlab-cli`

The same package installs `memlab-cli`, which runs the same tools from a shell. Use it in scripts and CI, or when the assistant can't connect to the server:

```bash
npx -p @memlab/mcp-server memlab-cli doctor          # check node, the server, and a live handshake
npx -p @memlab/mcp-server memlab-cli list            # every tool with a one-line description
npx -p @memlab/mcp-server memlab-cli call \
  memlab_load_snapshot '{"file_path":"/tmp/app.heapsnapshot"}' \
  memlab_quick_diagnosis '{}'                        # several calls in one server session
```

### Finding the right tool

Don't work from a fixed tool list; the set grows with each release. Call `memlab_tools` (or run `memlab-cli list`) to get every tool grouped by the question it answers, with a one-line "use it when". Good entry points:

| Question | Start with |
|---|---|
| What is in this heap? | `memlab_load_snapshot`, then `memlab_quick_diagnosis` and `memlab_auto_investigate` in parallel; `memlab_app_heap` to split app data from bundle source and engine internals |
| Will this snapshot load? | `memlab_snapshot_header` (reads counts without parsing the graph) |
| Why is this object alive? | `memlab_retainer_trace`, then `memlab_retainer_layers` to see every independent retainer before writing a fix |
| What leaked between two snapshots? | `memlab_diff_snapshots` |
| What grows across a series of snapshots? | `memlab_sequence_analysis`, `memlab_leak_report` |
| Detached DOM elements | `memlab_detached_dom` |
| Is it real, or a DevTools or dev-build artifact? | `memlab_dev_artifacts` |
| Did the fix work? | `memlab_verify_fix` |
| Capture snapshots from a running Chrome | `memlab_capture` (Chrome started with `--remote-debugging-port=9222 --user-data-dir=<temp dir>`) |

### A typical investigation

1. **Load** the snapshot with `memlab_load_snapshot` (a local absolute path).
2. **Frame the heap**: what is it made of, and what are the biggest retainers?
3. **Find what grows**, using a series of snapshots taken while one interaction repeats.
4. **Leak or working set?** Check whether the growth plateaus or is given back after idle and GC. A bounded cache or work in flight can look like a leak in a short series.
5. **Rule out noise**: memory retained only by DevTools, browser extensions or a development build is not a production leak.
6. **Explain the retention** with a retainer trace, and name the reference to break.
7. **Confirm the fix** with new snapshots and `memlab_verify_fix`.

### Safety

Most tools only read the snapshot. `memlab_eval`, `memlab_for_each` and a few others run JavaScript that the assistant writes, with the full privileges of the server process. Heap snapshot contents can carry a prompt injection, so never auto-approve those tools or allowlist `mcp__memlab__*` as a wildcard. Start the server with `MEMLAB_DISABLE_CODE_TOOLS=1` to remove them. The README lists [every tool that executes JavaScript](./packages/mcp-server/README.md#tools-that-execute-javascript).

## Documentation References

When providing code examples, always reference:
- [IScenario API](https://meta.github.io/memlab/docs/api/core/src/interfaces/IScenario)
- [IHeapSnapshot API](https://meta.github.io/memlab/docs/api/core/src/interfaces/IHeapSnapshot)
- [IHeapNode API](https://meta.github.io/memlab/docs/api/core/src/interfaces/IHeapNode)
- [IHeapEdge API](https://meta.github.io/memlab/docs/api/core/src/interfaces/IHeapEdge)
- [ILeakFilter API](https://meta.github.io/memlab/docs/api/core/src/interfaces/ILeakFilter)
- [Official Documentation](https://meta.github.io/memlab/docs/intro)
- [CLI Commands](https://meta.github.io/memlab/docs/cli/CLI-commands)
- [Puppeteer Page API](https://pptr.dev/api/puppeteer.page) - For all `page.*` method calls
- [Puppeteer Locator API](https://pptr.dev/api/puppeteer.locator) - For using locators (Puppeteer v24+)
- [MCP Server (npm)](https://www.npmjs.com/package/@memlab/mcp-server) - For AI-assisted heap analysis

## Testing Best Practices

When generating test scenarios:

1. **Start Simple**: Begin with basic scenarios before adding complexity
2. **One Interaction Per Scenario**: Test one specific interaction pattern per scenario
3. **Verify Reversibility**: Ensure `back()` truly reverts the `action()`
4. **Use Stable Selectors**: Prefer IDs and data attributes over CSS classes
5. **Handle Loading States**: Wait for elements and network requests to complete
6. **Test Locally First**: Run scenarios locally before integrating into CI/CD

## Common Use Cases

### Detecting Detached DOM Elements
```javascript
// Built-in detector handles this automatically
module.exports = {
  url: () => 'https://example.com',
  action: async (page) => {
    await page.click('#create-widget');
  },
  back: async (page) => {
    await page.click('#remove-widget');
  },
};
```

### Detecting Oversized Objects
```javascript
module.exports = {
  url: () => 'https://example.com',
  action: async (page) => { /* ... */ },
  back: async (page) => { /* ... */ },
  leakFilter: (node) => node.retainedSize > 1024 * 1024, // > 1MB
};
```

### Detecting Event Listener Leaks
```javascript
// Use leakFilter to report objects held directly by a DOM event listener
module.exports = {
  url: () => 'https://example.com',
  action: async (page) => { /* ... */ },
  back: async (page) => { /* ... */ },
  leakFilter: (node, snapshot, leakedNodeIds) => {
    // In Chromium heap snapshots, a listener callback is retained by a native
    // node such as `V8EventListener` (the exact name varies by Chrome version)
    return node.referrers.some(
      edge => edge.fromNode.name.includes('EventListener'),
    );
  },
};
```

## Summary

When helping users with MemLab:
- ⚠️ **TOP PRIORITY**: The `page` parameter is a Puppeteer Page object - **ONLY use valid Puppeteer APIs**. Always refer to [Puppeteer Page API documentation](https://pptr.dev/api/puppeteer.page). Never hallucinate or invent API methods.
- 🚨 **HARD RULE**: Puppeteer Locators (`page.locator()`) **DO NOT have `count()` or `first()` methods**. Always verify available methods in the [Puppeteer Locator API documentation](https://pptr.dev/api/puppeteer.locator).
- ✅ Only `url()` is required. For most scenarios, include `url()`, `action()`, and `back()`.
- ✅ **Keep scenarios simple**: Only add optional callbacks (`setup`, `cookies`, `isPageLoaded`, `leakFilter`, `beforeLeakFilter`, `retainerReferenceFilter`, etc.) when necessary.
- ✅ **No need for `repeat()`**: Do not define the `repeat()` callback unless the user explicitly wants to stress test memory. MemLab runs scenarios once by default.
- ✅ Ensure `back()` truly reverts the state created by `action()`
- ✅ Use proper Puppeteer patterns (await, selectors, disposal)
- ✅ Recommend unminified code for better debugging
- ✅ Use `leakFilter` for custom leak detection beyond detached DOM/Fiber
- ✅ Use `node.retainedSize` (property, not method) for size checks in `leakFilter`
- ✅ Use `node.referrers` and `node.references` (arrays of `IHeapEdge`) to traverse the heap graph
- ✅ **Keep CLI commands simple**: Use basic `memlab run --scenario` by default. Only suggest `--debug` and `--headful` when users are debugging, troubleshooting, or need visual/step-by-step execution.
- ✅ **Use the MCP server** (`@memlab/mcp-server`) for AI-assisted heap snapshot analysis
- ❌ Never use `page.goto()`, `page.reload()`, or anything else that reloads the page in `action()` or `back()` - memlab stops the run because it can't compare heaps across a reload
- ❌ Don't forget to await async Puppeteer operations
- ❌ Don't pollute the baseline with setup code in `action()`
- ❌ Don't use `node.getRetainedSize()` — use `node.retainedSize` (it's a property, not a method)

MemLab is designed to make memory leak detection automatic and reliable. Follow these patterns to ensure accurate results.

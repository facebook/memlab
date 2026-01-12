# MemLab AI Assistant Guide

This document provides guidance for AI assistants (like ChatGPT, GitHub Copilot, Cursor, etc.) on how to correctly use and explain MemLab, a JavaScript memory leak detection framework.

## Overview

MemLab is an end-to-end testing and analysis framework for identifying JavaScript memory leaks and optimization opportunities. It works by:
1. Starting a headless Chrome browser
2. Interacting with web pages using Puppeteer
3. Taking JavaScript heap snapshots at different stages
4. Analyzing and diffing heap snapshots to detect memory leaks

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
  action: async (page) => {},  // Required: interaction that may cause leaks
  back: async (page) => {},    // Required: revert to baseline state
  // Optional callbacks:
  cookies: () => Cookies[],    // Authentication cookies
  setup: async (page) => {},  // Setup after initial page load
  beforeInitialPageLoad: async (page) => {}, // Setup before page load
  leakFilter: (node, snapshot, leakedNodeIds) => boolean, // Custom leak detection
  repeat: () => number,       // Number of iterations (only for stress testing)
};
```

**Important**: For most scenarios, only `url()`, `action()`, and `back()` are needed. Only use optional callbacks (`setup`, `cookies`, `beforeInitialPageLoad`, `leakFilter`, `repeat`) when they are necessary for your specific use case. Keep scenarios simple and focused.

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
- `page.goto(url, options)` - **BUT DO NOT USE IN SCENARIO CALLBACKS** (see rule #1 in DON'T section)

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

// ✅ GOOD: Use filter() to check if element exists
const loc = page.locator(selector).setTimeout(1500);
await loc.filter(() => true).click();  // Will retry until element exists

// ✅ GOOD: Use waitHandle() to check existence
const handle = await page.locator(selector).setTimeout(1500).waitHandle();
if (handle) {
  await handle.click();
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

**1. Always include all three required callbacks:**
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
  // Missing: doesn't close the modal
  await page.goto('https://example.com'); // This creates a new baseline!
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

**Alternative**: If cookies are not available, you can perform login in the `setup()` callback. The `setup()` callback executes after the initial page load (from `url()`) but before the `action()` callback. However, using `cookies()` is preferred when possible.

**5. Use `leakFilter` for custom detection:**
```javascript
// ✅ GOOD: Filter oversized objects
module.exports = {
  url: () => 'https://example.com',
  action: async (page) => { /* ... */ },
  back: async (page) => { /* ... */ },
  leakFilter: (node, snapshot, leakedNodeIds) => {
    // Report objects larger than 1MB as leaks
    return node.getRetainedSize() > 1024 * 1024;
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

### ❌ DON'T: Common Mistakes

**1. Don't use `page.goto()` or page refresh APIs in any callback:**
```javascript
// ❌ BAD: page.goto() or refresh APIs create a new JS runtime, breaking leak detection
// This applies to ALL callbacks: url, setup, action, back, beforeInitialPageLoad, etc.

// ❌ BAD in back()
back: async (page) => {
  await page.goto('https://different-page.com'); // Creates new runtime!
},

// ❌ BAD in action()
action: async (page) => {
  await page.goto('https://other-page.com'); // Creates new runtime!
  await page.reload(); // Also bad - refreshes page!
},

// ❌ BAD in setup()
setup: async (page) => {
  await page.goto('https://login-page.com'); // Creates new runtime!
},

// ✅ GOOD: Use in-page interactions only
back: async (page) => {
  await page.click('#close-button'); // In-page interaction
},

action: async (page) => {
  await page.click('#open-modal'); // In-page interaction
  await page.waitForSelector('#content'); // Wait for content to load
},

// ✅ GOOD: url() is the ONLY place that should navigate (initial load)
url: () => 'https://example.com', // This is fine - it's the initial page load
```

**Important**: Any API that causes a page refresh or starts a new JavaScript runtime will break MemLab's heap snapshot comparison. Avoid:
- `page.goto()` (except in special cases - see note below)
- `page.reload()`
- `page.evaluate(() => location.reload())`
- Any navigation that resets the JavaScript context

**Note**: The only exception is if you're specifically testing page load leaks and intentionally want a new baseline, but this is an advanced use case and should be clearly documented.

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

**3. Don't create scenarios that test page load leaks without `action()`:**
```javascript
// ⚠️ ADVANCED USE CASE ONLY: Testing initial page load leaks
// This is an exception to the "no page.goto()" rule, but should be used sparingly
// Only use this if you specifically want to test leaks from the initial page load itself
module.exports = {
  url: () => 'https://example.com',
  // No action() - memlab will detect leaks from initial page load
  back: async (page) => {
    // ⚠️ Exception: Using page.goto() here creates a new baseline
    // This is intentional for page-load leak testing, but breaks normal leak detection
    await page.goto('about:blank'); // Navigate away to final state
  },
};

// ✅ BETTER: For most cases, use in-page interactions even for page load testing
module.exports = {
  url: () => 'https://example.com',
  action: async (page) => {
    // Test interaction that should clean up page load resources
  },
  back: async (page) => {
    await page.click('#reset'); // Use in-page interaction instead
  },
};
```

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

When generating code that uses MemLab programmatically:

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

const leaks = await run({scenario});
console.log(`Found ${leaks.length} memory leaks`);
```

### CLI Usage

When suggesting CLI commands:

```bash
# Basic usage (most common)
memlab run --scenario path/to/scenario.js

# With custom leak filter
memlab find-leaks --scenario path/to/scenario.js --leak-filter path/to/filter.js

# Analyze heap snapshots
memlab analyze unbound-object --snapshot-dir ./snapshots

# View heap snapshot
memlab view-heap --snapshot path/to/heap.heapsnapshot
```

**Guideline**: Keep CLI commands simple by default. Only suggest `--debug` and `--headful` options when:
- The user is explicitly debugging or troubleshooting
- The user wants to run in headful mode for visual observation
- There's a specific need that makes this complexity necessary

For most users, the basic `memlab run --scenario` command is sufficient.

When CLI usage examples, always reference:
 - [CLI Usage Documentation](https://facebook.github.io/memlab/docs/cli/CLI-commands)

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

## Documentation References

When providing code examples, always reference:
- [IScenario API](https://facebook.github.io/memlab/docs/api/core/src/interfaces/IScenario)
- [IHeapSnapshot API](https://facebook.github.io/memlab/docs/api/core/src/interfaces/IHeapSnapshot)
- [ILeakFilter API](https://facebook.github.io/memlab/docs/api/core/src/interfaces/ILeakFilter)
- [Official Documentation](https://facebook.github.io/memlab/docs/intro)
- [Puppeteer Page API](https://pptr.dev/api/puppeteer.page) - For all `page.*` method calls
- [Puppeteer Locator API](https://pptr.dev/api/puppeteer.locator) - For using locators (Puppeteer v24+)

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
  leakFilter: (node) => node.getRetainedSize() > 1024 * 1024, // > 1MB
};
```

### Detecting Event Listener Leaks
```javascript
// Use leakFilter to detect objects retained by event listeners
module.exports = {
  url: () => 'https://example.com',
  action: async (page) => { /* ... */ },
  back: async (page) => { /* ... */ },
  leakFilter: (node, snapshot) => {
    // Custom logic to detect event listener leaks
    const retainers = snapshot.getRetainers(node);
    return retainers.some(r => r.type === 'EventListener');
  },
};
```

## Summary

When helping users with MemLab:
- ⚠️ **TOP PRIORITY**: The `page` parameter is a Puppeteer Page object - **ONLY use valid Puppeteer APIs**. Always refer to [Puppeteer Page API documentation](https://pptr.dev/api/puppeteer.page). Never hallucinate or invent API methods.
- 🚨 **HARD RULE**: Puppeteer Locators (`page.locator()`) **DO NOT have `count()` or `first()` methods**. Always verify available methods in the [Puppeteer Locator API documentation](https://pptr.dev/api/puppeteer.locator).
- ✅ Always include `url()`, `action()`, and `back()` callbacks
- ✅ **Keep scenarios simple**: For most cases, only `url()`, `action()`, and `back()` are needed. Only add optional callbacks (`setup`, `cookies`, `leakFilter`, etc.) when necessary.
- ✅ **No need for `repeat()`**: Do not define the `repeat()` callback unless the user explicitly wants to stress test memory. MemLab runs scenarios once by default.
- ✅ Ensure `back()` truly reverts the state created by `action()`
- ✅ Use proper Puppeteer patterns (await, selectors, disposal)
- ✅ Recommend unminified code for better debugging
- ✅ Use `leakFilter` for custom leak detection beyond detached DOM/Fiber
- ✅ **Keep CLI commands simple**: Use basic `memlab run --scenario` by default. Only suggest `--debug` and `--headful` when users are debugging, troubleshooting, or need visual/step-by-step execution.
- ❌ Never use `page.goto()`, `page.reload()`, or any page refresh APIs in any callback (url, setup, action, back, etc.) - they create new JS runtimes and break heap snapshot comparison
- ❌ Don't forget to await async Puppeteer operations
- ❌ Don't pollute the baseline with setup code in `action()`

MemLab is designed to make memory leak detection automatic and reliable. Follow these patterns to ensure accurate results.

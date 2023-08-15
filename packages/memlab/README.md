# memlab

memlab is an end-to-end testing and analysis framework for identifying
JavaScript memory leaks and optimization opportunities.

Online Resources:
* [Official Website and Demo](https://facebook.github.io/memlab)
* [Documentation](https://facebook.github.io/memlab/docs/intro)
* [Meta Engineering Blog Post](https://engineering.fb.com/2022/09/12/open-source/memlab/)

Features:
 * **Browser memory leak detection** - Write test scenarios with the Puppeteer
   API, and memlab will automatically compare JavaScript heap snapshots, filter
   out memory leaks, and aggregate the results
 * **Object-oriented heap traversing API** - Supports the creation of
   self-defined memory leak detector, and enables programmatic analysis JS heap
   snapshots taken from Chromium-based browsers, Node.js, Electron.js, and Hermes
 * **Memory CLI toolbox** - Built-in toolbox and APIs for finding memory
   optimization opportunities (not necessarily just memory leaks)
 * **Memory assertions in Node.js** - Enables unit tests or running node.js
   programs to take a heap snapshot of their own state, perform self memory
   checking, or write advanced memory assertions

## CLI Usage

Install the CLI

```bash
npm install -g memlab
```

### Find Memory Leaks

To find memory leaks in Google Maps, you can create a
[scenario file](https://facebook.github.io/memlab/docs/api/interfaces/core_src.IScenario) defining how
to interact with the Google Maps, let's name it `test-google-maps.js`:

```javascript
// initial page load url: Google Maps
function url() {
  return 'https://www.google.com/maps/@37.386427,-122.0428214,11z';
}

// action where we want to detect memory leaks: click the Hotels button
async function action(page) {
  // puppeteer page API
  await page.click('button[aria-label="Hotels"]');
}

// action where we want to go back to the step before: click clear search
async function back(page) {
  // puppeteer page API
  await page.click('[aria-label="Close"]');
}

module.exports = {action, back, url};
```

Now run memlab with the scenario file, memlab will interact with
the web page and detect memory leaks with built-in leak detectors:

```bash
memlab run --scenario test-google-maps.js
```

memlab will print memory leak results showing one representative
retainer trace for each cluster of leaked objects.

**Retainer traces**: This is the result from
[an example website](https://facebook.github.io/memlab/docs/guides/guides-find-leaks),
the retainer trace is an object reference chain from the GC root to a leaked
object. The trace shows why and how a leaked object is still kept alive in
memory. Breaking the reference chain means the leaked object will no longer
be reachable from the GC root, and therefore can be garbage collected.
By following the leak trace one step at a time, you will be able to find
a reference that should be set to null (but it wasn't due to a bug).

```bash
MemLab found 46 leak(s)
--Similar leaks in this run: 4--
--Retained size of leaked objects: 8.3MB--
[Window] (native) @35847 [8.3MB]
  --20 (element)--->  [InternalNode] (native) @130981728 [8.3MB]
  --8 (element)--->  [InternalNode] (native) @130980288 [8.3MB]
  --1 (element)--->  [EventListener] (native) @131009888 [8.3MB]
  --1 (element)--->  [V8EventListener] (native) @224808192 [8.3MB]
  --1 (element)--->  [eventHandler] (closure) @168079 [8.3MB]
  --context (internal)--->  [<function scope>] (object) @181905 [8.3MB]
  --bigArray (variable)--->  [Array] (object) @182925 [8.3MB]
  --elements (internal)--->  [(object elements)] (array) @182929 [8.3MB]
...
```
To get readable trace, the web site under test needs to serve non-minified code (or at least minified code
with readable variables, function name, and property names on objects).

Alternatively, you can debug the leak by loading the heap snapshot taken by memlab (saved in `$(memlab get-default-work-dir)/data/cur`)
in Chrome DevTool and search for the leaked object ID (`@182929`).

**View Retainer Trace Interactively**

View memory issues detected by memlab based on a single JavaScript
heap snapshot taken from Chromium, Hermes, memlab, or any node.js
or Electron.js program:
```bash
memlab view-heap --snapshot <PATH TO .heapsnapshot FILE>
```

You can optionally specify a specific heap object with the object's id: `--node-id @28173` to pinpoint a specific object.

**Self-defined leak detector**: If you want to use a self-defined leak detector, add a `leakFilter` callback
([doc](https://facebook.github.io/memlab/docs/api/interfaces/core_src.IScenario/#-optional-leakfilter-leakfiltercallback))
in the scenario file. `filterLeak` will be called for every unreleased heap
object (`node`) allocated by the target interaction.

```javascript
function leakFilter(node, heap) {
  // ... your leak detector logic
  // return true to mark the node as a memory leak
};
```

`heap` is the graph representation of the final JavaScript heap snapshot.
For more details, view the
[doc site](https://facebook.github.io/memlab/docs/api/interfaces/core_src.IHeapSnapshot).

### Heap Analysis and Investigation

View which object keeps growing in size during interaction in the previous run:
```bash
memlab analyze unbound-object
```

Analyze pre-fetched V8/hermes `.heapsnapshot` files:

```bash
memlab analyze unbound-object --snapshot-dir <DIR_OF_SNAPSHOT_FILES>
```

Use `memlab analyze` to view all built-in memory analyses.
For extension, view the [doc site](https://facebook.github.io/memlab).

View retainer trace of a particular object:
```bash
memlab trace --node-id <HEAP_OBJECT_ID>
```

Use `memlab help` to view all CLI commands.

## APIs

Use the `memlab` npm package to start a E2E run in browser and detect memory leaks.

```javascript
const memlab = require('memlab');

const scenario = {
    // initial page load url
    url: () => 'https://www.google.com/maps/@37.386427,-122.0428214,11z',

    // action where we want to detect memory leaks
    action: async (page) => await page.click('button[aria-label="Hotels"]'),

    // action where we want to go back to the step before
    back: async (page) => await page.click('[aria-label="Close"]'),
}
memlab.run({scenario});
```

## Memory Assertions

memlab makes it possible to enable a unit test or running node.js program
to take a heap snapshot of its own state, and write advanced memory assertions:

```typescript
// save as example.test.ts
import type {IHeapSnapshot, Nullable} from '@memlab/core';
import {config, takeNodeMinimalHeap} from '@memlab/core';

class TestObject {
  public arr1 = [1, 2, 3];
  public arr2 = ['1', '2', '3'];
}

test('memory test with heap assertion', async () => {
  config.muteConsole = true; // no console output

  let obj: Nullable<TestObject> = new TestObject();
  // get a heap snapshot of the current program state
  let heap: IHeapSnapshot = await takeNodeMinimalHeap();

  // call some function that may add references to obj
  rabbitHole(obj)

  expect(heap.hasObjectWithClassName('TestObject')).toBe(true);
  obj = null;

  heap = await takeNodeMinimalHeap();
  // if rabbitHole does not have any side effect that
  // adds new references to obj, then obj can be GCed
  expect(heap.hasObjectWithClassName('TestObject')).toBe(false);

}, 30000);
```

For other APIs check out the
[API documentation](https://facebook.github.io/memlab/docs/api/interfaces/core_src.IHeapSnapshot#hasobjectwithclassnameclassname).

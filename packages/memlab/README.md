# memlab

memlab is an E2E testing and analysis framework for finding JavaScript memory
leaks in Chromium. The CLI Toolbox and library provide extensible interfaces
for analyzing heap snapshots taken from Chrome/Chromium, Node.js, Hermes, and Electron.js.

## CLI Usage

Install the CLI

```bash
npm install -g memlab
```

### Find Memory Leaks

To find memory leaks in Google Maps, you can create a scenario file defining how
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
  await page.click('[aria-label="Clear search"]');
}

module.exports = {action, back, url};
```

Now run memlab with the scenario file, memlab will interact with
the web page and detect memory leaks with built-in leak detectors:

```bash
memlab run --scenario test-google-maps.js
```

If you want to use a self-defined leak detector, add a `filterLeak` callback
in the scenario file. `filterLeak` will be called for every unreleased heap
object (`node`) allocated by the target interaction.

```javascript
function filterLeak(node, heap) {
  // ... your leak detector logic
  // return true to mark the node as a memory leak
};
```

`heap` is the graph representation of the final JavaScript heap snapshot.
For more details, view the [doc site](https://facebookincubator.github.io/memlab).

### Heap Analysis and Investigation

View which object keeps growing in size during interaction in the previous run:
```bash
memlab analyze unbound-object
```

Analyze pre-fetched V8/hermes `.heapsnapshot` files:

```bash
memlab analyze unbound-object --snapshot-dir <DIR_OF_SNAPSHOT_FILES>
```

Use `memlab analyze` to view all built-in memory analyses. For extension, view the [doc site](https://facebookincubator.github.io/memlab).

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
    back: async (page) => await page.click('[aria-label="Clear search"]'),
}
memlab.run({scenario});
```

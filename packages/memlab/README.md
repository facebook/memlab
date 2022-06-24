# memlab

memlab is an E2E testing and analysis framework for finding JavaScript memory
leaks in Chromium. The CLI Toolbox and library provide extensible interfaces
for analyzing heap snapshots taken from Chrome/Chromium, Node.js, Hermes, and Electron.js.

## CLI Usage

Install the CLI

```bash
npm install -g memlab
```

To find memory leaks in Google Maps, you can create a scenario file defining how
to interact with the Google Maps, let's name it `test-google-maps.js`:

```javascript
// Visit Google Maps
function url() {
  return 'https://www.google.com/maps/@37.386427,-122.0428214,11z';
}

// action where we want to detect memory leaks: click the Hotels button
async function action(page) {
  await page.click('button[aria-label="Hotels"]');
}

// action where we want to go back to the step before: click clear search
async function back(page) {
  await page.click('[aria-label="Clear search"]');
}

module.exports = {action, back, url};
```

Now run memlab with the scenario file, memlab will interact with
the web page and show detected memory leaks:

```bash
memlab run --scenario test-google-maps.js
```

View which object keeps growing in size during interaction in the previous run:
```bash
memlab analyze unbound-object
```

Analyze pre-fetched v8/hermes `.heapsnapshot` files:

```bash
memlab analyze unbound-object --snapshot-dir <DIR_OF_SNAPSHOT_FILES>
```

Use `memlab analyze` to view all built-in memory analyses. For extension, view the [doc site](/tba).

View retainer trace of a particular object:
```bash
memlab trace --node-id <HEAP_OBJECT_ID>
```

Use `memlab help` to view all CLI commands.

## APIs

Use the `memlab` package to start a E2E run in browser and detect memory leaks:

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

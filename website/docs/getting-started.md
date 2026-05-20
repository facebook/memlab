---
sidebar_position: 2
---

# Getting Started
In this section, you will learn how to use memlab to detect memory leaks.
Make sure you have completed the [installation](./installation.md)
step on your local machine. We'll start by defining a scenario file that
tells memlab how to interact with your page.


## Write a Test Scenario
A scenario file is a `js` file that exports functions describing
how to navigate to and interact with your page. Copy the following
example and save it as `~/memlab/scenario.js`.

```javascript
// initial page load's url
function url() {
  return "https://www.youtube.com";
}

// action where you suspect the memory leak might be happening
async function action(page) {
  await page.click('[id="video-title-link"]');
}

// how to go back to the state before action
async function back(page) {
  await page.click('[id="logo-icon"]');
}

module.exports = { action, back, url };
```

For more details, check out the
[IScenario API doc](./api/core/src/interfaces/IScenario).
:::note
Feel free to save the scenario file anywhere. We will be running memlab
with this file shortly.
:::

## Running memlab
Run `memlab` in your terminal to make sure it is installed. You should see
the help output in the terminal.

Now let's pass the `~/memlab/scenario.js` file we created earlier to `memlab`
as shown below:

```bash
$ memlab run --scenario ~/memlab/scenario.js
```

:::note
It is highly recommended that the web app under test serves unminified code,
which makes the retainer trace and symbols in leak report easier to understand.
:::

memlab will display a live-updating breadcrumb showing its progress as it
interacts with the target web page:

```bash
page-load(baseline)[s1] > action-on-page(target)[s2] > revert(final)[s3]
Connecting to web server...
```

After memlab finishes, the terminal will show the JavaScript heap size
at each navigation step along with all leaked objects grouped by their
potential root causes. Your exact output may differ, but it will look
something like this:

```bash
page-load[23MB](baseline)[s1] > action-on-page[37.3MB](target)[s2] > revert[35.9MB](final)[s3]
```

A breakdown of each step in the breadcrumb:
- **page-load (baseline)** - This is the starting point, showing how much
  memory was allocated when the page loaded.
- **action-on-page (target)** - After performing the action — in our case,
  clicking the link with id `"video-title-link"` — we see how much memory
  was allocated.
- **revert (final)** - This is the state after performing the back/reverse action.
  In this example, that means navigating back to the home page.

Continue [reading here](./guides/01-detached-dom.mdx) to learn how to debug
the memory leak traces reported by memlab.

See [How memlab Works](./how-memlab-works.md) if you would like to
learn how memlab detects memory leaks.

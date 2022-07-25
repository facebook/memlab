---
sidebar_position: 2
---

# Getting Started
In this section, you will learn how to use memlab to detect a memory leak.
Please make sure you have completed a [installation](/docs/installation) step
in your local machine. We start with defining the scenario file where we
specify how memlab should interact with our page.


## Write a Test Scenario
A scenario file is a `js` file that exports functions to provide details about
how to navigate to and interact with your page. Now let's copy the following
example and save it as `~/memlab/scenraio.js` file somewhere we can find later.

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
[IScenario API doc](/docs/api/interfaces/core_src.IScenario).
:::note
Feel free to save the scenario file anywhere. We will be running memlab
with this file shortly.
:::

## Running memlab
Run `memlab` in your console to make sure it is installed. You should see
the help instructions in console.

Now let's pass the `~/memlab/scenario.js` file we created earlier to `memlab`
as shown below:

```bash
$ memlab run --scenario ~/memlab/scenario.js
```

:::note
It is highly recommended that the web app under test serves unminified code,
which makes the retainer trace and symbols in leak report easier to understand.
:::

memlab will lively update a breadcrumb showing the progress of interaction
with the target web page:

```bash
page-load(baseline)[s1] > action-on-page(target)[s2] > revert(final)[s3]
Connecting to web server...
```

After memlab finishes running, the console will show the JavaScript heap size
of each navigation step and all leak objects grouped by their potential root
causes. The details may differ in your case but it will be something like:

```bash
page-load[23MB](baseline)[s1] > action-on-page[37.3MB](target)[s2] > revert[35.9MB](final)[s3]
```

A breakdown of each step in the breadcrumb:
- **page-load (baseline)** - this is our starting point where we see how much
  memory was allocated when the page is loaded
- **action-on-page(target)** - after performing the action - in our case, it is
  clicking the link with id `"video-title-link"` - we see how much memory
  was allocated
- **revert(final)** - this is when we perform the back/reverse action.
  In this example, it is going back to the home page.

Continue [reading here](guides/guides-detached-dom) on how to debug the
memory leak traces reported by memlab.

Click [here](/docs/how-memlab-works) if you would like to
learn how memlab detects memory leak.

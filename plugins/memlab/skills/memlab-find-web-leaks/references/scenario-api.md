# memlab scenario callbacks

A scenario file exports an object. Only `url` is required; most scenarios need
just `url`, `action` and `back`. Full reference:
[IScenario](https://meta.github.io/memlab/docs/api/core/src/interfaces/IScenario).

| Callback | Signature | When it runs |
|---|---|---|
| `url` | `() => string` | The page for the initial load |
| `cookies` | `() => Array<{name, value, domain?, path?, ...}>` | Set before the initial load |
| `beforeInitialPageLoad` | `async (page) => void` | Before the initial load |
| `setup` | `async (page) => void` | After the initial load, before the baseline snapshot |
| `action` | `async (page) => void` | The interaction under test; target snapshot after it |
| `back` | `async (page) => void` | Undoes `action`; final snapshot after it |
| `isPageLoaded` | `async (page) => boolean` | After each step, polled until it returns `true` |
| `repeat` | `() => number` | Extra `action`/`back` cycles before the target snapshot |
| `beforeLeakFilter` | `(snapshot, leakedNodeIds) => void` | Once, before `leakFilter` |
| `leakFilter` | `(node, snapshot, leakedNodeIds) => boolean` | For each object `action` allocated that survived `back`; return `true` to report it |
| `retainerReferenceFilter` | `(edge, snapshot, isReferenceUsedByDefault) => boolean` | While building retainer traces; return `false` to skip an edge |

`page` is a [Puppeteer `Page`](https://pptr.dev/api/puppeteer.page). `node`
and `edge` are memlab's
[`IHeapNode`](https://meta.github.io/memlab/docs/api/core/src/interfaces/IHeapNode)
and [`IHeapEdge`](https://meta.github.io/memlab/docs/api/core/src/interfaces/IHeapEdge).
`leakedNodeIds` is a set of node ids (iterable, with `has()` and `size`).

## Authentication

```javascript
module.exports = {
  url: () => 'https://app.example.com/',
  cookies: () => [
    {name: 'session', value: process.env.SESSION_TOKEN, domain: '.example.com'},
  ],
  action: async page => { /* ... */ },
  back: async page => { /* ... */ },
};
```

Without cookies, log in from `setup`. It runs before the baseline snapshot, so
it may navigate (for example, through a login redirect). The page `setup` ends
on becomes the baseline.

```javascript
setup: async page => {
  await page.type('#username', process.env.TEST_USER);
  await page.type('#password', process.env.TEST_PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('#login')]);
},
```

## Waiting for the page

Without `isPageLoaded`, memlab waits for the network to go idle (Puppeteer's
`networkidle0`) and then a fixed delay. For apps that keep a connection open or
render after the network settles, return `true` once the UI is ready. memlab calls it every 200 ms, so keep each call quick:

```javascript
isPageLoaded: async page =>
  page.evaluate(() => document.querySelector('[data-testid="app-ready"]') != null),
```

## Optional elements

Locator actions throw a `TimeoutError` when the element never appears; they
don't return `null`:

```javascript
action: async page => {
  try {
    await page.locator('[aria-label="Dismiss banner"]').setTimeout(1500).click();
  } catch (e) {
    if (e.name !== 'TimeoutError') {
      throw e;
    }
  }
  await page.click('[data-testid="open-panel"]');
},
```

## Custom leak rules

By default memlab reports detached DOM elements and unmounted React Fiber
nodes. A `leakFilter` replaces that rule.

Report any surviving object over 1 MB:

```javascript
leakFilter: node => node.retainedSize > 1024 * 1024,
```

Report objects held directly by a DOM event listener. In Chromium heap
snapshots the callback is retained by a native node such as `V8EventListener`:

```javascript
leakFilter: node =>
  node.referrers.some(edge => edge.fromNode.name.includes('EventListener')),
```

Do expensive work once in `beforeLeakFilter`:

```javascript
let bigIds;
module.exports = {
  url: () => 'https://example.com/',
  action: async page => { /* ... */ },
  back: async page => { /* ... */ },
  beforeLeakFilter: (snapshot, leakedNodeIds) => {
    bigIds = new Set(
      [...leakedNodeIds].filter(id => {
        const node = snapshot.getNodeById(id);
        return node != null && node.retainedSize > 500000;
      }),
    );
  },
  leakFilter: node => bigIds.has(node.id),
};
```

`retainedSize` is a property, not a method. `node.references` and
`node.referrers` are arrays of edges; `edge.toNode` and `edge.fromNode` are
nodes.

## Cleaner retainer traces

Skip edges that make traces noisy, for example React Fiber back-references:

```javascript
retainerReferenceFilter: (edge, snapshot, isReferenceUsedByDefault) => {
  if (String(edge.name_or_index).startsWith('__reactFiber$')) {
    return false;
  }
  return isReferenceUsedByDefault;
},
```

## Stress tests

`repeat: () => 5` runs `action` and `back` 5 extra times before the target
snapshot. Use it only to amplify a small leak; normal runs don't need it.

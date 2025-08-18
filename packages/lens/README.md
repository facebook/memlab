# MemLens

MemLens is a lightweight, in-browser lens for spotting memory issues in React apps. It detects and visualizes:

- Detached DOM elements still retained in memory
- Unmounted React Fiber nodes that may indicate leaks
- Event listener leaks (optional)
- High-level DOM and heap usage stats (overlay header)

It can run as a one-line console snippet or as a small library you embed in dev builds.

### Key features

- **Visual overlay**: Highlights detached DOM elements; interactive panel shows counts and the React component stack for the selected element
- **React Fiber analysis**: Scans the fiber tree to attribute elements to components
- **Event listener leak scan (opt-in)**: Groups leaked listeners by component and type
- **Non-intrusive**: Uses a transparent overlay and avoids tracking its own UI

### Browser support

- Requires browsers with WeakRef/FinalizationRegistry support (e.g. modern Chrome, Edge, Safari, Firefox). In older browsers the tool may not function.

---

### Quick start

#### Option A: Run from the browser console (CDN)

Paste this in your app page:

```js
(() => {
  const s = document.createElement('script');
  s.src = 'https://unpkg.com/@memlab/lens/dist/memlens.run.bundle.min.js';
  s.crossOrigin = 'anonymous';
  document.head.appendChild(s);
})();
```

This injects and starts MemLens with the interactive overlay.

#### Option B: Run from the browser console (local build)

Copy the contents of `packages/lens/dist/memlens.run.bundle.min.js` (or `packages/lens/dist/memlens.run.bundle.js`) and paste into the browser's web console. The overlay starts immediately.

#### Option C: Programmatic scanner (UMD global)

Load the library bundle and use the `MemLens` global:

```html
<script src="https://unpkg.com/@memlab/lens/dist/memlens.lib.bundle.min.js"></script>
<script>
  // Create a scanner (no overlay by default; use the run bundle for overlay)
  const scan = MemLens.createReactMemoryScan({
    isDevMode: true,
    scanIntervalMs: 1000,
    trackEventListenerLeaks: true, // optional
  });

  const unsubscribe = scan.subscribe((result) => {
    console.log('[MemLens]', {
      totalElements: result.totalElements,
      detached: result.totalDetachedElements,
      eventListenerLeaks: result.eventListenerLeaks,
    });
  });

  scan.start();

  // Later: scan.stop(); unsubscribe(); scan.dispose();
</script>
```

Note: The visualization overlay is provided by the self-starting "run" bundle (Option A/B/D). The library bundle focuses on scanning APIs.

#### Option D: Node/Puppeteer injection

`@memlab/lens` exposes a helper to retrieve the self-starting bundle as a string for script injection:

```js
// Node
const {getBundleContent} = require('@memlab/lens');

// Puppeteer example
await page.addScriptTag({content: getBundleContent()});
```

---

### Overlay controls and interactions

- **Toggle switch**: Show/hide all overlay rectangles
- **Select/pin**: Click a rectangle to pin/unpin the current selection
- **Hover**: Reveal the selection chain of related detached elements
- **Component stack panel**: Shows the React component stack of the selected element
- **Keyboard**: Press `D` to temporarily ignore the currently selected element in the overlay
- **Widget**: The control widget is draggable

Notes:
- The overlay ignores its own UI elements and won’t count them as part of the page.
- In dev mode, MemLens logs basic timing and scan stats to the console.

---

### Configuration (CreateOptions)

```ts
type CreateOptions = {
  isDevMode?: boolean;                // enable console logs and dev-only behaviors
  subscribers?: Array<(r) => void>;   // observers of each scan result
  extensions?: Array<BasicExtension>; // e.g., DOMVisualizationExtension
  scanIntervalMs?: number;            // default ~1000ms
  trackEventListenerLeaks?: boolean;  // enable listener leak scanning
};
```

Core API (`ReactMemoryScan`):
- `start()`, `pause()`, `stop()`, `dispose()`
- `subscribe(cb) => () => void`
- `registerExtension(ext) => () => void`

---

### Build

```bash
# from packages/lens
npm run build
# or
webpack
```

### Test

1) Install Playwright dependencies (first time):

```bash
npx playwright install
npx playwright install-deps
```

2) Run tests:

```bash
npm run test:e2e
```

3) Manual test: open `src/tests/manual/todo-list/todo-with-run.bundle.html` in a browser, or copy/paste `dist/memlens.run.bundle.js` to the DevTools console on any React page.

---

### Learn more

Please check out this
[tutorial page](https://facebook.github.io/memlab/docs/guides/visually-debug-memory-leaks-with-memlens)
on how to use MemLens (a debugging utility) to visualize memory leaks in the
browser for easier memory debugging.

### License

MIT © Meta Platforms, Inc.

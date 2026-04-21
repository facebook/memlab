import {useEffect, useRef, useState} from 'react';

function makePayload() {
  const big = new Array(50000);
  for (let i = 0; i < big.length; i++) {
    big[i] = {tag: 'memlab-payload', i, nested: {alive: true}};
  }
  return big;
}

// --- Pattern 1: setInterval ------------------------------------------------
function IntervalLeaky() {
  const [payload] = useState(makePayload);
  useEffect(() => {
    const id = setInterval(() => {
      if (payload.length < 0) console.log('x');
    }, 1_000_000);
    void id;
  }, [payload]);
  return <div id="slot">interval-leaky</div>;
}
function IntervalClean() {
  const [payload] = useState(makePayload);
  useEffect(() => {
    const id = setInterval(() => {
      if (payload.length < 0) console.log('x');
    }, 1_000_000);
    return () => clearInterval(id);
  }, [payload]);
  return <div id="slot">interval-clean</div>;
}

// --- Pattern 2: window event listener --------------------------------------
function WindowListenerLeaky() {
  const [payload] = useState(makePayload);
  useEffect(() => {
    const handler = () => {
      if (payload.length < 0) console.log('x');
    };
    window.addEventListener('resize', handler);
    // no removeEventListener — window retains handler → payload
  }, [payload]);
  return <div id="slot">window-listener-leaky</div>;
}
function WindowListenerClean() {
  const [payload] = useState(makePayload);
  useEffect(() => {
    const handler = () => {
      if (payload.length < 0) console.log('x');
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [payload]);
  return <div id="slot">window-listener-clean</div>;
}

// --- Pattern 3: unresolved Promise holding closure -------------------------
function PromiseLeaky() {
  const [payload] = useState(makePayload);
  useEffect(() => {
    // Promise that never resolves — the then-callback closure retains payload
    // indefinitely. No AbortController.
    new Promise<void>(resolve => {
      setTimeout(resolve, 10_000_000);
    }).then(() => {
      if (payload.length < 0) console.log('x');
    });
  }, [payload]);
  return <div id="slot">promise-leaky</div>;
}
function PromiseClean() {
  const [payload] = useState(makePayload);
  useEffect(() => {
    const controller = new AbortController();
    new Promise<void>((resolve, reject) => {
      const id = setTimeout(resolve, 10_000_000);
      controller.signal.addEventListener('abort', () => {
        clearTimeout(id);
        reject(new DOMException('aborted', 'AbortError'));
      });
    })
      .then(() => {
        if (payload.length < 0) console.log('x');
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [payload]);
  return <div id="slot">promise-clean</div>;
}

// --- Pattern 4: external store subscription --------------------------------
const externalStore = {
  subs: new Set<() => void>(),
  subscribe(fn: () => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  },
};
function StoreLeaky() {
  const [payload] = useState(makePayload);
  useEffect(() => {
    externalStore.subscribe(() => {
      if (payload.length < 0) console.log('x');
    });
    // unsubscribe returned but ignored
  }, [payload]);
  return <div id="slot">store-leaky</div>;
}
function StoreClean() {
  const [payload] = useState(makePayload);
  useEffect(() => {
    const unsub = externalStore.subscribe(() => {
      if (payload.length < 0) console.log('x');
    });
    return () => {
      unsub();
    };
  }, [payload]);
  return <div id="slot">store-clean</div>;
}

// --- Pattern 5: module-scope array accumulation ----------------------------
const globalRefs: unknown[] = [];
function GlobalRefLeaky() {
  const [payload] = useState(makePayload);
  useEffect(() => {
    globalRefs.push({payload});
    // no cleanup — module array grows forever
  }, [payload]);
  return <div id="slot">global-ref-leaky</div>;
}
function GlobalRefClean() {
  const [payload] = useState(makePayload);
  useEffect(() => {
    const entry = {payload};
    globalRefs.push(entry);
    return () => {
      const i = globalRefs.indexOf(entry);
      if (i >= 0) globalRefs.splice(i, 1);
    };
  }, [payload]);
  return <div id="slot">global-ref-clean</div>;
}

// --- Pattern 6: MutationObserver on document.body without disconnect -------
// Observing a GC root (document.body) keeps the observer intrinsically
// alive — its callback closure retains `payload` until the observer is
// explicitly disconnected.
function ObserverLeaky() {
  const [payload] = useState(makePayload);
  useEffect(() => {
    const obs = new MutationObserver(() => {
      if (payload.length < 0) console.log('x');
    });
    obs.observe(document.body, {childList: true, subtree: true});
    // no obs.disconnect() — observer is reachable from document.body's
    // observer registry, callback retains payload
  }, [payload]);
  return <div id="slot">observer-leaky</div>;
}
function ObserverClean() {
  const [payload] = useState(makePayload);
  useEffect(() => {
    const obs = new MutationObserver(() => {
      if (payload.length < 0) console.log('x');
    });
    obs.observe(document.body, {childList: true, subtree: true});
    return () => obs.disconnect();
  }, [payload]);
  return <div id="slot">observer-clean</div>;
}

// --- Pattern 7: requestAnimationFrame recursive chain ---------------------
// Different retention class from setInterval: the browser render loop
// re-registers the callback each frame, so the retention is driven by
// rAF's internal queue rather than a timer registry.
function RafLeaky() {
  const [payload] = useState(makePayload);
  useEffect(() => {
    const tick = () => {
      if (payload.length < 0) console.log('x');
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // no cancelAnimationFrame — render loop keeps closure (→ payload) alive
  }, [payload]);
  return <div id="slot">raf-leaky</div>;
}
function RafClean() {
  const [payload] = useState(makePayload);
  useEffect(() => {
    let id = 0;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      if (payload.length < 0) console.log('x');
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(id);
    };
  }, [payload]);
  return <div id="slot">raf-clean</div>;
}

// --- Pattern 8: Detached DOM retained by module-scope var -----------------
// Exercises FilterDetachedDOMElement (rule #7) specifically. No large
// payload attached, so this does NOT pass a retained-size threshold —
// detection must come from memlab's detached-DOM rule, not size.
const detachedDomStash: HTMLDivElement[] = [];
function DetachedDomLeaky() {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) detachedDomStash.push(ref.current);
    // no cleanup — on unmount the <div> is removed from the tree but
    // still referenced by detachedDomStash, i.e. it becomes detached DOM
  }, []);
  return <div ref={ref} id="slot">detached-dom-leaky</div>;
}
function DetachedDomClean() {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) detachedDomStash.push(el);
    return () => {
      if (!el) return;
      const i = detachedDomStash.indexOf(el);
      if (i >= 0) detachedDomStash.splice(i, 1);
    };
  }, []);
  return <div ref={ref} id="slot">detached-dom-clean</div>;
}

// --- Mode routing ----------------------------------------------------------
const COMPONENTS: Record<string, () => JSX.Element> = {
  'interval-leaky': IntervalLeaky,
  'interval-clean': IntervalClean,
  'window-listener-leaky': WindowListenerLeaky,
  'window-listener-clean': WindowListenerClean,
  'promise-leaky': PromiseLeaky,
  'promise-clean': PromiseClean,
  'store-leaky': StoreLeaky,
  'store-clean': StoreClean,
  'global-ref-leaky': GlobalRefLeaky,
  'global-ref-clean': GlobalRefClean,
  'observer-leaky': ObserverLeaky,
  'observer-clean': ObserverClean,
  'raf-leaky': RafLeaky,
  'raf-clean': RafClean,
  'detached-dom-leaky': DetachedDomLeaky,
  'detached-dom-clean': DetachedDomClean,
};

function getMode(): string | null {
  const m = new URLSearchParams(window.location.search).get('mode');
  return m && m in COMPONENTS ? m : null;
}

export function App() {
  const [visible, setVisible] = useState(false);
  const mode = getMode();
  const Target = mode ? COMPONENTS[mode] : null;

  return (
    <div>
      <div>
        mode: <span id="mode">{mode ?? 'none'}</span>
      </div>
      <button id="open" onClick={() => setVisible(true)}>
        open
      </button>
      <button id="close" onClick={() => setVisible(false)}>
        close
      </button>
      {visible && Target ? <Target /> : null}
    </div>
  );
}

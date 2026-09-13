const container = document.getElementById('container');
const mode =
  new URLSearchParams(window.location.search).get('mode') ?? 'none';
document.getElementById('mode').textContent = mode;

function makePayload() {
  const arr = new Array(50000);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = {tag: 'memlab-payload', i, nested: {alive: true}};
  }
  return arr;
}

const externalStore = {
  subs: new Set(),
  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  },
};

const detachedDomStash = [];

function mountSlot(label) {
  const slot = document.createElement('div');
  slot.id = 'slot';
  slot.textContent = label;
  container.appendChild(slot);
  return slot;
}

const MODES = {
  'detached-dom-leaky': () => {
    const slot = mountSlot('detached-dom-leaky');
    detachedDomStash.push(slot);
    return () => container.removeChild(slot);
  },
  'detached-dom-clean': () => {
    const slot = mountSlot('detached-dom-clean');
    detachedDomStash.push(slot);
    return () => {
      container.removeChild(slot);
      const i = detachedDomStash.indexOf(slot);
      if (i >= 0) detachedDomStash.splice(i, 1);
    };
  },
  'store-leaky': () => {
    const payload = makePayload();
    const slot = mountSlot('store-leaky');
    externalStore.subscribe(() => {
      if (payload.length < 0) console.log('x');
    });
    return () => container.removeChild(slot);
  },
  'interval-clean': () => {
    const payload = makePayload();
    const slot = mountSlot('interval-clean');
    const id = setInterval(() => {
      if (payload.length < 0) console.log('x');
    }, 1_000_000);
    return () => {
      container.removeChild(slot);
      clearInterval(id);
    };
  },
};

let cleanup = null;

document.getElementById('open').addEventListener('click', () => {
  if (cleanup) return;
  const factory = MODES[mode];
  if (factory) cleanup = factory();
});

document.getElementById('close').addEventListener('click', () => {
  if (!cleanup) return;
  cleanup();
  cleanup = null;
});

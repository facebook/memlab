import {useEffect, useState} from 'react';

function makePayload() {
  const big = new Array(50000);
  for (let i = 0; i < big.length; i++) {
    big[i] = {tag: 'memlab-payload', i, nested: {alive: true}};
  }
  return big;
}

// Leak: setInterval whose callback closes over state, with NO cleanup.
// When <Leaky /> unmounts, React drops the fiber but the interval keeps
// the closure (and thus `payload`) alive.
function Leaky() {
  const [payload] = useState(makePayload);
  useEffect(() => {
    const id = setInterval(() => {
      if (payload.length < 0) console.log('unreachable');
    }, 1_000_000);
    // no return cleanup, intentionally
    return undefined;
  }, [payload]);
  return <div id="leaky">leaky ({payload.length} items)</div>;
}

// Same shape as <Leaky /> but with proper clearInterval cleanup.
function Clean() {
  const [payload] = useState(makePayload);
  useEffect(() => {
    const id = setInterval(() => {
      if (payload.length < 0) console.log('unreachable');
    }, 1_000_000);
    return () => clearInterval(id);
  }, [payload]);
  return <div id="clean">clean ({payload.length} items)</div>;
}

function getMode(): 'leaky' | 'clean' | null {
  const m = new URLSearchParams(window.location.search).get('mode');
  return m === 'leaky' || m === 'clean' ? m : null;
}

export function App() {
  const [visible, setVisible] = useState(false);
  const mode = getMode();
  const Target = mode === 'leaky' ? Leaky : mode === 'clean' ? Clean : null;

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

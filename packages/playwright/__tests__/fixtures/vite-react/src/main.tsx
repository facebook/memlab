import {createRoot} from 'react-dom/client';
import {App} from './App';

// Intentionally NOT wrapping in <StrictMode>: its double-mount/unmount
// behavior in dev makes heap snapshots harder to reason about.
createRoot(document.getElementById('root')!).render(<App />);

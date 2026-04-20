import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    host: '127.0.0.1',
    // Disable HMR — the injected HMR client keeps websocket-based refs
    // that show up in heap snapshots and muddy the leak signal.
    hmr: false,
  },
});

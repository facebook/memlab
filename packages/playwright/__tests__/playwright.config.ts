import {defineConfig, devices} from '@playwright/test';
import path from 'path';

const fixtureDir = path.join(__dirname, 'fixtures');

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  reporter: [['list'], ['html', {open: 'never'}]],
  use: {
    trace: 'off',
  },
  webServer: {
    command: 'node server.mjs',
    cwd: fixtureDir,
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {...devices['Desktop Chrome']},
    },
  ],
});

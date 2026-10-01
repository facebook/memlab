// Minimal spike to verify PlaywrightHeapCapturer end-to-end without booting
// the full Playwright test runner.
import {chromium} from 'playwright';
import {pathToFileURL} from 'url';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import pkg from '../dist/index.js';
const {PlaywrightHeapCapturer} = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = pathToFileURL(path.join(__dirname, 'leaky.html')).href;

const workDir = fs.mkdtempSync(path.join(process.cwd(), 'memlab-smoke-'));
console.log('workDir:', workDir);

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(pageUrl);

const capturer = await PlaywrightHeapCapturer.attach(page, {
  workDir,
  cleanupOnDispose: false,
});

await capturer.snapshot('baseline');
await page.click('#leak');
await capturer.snapshot('target');
await page.click('#cleanup');
await capturer.snapshot('final');

for (const label of ['baseline', 'target', 'final']) {
  const p = capturer.getSnapshotPath(label);
  const size = fs.statSync(p).size;
  const tail = fs.readFileSync(p, 'utf8').slice(-5);
  console.log(`${label}: ${p} (${size} bytes, ends with: ${JSON.stringify(tail)})`);
}

const leaks = await capturer.findLeaks();
console.log(`found ${leaks.length} leak trace(s)`);
if (leaks.length > 0) {
  console.log(JSON.stringify(leaks[0], null, 2).slice(0, 500));
}

await capturer.dispose();
await browser.close();

process.exit(leaks.length > 0 ? 0 : 1);

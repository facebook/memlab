/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Fail when a registered tool is missing from `tools-index.ts`.
 *
 * Under deferred tool loading a client sees only the schemas it has already
 * fetched, so `memlab_tools` is the single point of discovery for everything
 * else. The index drifted to 83 of 97 tools, and the cost was not abstract: in
 * one session three of the fourteen missing tools were re-implemented by hand
 * in `memlab_eval`, and one of those hand-rolled versions reported a hop cap as
 * if it were a measurement. An unindexed tool is, in practice, a tool that does
 * not exist.
 *
 * `memlab_tools` already reports drift at RUNTIME ("Registered but not
 * categorized"), which only helps a caller who is already looking at it. This
 * runs at author time, where the fix is cheap.
 *
 * Static on purpose: importing the server would start it. Both lists are read
 * out of the source, the same way check-tool-docs.mjs reads descriptions.
 */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.join(here, '..', 'src', 'tools');
const indexFile = path.join(toolsDir, 'tools-index.ts');

/** Every name passed to `server.tool(...)` anywhere under src/tools. */
function registeredTools() {
  const names = new Set();
  for (const file of fs.readdirSync(toolsDir)) {
    if (!file.endsWith('.ts')) continue;
    const src = fs.readFileSync(path.join(toolsDir, file), 'utf8');
    for (const m of src.matchAll(/server\.tool\(\s*'([a-z0-9_]+)'/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

/**
 * Names inside the GROUPS literal only. A tool mentioned in prose elsewhere in
 * the file is not indexed, and counting it would let real drift through.
 */
function indexedTools() {
  const src = fs.readFileSync(indexFile, 'utf8');
  const start = src.indexOf('const GROUPS: Group[] = [');
  if (start < 0) {
    console.error('check-tool-index: could not find the GROUPS literal.');
    process.exit(1);
  }
  const end = src.indexOf('\n];', start);
  const groups = src.slice(start, end < 0 ? undefined : end);
  return new Set([...groups.matchAll(/'(memlab_[a-z0-9_]+)'/g)].map(m => m[1]));
}

const registered = registeredTools();
const indexed = indexedTools();
const missing = [...registered].filter(n => !indexed.has(n)).sort();
const stale = [...indexed].filter(n => !registered.has(n)).sort();

if (missing.length === 0 && stale.length === 0) {
  console.log(
    `check-tool-index: ${registered.size} registered tools, all present in tools-index.ts.`,
  );
  process.exit(0);
}

if (missing.length > 0) {
  console.error(
    `check-tool-index: ${missing.length} registered tool(s) missing from tools-index.ts:\n` +
      missing.map(n => `  - ${n}`).join('\n') +
      '\n\nAdd each to the group whose QUESTION it answers, with a one-line ' +
      '"use it when". A tool that is not in the index cannot be discovered ' +
      'under deferred tool loading.',
  );
}
if (stale.length > 0) {
  console.error(
    `check-tool-index: ${stale.length} indexed name(s) are not registered:\n` +
      stale.map(n => `  - ${n}`).join('\n') +
      '\n\nA name in the index that no longer exists sends the caller after a ' +
      'tool that will fail — worse than a missing one.',
  );
}
process.exit(1);

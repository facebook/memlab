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
 * Fail when the version the server REPORTS disagrees with the version it is
 * PUBLISHED as.
 *
 * The self-reported version is the one fact a session uses to answer "is the
 * attached server actually my local build?" — a running MCP server keeps old
 * code in memory across a rebuild, and one session spent its debugging budget
 * on a stale 2.65.0 server while the working copy said 2.77.1. If that number
 * can drift from package.json, it answers the question wrongly, which is worse
 * than not answering it.
 */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(here, '..');

const pkg = JSON.parse(
  fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'),
);
const src = fs.readFileSync(
  path.join(pkgDir, 'src', 'server-version.ts'),
  'utf8',
);
const m = /SERVER_VERSION\s*=\s*'([^']+)'/.exec(src);

if (!m) {
  console.error(
    'check-version-sync: could not find SERVER_VERSION in src/server-version.ts.',
  );
  process.exit(1);
}
if (m[1] !== pkg.version) {
  console.error(
    `check-version-sync: SERVER_VERSION is ${m[1]} but package.json says ${pkg.version}.\n` +
      'The server would report a version it is not. Update both (or run scripts/fb-internal/bump-mcp-version.sh).',
  );
  process.exit(1);
}
console.log(`check-version-sync: ${pkg.version} everywhere.`);

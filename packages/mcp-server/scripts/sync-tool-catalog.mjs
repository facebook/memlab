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
 * Generate the README's tool tables from `src/tools/tools-index.ts`.
 *
 * The index is what `memlab_tools` prints in a session; the README tables
 * were a hand-kept copy of it, and a copy drifts: a tool added to one and not
 * the other is documented in one place and invisible in the other. The index
 * is the single source now.
 *
 *   node scripts/sync-tool-catalog.mjs          rewrite README.md
 *   node scripts/sync-tool-catalog.mjs --check  fail if README.md is stale
 */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexFile = path.join(here, '..', 'src', 'tools', 'tools-index.ts');
const readmeFile = path.join(here, '..', 'README.md');
const END_MARKER = '## Core Session Tools';

function readGroups() {
  const src = fs.readFileSync(indexFile, 'utf8');
  const open = 'const GROUPS: Group[] = [';
  const start = src.indexOf(open);
  const end = src.indexOf('\n];', start);
  if (start < 0 || end < 0) {
    throw new Error('sync-tool-catalog: could not find the GROUPS literal.');
  }
  // The literal is plain data (strings, arrays, objects), so it evaluates as
  // JavaScript once the TypeScript annotation is gone.
  const body = src.slice(start + open.length, end);
  try {
    return new Function(`return [${body}];`)();
  } catch (err) {
    throw new Error(
      `sync-tool-catalog: the GROUPS literal in tools-index.ts did not evaluate (${err.message}). It must be plain data, closed by a line that starts with "];".`,
    );
  }
}

function render(groups) {
  const cell = text => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  return groups
    .map(g =>
      [
        `### ${g.question}`,
        '',
        '| Tool | Use it when |',
        '| --- | --- |',
        ...g.tools.map(([name, when]) => `| \`${name}\` | ${cell(when)} |`),
        '',
      ].join('\n'),
    )
    .join('\n');
}

const groups = readGroups();
const readme = fs.readFileSync(readmeFile, 'utf8');
const first = `### ${groups[0].question}`;
// Whole lines only: the same words in prose must not move the splice.
const lineAt = (line, from) => {
  const i = readme.indexOf(`\n${line}\n`, from - 1);
  return i < 0 ? -1 : i + 1;
};
const start = lineAt(first, 0);
const end = start < 0 ? -1 : lineAt(END_MARKER, start);
if (start < 0 || end < 0) {
  console.error(
    `sync-tool-catalog: README.md needs a "${first}" heading followed by "${END_MARKER}".`,
  );
  process.exit(1);
}
const next = readme.slice(0, start) + render(groups) + readme.slice(end);

if (process.argv.includes('--check')) {
  if (next !== readme) {
    console.error(
      'sync-tool-catalog: README.md tool tables differ from src/tools/tools-index.ts. Run `node scripts/sync-tool-catalog.mjs`.',
    );
    process.exit(1);
  }
  const count = groups.reduce((s, g) => s + g.tools.length, 0);
  console.log(
    `sync-tool-catalog: README.md tool tables match the index (${groups.length} groups, ${count} rows).`,
  );
} else {
  fs.writeFileSync(readmeFile, next);
  console.log('sync-tool-catalog: README.md tool tables regenerated.');
}

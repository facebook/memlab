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
 * Fail when a tool's description tells the caller to use a parameter that is
 * not in its schema.
 *
 * `memlab_batch` documented `timeout_ms` ("size it with `timeout_ms`") and had
 * no such key. The schema rejects unknown keys, so every call setting it failed
 * validation — and a reader who trusted the description concluded the batch was
 * bounded when nothing bounded it. A documented knob that cannot be called is
 * worse than an absent one, and prose drifting from a schema is not something
 * review reliably catches.
 *
 * Deliberately narrow: it only flags a backticked identifier that the
 * description actively tells the caller to use ("set `x`", "pass `x`", "with
 * `x`"). Mentioning another tool's parameter in passing is fine and common.
 */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.join(here, '..', 'src', 'tools');

const USE_RE = /(?:with|set|pass|use|via)\s+`([a-z_][a-z0-9_]{3,})`/g;
// Prettier wraps long chains as `name: z\n  .string()`, so `: z.` alone
// misses most keys — match the identifier followed by `z` and any break.
const SCHEMA_KEY_RE = /^ {4,12}([a-z_][a-z0-9_]*): z[.\s]/gm;

let problems = 0;
let checked = 0;

for (const file of fs.readdirSync(toolsDir).sort()) {
  if (!file.endsWith('.ts')) continue;
  const src = fs.readFileSync(path.join(toolsDir, file), 'utf8');
  const toolMatch = /server\.tool\(\s*'([^']+)'/.exec(src);
  if (!toolMatch) continue;
  const schemaStart = src.indexOf('\n    {', toolMatch.index);
  if (schemaStart < 0) continue;

  const keys = new Set([...src.matchAll(SCHEMA_KEY_RE)].map(m => m[1]));
  if (keys.size === 0) continue;
  checked++;

  const description = src.slice(toolMatch.index, schemaStart);
  const mentioned = new Set([...description.matchAll(USE_RE)].map(m => m[1]));
  for (const name of mentioned) {
    if (keys.has(name)) continue;
    // Another tool's parameter, referenced by its own name, is fine.
    if (description.includes(`memlab_`) && !description.includes(`\`${name}\``))
      continue;
    problems++;
    console.error(
      `${toolMatch[1]} (${file}): description tells the caller to use \`${name}\`, which is not one of its schema keys ` +
        `(${[...keys].join(', ')}). Either add it to the schema or stop documenting it.`,
    );
  }
}

if (problems > 0) {
  console.error(
    `\n${problems} description/schema mismatch(es) across ${checked} tools.`,
  );
  process.exit(1);
}
console.log(
  `check-tool-docs: ${checked} tools checked, no description/schema mismatches.`,
);

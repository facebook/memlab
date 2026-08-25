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

// Two characters minimum, not four: `key`, `id` and `ms` are real parameter
// names, and a longer floor silently drops them from the audit. The verb is
// matched in either case (a sentence often opens with "Set `x`"), but the
// identifier stays lower-case — an /i flag would widen the capture to match
// type names like `ClientRect` and report them as missing parameters.
const USE_RE =
  /(?:[Ww]ith|[Ss]et|[Pp]ass|[Uu]se|[Vv]ia)\s+`([a-z_][a-z0-9_]+)`/g;
const TOOL_NAME_RE = /memlab_[a-z0-9_]+/g;

/** Index just past the string literal starting at `i`. */
function skipString(src, i) {
  const quote = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/** Index just past the comment starting at `i`, or -1 if none starts there. */
function skipComment(src, i) {
  if (src[i] !== '/') return -1;
  if (src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl < 0 ? src.length : nl;
  }
  if (src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end < 0 ? src.length : end + 2;
  }
  return -1;
}

/**
 * Opening brace of the schema object — the first `{` that is an argument of
 * `server.tool(...)` rather than part of the description string.
 *
 * Located structurally instead of by matching a fixed indentation: a
 * reformatted schema object silently skipped the whole tool, so the audit
 * quietly covered less than it reported.
 */
function findSchemaStart(src, from) {
  let i = src.indexOf('(', from);
  if (i < 0) return -1;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    const commentEnd = skipComment(src, i);
    if (commentEnd >= 0) {
      i = commentEnd;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return -1;
    } else if (c === '{' && depth === 1) {
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * Top-level keys of the object literal beginning at `start`.
 *
 * Scoped to that object and to its own nesting level: matching key-like lines
 * across the whole file also collected the keys of nested zod objects, so a
 * description naming a nested helper field passed the check as though it were
 * a real parameter.
 */
function topLevelSchemaKeys(src, start) {
  const keys = new Set();
  const keyRe = /([a-z_][a-z0-9_]*)\s*:/y;
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    const commentEnd = skipComment(src, i);
    if (commentEnd >= 0) {
      i = commentEnd;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if (c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === '}') {
      depth--;
      if (depth === 0) return keys;
      i++;
      continue;
    }
    if (depth === 1 && /[\s{,]/.test(src[i - 1] ?? '')) {
      keyRe.lastIndex = i;
      const m = keyRe.exec(src);
      if (m) {
        keys.add(m[1]);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return keys;
}

/** The sentence containing `index`, used to scope "who is being described". */
function sentenceAround(text, index) {
  let start = index;
  while (start > 0 && !'.\n'.includes(text[start - 1])) start--;
  let end = index;
  while (end < text.length && !'.\n'.includes(text[end])) end++;
  return text.slice(start, end);
}

let problems = 0;
let checked = 0;

for (const file of fs.readdirSync(toolsDir).sort()) {
  if (!file.endsWith('.ts')) continue;
  const src = fs.readFileSync(path.join(toolsDir, file), 'utf8');
  const toolMatch = /server\.tool\(\s*'([^']+)'/.exec(src);
  if (!toolMatch) continue;
  const schemaStart = findSchemaStart(src, toolMatch.index);
  if (schemaStart < 0) continue;

  const toolName = toolMatch[1];
  const keys = topLevelSchemaKeys(src, schemaStart);
  if (keys.size === 0) continue;
  checked++;

  const description = src.slice(toolMatch.index, schemaStart);
  for (const m of description.matchAll(USE_RE)) {
    const name = m[1];
    if (keys.has(name)) continue;
    // A sentence that names a different tool is describing that tool's
    // parameter, not a missing one of ours. The previous form of this guard
    // tested whether the identifier appeared in backticks, which the pattern
    // above has already guaranteed — so it never skipped anything.
    const sentence = sentenceAround(description, m.index);
    const others = [...sentence.matchAll(TOOL_NAME_RE)].map(t => t[0]);
    if (others.some(other => other !== toolName)) continue;
    problems++;
    console.error(
      `${toolName} (${file}): description tells the caller to use \`${name}\`, which is not one of its schema keys ` +
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

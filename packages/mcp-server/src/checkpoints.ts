/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import fs from 'fs';
import path from 'path';

/**
 * Named capture checkpoints.
 *
 * `memlab_capture({label})` records each capture in `<out_dir>/checkpoints.json`
 * with its label, time, page and files. Any tool that takes a snapshot path
 * then accepts `checkpoint:<label>` (the latest capture directory of this
 * session) or `checkpoint:<out_dir>#<label>`, so "capture baseline, act,
 * capture after, compare" needs no file names, and the comparison says which
 * checkpoint each side was.
 */

export interface CheckpointFile {
  target: 'page' | 'worker';
  title: string;
  path: string;
  used_mb: number | null;
}

export interface Checkpoint {
  label: string;
  captured_at: string;
  page_url: string;
  page_title: string;
  files: CheckpointFile[];
}

const MANIFEST = 'checkpoints.json';
// Directories captured into this session, most recent last.
const sessionDirs: string[] = [];

export function readCheckpoints(dir: string): Checkpoint[] {
  const file = path.join(dir, MANIFEST);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  // A manifest that does not parse is an error, not an empty one: treating it
  // as empty would overwrite every checkpoint in it on the next capture.
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${file} does not parse (${err instanceof Error ? err.message : String(err)}); fix or remove it.`,
    );
  }
  const valid =
    Array.isArray(raw) &&
    raw.every(
      c =>
        c != null &&
        typeof c === 'object' &&
        typeof (c as Checkpoint).label === 'string' &&
        Array.isArray((c as Checkpoint).files),
    );
  if (!valid) {
    throw new Error(
      `${file} is not a list of checkpoints with a label and files; fix or remove it.`,
    );
  }
  return raw as Checkpoint[];
}

/** Labels may not contain the characters checkpoint references reserve. */
export function checkpointLabelError(label: string): string | null {
  if (label.trim() === '') return 'a checkpoint label cannot be empty';
  if (label.trim() !== label) {
    return `checkpoint label "${label}" may not start or end with whitespace (\`checkpoint:${label.trim()}\` would not find it)`;
  }
  if (/[/#]/.test(label)) {
    return `checkpoint label "${label}" may not contain "/" or "#" (they separate the directory and the worker in a checkpoint reference)`;
  }
  return null;
}

/** Add or replace the checkpoint `entry.label` in `dir`'s manifest. */
export function recordCheckpoint(dir: string, entry: Checkpoint): Checkpoint[] {
  const all = readCheckpoints(dir).filter(c => c.label !== entry.label);
  all.push(entry);
  fs.mkdirSync(dir, {recursive: true});
  // Write a temporary file and rename it over the manifest: the rename is
  // atomic, so an interrupted write cannot leave a half-written manifest that
  // `readCheckpoints` would then refuse for every checkpoint in it.
  const manifest = path.join(dir, MANIFEST);
  const temporary = `${manifest}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(all, null, 2));
    fs.renameSync(temporary, manifest);
  } catch (err) {
    fs.rmSync(temporary, {force: true});
    throw err;
  }
  const resolved = path.resolve(dir);
  const at = sessionDirs.indexOf(resolved);
  if (at >= 0) sessionDirs.splice(at, 1);
  sessionDirs.push(resolved);
  return all;
}

export function isCheckpointRef(ref: string): boolean {
  return ref.startsWith('checkpoint:');
}

/**
 * The page snapshot (or, with `checkpoint:<label>/<worker title>`, a worker
 * snapshot) of a named checkpoint.
 */
export function resolveCheckpointRef(ref: string): {
  path: string;
  checkpoint: Checkpoint;
} {
  const body = ref.slice('checkpoint:'.length);
  const hash = body.lastIndexOf('#');
  const spec = hash >= 0 ? body.slice(hash + 1) : body;
  const slash = spec.indexOf('/');
  const label = slash >= 0 ? spec.slice(0, slash) : spec;
  const worker = slash >= 0 ? spec.slice(slash + 1) : null;
  // Whether a checkpoint holds the snapshot the reference asks for: the page,
  // or a worker whose title matches.
  const hasTarget = (c: Checkpoint) =>
    worker == null
      ? c.files.some(f => f.target === 'page')
      : c.files.some(f => f.target === 'worker' && f.title.includes(worker));
  // A bare label searches every directory captured into this session, most
  // recent first, so two captures to different out_dirs both stay reachable.
  // Prefer one whose checkpoint has the requested snapshot; otherwise the most
  // recent with the label, so the error below names the closest match.
  const recent = [...sessionDirs].reverse();
  const withLabel = (d: string, target: boolean) =>
    readCheckpoints(d).some(
      c => c.label === label && (!target || hasTarget(c)),
    );
  const dir =
    hash >= 0
      ? body.slice(0, hash)
      : (recent.find(d => withLabel(d, true)) ??
        recent.find(d => withLabel(d, false)) ??
        null);
  if (dir == null) {
    if (sessionDirs.length === 0) {
      throw new Error(
        `\`${ref}\`: no checkpoint directory yet in this session. Capture with memlab_capture({label}) first, or write \`checkpoint:<out_dir>#<label>\`.`,
      );
    }
    const have = sessionDirs.map(d => {
      const labels = readCheckpoints(d).map(c => c.label);
      return `${d}: ${labels.length > 0 ? labels.join(', ') : 'none'}`;
    });
    throw new Error(
      `\`${ref}\`: no checkpoint "${label}" in this session's directories (${have.join('; ')}).`,
    );
  }
  const all = readCheckpoints(dir);
  const cp = all.find(c => c.label === label);
  if (cp == null) {
    throw new Error(
      `\`${ref}\`: no checkpoint "${label}" in ${path.join(dir, MANIFEST)}` +
        (all.length > 0
          ? ` (have: ${all.map(c => c.label).join(', ')}).`
          : ' (none recorded).'),
    );
  }
  let file: CheckpointFile | undefined;
  if (worker == null) {
    file = cp.files.find(f => f.target === 'page');
  } else {
    const workers = cp.files.filter(f => f.target === 'worker');
    const exact = workers.filter(f => f.title === worker);
    const partial = workers.filter(f => f.title.includes(worker));
    const candidates = exact.length > 0 ? exact : partial;
    if (candidates.length > 1) {
      throw new Error(
        `\`${ref}\`: "${worker}" matches ${candidates.length} workers (${candidates.map(f => f.title).join('; ')}); use more of the title.`,
      );
    }
    file = candidates[0];
  }
  if (file == null) {
    throw new Error(
      `\`${ref}\`: checkpoint "${label}" has no ${worker == null ? 'page' : `worker matching "${worker}"`} snapshot.`,
    );
  }
  return {path: file.path, checkpoint: cp};
}

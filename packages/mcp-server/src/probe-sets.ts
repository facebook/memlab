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
 * Named probe sets, kept on disk across sessions.
 *
 * A hunt on one app measures the same handful of populations every round
 * (a collection count, duplicate models, a listener-record count). Each round
 * re-typed them into `ladder_probe` and `ab_compare`, and the battery could not
 * run them at all. A set is saved once, under a name, with an optional `match`
 * against the round's URL filter so the ladder tools pick it up by themselves.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export type ProbeExpectation = 'flat' | 'bounded' | 'any';

export interface SavedProbe {
  code: string;
  /** The size a fix bounds the population at (see `memlab_ab_compare`). */
  cap?: number;
  expect?: ProbeExpectation;
  note?: string;
}

export interface ProbeSet {
  /** Substring of the round's URL filter that selects this set. */
  match?: string;
  /** Source run before every probe of the set. */
  prelude?: string;
  probes: Record<string, SavedProbe>;
}

interface ProbeStore {
  version: 1;
  sets: Record<string, ProbeSet>;
}

export function probeStorePath(): string {
  const dir =
    process.env.MEMLAB_STATE_DIR ?? path.join(os.homedir(), '.memlab');
  return path.join(dir, 'probes.json');
}

export function readProbeSets(): Record<string, ProbeSet> {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(probeStorePath(), 'utf8'),
    ) as ProbeStore;
    if (parsed?.version === 1 && parsed.sets != null) return parsed.sets;
  } catch {
    // Missing or corrupt: no sets, rather than failing the tool reading them.
  }
  return {};
}

export function writeProbeSets(sets: Record<string, ProbeSet>): void {
  const file = probeStorePath();
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const store: ProbeStore = {version: 1, sets};
  // Write then rename: a torn write would read back as no sets, and the next
  // save would overwrite every saved set with that.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
}

/** The URL strings a round records, lower-cased, for `match`. */
function roundUrls(runDir: string): string[] {
  try {
    const run = JSON.parse(
      fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'),
    ) as {
      config?: {url_filter?: unknown; url?: unknown};
      environment?: {url?: unknown};
    };
    return [run.config?.url_filter, run.config?.url, run.environment?.url]
      .filter((v): v is string => typeof v === 'string' && v !== '')
      .map(v => v.toLowerCase());
  } catch {
    return [];
  }
}

/**
 * The set to use: `name` when given (an unknown name throws), else the one set
 * with probes whose `match` appears in the round's URLs. None when nothing
 * matches or when two sets do, since guessing between them would measure the
 * wrong app.
 */
export function resolveProbeSet(
  name: string | undefined,
  runDir: string | undefined,
): {name: string; set: ProbeSet; auto: boolean} | null {
  const sets = readProbeSets();
  if (name != null && name !== '') {
    const set = sets[name];
    if (set == null) {
      const known = Object.keys(sets);
      throw new Error(
        `No probe set named "${name}". ${known.length > 0 ? `Saved sets: ${known.join(', ')}.` : 'None are saved yet: `memlab_probes({mode: "save", …})`.'}`,
      );
    }
    return {name, set, auto: false};
  }
  if (runDir == null || runDir === '') return null;
  const urls = roundUrls(runDir);
  if (urls.length === 0) return null;
  const hits = Object.entries(sets).filter(
    ([, s]) =>
      Object.keys(s.probes ?? {}).length > 0 &&
      s.match != null &&
      s.match !== '' &&
      urls.some(u => u.includes((s.match as string).toLowerCase())),
  );
  if (hits.length !== 1) return null;
  const [setName, set] = hits[0];
  return {name: setName, set, auto: true};
}

/**
 * Whether a per-rung series meets its expectation. `flat`: the last rung is
 * within max(1, 5%) of the first, either way (a population that collapsed is
 * as suspect as one that grew: often the probe stopped finding it). `bounded`: under `cap` when one is given,
 * else the second half of the ladder grew at most a quarter as fast as the
 * first.
 */
export function judgeExpectation(
  series: Array<number | null>,
  expect: ProbeExpectation | undefined,
  cap: number | undefined,
): string | null {
  if (expect == null || expect === 'any') return null;
  const vals = series.filter((v): v is number => v != null);
  if (vals.length < 2) return 'CANNOT JUDGE (fewer than 2 readable rungs)';
  const first = vals[0];
  const last = vals[vals.length - 1];
  if (expect === 'flat') {
    const slack = Math.max(1, Math.abs(first) * 0.05);
    const moved = last - first;
    return Math.abs(moved) <= slack
      ? 'OK (flat)'
      : moved > 0
        ? `VIOLATED (expected flat, grew +${moved})`
        : `VIOLATED (expected flat, dropped ${moved})`;
  }
  if (cap != null) {
    const peak = Math.max(...vals);
    return peak <= cap
      ? `OK (bounded, peak ${peak} ≤ cap ${cap})`
      : `VIOLATED (expected ≤ ${cap}, peaked at ${peak})`;
  }
  if (vals.length < 3) {
    return 'CANNOT JUDGE (bounded without a cap needs 3 rungs)';
  }
  const mid = Math.floor((vals.length - 1) / 2);
  const early = vals[mid] - first;
  const late = last - vals[mid];
  // No growth in the first half (early <= 0) leaves a floor of 1: any later
  // growth is then growth that has not stopped, which is what VIOLATED means.
  return late <= Math.max(1, early * 0.25)
    ? 'OK (bounded: growth slowed)'
    : `VIOLATED (expected bounded, still growing: +${early} then +${late})`;
}

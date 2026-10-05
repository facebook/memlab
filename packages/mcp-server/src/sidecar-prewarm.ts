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
 * Build missing rung sidecars in parallel worker threads.
 *
 * A ladder tool walked its rungs one at a time, parsing each: five 500 MB
 * rungs at ~27 s apiece (parse + index) before the first number came out, on a
 * host with 192 cores. The per-class trend needs only the sidecar, so the
 * rungs that lack one are parsed concurrently here, each in its own isolate,
 * and the tool then reads every rung from its sidecar.
 *
 * Concurrency is bounded by free memory as well as cores: a parse holds
 * several times the file size, and running out of memory in a worker costs
 * that rung's sidecar, not the analysis — the tool falls back to parsing it
 * inline.
 */

import os from 'os';
import fs from 'fs';
import {Worker} from 'node:worker_threads';
import {indexCacheEnabled, sidecarLooksCurrent} from './snapshot-index.js';

/** Bytes of memory a parse is assumed to need per byte of snapshot. */
const PARSE_MEMORY_FACTOR = 8;
const MAX_WORKERS = 8;
const WORKER_TIMEOUT_MS = 15 * 60 * 1000;

export interface PrewarmTarget {
  /** Path the sidecar is keyed on (`resolveSnapshotPath().sidecarBase`). */
  sidecarBase: string;
  /** Local file to parse. */
  localPath: string;
}

export interface PrewarmResult {
  built: number;
  /** `path: reason` for each rung whose sidecar could not be built. */
  failed: string[];
  concurrency: number;
  ms: number;
}

/** MEMLAB_PREWARM_CONCURRENCY, or null when unset or not a count. */
function explicitConcurrency(): number | null {
  const raw = process.env.MEMLAB_PREWARM_CONCURRENCY;
  const env = raw == null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(env) && env >= 0 ? Math.floor(env) : null;
}

function workerCount(targets: PrewarmTarget[]): number {
  const env = explicitConcurrency();
  if (env != null) return Math.min(env, targets.length);
  const largest = Math.max(
    ...targets.map(t => {
      try {
        return fs.statSync(t.localPath).size;
      } catch {
        return 0;
      }
    }),
    1,
  );
  const byMemory = Math.floor(os.freemem() / (largest * PARSE_MEMORY_FACTOR));
  const byCores = Math.max(1, Math.floor(os.cpus().length / 4));
  return Math.max(0, Math.min(targets.length, byMemory, byCores, MAX_WORKERS));
}

function buildOne(t: PrewarmTarget): Promise<string | null> {
  return new Promise(resolve => {
    let size = 0;
    try {
      size = fs.statSync(t.localPath).size;
    } catch (e) {
      resolve(`stat failed: ${String(e)}`);
      return;
    }
    const worker = new Worker(new URL('./sidecar-worker.js', import.meta.url), {
      workerData: t,
      resourceLimits: {
        maxOldGenerationSizeMb: Math.max(
          8192,
          Math.ceil((size * PARSE_MEMORY_FACTOR) / 1048576),
        ),
      },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve(`timed out after ${WORKER_TIMEOUT_MS / 60000} min`);
    }, WORKER_TIMEOUT_MS);
    worker.once('message', (m: {ok?: boolean; error?: string}) => {
      clearTimeout(timer);
      resolve(m?.ok === true ? null : (m?.error ?? 'worker reported failure'));
    });
    worker.once('error', e => {
      clearTimeout(timer);
      resolve(`worker error: ${e.message}`);
    });
    // Settles a worker that exited without posting; after a message this is a
    // no-op, the promise having resolved already.
    worker.once('exit', code => {
      clearTimeout(timer);
      resolve(`worker exited (code ${code}) without reporting`);
    });
  });
}

/**
 * Build sidecars for every target that lacks a valid one. Returns how many
 * were built; a target that fails is left for the caller to parse inline.
 * Does nothing (concurrency 0) with the index cache off, or for fewer than
 * two missing sidecars, where parsing inline costs the same and spawns
 * nothing.
 */
export async function prewarmSidecars(
  targets: PrewarmTarget[],
): Promise<PrewarmResult> {
  const started = Date.now();
  // With the cache off nothing reads a sidecar back, so building one is
  // wasted work.
  if (!indexCacheEnabled()) {
    return {built: 0, failed: [], concurrency: 0, ms: 0};
  }
  // Header-only: decoding every existing sidecar here, only for the per-rung
  // loop to decode it again, doubled the warm path this exists to shorten.
  const missing = targets.filter(t => !sidecarLooksCurrent(t.sidecarBase));
  const concurrency = missing.length < 2 ? 0 : workerCount(missing);
  const result: PrewarmResult = {built: 0, failed: [], concurrency, ms: 0};
  // One automatic worker is no faster than parsing inline. An explicit
  // MEMLAB_PREWARM_CONCURRENCY=1 is still honoured.
  if (concurrency < (explicitConcurrency() != null ? 1 : 2)) {
    result.concurrency = 0;
    return result;
  }
  const queue = [...missing];
  const run = async (): Promise<void> => {
    for (let t = queue.shift(); t != null; t = queue.shift()) {
      const failure = await buildOne(t);
      if (failure == null) result.built++;
      else result.failed.push(`${t.localPath}: ${failure}`);
    }
  };
  await Promise.all(Array.from({length: concurrency}, run));
  result.ms = Date.now() - started;
  return result;
}

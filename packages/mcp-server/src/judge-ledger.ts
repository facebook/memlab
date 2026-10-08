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
 * When has each judge been seen red?
 *
 * A PASS is only evidence from a judge that has fired before, on a round known
 * to carry the leak it guards or with its fix switched off. This ledger records
 * those sightings, keyed by a fingerprint of what the judge measures rather than
 * by its name or file: invariants.json is copied into every round directory, so
 * the same judge appears in many places, and editing a probe must invalidate its
 * evidence while renaming it must not.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {Invariant} from './judges.js';

export interface Sighting {
  kind: 'calibration' | 'switch';
  /** Round directory the judge was run on. */
  round: string;
  /** Free text: which leak the round carries, or which rule was off. */
  note: string;
  red: boolean;
  at: string;
}

export interface LedgerFile {
  judges: Record<string, {name: string; sightings: Sighting[]}>;
}

export function ledgerPath(): string {
  const override = process.env.MEMLAB_JUDGE_LEDGER;
  if (override != null && override !== '') return override;
  return path.join(
    process.env.HOME ?? '/tmp',
    '.memlab-mcp',
    'judge-calibration.json',
  );
}

export function judgeFingerprint(
  inv: Invariant,
  prelude: string | null,
): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        prelude,
        inv.probe,
        inv.visibilityProbe,
        inv.expect,
        inv.maxPerCycle,
        inv.tolerance,
        inv.absTolerance,
        inv.max,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
}

/** The ledger on disk, with any malformed slot or sighting dropped rather than trusted. */
/**
 * `strict` is for the write path: a ledger that exists but cannot be parsed
 * throws rather than reading as empty, or the write would replace every
 * earlier sighting with this batch alone. Readers stay lenient.
 */
function load(strict = false): LedgerFile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (strict && !missing) {
      throw new Error(
        `${ledgerPath()} exists but is unreadable (${String(err)}); not overwriting it`,
      );
    }
    return {judges: {}};
  }
  const judges: LedgerFile['judges'] = {};
  const src = (raw as {judges?: unknown})?.judges;
  if (src == null || typeof src !== 'object') return {judges};
  for (const [fp, slot] of Object.entries(src as Record<string, unknown>)) {
    const o = (slot ?? {}) as {name?: unknown; sightings?: unknown};
    const sightings = (Array.isArray(o.sightings) ? o.sightings : []).filter(
      (x): x is Sighting =>
        x != null &&
        ((x as Sighting).kind === 'calibration' ||
          (x as Sighting).kind === 'switch') &&
        typeof (x as Sighting).note === 'string' &&
        typeof (x as Sighting).round === 'string' &&
        typeof (x as Sighting).at === 'string' &&
        typeof (x as Sighting).red === 'boolean',
    );
    judges[fp] = {name: typeof o.name === 'string' ? o.name : fp, sightings};
  }
  return {judges};
}

const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 10000;

/**
 * Take a dead holder's lock out of the way, at most once per stale lock.
 *
 * A rename is atomic, so of two waiters that both saw the lock as stale only
 * one moves it. The other's rename then finds no lock, or finds the FRESH lock
 * the winner just made; that one is put back, so a live holder is never evicted.
 */
function reclaimStale(lock: string): boolean {
  const moved = `${lock}.stale.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(lock, moved);
  } catch {
    return true; // already gone: retry the mkdir
  }
  let fresh = false;
  try {
    fresh = Date.now() - fs.statSync(moved).mtimeMs <= LOCK_STALE_MS;
  } catch {
    // vanished after the move; nothing to restore
  }
  if (fresh) {
    try {
      fs.renameSync(moved, lock);
    } catch {
      // the path was retaken meanwhile; its holder still has the lock
    }
    return false;
  }
  fs.rmSync(moved, {recursive: true, force: true});
  return true;
}

/**
 * Hold a cross-process lock around the ledger's read-modify-write: two servers
 * (a session's and a CLI's) recording at once would otherwise each write back
 * the ledger they read, and the last rename would drop the other's sightings.
 *
 * Waits asynchronously, so a contended lock never blocks the server's event
 * loop. Reclaims only a lock older than LOCK_STALE_MS (its holder died), never
 * a fresh one just because this waiter ran out of patience; then it returns
 * false and the caller says the sightings were not recorded.
 */
async function withLedgerLock(fn: () => void): Promise<boolean> {
  const lock = `${ledgerPath()}.lock`;
  fs.mkdirSync(path.dirname(lock), {recursive: true});
  const deadline = Date.now() + LOCK_WAIT_MS;
  // Who holds the lock: the release removes it only if it is still ours, in
  // case a waiter reclaimed it as stale and another process took it since.
  const token = `${process.pid}.${Date.now()}.${Math.random()}`;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      try {
        fs.writeFileSync(path.join(lock, 'owner'), token);
      } catch (err) {
        // Never leave an ownerless lock that everyone must wait out.
        fs.rmSync(lock, {recursive: true, force: true});
        throw err;
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        // Released between the mkdir and the stat: wait like any other miss
        // rather than spin, in case it is being taken and dropped rapidly.
        age = 0;
      }
      if (age > LOCK_STALE_MS && reclaimStale(lock)) continue;
      if (Date.now() > deadline) return false;
      await new Promise(r => setTimeout(r, 50));
    }
  }
  try {
    fn();
    return true;
  } finally {
    let mine = false;
    try {
      mine = fs.readFileSync(path.join(lock, 'owner'), 'utf8') === token;
    } catch {
      // gone, or someone else's half-made lock: not ours to remove
    }
    if (mine) fs.rmSync(lock, {recursive: true, force: true});
  }
}

/**
 * Null when recorded; otherwise why not, so a permanent disk or permission
 * error reads differently from ordinary contention.
 */
export async function recordSightings(
  entries: Array<{fingerprint: string; name: string; sighting: Sighting}>,
): Promise<string | null> {
  if (entries.length === 0) return null;
  let writeError: string | null = null;
  let locked: boolean;
  try {
    locked = await withLedgerLock(() => {
      const ledger = load(true);
      for (const {fingerprint, name, sighting} of entries) {
        const slot = (ledger.judges[fingerprint] ??= {name, sightings: []});
        slot.name = name;
        // One sighting per round and kind: re-running calibration replaces it.
        slot.sightings = slot.sightings
          .filter(
            s => !(s.round === sighting.round && s.kind === sighting.kind),
          )
          .concat(sighting);
      }
      const file = ledgerPath();
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
        fs.renameSync(tmp, file);
      } catch (err) {
        // A full or read-only disk loses the sightings, not the verdicts the
        // caller has already computed: report not-recorded, as for contention.
        fs.rmSync(tmp, {force: true});
        writeError = `could not write ${file}: ${String(err)}`;
      }
    });
  } catch (err) {
    // The lock could not be taken (a read-only ledger directory), or the
    // ledger on disk is unreadable and was deliberately left alone.
    return err instanceof Error ? err.message : String(err);
  }
  if (!locked) return 'the ledger stayed locked by another live process';
  return writeError;
}

export type SeenRed =
  | {status: 'red'; sightings: Sighting[]}
  | {status: 'blind'; sighting: Sighting}
  | {status: 'never'};

/**
 * A judge's standing: BLIND while any round's current sighting is a miss, so a
 * judge that fired last month and missed a known leak yesterday is not
 * calibrated, and re-checking that round is what clears it.
 */
/** The ledger as read once, for callers that look up many judges. */
export function readLedger(): LedgerFile {
  return load();
}

export function seenRed(
  fingerprint: string,
  ledger: LedgerFile = load(),
): SeenRed {
  const slot = ledger.judges[fingerprint];
  if (slot == null || slot.sightings.length === 0) return {status: 'never'};
  const sorted = [...slot.sightings].sort((a, b) => a.at.localeCompare(b.at));
  // One current sighting per round and kind (recordSightings replaces them),
  // so a miss on ANY known leak stands until that round is re-checked: a
  // judge is calibrated only when every round it was checked on saw it fire.
  const misses = sorted.filter(s => !s.red);
  if (misses.length > 0) {
    return {status: 'blind', sighting: misses[misses.length - 1]};
  }
  return {status: 'red', sightings: sorted};
}

export function describeSeenRed(s: SeenRed): string {
  const short = (round: string) =>
    round.replace(/\/+$/, '').replace(/^.*\//, '');
  switch (s.status) {
    case 'never':
      return 'never';
    case 'blind':
      return `**BLIND** on ${short(s.sighting.round)} (${s.sighting.kind})`;
    case 'red': {
      const last = s.sightings[s.sightings.length - 1];
      return `yes — ${short(last.round)} (${last.kind})${s.sightings.length > 1 ? ` +${s.sightings.length - 1}` : ''}`;
    }
  }
}

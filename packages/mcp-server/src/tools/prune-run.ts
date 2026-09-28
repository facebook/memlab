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
 * Reclaim the disk a sweep's snapshots occupy.
 *
 * One 21-round sweep captured 101 snapshots at 358-526 MB each: ~40 GB, with
 * nothing in the tooling to manage it. A hunt on a smaller disk simply dies
 * mid-sweep, after the leases that produced the rungs have already been spent.
 *
 * COMPRESSION is the default, not deletion. A heap snapshot is JSON and gzips
 * roughly 5-10x, and the load path resolves `<rung>.gz` transparently, so a
 * compressed round is still fully analysable — it just pays one decompression
 * the first time a rung is opened. Deleting is available and is a one-way
 * door: a rung cannot be re-captured, because the isolate it came from is
 * gone.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import {execFileSync} from 'child_process';
import {z} from 'zod';
import {loadRunManifest} from '../run-manifest.js';
import {rekeySidecarToArchive, sidecarPathFor} from '../snapshot-index.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

type Keep = 'baseline+final+settle' | 'baseline+final' | 'settle' | 'none';

/** Which rungs a keep policy protects, by index and by settle-ness. */
function keptIndices(keep: Keep, driven: number): Set<number> {
  const out = new Set<number>();
  if (keep === 'none' || keep === 'settle') return out;
  out.add(0);
  if (driven > 0) out.add(driven - 1);
  return out;
}

function sizeOf(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * Decompressed byte count of a gzip file, without holding it in memory.
 *
 * `gzip -l` reports the size from the trailer, which a truncated archive
 * also carries — so it agrees with the original on exactly the corruption
 * worth catching. Streaming the real bytes through and counting them is the
 * check that does not.
 */
/** Is the `gzip` binary usable here? Asked once, cached. */
let gzipAvailable: boolean | null = null;
function hasGzipBinary(): boolean {
  if (gzipAvailable == null) {
    try {
      execFileSync('gzip', ['--version'], {stdio: 'ignore'});
      gzipAvailable = true;
    } catch {
      gzipAvailable = false;
    }
  }
  return gzipAvailable;
}

function verifyArchive(file: string, originalBytes: number): string | null {
  // NO SHELL. This ran as `/bin/sh -c "gzip -dc <file> | wc -c"`, and
  // `JSON.stringify` only adds double quotes — inside which `$(...)`,
  // backticks and `${...}` are still live. The path comes from the caller's
  // `run_dir` and the manifest, so a rung under `/tmp/run$(...)/…` executed
  // as this process. `execFileSync` with an argv array cannot be injected
  // into, which is what every other subprocess call in this file already
  // does.
  // `gzip -t` when the binary is there, `zlib` when it is not — mirroring
  // `gzipToFile`, which already falls back. Without this pairing, a host
  // with no `gzip` compressed happily through the zlib path and then
  // failed EVERY verification, so `mode: "compress"` refused every rung
  // and reported a corrupt archive it had just written correctly.
  try {
    execFileSync('gzip', ['-t', file], {stdio: ['ignore', 'ignore', 'pipe']});
  } catch (e) {
    if (!hasGzipBinary()) {
      try {
        // Streamed through the decompressor purely to force the CRC check;
        // the bytes are discarded as they go, so this holds one chunk at a
        // time rather than the whole rung.
        zlib.gunzipSync(fs.readFileSync(file), {
          maxOutputLength: 8 * 1024 * 1024 * 1024,
        });
      } catch (inner) {
        return `the archive does not decompress: ${inner instanceof Error ? inner.message : String(inner)}`;
      }
      return null;
    }
    return `gzip -t rejected the archive: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`;
  }
  // `gzip -t` verifies the CRC32 over the real decompressed bytes, so it
  // catches a truncated or garbled archive that exited 0 — which byte-count
  // equality alone does not. The ISIZE trailer is then checked against the
  // original as a second, independent witness: it is the last four bytes of
  // the file and costs no decompression.
  //
  // ISIZE is the uncompressed length MODULO 2^32, so for a rung at or above
  // 4 GiB it wraps and can only be compared in the same modulus.
  let isize: number;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const tail = Buffer.alloc(4);
      const {size} = fs.fstatSync(fd);
      if (size < 4) return 'the archive is too short to carry a gzip trailer';
      fs.readSync(fd, tail, 0, 4, size - 4);
      isize = tail.readUInt32LE(0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return `could not read the gzip trailer: ${e instanceof Error ? e.message : String(e)}`;
  }
  // A non-positive expected size is a FAILED STAT, not a real size —
  // `sizeOf` returns 0 when it cannot read the file. Comparing against it
  // rejected a perfectly good archive and reported it as corrupt, which
  // sends the operator looking for a disk problem that is not there.
  if (originalBytes <= 0) {
    return 'could not read the size of the original rung, so the archive cannot be verified against it';
  }
  const expected = originalBytes % 4294967296;
  if (isize !== expected) {
    return `the archive reports ${isize} uncompressed bytes but the rung is ${originalBytes} (mod 2^32: ${expected})`;
  }
  return null;
}

/**
 * Compress `src` to `dest`, streamed.
 *
 * The mirror of `gunzipToFile` in `load-snapshot.ts`, for the same reason: a
 * rung is hundreds of megabytes and `gzipSync(readFileSync(...))` holds the
 * whole of it, plus the whole result, as two Buffers — so the largest rungs,
 * the ones worth compressing, are the ones that fail. `zlib` stays as the
 * fallback for a host without `gzip`.
 */
function gzipToFile(src: string, dest: string): void {
  try {
    try {
      // 0600, and `wx` so an existing path is refused rather than followed.
      // The archive holds exactly the page contents the rung did, so the
      // compressed copy needs the same owner-only handling the decompress
      // side got — it was the one half left at the umask default.
      const fd = fs.openSync(dest, 'wx', 0o600);
      try {
        execFileSync('gzip', ['-6', '-c', src], {
          stdio: ['ignore', fd, 'inherit'],
        });
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // The first `openSync` already CREATED `dest`, so re-opening it
      // `wx` below would hit EEXIST and make this fallback unreachable —
      // on a host with no `gzip`, the only path that can work. Clear the
      // empty file the failed attempt left behind first.
      try {
        fs.unlinkSync(dest);
      } catch {
        // Never created.
      }
      // `wx` on the fallback too. `writeFileSync` with a mode happily
      // truncates an existing path (and follows a symlink to it), so the
      // exclusive-create guarantee the primary path gained was lost the
      // moment `gzip` was unavailable — which is exactly the host where
      // nobody is watching.
      const fd = fs.openSync(dest, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, zlib.gzipSync(fs.readFileSync(src), {level: 6}));
      } finally {
        fs.closeSync(fd);
      }
    }
    fs.chmodSync(dest, 0o600);
  } catch (e) {
    // Both paths failed — gzip killed mid-write, or the disk filled, which
    // is the condition prune is usually run under. The partial archive is
    // close to the size of the rung it was compressing, so leaving it behind
    // makes the problem it was called to fix worse.
    try {
      fs.unlinkSync(dest);
    } catch {
      // Never created, or already gone.
    }
    throw e;
  }
}

export function registerPruneRun(server: McpServer): void {
  server.tool(
    'memlab_prune_run',
    "Reclaim the disk a round's snapshots occupy, by COMPRESSING them (default) or deleting them.\n\n" +
      'One sweep captured 101 snapshots at 358-526 MB: ~40 GB, and nothing in the tooling managed it — a hunt on a smaller disk dies mid-sweep, after the leases that produced the rungs have been spent.\n\n' +
      'Compression is the default and is NOT a one-way door: a heap snapshot is JSON and gzips ~5-10x, and the snapshot loader resolves `<rung>.gz` transparently, so a compressed round stays fully analysable at the cost of one decompression per rung opened. Deleting IS one-way — a rung cannot be re-captured, the isolate it came from is gone — so it is opt-in and `dry_run` is the way to see what would go first.\n\n' +
      'Sidecar index files (`<rung>.memlab-index.json`) are kept by default: they are ~1% of a rung and they are what lets a pruned round still answer class- and shape-level questions instantly.',
    {
      run_dir: z
        .string()
        .describe(
          "The round's output directory (the one holding run.json and snapshots/).",
        ),
      mode: z
        .enum(['compress', 'delete', 'dry_run'])
        .optional()
        .default('dry_run')
        .describe(
          '`dry_run` (DEFAULT) reports what would happen and touches nothing. `compress` gzips each pruned rung in place, keeping it analysable. `delete` removes it — irreversible, and a rung cannot be re-captured.',
        ),
      keep: z
        .enum(['baseline+final+settle', 'baseline+final', 'settle', 'none'])
        .optional()
        .default('baseline+final+settle')
        .describe(
          'Which rungs to leave untouched. The default keeps the three that carry the verdict: the baseline, the last driven rung, and the settle rung — enough for a census diff, an artifact budget and a backlog-vs-retention call, but NOT enough for a per-cycle rate, which needs the intermediate rungs.',
        ),
      keep_sidecars: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Leave `<rung>.memlab-index.json` in place (default). They are ~1% of a rung and are what makes a pruned round still answer instantly; set false to reclaim them too.',
        ),
    },
    async ({run_dir, mode, keep, keep_sidecars}) => {
      try {
        const manifest = loadRunManifest(run_dir);
        const driven = manifest.paths.length;
        const protectedIdx = keptIndices(keep, driven);
        const keepSettle =
          keep === 'baseline+final+settle' || keep === 'settle';

        interface Row {
          label: string;
          file: string;
          bytes: number;
          action: 'keep' | 'compress' | 'delete' | 'already compressed';
        }
        const rows: Row[] = [];
        manifest.paths.forEach((p, i) => {
          const exists = fs.existsSync(p);
          const gz = fs.existsSync(`${p}.gz`);
          rows.push({
            label: path.basename(p),
            file: p,
            bytes: exists ? sizeOf(p) : sizeOf(`${p}.gz`),
            // `delete` is tested BEFORE `already compressed`: a rung that
            // was compressed on an earlier pass is exactly what a later
            // delete pass is for, and classifying it 'already compressed'
            // made `mode: "delete"` over a compressed round unlink nothing
            // and report "Reclaimed 0 B".
            //
            // Archive presence is tested BEFORE the plain file, not after: an
            // interrupted compress leaves both, and testing `!exists && gz`
            // sends that pair down the compress path to gzip over an archive
            // that is already good. Nothing here ever clobbers a `.gz`.
            action: protectedIdx.has(i)
              ? 'keep'
              : mode === 'delete'
                ? 'delete'
                : gz
                  ? 'already compressed'
                  : 'compress',
          });
        });
        if (manifest.settleRungPath != null) {
          const p = manifest.settleRungPath;
          const exists = fs.existsSync(p);
          const gz = fs.existsSync(`${p}.gz`);
          rows.push({
            label: path.basename(p),
            file: p,
            bytes: exists ? sizeOf(p) : sizeOf(`${p}.gz`),
            action: keepSettle
              ? 'keep'
              : mode === 'delete'
                ? 'delete'
                : gz
                  ? 'already compressed'
                  : 'compress',
          });
        }

        const acted: string[] = [];
        const failed: string[] = [];
        const staleSidecars: string[] = [];
        let before = 0;
        let after = 0;
        for (const r of rows) {
          before += r.bytes;
          if (r.action === 'keep' || r.action === 'already compressed') {
            after += r.bytes;
            continue;
          }
          if (mode === 'dry_run') {
            // A gzip ratio is not knowable without doing the work; 7x is the
            // middle of the 5-10x a heap snapshot actually achieves, and the
            // estimate is labelled as one.
            after += r.action === 'compress' ? Math.round(r.bytes / 7) : 0;
            continue;
          }
          // The `.gz` form counts as present: a delete pass over an
          // already-compressed round must reclaim the archive, not skip it.
          const plain = fs.existsSync(r.file);
          const archive = fs.existsSync(`${r.file}.gz`);
          if (!plain && !archive) continue;
          try {
            if (r.action === 'compress') {
              // Random, not the pid, and `gzipToFile` opens it with `wx`:
              // a predictable staging path beside the rung can be
              // pre-created by another local user.
              const tmp = `${r.file}.gz.${crypto.randomBytes(9).toString('hex')}.tmp`;
              gzipToFile(r.file, tmp);
              // VERIFIED before the original is unlinked. A `gzip` writing
              // to a filling disk can exit 0 having produced a truncated
              // archive — and this tool is most often run precisely because
              // the disk is filling. Decompressing the archive back and
              // comparing its byte count against the rung is the only check
              // that catches that before the only other copy is deleted.
              const bad = verifyArchive(tmp, sizeOf(r.file));
              if (bad != null) {
                fs.unlinkSync(tmp);
                throw new Error(
                  `${bad} — refusing to replace the rung. The disk may be full.`,
                );
              }
              fs.renameSync(tmp, `${r.file}.gz`);
              fs.unlinkSync(r.file);
              // Or compressing would throw the rung's cache away: the sidecar
              // records the size and mtime of a file that no longer exists.
              // A sidecar that fails to re-key still records the
              // UNCOMPRESSED size and mtime, so every later read rejects it
              // and re-parses the rung (22-43 s) — the cost the cache
              // exists to avoid, silently reintroduced. Report it.
              if (keep_sidecars && !rekeySidecarToArchive(r.file)) {
                staleSidecars.push(r.label);
              }
              after += sizeOf(`${r.file}.gz`);
            } else {
              if (plain) fs.unlinkSync(r.file);
              if (archive) fs.unlinkSync(`${r.file}.gz`);
            }
            if (!keep_sidecars) {
              try {
                fs.unlinkSync(sidecarPathFor(r.file));
              } catch {
                // No sidecar for this rung; nothing to reclaim.
              }
            }
            acted.push(r.label);
          } catch (e) {
            // Per rung, not per run. Aborting here left the rungs already
            // processed unreported and the reclaimed bytes uncounted, so a
            // transient failure on one file looked like a failure of the
            // whole prune — and the obvious response, re-running it, is
            // exactly what should not happen when part of it succeeded.
            failed.push(
              `${r.label}: ${e instanceof Error ? e.message : String(e)}`,
            );
            after += r.bytes;
          }
        }

        const lines: string[] = [
          `## Prune \`${path.basename(run_dir.replace(/\/$/, ''))}\` — ${mode === 'dry_run' ? 'DRY RUN' : mode}`,
          '',
          `Keep policy: \`${keep}\`.`,
          '',
          markdownTable(
            ['Rung', 'Size', 'Action'],
            rows.map(r => [r.label, formatBytes(r.bytes), r.action]),
            new Set([1]),
          ),
          '',
          mode === 'dry_run'
            ? `**Would reclaim ~${formatBytes(before - after)}** of ${formatBytes(before)} (estimated at a 7x gzip ratio; a heap snapshot achieves 5-10x). Re-run with \`mode: "compress"\` to do it, or \`mode: "delete"\` to reclaim all of it irreversibly.`
            : `**Reclaimed ${formatBytes(before - after)}** of ${formatBytes(before)} across ${formatNumber(acted.length)} rung(s).`,
        ];
        if (failed.length > 0) {
          lines.push(
            '',
            `⚠ ${formatNumber(failed.length)} rung(s) could not be ${mode === 'delete' ? 'deleted' : 'compressed'} and were left untouched:`,
            ...failed.map(f => `- ${f}`),
            '',
            'The reclaimed figure above covers only the rungs that succeeded. Re-running is safe: a rung already compressed is skipped.',
          );
        }
        if (staleSidecars.length > 0) {
          lines.push(
            '',
            `⚠ ${formatNumber(staleSidecars.length)} rung(s) lost their sidecar index (it could not be re-pointed at the archive): ` +
              staleSidecars.join(', ') +
              '. Those rungs will be re-parsed on the next analysis instead of answered from cache.',
          );
        }
        if (mode === 'compress' || mode === 'dry_run') {
          lines.push(
            '',
            '_A compressed rung is still analysable: the loader resolves `<rung>.gz` and decompresses to a temp file on first use. Nothing needs to be un-pruned._',
          );
        }
        if (keep !== 'none') {
          lines.push(
            '',
            `_The kept rungs support a census diff, an artifact budget and a settle call. They do NOT support a per-cycle RATE — that needs the intermediate rungs, so run \`memlab_leak_report\` / \`memlab_ladder_probe\` before pruning with anything but \`mode: "compress"\`._`,
          );
        }
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

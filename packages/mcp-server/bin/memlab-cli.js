/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
/// usr/bin/env node

/**
 * Non-MCP command line for the memlab MCP server.
 *
 * Why this exists: the server is only ever reachable through an MCP client, so
 * when a host fails to attach it (a dropped stdio handshake, a plugin that never
 * finishes connecting) every tool in the package becomes unavailable at once,
 * with no diagnostic and no fallback. That happened in practice and cost an
 * agent ~20 minutes and a hand-written JSON-RPC client before any heap could be
 * analyzed at all. The server itself was healthy the whole time.
 *
 * This speaks the same stdio JSON-RPC the host would, so the tools stay usable
 * without one:
 *
 *   memlab-cli doctor
 *   memlab-cli list
 *   memlab-cli schema memlab_load_snapshot
 *   memlab-cli call memlab_snapshot_header '{"file_path":"/tmp/a.heapsnapshot"}'
 *   memlab-cli script steps.jsonl        # one {"tool":..,"args":{..}} per line
 *
 * `script` (and multiple `call` pairs) reuse ONE server process, which matters:
 * the server is stateful and a large snapshot costs minutes to load, so a
 * process per call pays that repeatedly.
 */

import {spawn} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {fileURLToPath} from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function resolveServerPath() {
  if (process.env.MEMLAB_MCP_SERVER) {
    return process.env.MEMLAB_MCP_SERVER;
  }
  // Packaged layout is bin/ next to dist/; the plugin copies this script to the
  // install root, where dist/ is a direct child.
  const candidates = [
    path.join(HERE, '..', 'dist', 'index.js'),
    path.join(HERE, 'dist', 'index.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return candidates[0];
}

/**
 * The interpreter to run the SERVER with, which is not necessarily the one
 * running this CLI: `node` on PATH is frequently older than the package's
 * `>= 18` engine requirement, and spawning the server with it fails at module
 * load with an opaque syntax error. Mirrors the plugin start.sh lookup.
 */
function resolveNodeBin() {
  if (Number(process.versions.node.split('.')[0]) >= 18) {
    return process.execPath;
  }
  for (const c of ['/usr/local/bin/claude_code/node']) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return process.execPath;
}

const DEFAULT_MAX_OLD_SPACE_MB = 8192;
// Fraction of physical RAM the server may claim when the default is used.
const MAX_OLD_SPACE_RAM_FRACTION = 0.6;
// Above this, more old space buys nothing for snapshot analysis.
const MAX_OLD_SPACE_CEILING_MB = 49152;
// Smallest limit worth starting with, and the same floor resolveMaxOldSpaceMB
// enforces on an explicit MEMLAB_MAX_OLD_SPACE_MB.
const MAX_OLD_SPACE_MIN_MB = 512;

/**
 * The container's memory cap in MB, or 0 when the process is not capped.
 *
 * `os.totalmem()` reports the HOST's RAM and knows nothing about a cgroup cap,
 * so inside a memory-limited container 60% of the host is routinely more than
 * the container may ever use — and the failure mode is an OOM-kill by the
 * kernel instead of V8 refusing the load at its own ceiling, which is strictly
 * worse because it takes the server with it. Both cgroup generations expose the
 * cap; v2 writes "max" when unlimited. `start.sh` reads the same two files.
 */
function cgroupLimitMB() {
  for (const f of [
    '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  ]) {
    try {
      const raw = fs.readFileSync(f, 'utf8').trim();
      if (raw === 'max') {
        continue;
      }
      const bytes = Number(raw);
      // v1 spells "unlimited" as a huge sentinel rather than a word.
      if (
        !Number.isFinite(bytes) ||
        bytes <= 0 ||
        bytes >= Number.MAX_SAFE_INTEGER
      ) {
        continue;
      }
      return Math.round(bytes / (1024 * 1024));
    } catch {
      // Not present on this host or not readable — try the next spelling.
    }
  }
  return 0;
}

/**
 * Old-space default, sized from the machine rather than fixed at 8 GB.
 *
 * 8192 was a safe constant on any host, and it is also the number that made a
 * two-snapshot comparison impossible: holding two rungs of a large capture
 * resident measured 5.2 GB RSS, which the 8 GB limit refuses. The env var
 * exists, but most operators never discover it, so the default has to be right
 * on its own. Take a fraction of the memory actually available (leaving room
 * for the browser being driven and the rest of the machine), floored at the
 * historical default so a small host is never made worse, and capped so a very
 * large host does not hand V8 a limit it will never use.
 *
 * Rounded to the nearest whole GB. `start.sh` computes the same number the same
 * way; truncating in one and rounding in the other made the two launchers
 * disagree on the same host (16 GB: 9830 vs 10240).
 */
function defaultMaxOldSpaceMB() {
  let totalMB = 0;
  try {
    totalMB = Math.round(os.totalmem() / (1024 * 1024));
  } catch {
    totalMB = 0;
  }
  const cgroupMB = cgroupLimitMB();
  const capped = cgroupMB > 0 && (totalMB <= 0 || cgroupMB < totalMB);
  if (capped) {
    totalMB = cgroupMB;
  }
  if (!Number.isFinite(totalMB) || totalMB <= 0) {
    return DEFAULT_MAX_OLD_SPACE_MB;
  }
  const scaled =
    Math.round((totalMB * MAX_OLD_SPACE_RAM_FRACTION) / 1024) * 1024;
  if (capped) {
    // Under a HARD cap the 8 GB floor does not apply, and the limit is held
    // at the same 60% the uncapped path targets — not at the cap itself. A
    // 4 GB container clamped to 4096 would tell V8 it may fill 100% of what
    // the kernel allows, leaving nothing for the analysis process's own RSS,
    // which is the OOM-kill this lookup exists to prevent. The GB-rounded
    // `scaled` can round UP past 60%, so take whichever is smaller.
    const headroom = Math.floor(cgroupMB * MAX_OLD_SPACE_RAM_FRACTION);
    return Math.min(
      MAX_OLD_SPACE_CEILING_MB,
      Math.max(MAX_OLD_SPACE_MIN_MB, Math.min(scaled, headroom)),
    );
  }
  // Uncapped: the historical 8192 floor stands, so a small bare-metal host is
  // never made worse than it was before this default existed.
  return Math.min(
    MAX_OLD_SPACE_CEILING_MB,
    Math.max(DEFAULT_MAX_OLD_SPACE_MB, scaled),
  );
}

/**
 * Old-space limit (MB) to run the SERVER with.
 *
 * This has to be passed as an explicit flag, because the interpreter is chosen
 * by resolveNodeBin() and is not necessarily the one the caller's environment
 * was set up for. But an explicit `--max-old-space-size` also OVERRIDES any
 * `--max-old-space-size` in NODE_OPTIONS — so while this was hardcoded, the
 * advice "restart the server with NODE_OPTIONS=--max-old-space-size=..." that
 * the load tools print could not work, and the 8192 here was an unliftable
 * ceiling on what the server would ever accept.
 *
 * It is a ceiling because `memlab_load_snapshot` derives its node/edge limits
 * from the limit the process is ACTUALLY running with (computeDefaultCeilings),
 * so raising this raises what loads, with no other change and no retuning of
 * the safety estimates.
 */
function resolveMaxOldSpaceMB() {
  const raw = process.env.MEMLAB_MAX_OLD_SPACE_MB;
  if (raw == null || raw === '') {
    return defaultMaxOldSpaceMB();
  }
  const n = Number(raw);
  // Refused rather than defaulted: silently falling back would reproduce the
  // exact confusion this replaces — a limit the operator believes they raised
  // and did not.
  if (!Number.isFinite(n) || n < 512) {
    throw new Error(
      `MEMLAB_MAX_OLD_SPACE_MB must be a number of MB >= 512, got: ${raw}`,
    );
  }
  return Math.round(n);
}

class Client {
  constructor(serverPath) {
    this.proc = spawn(
      resolveNodeBin(),
      [`--max-old-space-size=${resolveMaxOldSpaceMB()}`, serverPath],
      {stdio: ['pipe', 'pipe', 'pipe']},
    );
    this.nextId = 0;
    this.buf = '';
    this.pending = new Map();
    this.stderr = [];
    // Drain stderr. A chatty server that fills this pipe would otherwise block
    // its own writes and deadlock the session.
    this.proc.stderr.on('data', d => {
      this.stderr.push(String(d));
      if (this.stderr.length > 400) {
        this.stderr.splice(0, 200);
      }
    });
    this.proc.stdout.on('data', d => this.onData(String(d)));
    this.proc.on('exit', code => {
      for (const {reject} of this.pending.values()) {
        reject(
          new Error(
            `memlab server exited (code ${code}). stderr tail:\n${this.stderr.slice(-40).join('')}`,
          ),
        );
      }
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) {
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) {
        continue;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(JSON.stringify(msg.error)));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  request(method, params) {
    const id = ++this.nextId;
    this.proc.stdin.write(
      JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n',
    );
    return new Promise((resolve, reject) =>
      this.pending.set(id, {resolve, reject}),
    );
  }

  notify(method, params) {
    this.proc.stdin.write(
      JSON.stringify({jsonrpc: '2.0', method, params}) + '\n',
    );
  }

  async init() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {name: 'memlab-cli', version: '1.0'},
    });
    this.notify('notifications/initialized', {});
  }

  async listTools() {
    return (await this.request('tools/list', {})).tools ?? [];
  }

  async callTool(name, args) {
    const res = await this.request('tools/call', {name, arguments: args});
    return (res.content ?? [])
      .map(c => (c.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n');
  }

  close() {
    this.proc.stdin.end();
  }
}

async function doctor(serverPath) {
  const major = Number(process.versions.node.split('.')[0]);
  const nodeBin = resolveNodeBin();
  const lines = [
    `cli node: ${process.versions.node}${major >= 18 ? '' : ' (below the >= 18 engine requirement)'}`,
    `server node: ${nodeBin}${nodeBin === process.execPath && major < 18 ? ' — NO >= 18 interpreter found; the server will fail to load' : ''}`,
  ];
  lines.push(`server path: ${serverPath}`);
  const exists = fs.existsSync(serverPath);
  lines.push(`server present: ${exists ? 'yes' : 'NO'}`);
  if (!exists) {
    lines.push(
      'Fix: build the package (`npm run build-pkg`), or set MEMLAB_MCP_SERVER to a built dist/index.js.',
    );
    console.log(lines.join('\n'));
    return 1;
  }
  // The decisive check: can the server actually start and answer? A corrupted
  // or partial node_modules only shows up here, not from a file listing.
  const client = new Client(serverPath);
  const timer = setTimeout(() => client.proc.kill('SIGKILL'), 60000);
  try {
    await client.init();
    const tools = await client.listTools();
    lines.push(`handshake: OK`);
    lines.push(`tools registered: ${tools.length}`);
    console.log(lines.join('\n'));
    return 0;
  } catch (err) {
    lines.push(`handshake: FAILED — ${err.message}`);
    lines.push(
      'Fix: check the install dir for build-errors.log / deps-check-errors.log, ' +
        'then rebuild (the plugin start.sh does a clean rebuild when dependencies fail to load).',
    );
    console.log(lines.join('\n'));
    return 1;
  } finally {
    clearTimeout(timer);
    client.close();
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const serverPath = resolveServerPath();

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(
      [
        'Usage: memlab-cli <command>',
        '',
        '  doctor                      check node, server presence, and a live handshake',
        '  list                        list tool names and one-line descriptions',
        '  schema <tool>               print a tool input schema as JSON',
        '  call <tool> <json> [...]    call one or more tools in ONE server session',
        '  script <file.jsonl>         run {"tool":..,"args":{..}} lines in ONE session',
        '',
        'Server is resolved from $MEMLAB_MCP_SERVER, else dist/index.js next to this script.',
      ].join('\n'),
    );
    return 0;
  }

  if (cmd === 'doctor') {
    return doctor(serverPath);
  }

  const client = new Client(serverPath);
  try {
    await client.init();
    if (cmd === 'list') {
      for (const t of await client.listTools()) {
        console.log(`${t.name}\t${(t.description ?? '').slice(0, 150)}`);
      }
    } else if (cmd === 'schema') {
      const want = rest[0];
      const tool = (await client.listTools()).find(t => t.name === want);
      if (!tool) {
        console.error(`Unknown tool: ${want}`);
        return 1;
      }
      console.log(JSON.stringify(tool.inputSchema ?? {}, null, 2));
    } else if (cmd === 'call') {
      for (let i = 0; i < rest.length; i += 2) {
        const tool = rest[i];
        const args = rest[i + 1] ? JSON.parse(rest[i + 1]) : {};
        console.log(`\n===== ${tool} =====`);
        // Sequential by construction: JSON-RPC over ONE stdio socket to a
        // stateful server (a loaded snapshot). These cannot be parallelised —
        // the server answers one request at a time and later calls depend on
        // earlier ones.
        // eslint-disable-next-line no-await-in-loop
        console.log(await client.callTool(tool, args));
      }
    } else if (cmd === 'script') {
      const file = rest[0];
      // Sequential by construction: these are JSON-RPC calls over ONE stdio
      // socket to a stateful server, so they cannot be parallelised — the next
      // request depends on the previous one having been answered.

      for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) {
          continue;
        }
        const spec = JSON.parse(line);
        console.log(`\n===== ${spec.tool} =====`);
        // Sequential by construction: JSON-RPC over ONE stdio socket to a
        // stateful server (a loaded snapshot). These cannot be parallelised —
        // the server answers one request at a time and later calls depend on
        // earlier ones.
        // eslint-disable-next-line no-await-in-loop
        console.log(await client.callTool(spec.tool, spec.args ?? {}));
      }
    } else {
      console.error(`Unknown command: ${cmd}. Try --help.`);
      return 1;
    }
    return 0;
  } finally {
    client.close();
  }
}

// Terminal by construction: both arms call process.exit, so there is nothing
// left to chain and no rejection can escape.
// eslint-disable-next-line fb-www/promise-termination
main().then(
  code => process.exit(code ?? 0),
  err => {
    console.error(err.message ?? String(err));
    process.exit(1);
  },
);

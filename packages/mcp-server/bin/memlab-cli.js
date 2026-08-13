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

class Client {
  constructor(serverPath) {
    this.proc = spawn(
      resolveNodeBin(),
      ['--max-old-space-size=8192', serverPath],
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

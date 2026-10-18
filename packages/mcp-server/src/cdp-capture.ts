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
 * Heap snapshots of a live page AND its dedicated workers over the Chrome
 * DevTools Protocol, from inside the server.
 *
 * Two traps decide the shape:
 * - A worker's own `/devtools/page/<id>` websocket never answers in headless
 *   Chrome. Workers are reached through the PAGE connection with
 *   `Target.setAutoAttach {flatten: true}`; each command carries the worker's
 *   `sessionId`.
 * - Workers blocked in `Atomics.wait` (a Wasm thread pool) never answer at all,
 *   so every command has its own deadline and a blocked worker is skipped.
 */

import fs from 'fs';
import path from 'path';

interface MinimalWebSocket {
  onopen: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: {data: unknown}) => void) | null;
  send(data: string): void;
  close(): void;
}

type WebSocketCtor = new (url: string) => MinimalWebSocket;

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
}

export interface CaptureRow {
  target: 'page' | 'worker';
  title: string;
  usedMB: number | null;
  status: string;
  path: string | null;
  bytes: number;
}

export interface CaptureOptions {
  port: number;
  urlFilter: string;
  target: 'page' | 'workers' | 'all';
  outDir: string;
  titleFilter: string;
  callTimeoutMs: number;
  snapshotTimeoutMs: number;
}

class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {resolve: (m: CdpMessage) => void; timer: ReturnType<typeof setTimeout>}
  >();
  readonly attached: Array<{sessionId: string; info: Record<string, unknown>}> =
    [];
  private readonly sinks = new Map<string, number>();

  private constructor(private readonly ws: MinimalWebSocket) {
    ws.onmessage = ev => this.onMessage(String(ev.data));
  }

  static open(url: string, timeoutMs: number): Promise<CdpConnection> {
    const Ctor = (globalThis as unknown as {WebSocket?: WebSocketCtor})
      .WebSocket;
    if (Ctor == null) {
      return Promise.reject(
        new Error(
          'this Node has no global WebSocket (needs Node >= 22); use the leak-hunt worker_capture.py script instead',
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const ws = new Ctor(url);
      const timer = setTimeout(
        () => reject(new Error(`CDP connect timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`CDP connection to ${url} failed`));
      };
    });
  }

  private onMessage(raw: string): void {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
      const fd = this.sinks.get(msg.sessionId ?? '');
      if (fd != null) fs.writeSync(fd, String(msg.params?.chunk ?? ''));
      return;
    }
    if (msg.method === 'Target.attachedToTarget') {
      const p = msg.params as {
        sessionId: string;
        targetInfo: Record<string, unknown>;
      };
      this.attached.push({sessionId: p.sessionId, info: p.targetInfo});
      return;
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (p != null) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
    }
  }

  call(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | null,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        timer,
        resolve: m =>
          m.error != null
            ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`))
            : resolve(m.result ?? {}),
      });
      const msg: CdpMessage & {params: Record<string, unknown>} = {
        id,
        method,
        params,
      };
      if (sessionId != null) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }

  async snapshot(
    sessionId: string | null,
    file: string,
    timeoutMs: number,
  ): Promise<number> {
    await this.call('HeapProfiler.enable', {}, sessionId, 20_000);
    await this.call('HeapProfiler.collectGarbage', {}, sessionId, 60_000);
    const tmp = `${file}.part`;
    const fd = fs.openSync(tmp, 'w');
    this.sinks.set(sessionId ?? '', fd);
    try {
      await this.call(
        'HeapProfiler.takeHeapSnapshot',
        {reportProgress: false, captureNumericValue: false},
        sessionId,
        timeoutMs,
      );
    } finally {
      this.sinks.delete(sessionId ?? '');
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return fs.statSync(file).size;
  }

  close(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.ws.close();
  }
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'target';
}

/** Capture the page and/or its workers; never throws for one worker. */
export async function captureLive(opts: CaptureOptions): Promise<CaptureRow[]> {
  const endpoint = `http://127.0.0.1:${opts.port}/json`;
  const hint = `is Chrome running with --remote-debugging-port=${opts.port}?`;
  let res: Response;
  try {
    res = await fetch(endpoint);
  } catch (err) {
    throw new Error(`${endpoint} is unreachable (${String(err)}); ${hint}`);
  }
  const body: unknown = res.ok ? await res.json() : null;
  if (!Array.isArray(body)) {
    throw new Error(
      `${endpoint} did not return a target list (HTTP ${res.status}); ${hint}`,
    );
  }
  const targets = body as Array<Record<string, string>>;
  const pages = targets.filter(
    t => t.type === 'page' && (t.url ?? '').includes(opts.urlFilter),
  );
  if (pages.length === 0) {
    throw new Error(
      `no page target matching "${opts.urlFilter}" on port ${opts.port}`,
    );
  }
  fs.mkdirSync(opts.outDir, {recursive: true});
  const stamp = Date.now();
  const conn = await CdpConnection.open(
    pages[0].webSocketDebuggerUrl,
    opts.callTimeoutMs,
  );
  const rows: CaptureRow[] = [];
  try {
    if (opts.target !== 'workers') {
      const file = path.join(opts.outDir, `page-${stamp}.heapsnapshot`);
      const bytes = await conn.snapshot(null, file, opts.snapshotTimeoutMs);
      rows.push({
        target: 'page',
        title: pages[0].title ?? pages[0].url ?? 'page',
        usedMB: null,
        status: 'ok',
        path: file,
        bytes,
      });
    }
    if (opts.target !== 'page') {
      await conn.call(
        'Target.setAutoAttach',
        {autoAttach: true, waitForDebuggerOnStart: false, flatten: true},
        null,
        opts.callTimeoutMs,
      );
      await new Promise(r => setTimeout(r, 1500));
      for (const {sessionId, info} of conn.attached) {
        if (info.type !== 'worker') continue;
        const title = String(info.title || info.url || 'worker');
        const row: CaptureRow = {
          target: 'worker',
          title,
          usedMB: null,
          status: 'ok',
          path: null,
          bytes: 0,
        };
        try {
          const usage = await conn.call(
            'Runtime.getHeapUsage',
            {},
            sessionId,
            opts.callTimeoutMs,
          );
          row.usedMB = Math.round(Number(usage.usedSize ?? 0) / 1e5) / 10;
        } catch (err) {
          row.status = `unresponsive (${String(err).slice(0, 60)})`;
          rows.push(row);
          continue;
        }
        if (title.includes(opts.titleFilter)) {
          const id = String(info.targetId ?? '').slice(0, 8);
          const file = path.join(
            opts.outDir,
            `worker_${safeName(title)}_${id}-${stamp}.heapsnapshot`,
          );
          try {
            row.bytes = await conn.snapshot(
              sessionId,
              file,
              opts.snapshotTimeoutMs,
            );
            row.path = file;
          } catch (err) {
            row.status = `snapshot failed (${String(err).slice(0, 60)})`;
          }
        }
        rows.push(row);
      }
    }
  } finally {
    conn.close();
  }
  return rows;
}

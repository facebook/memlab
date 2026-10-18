/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode} from '@memlab/core';
import {z} from 'zod';
import {computeHeapBudget} from '../heap-budget.js';
import {realmKind} from '../realm.js';
import {withSnapshotAt} from '../snapshot-borrow.js';
import {resolveSnapshotPath} from './load-snapshot.js';
import {errorResult, formatBytes, markdownTable, toolResult} from '../utils.js';

const SHARED_NAMES = new Set([
  'system / CppGCManaged (WasmNativeModule)',
  'SharedArrayBuffer',
]);

// Below this a shared buffer is noise (message channels, flags), not memory.
const MIN_SHARED_BYTES = 64 * 1024;

interface RealmRow {
  label: string;
  kind: string;
  app: number;
  bundle: number;
  code: number;
  devOnly: number;
  shared: Array<{sig: string; bytes: number}>;
}

export function registerRealmSummary(server: McpServer): void {
  server.tool(
    'memlab_realm_summary',
    'Compare the heaps of several REALMS captured at the same moment — a page plus its dedicated workers (memlab_capture writes them) — as one table: per realm, app memory, bundle text, loaded code and dev-only bytes, plus the WebAssembly modules and SharedArrayBuffers it holds. ' +
      'Shared memory is counted ONCE: every thread of a Wasm thread pool reports the same compiled module and the same SharedArrayBuffer (measured on one app: 10 pool workers each reported the same 11.8 MB module and 10 MB buffer), so a naive sum overstates the app by the pool size times the shared bytes. ' +
      'Each path is loaded transiently, one at a time.',
    {
      paths: z
        .array(z.string())
        .min(1)
        .describe(
          'Snapshot paths, one per realm (page first is conventional).',
        ),
    },
    async ({paths}) => {
      try {
        const rows: RealmRow[] = [];
        for (const p of paths) {
          const local = resolveSnapshotPath(p).localPath;
          const row = await withSnapshotAt<RealmRow>(local, snapshot => {
            const b = computeHeapBudget(snapshot);
            const shared: Array<{sig: string; bytes: number}> = [];
            snapshot.nodes.forEach((n: IHeapNode) => {
              if (!SHARED_NAMES.has(n.name)) return;
              const bytes = n.retainedSize;
              if (bytes < MIN_SHARED_BYTES) return;
              // Retained sizes of the same module differ by a few bytes between
              // realms (per-isolate wrappers), so the signature is rounded.
              const bucket = Math.round(bytes / MIN_SHARED_BYTES);
              shared.push({sig: `${n.name}:${bucket}`, bytes});
            });
            return {
              label: p.replace(/^.*\//, ''),
              kind: realmKind(snapshot),
              app: b.app,
              bundle: b.bundle,
              code: b.code,
              devOnly: b.devOnly,
              shared,
            };
          });
          rows.push(row);
        }
        // A shared object is counted in the first realm that reports it.
        const seen = new Map<string, number>();
        let duplicateBytes = 0;
        for (const r of rows) {
          for (const s of r.shared) {
            const n = seen.get(s.sig) ?? 0;
            if (n > 0) duplicateBytes += s.bytes;
            seen.set(s.sig, n + 1);
          }
        }
        const sum = (f: (r: RealmRow) => number): number =>
          rows.reduce((acc, r) => acc + f(r), 0);
        const appTotal = sum(r => r.app);
        const lines = [
          `## Realm summary — ${rows.length} realm(s)`,
          '',
          markdownTable(
            [
              'Realm',
              'Kind',
              'App',
              'Bundle',
              'Code',
              'Dev-only',
              'Wasm / SAB held',
            ],
            rows.map(r => [
              r.label.length > 60 ? `${r.label.slice(0, 57)}…` : r.label,
              r.kind,
              formatBytes(r.app),
              formatBytes(r.bundle),
              formatBytes(r.code),
              formatBytes(r.devOnly),
              r.shared.length > 0
                ? formatBytes(r.shared.reduce((a, s) => a + s.bytes, 0))
                : '—',
            ]),
            new Set([2, 3, 4, 5, 6]),
          ),
          '',
          `**App memory across realms: ${formatBytes(appTotal - duplicateBytes)}** ` +
            `(naive sum ${formatBytes(appTotal)}; ${formatBytes(duplicateBytes)} of WebAssembly modules / SharedArrayBuffers reported by more than one realm counted once).`,
          `Bundle text ${formatBytes(sum(r => r.bundle))} and loaded code ${formatBytes(sum(r => r.code))} are per realm: each worker loads its own copy.`,
        ];
        const multi = [...seen.entries()].filter(([, n]) => n > 1);
        if (multi.length > 0) {
          lines.push(
            '',
            'Shared across realms: ' +
              multi
                .map(([sig, n]) => {
                  const name = sig.slice(0, sig.lastIndexOf(':'));
                  const bytes =
                    Number(sig.slice(sig.lastIndexOf(':') + 1)) *
                    MIN_SHARED_BYTES;
                  return `${name.replace('system / CppGCManaged ', '')} ~${formatBytes(bytes)} ×${n}`;
                })
                .join('; '),
          );
        }
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

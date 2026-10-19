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
import {sizeInput, withSizeHint} from '../byte-size.js';
import {attributeByShortestPath} from '../heap-families.js';
import {moduleRecords} from '../module-registry.js';
import {withSnapshotAt} from '../snapshot-borrow.js';
import {moduleRegistryIds, registryTableBytes} from './framework-buffers.js';
import {resolveSnapshotPath} from './load-snapshot.js';
import {realmKind} from '../realm.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

const REGISTRY_ROW = '(module registry table)';

interface RealmModules {
  label: string;
  kind: string;
  loaded: Set<string>;
  bytes: Map<string, number>;
}

function realmLabel(path: string): string {
  return path
    .replace(/^.*\//, '')
    .replace(/\.heapsnapshot$/, '')
    .replace(/^worker_/, '')
    .replace(/_[0-9A-F]{8}$/, '')
    .replace(/-x\d+$/, '');
}

export function registerRealmDuplication(server: McpServer): void {
  server.tool(
    'memlab_realm_duplication',
    'Find what is loaded TWICE across realms: given a page snapshot and its worker snapshots (memlab_capture writes them), list every module present in more than one realm with its state bytes in each realm, and the bytes that would go away if only the largest copy remained. ' +
      "State bytes per module come from the shortest-retainer-path partition (each object credited to the first module record on its shortest path), so the per-realm numbers add up and survive minification. Each realm's module registry table is reported as its own row. " +
      'Also counts modules whose CODE is loaded in several realms even when they hold no state. Each path is loaded transiently, one at a time.',
    {
      paths: z
        .array(z.string())
        .min(2)
        .describe(
          'Snapshot paths, one per realm (page first is conventional).',
        ),
      min_bytes: sizeInput()
        .optional()
        .default(16 * 1024)
        .describe(
          withSizeHint(
            'Hide modules whose duplicated bytes are below this (default 16 KB).',
          ),
        ),
      limit: z
        .number()
        .int()
        .optional()
        .default(30)
        .describe('Modules to show (default 30).'),
    },
    async ({paths, min_bytes, limit}) => {
      try {
        const realms: RealmModules[] = [];
        // One unreadable realm costs its own row, not the whole report.
        const failed: string[] = [];
        for (const p of paths) {
          let realm: RealmModules;
          try {
            const local = resolveSnapshotPath(p).localPath;
            realm = await withSnapshotAt<RealmModules>(local, snapshot => {
              const loaded = new Set(moduleRecords(snapshot).keys());
              const bytes = new Map<string, number>();
              for (const [mod, row] of attributeByShortestPath(snapshot)
                .byModule) {
                bytes.set(mod, row.bytes);
              }
              let table = 0;
              for (const id of moduleRegistryIds(snapshot)) {
                const reg: IHeapNode | null = snapshot.getNodeById(id);
                if (reg != null) table += registryTableBytes(reg);
              }
              if (table > 0) {
                loaded.add(REGISTRY_ROW);
                bytes.set(REGISTRY_ROW, table);
              }
              return {
                label: realmLabel(p),
                kind: realmKind(snapshot),
                loaded,
                bytes,
              };
            });
          } catch (err) {
            failed.push(
              `${p}: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
          // Two captures can shorten to the same label; keep rows distinct.
          const clash = realms.filter(r => r.label === realm.label).length;
          if (clash > 0) realm.label = `${realm.label} #${clash + 1}`;
          realms.push(realm);
        }
        if (realms.length < 2) {
          throw new Error(
            `need at least two loadable realms; ${failed.length} failed:\n${failed.join('\n')}`,
          );
        }
        const realmsOf = new Map<string, number[]>();
        realms.forEach((r, i) => {
          for (const m of r.loaded) {
            let list = realmsOf.get(m);
            if (list == null) {
              list = [];
              realmsOf.set(m, list);
            }
            list.push(i);
          }
        });
        const multi = [...realmsOf.entries()].filter(([, l]) => l.length > 1);
        const rows = multi
          .map(([mod, idx]) => {
            const per = idx.map(i => ({
              i,
              bytes: realms[i].bytes.get(mod) ?? 0,
            }));
            const total = per.reduce((s, x) => s + x.bytes, 0);
            const max = Math.max(...per.map(x => x.bytes));
            return {mod, per, total, duplicated: total - max};
          })
          .filter(r => r.duplicated > 0)
          .sort((a, b) => b.duplicated - a.duplicated);
        const duplicatedTotal = rows.reduce((s, r) => s + r.duplicated, 0);
        const shown = rows
          .filter(r => r.duplicated >= min_bytes)
          .slice(0, limit);
        const lines = [
          `## Cross-realm duplication — ${realms.length} realms`,
          '',
          markdownTable(
            ['Realm', 'Kind', 'Modules loaded', 'Also loaded elsewhere'],
            realms.map((r, i) => [
              r.label,
              r.kind,
              formatNumber(r.loaded.size),
              formatNumber(
                [...r.loaded].filter(m =>
                  (realmsOf.get(m) ?? []).some(j => j !== i),
                ).length,
              ),
            ]),
            new Set([2, 3]),
          ),
          '',
          `**${formatNumber(multi.length)} module(s) are loaded in more than one realm; ${formatNumber(rows.length)} of them hold state in more than one, ${formatBytes(duplicatedTotal)} duplicated** (the sum over those modules of all copies but the largest; the rest duplicate code only).`,
          '',
        ];
        if (shown.length === 0) {
          lines.push(
            `_No module duplicates at least ${formatBytes(min_bytes)}._`,
          );
        } else {
          lines.push(
            markdownTable(
              ['Module', 'Realms', 'Bytes per realm', 'Total', 'Duplicated'],
              shown.map(r => [
                r.mod.length > 50 ? `${r.mod.slice(0, 47)}…` : r.mod,
                String(r.per.length),
                r.per
                  .map(x => `${realms[x.i].label} ${formatBytes(x.bytes)}`)
                  .join(', '),
                formatBytes(r.total),
                formatBytes(r.duplicated),
              ]),
              new Set([1, 3, 4]),
            ),
          );
        }
        lines.push(
          '',
          ...(failed.length > 0
            ? [
                `⚠ Not loaded (left out of every figure): ${failed.join('; ')}`,
                '',
              ]
            : []),
          '_A module in several realms is a separate copy in each isolate; workers do not share heap state. Loaded code and bundle text are per realm too (see memlab_realm_summary)._',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

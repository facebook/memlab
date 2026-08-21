/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * Retained JS SOURCE TEXT — the largest single line item in a browser heap and,
 * until now, the one with no tool.
 *
 * V8 keeps a script's source alive as an external string for as long as any
 * function compiled from it is reachable, so source text is not overhead you can
 * ignore: measured across one 20-round sweep it was 46-60% of the heap in every
 * single round.
 *
 * The finding that motivated this: the two largest strings in one capture were
 * the SAME package set, fetched twice — once at page load and once again
 * mid-session — with both copies retained, for ~74 MB (15% of that heap). No
 * existing tool could see it:
 *
 *   - `memlab_duplicated_strings` matches EXACTLY, and the two copies differed
 *     by 74 bytes of header, so it reported ~nothing.
 *   - `memlab_intern_opportunities` groups by property + parent shape; script
 *     source is not a property value.
 *   - `memlab_largest_objects` shows the two strings but not that they are the
 *     same bundle, because the distinguishing part is a 200-char comment header.
 *
 * So the grouping key here is the PACKAGE LIST parsed out of the header comment,
 * not the bytes. Two builds of the same package set are near-duplicates by
 * construction and byte-equality is the wrong test.
 */

// `/*<ts>,,<hash-or-"no">,<ms>,HYP:<pkg-list>*/` — the wrapper Meta's JS
// packager emits at the top of every served bundle. Parsed defensively: an
// unrecognised header degrades to "no header", never to a throw.
const HEADER_RE = /^\/\*(\d+),,([^,]*),(\d+)ms,([^*]*)\*\//;

interface ScriptInfo {
  id: number;
  bytes: number;
  timestamp: string | null;
  loadMs: number | null;
  packageKey: string | null;
  headerPreview: string;
}

function parseHeader(text: string): {
  timestamp: string | null;
  loadMs: number | null;
  packageKey: string | null;
} {
  const m = HEADER_RE.exec(text);
  if (!m) return {timestamp: null, loadMs: null, packageKey: null};
  const [, ts, , ms, tail] = m;
  // The package list is the stable identity of a bundle; the revision hash and
  // the timing in the header are not. Normalise to the sorted set of `pkg:` ids
  // so a re-fetch of the same set groups with the original however the packager
  // ordered or re-hashed it.
  const pkgs = [...tail.matchAll(/pkg:([a-z0-9]+)/gi)].map(x => x[1]);
  const key =
    pkgs.length > 0
      ? [...new Set(pkgs)].sort().join(',')
      : tail.trim().slice(0, 120) || null;
  return {timestamp: ts, loadMs: Number(ms), packageKey: key};
}

export function registerScriptCensus(server: McpServer): void {
  server.tool(
    'memlab_script_census',
    'Census the retained JS SOURCE TEXT in the heap, and flag the same bundle being retained more than once. ' +
      'Source text is routinely 46-60% of a browser heap — the single largest line item — and no other tool reports it: memlab_duplicated_strings matches byte-exactly (two builds of one bundle differ in their header and do not match), memlab_intern_opportunities only groups property values, and memlab_largest_objects shows the strings without showing that two of them are the same package set. ' +
      'Scripts are grouped by the PACKAGE LIST parsed from the packager header comment, not by bytes, because a re-fetch of the same package set is a near-duplicate by construction. A group with more than one member is a superseded copy still being retained — measured once at ~74 MB, 15% of that heap. ' +
      'Reports total source bytes, share of heap, and reclaimable bytes if superseded copies were released.',
    {
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum individual scripts to list (default 20).'),
      min_size: z
        .number()
        .optional()
        .default(65536)
        .describe(
          'Ignore script sources smaller than this many bytes (default 64 KB).',
        ),
    },
    async ({limit, min_size}) => {
      try {
        const snapshot = getSnapshot();
        if (!snapshot) {
          return errorResult(
            'No heap snapshot loaded. Use memlab_load_snapshot first.',
          );
        }
        const scripts: ScriptInfo[] = [];
        let totalHeap = 0;
        let totalSource = 0;
        snapshot.nodes.forEach((node: IHeapNode) => {
          totalHeap += node.self_size;
          if (node.name !== 'system / ExternalStringData') return;
          totalSource += node.self_size;
          if (node.self_size < min_size) return;
          // The owning string node carries the text; the ExternalStringData node
          // carries the bytes.
          let text = '';
          for (const edge of node.referrers) {
            const from = edge.fromNode;
            if (from != null && from.isString) {
              text = from.name ?? '';
              if (text.length > 0) break;
            }
          }
          const h = parseHeader(text);
          scripts.push({
            id: node.id,
            bytes: node.self_size,
            timestamp: h.timestamp,
            loadMs: h.loadMs,
            packageKey: h.packageKey,
            headerPreview: text.slice(0, 96),
          });
        });
        scripts.sort((a, b) => b.bytes - a.bytes);

        const lines: string[] = [
          '## Script source census',
          '',
          `Retained JS source (\`system / ExternalStringData\`): **${formatBytes(totalSource)}**` +
            (totalHeap > 0
              ? ` — **${((totalSource / totalHeap) * 100).toFixed(1)}% of the ${formatBytes(totalHeap)} heap**`
              : ''),
          `Scripts at or above ${formatBytes(min_size)}: ${formatNumber(scripts.length)}`,
          '',
        ];

        // Duplicate / superseded detection.
        const groups = new Map<string, ScriptInfo[]>();
        for (const s of scripts) {
          if (s.packageKey == null) continue;
          const g = groups.get(s.packageKey);
          if (g) g.push(s);
          else groups.set(s.packageKey, [s]);
        }
        const dupGroups = [...groups.values()]
          .filter(g => g.length > 1)
          .sort(
            (a, b) =>
              b.reduce((n, s) => n + s.bytes, 0) -
              a.reduce((n, s) => n + s.bytes, 0),
          );
        let reclaimable = 0;
        for (const g of dupGroups) {
          const sorted = [...g].sort((a, b) => b.bytes - a.bytes);
          // Keep the largest; every other copy of the same package set is a
          // superseded retention.
          for (const s of sorted.slice(1)) reclaimable += s.bytes;
        }

        if (dupGroups.length > 0) {
          lines.push(
            `### ⚠ ${formatNumber(dupGroups.length)} package set(s) retained MORE THAN ONCE — **${formatBytes(reclaimable)} reclaimable**`,
            '',
          );
          for (const g of dupGroups.slice(0, 8)) {
            const sorted = [...g].sort((a, b) => b.bytes - a.bytes);
            lines.push(
              `**${sorted.length} copies of package set \`${sorted[0].packageKey?.slice(0, 72)}\`** — ${formatBytes(sorted.reduce((n, s) => n + s.bytes, 0))} total:`,
            );
            for (const s of sorted) {
              lines.push(
                `- \`@${s.id}\` ${formatBytes(s.bytes)}` +
                  (s.timestamp != null
                    ? ` · loaded at ts \`${s.timestamp}\``
                    : '') +
                  (s.loadMs != null ? ` in ${formatNumber(s.loadMs)}ms` : '') +
                  (s.loadMs != null && s.loadMs < 2000
                    ? ' (warm — a re-fetch)'
                    : ''),
              );
            }
            lines.push('');
          }
          lines.push(
            "_Same package set, different load. V8 keeps a script's source alive while any function compiled from it is reachable, so two script objects for one package set cost two full copies. Sizes differing by a few dozen bytes is the normal shape here (a header/revision delta), which is exactly why a byte-exact duplicate scan does not find this._",
            '',
          );
        } else {
          lines.push('_No package set is retained more than once._', '');
        }

        const headers = ['Node', 'Bytes', 'Loaded (ms)', 'Header'];
        lines.push(
          '### Largest retained sources',
          markdownTable(
            headers,
            scripts
              .slice(0, limit)
              .map(s => [
                `@${s.id}`,
                formatBytes(s.bytes),
                s.loadMs != null ? formatNumber(s.loadMs) : '—',
                s.headerPreview.replace(/\|/g, '\\|') || '(no packager header)',
              ]),
            new Set([1, 2]),
          ),
        );
        lines.push(
          '',
          '_Source text is not an application leak and usually cannot be trimmed by application code — but it IS the denominator. Quote the non-source remainder alongside any heap total, or the number misleads._',
        );
        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(
          `Failed to census scripts: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}

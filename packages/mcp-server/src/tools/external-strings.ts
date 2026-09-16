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
import {getSnapshot} from '../heap-state.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * V8 stores the character data of an external string outside the JS heap and
 * points at it from a `system / ExternalStringData` node. For a web app the
 * overwhelming majority of that is SOURCE TEXT — script and stylesheet bodies
 * the engine keeps for lazy compilation and `Function.prototype.toString`.
 */
const EXTERNAL_STRING_CLASS = 'system / ExternalStringData';

/**
 * Markers that identify which resource a blob of source text came from.
 *
 * Ordered most-specific first. The module-registry marker is the useful one on
 * a Meta web app: every bundle chunk is a run of `__d("ModuleName",…)` calls,
 * so the first few module names in a blob name the chunk far more usefully
 * than its byte count does.
 */
const SOURCE_MARKERS: Array<{name: string; re: RegExp}> = [
  {name: 'haste module registry', re: /__d\(\s*["']([A-Za-z0-9_.$-]+)["']/},
  {name: 'webpack chunk', re: /webpackJsonp|__webpack_require__/},
  // Stops at the `*/` that closes the comment, not at any `*`: a map URL may
  // legitimately contain one, and `[^\s*]+` truncated the label there.
  {name: 'sourceMappingURL', re: /sourceMappingURL=(\S+?)(?=\*\/|\s|$)/},
  {name: 'CSS stylesheet', re: /^\s*(?:@charset|@media|\.[a-zA-Z0-9_-]+\s*\{)/},
  {name: 'JSON payload', re: /^\s*[[{]/},
];

interface ExternalStringBlob {
  id: number;
  bytes: number;
  kind: string;
  label: string;
}

/** Best-effort: the string node that owns this backing store. */
function owningString(node: IHeapNode): IHeapNode | null {
  // The first referrer is captured DURING the walk rather than re-derived
  // afterwards. `node.referrers` may be a one-shot iterator, in which case a
  // second `[Symbol.iterator]()` yields nothing because the loop above already
  // consumed it — so the fallback silently returned null for exactly the
  // inputs it exists to serve.
  let first: IHeapNode | null = null;
  for (const e of node.referrers) {
    const from = e.fromNode;
    if (from.type === 'string' || from.type === 'concatenated string') {
      return from;
    }
    first ??= from;
  }
  return first;
}

function classify(text: string): {kind: string; label: string} {
  for (const m of SOURCE_MARKERS) {
    const hit = m.re.exec(text);
    if (hit != null) {
      return {kind: m.name, label: hit[1] != null ? hit[1] : ''};
    }
  }
  return {kind: 'unclassified', label: ''};
}

/** First N distinct Haste module names in a chunk — what the chunk actually is. */
function moduleNames(text: string, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /__d\(\s*["']([A-Za-z0-9_.$-]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) != null && out.length < max) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}

export function registerExternalStrings(server: McpServer): void {
  server.tool(
    'memlab_external_strings',
    'Attribute `system / ExternalStringData` — the LARGEST class in a typical web-app heap, and the one a retainer trace cannot explain. ' +
      'On a measured Ads Manager capture it was 183.7 MB across 5,797 objects (38% of heap), of which ~284 carried essentially all of it: ' +
      'larger than the CSSOM, larger than the Relay store, larger than every leak in that app combined. ' +
      '`memlab_retainer_trace` returns nothing useful for these because the character data hangs off Blink rather than off a JS object, ' +
      'so the usual "who holds this?" question has no answer and the biggest thing in the heap stays unattributed.\n\n' +
      'This reads the string CONTENT instead of the reference graph and names the resource: for Meta web bundles it reports the first Haste ' +
      'module names in each chunk (`__d("ModuleName",…)`), so "load less JS" becomes a ranked list of modules rather than a slogan. ' +
      'Nothing here is a leak — this is standing cost, and it is the structural baseline every leak number should be quoted against.',
    {
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Largest blobs to list individually (default 20).'),
      min_bytes: z
        .number()
        .optional()
        .default(64 * 1024)
        .describe(
          'Only list blobs at least this large (default 65536). The long tail is thousands of sub-KB strings that carry almost none of the total.',
        ),
      modules_per_blob: z
        .number()
        .optional()
        .default(4)
        .describe('How many Haste module names to name per chunk (default 4).'),
      sample_chars: z
        .number()
        .optional()
        .default(4096)
        .describe(
          'How many leading characters of each blob to read when classifying (default 4096). Reading the whole of a multi-megabyte string is what makes this slow.',
        ),
    },
    async ({limit, min_bytes, modules_per_blob, sample_chars}) => {
      try {
        const snapshot = getSnapshot();
        const blobs: ExternalStringBlob[] = [];
        const buckets = new Map<string, {count: number; bytes: number}>();
        let total = 0;
        let count = 0;

        snapshot.nodes.forEach(node => {
          if (node.name !== EXTERNAL_STRING_CLASS) return;
          count++;
          total += node.self_size;
          const kb = node.self_size / 1024;
          const bucket =
            kb < 1
              ? '<1 KB'
              : kb < 16
                ? '1–16 KB'
                : kb < 128
                  ? '16–128 KB'
                  : kb < 1024
                    ? '128 KB–1 MB'
                    : '>1 MB';
          const b = buckets.get(bucket) ?? {count: 0, bytes: 0};
          b.count++;
          b.bytes += node.self_size;
          buckets.set(bucket, b);
          if (node.self_size < min_bytes) return;

          const holder = owningString(node);
          let text = '';
          try {
            const raw = (
              holder as {toStringNode?: () => {stringValue?: string}}
            )?.toStringNode?.()?.stringValue;
            text = typeof raw === 'string' ? raw.slice(0, sample_chars) : '';
          } catch {
            text = '';
          }
          const {kind, label} = classify(text);
          const mods = moduleNames(text, modules_per_blob);
          blobs.push({
            id: node.id,
            bytes: node.self_size,
            kind,
            label: mods.length > 0 ? mods.join(', ') : label,
          });
        });

        if (count === 0) {
          return toolResult(
            'No `system / ExternalStringData` in this snapshot. Node.js captures often have none; this is a browser-heap concern.',
          );
        }

        blobs.sort((a, b) => b.bytes - a.bytes);
        const listed = blobs.slice(0, limit);
        const listedBytes = listed.reduce((s, b) => s + b.bytes, 0);

        const lines = [
          '## External string data (source text)',
          '',
          `**${formatNumber(count)} objects, ${formatBytes(total)} total.** ` +
            `${formatNumber(blobs.length)} are at least ${formatBytes(min_bytes)}, ` +
            `and the ${formatNumber(listed.length)} listed below carry ${formatBytes(listedBytes)} ` +
            `(${((listedBytes / Math.max(1, total)) * 100).toFixed(1)}% of the total).`,
          '',
          markdownTable(
            ['Size band', 'Objects', 'Bytes'],
            [...buckets.entries()]
              .sort((a, b) => b[1].bytes - a[1].bytes)
              .map(([k, v]) => [
                k,
                formatNumber(v.count),
                formatBytes(v.bytes),
              ]),
            new Set([1, 2]),
          ),
          '',
        ];

        if (listed.length > 0) {
          lines.push(
            markdownTable(
              ['Node', 'Bytes', 'Looks like', 'Modules / resource'],
              listed.map(b => [
                `@${b.id}`,
                formatBytes(b.bytes),
                b.kind,
                b.label !== '' ? b.label : '—',
              ]),
              new Set([1]),
            ),
          );
        }

        const unclassified = listed.filter(
          b => b.kind === 'unclassified',
        ).length;
        lines.push(
          '',
          '_This is a STANDING cost, not a leak: it does not grow with interaction. It belongs in the structural baseline — a leak of a few MB quoted against a heap this size reads very differently once the source text is named._',
        );
        if (unclassified > 0) {
          lines.push(
            `_${formatNumber(unclassified)} of the listed blobs could not be classified from their first ${formatNumber(sample_chars)} characters. Raise \`sample_chars\`, or read one directly with \`memlab_get_string\`._`,
          );
        }
        lines.push(
          '',
          '**Next:** the lever is loading less code, not freeing it. Cross-check the named modules against production usage (which modules are shipped but never executed on this surface) before proposing a code-split — a module that is used is not waste, however large.',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

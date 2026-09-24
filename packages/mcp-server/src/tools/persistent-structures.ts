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
 * Find persistent (structurally-shared) data structures and count their
 * retained VERSIONS.
 *
 * This exists because a whole class of leak was invisible to every other tool
 * here. A persistent structure is designed so that keeping an old version is
 * cheap — that is the point of structural sharing — which makes accidentally
 * keeping ALL of them both easy to do and very hard to see: the classes are
 * library internals, and in a minified bundle they are named `_t`, `St`, `Ct`,
 * `jt`. A leak report shows "class St grew by 44,000" and nothing connects
 * that to Immutable.js.
 *
 * Measured on Ads Manager: selector caches retained one Immutable Map version
 * per interaction — 1,540 roots at baseline against 157,306 after 150 cycles,
 * +388 versions/cycle at r2 = 1.0000, surviving idle and GC. It was found only
 * because an operator recognised `{ownerID, keyHash, entry}` by eye. Nothing in
 * the server knew what Immutable.js was.
 *
 * Detection is by SHAPE, not by class name, so it survives minification. Each
 * library contributes a fingerprint; unknown libraries degrade to "not
 * detected" rather than to a wrong answer.
 */

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

interface Fingerprint {
  library: string;
  kind: string;
  /** Own properties every instance of this shape carries. */
  keys: string[];
  /** What a growing count of these MEANS, in one line. */
  meaning: string;
}

/**
 * Shapes are matched on own JS properties, which minifiers do not rename when
 * the library reads them reflectively or ships them as part of its wire format.
 * Immutable's node records are the clearest case: `{ownerID, keyHash, entry}`
 * is stable across every build of it seen so far.
 */
const FINGERPRINTS: Fingerprint[] = [
  {
    library: 'Immutable.js',
    kind: 'Map / Set root',
    keys: ['_root', 'size'],
    meaning:
      'One per VERSION of a map that is still reachable. Every mutation of a persistent map produces a new root; a growing count means old versions are being retained, usually as cache VALUES.',
  },
  {
    library: 'Immutable.js',
    kind: 'List root',
    keys: ['_origin', '_capacity', '_level'],
    meaning:
      'One per retained version of a List. Same mechanism as the Map root above.',
  },
  {
    library: 'Immutable.js',
    kind: 'trie node (ValueNode)',
    keys: ['ownerID', 'keyHash', 'entry'],
    meaning:
      'Interior nodes of the HAMT. These dominate the object count and are the bulk of the bytes; they are a CONSEQUENCE of retained roots, not an independent leak.',
  },
  {
    library: 'Immer',
    kind: 'draft state',
    keys: ['base_', 'copy_', 'draft_'],
    meaning:
      'An Immer draft. A growing count means drafts are not being finalised, or finalised drafts are retained.',
  },
  {
    library: 'RxJS-like',
    kind: 'Subscription',
    keys: ['closed', '_subscriptions'],
    meaning:
      'A subscription object. A growing count of these with `closed` false is the classic never-unsubscribed leak.',
  },
];

export function registerPersistentStructures(server: McpServer): void {
  server.tool(
    'memlab_persistent_structures',
    'Detect persistent / structurally-shared data structures (Immutable.js Maps, Lists and trie nodes; Immer drafts; RxJS-style Subscriptions) and report how many VERSIONS are retained, with dominator-deduped bytes. Use it whenever a leak report shows growth in short minified classes (`_t`, `St`, `Ct`, `jt`) that no retainer trace explains — that is what Immutable internals look like after minification, and no other tool here knows they are a library. A persistent structure makes keeping an old version cheap BY DESIGN, so retaining every version is easy to do and nearly invisible: one measured app held 157,306 Immutable Map versions (from 1,540 at baseline) because a selector cache kept each one as a cache value. Detection is by object SHAPE, so it survives minification; an unrecognised library is reported as not detected rather than guessed at.',
    {
      min_count: z
        .number()
        .optional()
        .default(50)
        .describe(
          'Ignore fingerprints with fewer instances than this (default 50). A handful of Immutable objects is a library being used, not a leak.',
        ),
      sizes: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Compute dominator-deduped retained bytes per fingerprint (default true). Turn it off for a fast count-only pass on a very large heap.',
        ),
    },
    async ({min_count, sizes}) => {
      try {
        const snapshot = getSnapshot();

        // One pass builds a property -> ids index, then every fingerprint is a
        // set intersection over it. The alternative — one full walk per
        // fingerprint — is five walks of a multi-million-node graph and blows
        // the eval budget that the hand-rolled version of this kept hitting.
        const byKey = new Map<string, number[]>();
        const wanted = new Set(FINGERPRINTS.flatMap(f => f.keys));
        snapshot.nodes.forEach(node => {
          if (node.id <= 3 || node.type !== 'object') return;
          for (const e of node.references) {
            if (e.type !== 'property') continue;
            const name = String(e.name_or_index);
            // Skipped for parity with `buildShapeIndex` in eval.ts: every
            // object carries `__proto__`, so a fingerprint that ever names it
            // would match the whole heap here and nothing there.
            if (name === '__proto__') continue;
            if (!wanted.has(name)) continue;
            let a = byKey.get(name);
            if (!a) {
              a = [];
              byKey.set(name, a);
            }
            // An accessor pair emits two edges for one property; a repeated id
            // would over-count the intersection.
            if (a[a.length - 1] !== node.id) a.push(node.id);
          }
        });

        const rows: string[][] = [];
        const detected: Array<{f: Fingerprint; ids: number[]}> = [];
        for (const f of FINGERPRINTS) {
          const lists = f.keys.map(k => byKey.get(k) ?? []);
          if (lists.some(l => l.length === 0)) continue;
          lists.sort((a, b) => a.length - b.length);
          let acc = lists[0];
          for (let i = 1; i < lists.length && acc.length > 0; i++) {
            const other = new Set(lists[i]);
            acc = acc.filter(id => other.has(id));
          }
          if (acc.length < min_count) continue;
          detected.push({f, ids: acc});
        }

        if (detected.length === 0) {
          return toolResult(
            '## Persistent structures\n\n' +
              `No known persistent-structure fingerprint reached ${formatNumber(min_count)} instances in this heap.\n\n` +
              '_That is a negative for the libraries this tool knows (Immutable.js, Immer, ' +
              'RxJS-style subscriptions), not for structural sharing in general. A library ' +
              'whose shape is not listed here is reported as absent — if a leak report shows ' +
              'unexplained growth in short minified classes, inspect one with ' +
              '`memlab_property_names` and add its shape._',
          );
        }

        for (const {f, ids} of detected) {
          let bytes = '—';
          if (sizes) {
            // Dominator-deduped: trie nodes are dominated by their root, so a
            // plain sum double-counts the same bytes under both rows.
            // No guard on ids[0]: `aggregateRetained` already marks the
            // total inexact for any id it cannot resolve. Gating the whole
            // fingerprint on the FIRST id reported 0 bytes for every other id
            // in the set, and reported it as exact.
            const agg = aggregateRetained(snapshot, ids);
            bytes = `${formatBytes(agg.retained)}${agg.exact ? '' : ' (lower bound)'}`;
          }
          rows.push([
            f.library,
            f.kind,
            formatNumber(ids.length),
            bytes,
            f.meaning,
          ]);
        }

        const lines: string[] = ['## Persistent structures', ''];
        lines.push(
          markdownTable(
            [
              'Library',
              'Kind',
              'Instances',
              'Retained',
              'What a rising count means',
            ],
            rows,
          ),
        );
        lines.push('');
        lines.push(
          '**A count is not a leak — a TREND is.** These structures are supposed to exist; ' +
            'the question is whether the number of retained VERSIONS grows with interaction. ' +
            'Measure it across the ladder:',
        );
        lines.push('');
        lines.push(
          '```\nmemlab_ladder_probe({run_dir: "<round>", code:\n' +
            "  \"result = helpers.byShape(['_root', 'size']).length\"})\n```",
        );
        lines.push('');
        lines.push(
          '_Then check it against an IDLE round. A persistent-structure population that is ' +
            'flat with zero interaction and linear with interaction is a per-interaction ' +
            'version leak; one that grows on both is a timer._',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

/**
 * Dominator-deduped retained size for a set of ids.
 *
 * Local rather than shared because the eval helper of the same name is only
 * reachable from inside `memlab_eval`'s sandbox.
 */
function aggregateRetained(
  snapshot: ReturnType<typeof getSnapshot>,
  ids: readonly number[],
): {retained: number; exact: boolean} {
  const set = new Set(ids);
  let total = 0;
  let exact = true;
  for (const id of ids) {
    const node = snapshot.getNodeById(id);
    if (!node) {
      exact = false;
      continue;
    }
    // Skip a node whose dominator is also in the set: its bytes are already
    // counted under that ancestor.
    let dom = node.dominatorNode;
    let dominated = false;
    let hops = 0;
    while (dom && dom.id !== node.id && hops < 500) {
      if (set.has(dom.id)) {
        dominated = true;
        break;
      }
      const next = dom.dominatorNode;
      if (!next || next.id === dom.id) break;
      dom = next;
      hops++;
    }
    if (hops >= 500) exact = false;
    if (!dominated) total += node.retainedSize;
  }
  return {retained: total, exact};
}

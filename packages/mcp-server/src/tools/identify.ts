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
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * Shape fingerprints for structures whose class name is useless in a minified
 * bundle. In a production browser heap almost everything is `t`, `e`, `s` or
 * `Object`, so naming a structure is most of the investigation — and it is
 * knowledge that gets re-derived by hand, one property walk at a time, every
 * time someone opens a snapshot.
 *
 * `required` must all be present; `optional` raises confidence; `absent` rules
 * a candidate out. Fingerprints are deliberately conservative: a wrong name is
 * worse than no name, because it sends the reader to the wrong library.
 */
interface Fingerprint {
  name: string;
  required: string[];
  optional?: string[];
  absent?: string[];
  what: string;
  matters: string;
}

const FINGERPRINTS: Fingerprint[] = [
  {
    name: 'React update-queue record',
    required: ['action', 'next'],
    optional: ['eagerState', 'hasEagerState', 'lane'],
    what: 'One queued useState/useReducer update on a hook, in a circular linked list at `queue.pending`.',
    matters:
      "A record carrying `hasEagerState: true` whose `eagerState` is the queue's current state is a NO-OP update: React took the eager-state bailout, scheduled no render, and nothing ever drains the queue. On a component that never unmounts these accumulate for the lifetime of the tab.",
  },
  {
    name: 'React scheduler task',
    required: ['callback', 'priorityLevel', 'sortIndex'],
    optional: ['expirationTime', 'startTime', 'id'],
    what: "An entry in the `scheduler` package's min-heap task queue.",
    matters:
      'A `callback` of null means the task was cancelled or has already run; the scheduler only drops it when it surfaces at the top of the heap. A deep queue mid-burst is normal — check it again after the app settles before calling it a leak.',
  },
  {
    name: 'React hook state',
    required: ['memoizedState', 'next', 'queue'],
    optional: ['baseQueue', 'baseState'],
    what: "One hook in a fiber's hook list.",
    matters:
      'Counts scale with mounted components. Growth without a matching rise in rendered UI means fibers are being retained after unmount.',
  },
  {
    name: 'Observer/emitter listener record',
    required: ['callback', 'context'],
    absent: ['priorityLevel'],
    what: "A Backbone-style `{callback, context}` pair in an emitter's per-event listener array.",
    matters:
      'Two different leaks share this shape: the same (callback, context) registered repeatedly, and many DISTINCT contexts piling up on one long-lived emitter (a `listenTo` with no `stopListening`). The second produces no duplicates at all — check the per-host distribution, not just duplicate pairs.',
  },
  {
    name: 'LRU list node',
    required: ['key', 'next', 'prev', 'value'],
    what: 'A doubly-linked-list node in an LRU cache (the recency list beside the Map).',
    matters:
      "The node count is the cache's live entry count, so it is the cheapest way to see whether a configured cap is actually binding. `memlab_unit_cost` on this shape gives the per-entry cost a cap is sized against.",
  },
  {
    name: 'Promise-library deferred (Dexie/Bluebird style)',
    required: ['_listeners'],
    optional: ['_PSD', '_state', '_value', 'onuncatched'],
    what: 'A userland promise object with its own listener list and zone/context handle.',
    matters:
      'When the zone handle (`_PSD`) carries a transaction, the promise pins that transaction and everything it holds. Large populations are usually in-flight work — confirm with a post-idle capture (`memlab_settle_check`) before treating them as retention.',
  },
  {
    name: 'Editor history entry (Lexical/ProseMirror style)',
    required: ['editorState'],
    optional: ['undoStack', 'redoStack', 'current'],
    what: 'One immutable editor state snapshot on an undo stack.',
    matters:
      'Undo stacks are usually unbounded unless the host passes a depth limit, and each entry clones the whole document node map. Growth is per keystroke-group, released only when the editor unmounts.',
  },
  {
    name: 'Timer/interval registry entry',
    required: ['callback'],
    optional: ['delay', 'timerId', 'repeat'],
    absent: ['context', 'priorityLevel'],
    what: 'A pending timer record held by a timer wrapper or scheduler shim.',
    matters:
      "Entries that outlive their `clearTimeout`/`clearInterval` keep their callback's entire closure scope alive.",
  },
];

function propsOf(node: IHeapNode, cap = 200): Set<string> {
  const out = new Set<string>();
  let seen = 0;
  for (const edge of node.references) {
    if (edge.type !== 'property') continue;
    out.add(String(edge.name_or_index));
    if (++seen >= cap) break;
  }
  return out;
}

interface Match {
  fp: Fingerprint;
  score: number;
  matchedOptional: string[];
}

function matchFingerprints(props: Set<string>): Match[] {
  const matches: Match[] = [];
  for (const fp of FINGERPRINTS) {
    if (!fp.required.every(p => props.has(p))) continue;
    if (fp.absent?.some(p => props.has(p))) continue;
    const matchedOptional = (fp.optional ?? []).filter(p => props.has(p));
    // Required properties carry the match; optional ones only rank it.
    const score =
      fp.required.length * 2 +
      matchedOptional.length +
      (fp.absent != null ? 0.5 : 0);
    matches.push({fp, score, matchedOptional});
  }
  return matches.sort((a, b) => b.score - a.score);
}

export function registerIdentify(server: McpServer): void {
  server.tool(
    'memlab_identify',
    'Name a minified structure from its property shape. In a production bundle nearly every class is `t`, `e`, `s` or `Object`, so the first — and often longest — step of an investigation is working out what a population actually IS: a listener record, an LRU node, a React update record, an editor-history entry. This matches a node (or a bare shape) against a library of known fingerprints and reports what it is, why it matters, and what to check next.\n\n' +
      'Give it a `node_id`, or a `shape` you already have from `memlab_shape_histogram` / `memlab_find_by_shape`. With `scan: true` it sweeps the whole heap and reports every recognised structure with its population count, which is a fast way to orient in an unfamiliar app.\n\n' +
      'A name here is a strong hypothesis, not proof: shapes collide across libraries, so confirm with a retainer trace before writing it into a report.',
    {
      node_id: z
        .number()
        .optional()
        .describe('Identify this node from its properties.'),
      shape: z
        .array(z.string())
        .optional()
        .describe(
          'Identify a property set directly, e.g. ["callback","context"] — useful with output from memlab_shape_histogram.',
        ),
      scan: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Sweep the whole heap and report every recognised structure with its instance count (default false).',
        ),
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Maximum rows in scan mode (default 15).'),
    },
    async ({node_id, shape, scan, limit}) => {
      try {
        const snapshot = getSnapshot({allowLight: true});

        if (scan) {
          const counts = new Map<string, number>();
          snapshot.nodes.forEach(node => {
            if (node.id <= 3 || node.type !== 'object') return;
            const props = propsOf(node, 40);
            if (props.size === 0) return;
            const best = matchFingerprints(props)[0];
            if (best == null) return;
            counts.set(best.fp.name, (counts.get(best.fp.name) ?? 0) + 1);
          });
          if (counts.size === 0) {
            return toolResult(
              'No known structures recognised in this heap. The fingerprint library covers React internals, observer/emitter listener records, LRU nodes, userland promise deferreds, editor history and timer registries — an app built on other libraries will match none of them, which is a gap in the library rather than a fact about the heap.',
            );
          }
          const rows = [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([name, count]) => {
              const fp = FINGERPRINTS.find(f => f.name === name);
              return [
                name,
                formatNumber(count),
                `{${(fp?.required ?? []).join(', ')}}`,
              ];
            });
          return toolResult(
            [
              '## Recognised structures',
              '',
              markdownTable(
                ['Structure', 'Instances', 'Required shape'],
                rows,
                new Set([1]),
              ),
              '',
              '_Matched on property shape alone. Shapes collide across libraries — confirm a population with `memlab_retainer_trace` before acting on the name. Counts here are of objects whose BEST match is that fingerprint._',
              '',
              'Next: `memlab_unit_cost` for what one of them costs, `memlab_identify({node_id})` for why a specific one matters.',
            ].join('\n'),
          );
        }

        let props: Set<string>;
        let subject: string;
        if (node_id != null) {
          const node = snapshot.getNodeById(node_id);
          if (node == null) {
            return errorResult(
              new Error(
                `Node ${node_id} not found. Node ids are per-capture — check you are on the snapshot the id came from (memlab_snapshots).`,
              ),
            );
          }
          props = propsOf(node);
          subject = `@${node_id} \`${node.name}\` (${node.type})`;
        } else if (shape != null && shape.length > 0) {
          props = new Set(shape);
          subject = `shape \`{${shape.join(', ')}}\``;
        } else {
          return errorResult(
            new Error('Pass node_id or shape (or scan: true).'),
          );
        }

        const matches = matchFingerprints(props);
        if (matches.length === 0) {
          return toolResult(
            [
              `## ${subject}`,
              '',
              `Properties: \`{${[...props].slice(0, 25).join(', ')}}\`${props.size > 25 ? ` … +${props.size - 25}` : ''}`,
              '',
              '**No fingerprint matched.** That is a statement about the library here, not about the object: it covers React internals, observer/emitter listener records, LRU nodes, userland promise deferreds, editor history and timer registries.',
              '',
              'To identify it by hand: `memlab_referrer_summary` (who holds it, which usually names it), `memlab_object_shape` on a few instances (which properties are stable), and `memlab_retainer_trace` (which subsystem it hangs off).',
            ].join('\n'),
          );
        }

        const lines = [`## ${subject}`, ''];
        matches.slice(0, 3).forEach((m, i) => {
          lines.push(
            `### ${i === 0 ? '' : 'Also matches: '}${m.fp.name}${i === 0 && matches.length > 1 ? ' (best match)' : ''}`,
            '',
            `**What it is:** ${m.fp.what}`,
            '',
            `**Why it matters:** ${m.fp.matters}`,
            '',
            `Matched on \`{${m.fp.required.join(', ')}}\`${m.matchedOptional.length > 0 ? ` plus \`${m.matchedOptional.join('`, `')}\`` : ''}.`,
            '',
          );
        });
        if (matches.length > 1) {
          lines.push(
            `_${matches.length} fingerprints matched; shapes collide, so treat the ranking as a hypothesis and confirm with a retainer trace._`,
            '',
          );
        }
        lines.push(
          'Next: `memlab_unit_cost` for the per-instance cost, `memlab_retainer_trace` to confirm the owner.',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

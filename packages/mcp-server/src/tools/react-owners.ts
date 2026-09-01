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
  nearestFiber,
  fiberComponentName,
  isUpdateRecord,
  UPDATE_RECORD_FIELDS,
} from '../react-shapes.js';
import {
  errorResult,
  toolResult,
  formatNumber,
  markdownTable,
  suggestionsSuppressed,
} from '../utils.js';

/** Resolve a population from whichever of the three selectors was given. */
function resolvePopulation(
  snapshot: ReturnType<typeof getSnapshot>,
  nodeIds: number[] | undefined,
  shape: string[] | undefined,
  updateRecords: boolean,
): {nodes: IHeapNode[]; how: string} {
  if (nodeIds != null && nodeIds.length > 0) {
    const nodes: IHeapNode[] = [];
    for (const id of nodeIds) {
      const n = snapshot.getNodeById(id);
      if (n != null) nodes.push(n);
    }
    return {nodes, how: `${formatNumber(nodes.length)} node id(s)`};
  }
  if (updateRecords) {
    const nodes: IHeapNode[] = [];
    snapshot.nodes.forEach(node => {
      if (isUpdateRecord(node)) nodes.push(node);
    });
    return {
      nodes,
      how: `React update records (\`${UPDATE_RECORD_FIELDS.join('`, `')}\`)`,
    };
  }
  const want = new Set(shape ?? []);
  const nodes: IHeapNode[] = [];
  snapshot.nodes.forEach(node => {
    if (node.type !== 'object') return;
    // Collect the NAMES rather than counting edges. A node can carry more than
    // one property edge under the same name, and counting them made `matched`
    // exceed `want.size`, so the strict equality below dropped a node that has
    // every wanted property — the opposite of what the filter is for.
    const matched = new Set<string>();
    for (const edge of node.references) {
      if (edge.type !== 'property') continue;
      const name = String(edge.name_or_index);
      if (want.has(name)) matched.add(name);
      if (matched.size === want.size) break;
    }
    if (matched.size === want.size) nodes.push(node);
  });
  return {nodes, how: `shape \`${[...want].join('`, `')}\``};
}

export function registerReactOwners(server: McpServer): void {
  server.tool(
    'memlab_react_owners',
    'Name the React COMPONENT behind a population of plain `Object`s. Fibers, hooks, update queues and update records are all `Object` in a production bundle, so every class-name heuristic — including memlab_get_referrers and helpers.owner — walks straight past them: on one measured population `owner()` returned `(none)` for 100% of 1,645 records. This walks each node up to its owning fiber (preferring `memoizedState` / `queue` / `baseQueue` / `next`) and resolves `elementType` through all three of its shapes (function closure, host string, and the `render`/`type` indirection memo and forwardRef add), then groups the population by component. Turning "Object grew 13/cycle" into "BaseTooltipSimple, 13 mounted, one record each" is the step that makes a finding filable.',
    {
      node_ids: z
        .array(z.number())
        .optional()
        .describe(
          'Explicit population to attribute. Takes precedence over `shape` and `update_records`.',
        ),
      shape: z
        .array(z.string())
        .optional()
        .describe(
          'Find the population by own-property names, e.g. ["action","lane","next"]. A node matches when it carries ALL of them.',
        ),
      update_records: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Use the built-in React update-record shape instead of `shape` — the eager-bailout leak family. Equivalent to passing that literal, without having to remember it.',
        ),
      max_hops: z
        .number()
        .optional()
        .default(12)
        .describe(
          'How far up the referrer chain to look for a fiber before giving up (default 12).',
        ),
      limit: z
        .number()
        .optional()
        .default(25)
        .describe('Maximum components to report (default 25).'),
    },
    async ({node_ids, shape, update_records, max_hops, limit}) => {
      try {
        const snapshot = getSnapshot();
        if (
          (node_ids == null || node_ids.length === 0) &&
          (shape == null || shape.length === 0) &&
          !update_records
        ) {
          return errorResult(
            'Pass `node_ids`, or `shape` (own-property names), or `update_records: true`.',
          );
        }
        const {nodes, how} = resolvePopulation(
          snapshot,
          node_ids,
          shape,
          update_records ?? false,
        );
        if (nodes.length === 0) {
          return toolResult(
            `No nodes matched ${how}. If you used \`shape\`, check the names with \`memlab_property_names\` — a shape test against a property the bundle renamed silently matches nothing.`,
          );
        }

        interface Bucket {
          component: string;
          records: number;
          fibers: Set<number>;
          exampleRecord: number;
          exampleFiber: number;
        }
        const byComponent = new Map<string, Bucket>();
        let unattributed = 0;

        for (const node of nodes) {
          const fiber = nearestFiber(node, max_hops);
          if (fiber == null) {
            unattributed++;
            continue;
          }
          // An unnamed fiber is still an ANSWER — it groups records that share
          // an owner — so it gets a bucket rather than being discarded.
          const name = fiberComponentName(fiber) ?? `(unnamed fiber)`;
          let bucket = byComponent.get(name);
          if (!bucket) {
            bucket = {
              component: name,
              records: 0,
              fibers: new Set(),
              exampleRecord: node.id,
              exampleFiber: fiber.id,
            };
            byComponent.set(name, bucket);
          }
          bucket.records++;
          bucket.fibers.add(fiber.id);
        }

        const ranked = [...byComponent.values()].sort(
          (a, b) => b.records - a.records,
        );
        const shown = ranked.slice(0, limit);

        const lines: string[] = [
          `## React owners for ${formatNumber(nodes.length)} node(s) — ${how}`,
          '',
          markdownTable(
            [
              'Component',
              'Records',
              'Owning fibers',
              'Records / fiber',
              'Example',
            ],
            shown.map(b => [
              b.component,
              formatNumber(b.records),
              formatNumber(b.fibers.size),
              (b.records / b.fibers.size).toFixed(1),
              `@${b.exampleRecord} → fiber @${b.exampleFiber}`,
            ]),
            new Set([1, 2, 3]),
          ),
          '',
        ];
        if (ranked.length > shown.length) {
          lines.push(
            `_${formatNumber(ranked.length - shown.length)} further component(s) not shown; raise \`limit\`._`,
            '',
          );
        }

        // The ratio is the verdict, and it is the thing most often skipped.
        // One record per mounted owner is a structural baseline, however large
        // the absolute count; many records per owner is accumulation.
        const accumulating = shown.filter(b => b.records / b.fibers.size >= 2);
        lines.push(
          '### Structural or accumulating?',
          '',
          accumulating.length === 0
            ? 'Every component above holds about ONE record per owning fiber. That is a structural baseline — the population scales with how many components are mounted, not with how long the session ran. A growing total with a flat ratio means more mounts, not a leak.'
            : `${accumulating.length} component(s) hold two or more records per owning fiber: ${accumulating
                .map(
                  b =>
                    `**${b.component}** (${(b.records / b.fibers.size).toFixed(1)})`,
                )
                .join(
                  ', ',
                )}. That is accumulation — the owner is collecting records rather than replacing them. Confirm across a ladder before filing: the number that separates a leak from "more hooks mounted" is whether the FIBER count stays flat while the record count grows.`,
          '',
        );

        if (unattributed > 0) {
          lines.push(
            `_${formatNumber(unattributed)} node(s) (${Math.round((unattributed / nodes.length) * 100)}%) reached no fiber within ${max_hops} hops and are not represented above. Raise \`max_hops\`, or check whether they are owned by something that is not React at all._`,
            '',
          );
        }

        if (!suggestionsSuppressed('memlab_react_owners') && shown.length > 0) {
          lines.push(
            '**Suggested next steps**',
            `- \`memlab_chain_walk({start_id: ${shown[0].exampleRecord}, next_edges: ["next"]})\` — how long is this owner's chain, and does it terminate or cycle?`,
            `- \`memlab_population_vs_owners\` — the same structural-vs-accumulating question across the whole heap.`,
            `- \`memlab_verify_fix({metric_kind: "pending_chain"})\` — once you have a before and after ladder.`,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

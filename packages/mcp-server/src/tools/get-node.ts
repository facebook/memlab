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
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  serializeNodeDetail,
  formatBytes,
  formatNumber,
  errorResult,
  textResult,
  toolResult,
} from '../utils.js';

/**
 * Referrer count above which a root-dominated `retained_size` stops being worth
 * quoting.
 *
 * Not a measured threshold, and nothing branches on the analysis because of it —
 * it only decides whether to print a caveat. Two or three referrers can still
 * leave most of a subtree attributed to the node; by a couple of dozen the
 * dominator has essentially always moved to the root and the figure has gone
 * inert. Set where a false caveat costs a line of output and a missing one costs
 * a wrong fix signal.
 */
const INERT_RETAINED_SIZE_REFERRERS = 20;

export function registerGetNode(server: McpServer): void {
  server.tool(
    'memlab_get_node',
    'Look up a heap node by its numeric ID. Returns full details including size, type, detachment status, dominator, location, and string value if applicable.',
    {
      node_id: z.number().describe('The numeric ID of the heap node'),
    },
    async ({node_id}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(`Node with id ${node_id} not found`);
        }
        const d = serializeNodeDetail(node);
        const lines = [
          `**ID:** @${d.id}`,
          `**Name:** ${d.name}`,
          `**Type:** ${d.type}`,
          `**Self Size:** ${formatBytes(d.self_size)}`,
          `**Retained Size:** ${formatBytes(d.retained_size)}`,
          `**Edges Out:** ${formatNumber(d.edge_count)}`,
          `**Referrers:** ${formatNumber(d.referrer_count)}`,
          `**Detached:** ${d.is_detached ? 'Yes' : 'No'}`,
          `**Dominator:** ${d.dominator_id != null ? `@${d.dominator_id}` : 'none'}`,
        ];
        if (d.location) {
          lines.push(
            `**Location:** script ${d.location.script_id}, line ${d.location.line}, col ${d.location.column}`,
          );
        }
        if (d.string_value !== undefined) {
          const val =
            d.string_value.length > 200
              ? d.string_value.slice(0, 200) + '...'
              : d.string_value;
          lines.push(`**String Value:** "${val}"`);
        }
        if (node.name === 'smi number' && node.self_size === 0) {
          lines.push(`**Decoded SMI Value:** ${node.id >> 1}`);
        } else if (node.name === 'heap number') {
          lines.push(
            `**Type:** Heap Number (boxed double — value not stored in snapshot format)`,
          );
        }
        // Keep the caveat AFTER the key/value fields: it is a paragraph, and
        // pushed mid-list it splits the fields around itself.
        //
        // A node with many referrers ends up dominated by a synthetic root, so
        // almost none of the subtree it visibly belongs to is attributed to it.
        // The figure is correct and reads as the cost of the object, which it is
        // not: a leaked `HTMLDocument` with 32,069 referrers reported 65 KB
        // retained while the island around it was 10.5 MB — and it reported the
        // same 65 KB after a fix, because the number cannot move. Quoting it as
        // a fix signal is the specific mistake this warns about.
        //
        // Tested on the dominator's TYPE, not on an id bound. V8 numbers
        // synthetic nodes from its own counter in odd steps and a browser
        // capture has ~32 of them — `(GC roots)` at 3, but `(Internalized
        // strings)` at 5, `(Strong roots)` at 11, and so on. Measured on an
        // 892,922-node capture: 168,408 nodes are dominated by a synthetic node
        // and only 166,284 by one with an id <= 3, so an id bound would silently
        // skip the caveat on ~2,000 nodes — the exact case it exists for.
        const dominator = node.dominatorNode;
        const manyReferrers = d.referrer_count >= INERT_RETAINED_SIZE_REFERRERS;
        if (manyReferrers && dominator != null) {
          if (dominator.type === 'synthetic') {
            lines.push(
              '',
              `⚠ **Retained size is not the cost of this object.** It has ${formatNumber(d.referrer_count)} referrers ` +
                `and is dominated by a GC root (\`${dominator.name || '(root)'}\`), so the dominator tree attributes ` +
                'almost nothing exclusively to it. Do not use this number as a before/after fix signal — it will ' +
                'read the same either way. For what is actually reclaimable, size the whole island: ' +
                '`memlab_detached_dom` (dominator-deduped) or `memlab_island_doors` for what holds it.',
            );
          }
        } else if (manyReferrers) {
          // `dominator_id` is null both for "the root dominates it" and for "no
          // dominator tree on this load". Asserting the first from the second
          // would state as fact something this capture cannot show.
          lines.push(
            '',
            `⚠ **No dominator information for this node**, and it has ${formatNumber(d.referrer_count)} referrers. ` +
              'With many referrers the retained size is usually attributed to a GC root rather than to the ' +
              'object, so the figure above cannot be read as its cost — but that cannot be confirmed here. ' +
              'Reload without `light` if you need it.',
          );
        }
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

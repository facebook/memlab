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
import type {IHeapNode} from '@memlab/core';
import {getSnapshot} from '../heap-state.js';
import {resolveSavedNodeIds} from '../result-handles.js';
import {
  formatBytes,
  formatNumber,
  formatNodeInline,
  markdownTable,
  errorResult,
  textResult,
  toolResult,
} from '../utils.js';

/**
 * Nodes inspected per call.
 *
 * The output is a per-node shape breakdown, so the cap is about the size of the
 * answer, not the cost of producing it.
 */
const MAX_BATCH = 20;

export function registerObjectShape(server: McpServer): void {
  server.tool(
    'memlab_object_shape',
    'Show the shape/structure of one or more heap objects: all named properties with target node types and sizes. Filters out internal/hidden edges to show only user-visible properties. Supports batch inspection via node_ids to compare multiple objects side-by-side in a single call. ' +
      'Accepts a class_name instead of ids: every other tool reports classes by NAME (memlab_class_histogram, memlab_sequence_analysis, memlab_leak_report), so requiring an id here forced a memlab_find_nodes_by_class round-trip — a second whole-heap scan, on a server where loading the snapshot took minutes — just to answer "what shape is this class?".',
    {
      node_id: z
        .number()
        .optional()
        .describe(
          'The numeric ID of a single heap node. Use node_ids for batch inspection.',
        ),
      node_ids: z
        .array(z.number())
        .optional()
        .describe(
          'Array of node IDs to inspect in a single call (batch mode). Returns shape for each node.',
        ),
      from_result: z
        .string()
        .optional()
        .describe(
          `Read the node ids from a result saved by memlab_eval ({save_as} / helpers.save) instead of listing them. Avoids round-tripping a long id list through the transcript. A saved set is normally a whole population, so one larger than ${MAX_BATCH} is sampled rather than rejected: ${MAX_BATCH} ids evenly spaced across the set, reported in the response. Pass node_ids to choose the subset yourself.`,
        ),
      class_name: z
        .string()
        .optional()
        .describe(
          'Inspect instances of this class by NAME instead of by id (exact match on the node name, as reported by memlab_class_histogram / memlab_sequence_analysis). Samples the largest instances by retained size — see sample_count. Ignored when node_id/node_ids is given.',
        ),
      sample_count: z
        .number()
        .optional()
        .default(3)
        .describe(
          'How many instances to sample when class_name is used (default 3, max 20). The largest by retained size, so a shape read from them is representative of the memory rather than of an arbitrary instance.',
        ),
      include_internal: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include internal/hidden edges (default false)'),
      non_null_only: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Only show properties whose target is not null/undefined/false/zero. Useful for reducing noise on objects with many empty fields.',
        ),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe(
          'Maximum number of properties to return per node (default 50)',
        ),
    },
    async ({
      node_id,
      node_ids,
      from_result,
      class_name,
      sample_count,
      include_internal,
      non_null_only,
      limit,
    }) => {
      try {
        const snapshot = getSnapshot();

        const fromSavedSet = node_ids == null && from_result != null;
        let ids: number[] =
          node_ids ??
          (fromSavedSet ? resolveSavedNodeIds(from_result as string) : null) ??
          (node_id != null ? [node_id] : []);
        let sampleNote = '';
        // A saved set is normally a whole population — the point of handing it
        // over by name is that nobody counted it — so meeting the batch cap with
        // "reduce node_ids count" names a parameter the caller did not pass and
        // leaves them nowhere to go. Sample it the way `class_name` already
        // does, evenly rather than head-first so the sample is not all of
        // whatever the producing walk happened to reach first, and say so.
        if (fromSavedSet && ids.length > MAX_BATCH) {
          const total = ids.length;
          // MAX_BATCH points spanning [0, total - 1] inclusive, so the sample
          // ends ON the last id. Dividing by MAX_BATCH instead would stop a
          // whole step short of the tail, and for a set barely over the cap
          // (21 ids) would degenerate to the first 20 — head-first, which is
          // the one thing this sampling exists to avoid.
          const step = (total - 1) / (MAX_BATCH - 1);
          const sampled: number[] = [];
          for (let i = 0; i < MAX_BATCH; i++) {
            sampled.push(ids[Math.round(i * step)]);
          }
          ids = sampled;
          sampleNote =
            `Sampling ${formatNumber(MAX_BATCH)} of the ${formatNumber(total)} node(s) saved as ` +
            `\`${from_result}\`, evenly spaced. Shape is read from the sample; pass \`node_ids\` ` +
            'explicitly to inspect a chosen subset.\n\n';
        }
        if (ids.length === 0 && class_name != null && class_name !== '') {
          // Pick the largest instances by retained size: a shape read from the
          // biggest instances describes where the memory actually is, whereas an
          // arbitrary instance may be an empty or partially-initialized one.
          const want = Math.min(Math.max(1, sample_count), MAX_BATCH);
          const best: IHeapNode[] = [];
          let total = 0;
          snapshot.nodes.forEach(node => {
            if (node.id <= 3) return;
            if (node.name !== class_name) return;
            total++;
            let i = 0;
            while (
              i < best.length &&
              best[i].retainedSize >= node.retainedSize
            ) {
              i++;
            }
            if (i < want) {
              best.splice(i, 0, node);
              if (best.length > want) best.length = want;
            }
          });
          if (total === 0) {
            return errorResult(
              `No nodes named "${class_name}" found. Class names are matched exactly and are case-sensitive; check the spelling against memlab_class_histogram, or use memlab_search_nodes({name_pattern}) for a regex match.`,
            );
          }
          ids = best.map(n => n.id);
          sampleNote = `Sampling ${formatNumber(ids.length)} of ${formatNumber(total)} \`${class_name}\` instance(s), largest by retained size.\n\n`;
        }
        if (ids.length === 0) {
          return errorResult(
            'Provide node_id, node_ids, from_result, or class_name to inspect.',
          );
        }
        if (ids.length > MAX_BATCH) {
          return errorResult(
            `Maximum ${MAX_BATCH} nodes per batch, and ${formatNumber(ids.length)} were given in \`node_ids\`. ` +
              'Pass fewer ids, or save the set and pass `from_result`, which samples it.',
          );
        }

        const userEdgeTypes = new Set([
          'property',
          'element',
          'context',
          'shortcut',
        ]);

        const NULL_NAMES = new Set(['null', 'undefined', 'false', '']);
        // A property whose target carries no real payload: null/undefined/false,
        // the empty string, "0"/"false", Oddballs, or a zero-size hidden node.
        // Used both to drop rows under non_null_only and to summarize the empty
        // bulk on wide objects without dropping anything (Feedback round 5 §11).
        const isEmptyTarget = (target: {
          id: number;
          type: string;
          name: string;
          self_size: number;
          isString: boolean;
          toStringNode: () => {stringValue: string} | null;
        }): boolean => {
          if (target.id <= 3) return true;
          if (target.type === 'hidden' && target.self_size === 0) return true;
          if (NULL_NAMES.has(target.name) && target.self_size === 0)
            return true;
          if (target.name === 'Oddball' || target.name === 'system / Oddball')
            return true;
          if (target.isString) {
            const strNode = target.toStringNode();
            if (strNode) {
              const val = strNode.stringValue;
              if (
                val === '' ||
                val === '0' ||
                val === 'false' ||
                val === 'null' ||
                val === 'undefined'
              )
                return true;
            }
          }
          return false;
        };

        const sections: string[] = [];
        for (const id of ids) {
          const node = snapshot.getNodeById(id);
          if (!node) {
            sections.push(`**@${id}** — not found\n`);
            continue;
          }

          const filteredEdges = node.references
            .filter(edge => {
              if (!include_internal && !userEdgeTypes.has(edge.type))
                return false;
              if (non_null_only && isEmptyTarget(edge.toNode)) return false;
              return true;
            })
            .sort((a, b) => b.toNode.retainedSize - a.toNode.retainedSize)
            .slice(0, limit);

          // Count empty/null/0 fields over all user-visible edges (property +
          // element/context/shortcut) so the footer's denominator matches the
          // rows actually shown in the table (Feedback round 5 §11): a wide
          // inventory object is mostly "" fields.
          const userProps = node.references.filter(e =>
            userEdgeTypes.has(e.type),
          );
          const emptyProps = userProps.filter(e =>
            isEmptyTarget(e.toNode),
          ).length;

          const totalEdges = node.references.length;
          const hiddenCount = include_internal
            ? 0
            : totalEdges -
              node.references.filter(e => userEdgeTypes.has(e.type)).length;

          const lines = [
            `**${formatNodeInline(node.id, node.name, node.type, node.self_size)}** — ${formatNumber(totalEdges)} edges total${hiddenCount > 0 ? `, ${formatNumber(hiddenCount)} internal hidden` : ''}`,
            '',
          ];

          const headers = [
            'Name',
            'Edge Type',
            'Target',
            'Target Type',
            'Retained',
          ];
          const rightCols = new Set([4]);
          const rows = filteredEdges.map(edge => {
            const target = edge.toNode;
            let targetLabel = `@${target.id} ${target.name}`;
            if (target.isString) {
              const strNode = target.toStringNode();
              if (strNode) {
                const val = strNode.stringValue;
                targetLabel = `@${target.id} "${val.length > 60 ? val.slice(0, 60) + '...' : val}"`;
              }
            } else if (target.name === 'smi number' && target.self_size === 0) {
              // Decoded SMI value (id >> 1). Include the node id so it can be
              // passed to memlab_get_value if needed (Feedback §1c).
              targetLabel = `${target.id >> 1} (smi int, @${target.id})`;
            } else if (target.name === 'heap number') {
              targetLabel = `@${target.id} (heap number)`;
            }
            return [
              String(edge.name_or_index),
              edge.type,
              targetLabel,
              target.type,
              formatBytes(target.retainedSize),
            ];
          });
          lines.push(markdownTable(headers, rows, rightCols));
          if (emptyProps > 0 && userProps.length >= 8) {
            lines.push(
              '',
              `_${emptyProps} of ${userProps.length} fields are empty/null/0${non_null_only ? ' (hidden by non_null_only)' : ' — pass non_null_only:true to hide them'}._`,
            );
          }
          sections.push(lines.join('\n'));
        }

        // Compute property overlap summary for batch mode
        if (ids.length > 1) {
          const nodePropertySets: Array<{id: number; props: Set<string>}> = [];
          for (const id of ids) {
            const node = snapshot.getNodeById(id);
            if (!node) continue;
            const props = new Set<string>();
            for (const edge of node.references) {
              if (edge.type === 'property') {
                props.add(String(edge.name_or_index));
              }
            }
            nodePropertySets.push({id, props});
          }

          if (nodePropertySets.length > 1) {
            // Group nodes by their property set
            const shapeGroups = new Map<string, number[]>();
            for (const {id, props} of nodePropertySets) {
              const key = [...props].sort().join(',');
              const group = shapeGroups.get(key);
              if (group) {
                group.push(id);
              } else {
                shapeGroups.set(key, [id]);
              }
            }

            let overlapSummary: string;
            if (shapeGroups.size === 1) {
              const [key] = shapeGroups.keys();
              const propNames = key.split(',');
              const propsDisplay =
                propNames.length <= 8
                  ? `{${propNames.join(', ')}}`
                  : `{${propNames.slice(0, 6).join(', ')}, ... +${propNames.length - 6}}`;
              overlapSummary = `${nodePropertySets.length} nodes inspected: all share the same ${propNames.length}-property shape ${propsDisplay}`;
            } else {
              const groupDescs: string[] = [];
              for (const [key, groupIds] of shapeGroups) {
                const propNames = key.split(',');
                const propsDisplay =
                  propNames.length <= 6
                    ? `{${propNames.join(', ')}}`
                    : `{${propNames.slice(0, 5).join(', ')}, ... +${propNames.length - 5}}`;
                groupDescs.push(
                  `${groupIds.length} ${groupIds.length === 1 ? 'has' : 'share'} ${propsDisplay}`,
                );
              }
              overlapSummary = `${nodePropertySets.length} nodes: ${groupDescs.join(', ')}`;
            }

            sections.unshift(`**Shape overlap:** ${overlapSummary}`);
          }
        }

        return toolResult(sampleNote + sections.join('\n\n---\n\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

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
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {
  getSnapshot,
  getSnapshotByHandle,
  getMetadataByHandle,
  listSnapshots,
} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  truncateNodeName,
  errorResult,
  toolResult,
} from '../utils.js';
import {getFirstNonFrameworkRetainer} from './detached-dom.js';

// Property names sampled to fingerprint an object's shape. Matches the cap the
// other shape-based tools use, so a fingerprint is comparable across them.
const SHAPE_PROP_CAP = 12;

// Cap on candidates scored per match. A class with a million instances would
// otherwise turn an identity lookup into a full-heap ranking problem.
const MAX_CANDIDATES = 5000;

function shapeOf(node: IHeapNode): string[] {
  const props: string[] = [];
  if (node.edge_count > 1024) return props;
  node.forEachReference(edge => {
    if (edge.type === 'property') {
      props.push(String(edge.name_or_index));
      if (props.length >= SHAPE_PROP_CAP) return {stop: true};
    }
  });
  props.sort();
  return props;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

interface Candidate {
  node: IHeapNode;
  score: number;
  shapeScore: number;
  retainerMatch: boolean;
}

export function registerMatchObject(server: McpServer): void {
  server.tool(
    'memlab_match_object',
    'Find the object in ANOTHER loaded snapshot that corresponds to a given object in the current one. ' +
      'Heap node ids are assigned per capture and are meaningless across snapshots, which is why every cross-snapshot question ("did THIS object survive?", "did THIS cache grow?") otherwise degrades into comparing aggregate class counts. This matches on identity evidence instead: class name and type (required), property-shape overlap, and the first non-framework retainer path. ' +
      'Returns ranked candidates with a score and the retained-size delta, NOT a single answer — object identity across captures is inferred, never proven, and the tool says so rather than presenting a guess as a fact. Both snapshots must be resident: load them with keep_previous:true and see memlab_snapshots for handles.',
    {
      node_id: z
        .number()
        .describe('Node id in the CURRENT snapshot to find a match for.'),
      target_handle: z
        .string()
        .describe(
          'Handle of the other resident snapshot to search (memlab_snapshots lists them).',
        ),
      limit: z
        .number()
        .optional()
        .default(5)
        .describe('Maximum candidates to return (default 5).'),
      min_score: z
        .number()
        .optional()
        .default(0.5)
        .describe(
          'Minimum match score, 0-1 (default 0.5). Score is 0.7×shape overlap + 0.3×retainer-path agreement; name and type must match exactly regardless.',
        ),
    },
    async ({node_id, target_handle, limit, min_score}) => {
      try {
        const source: IHeapSnapshot = getSnapshot();
        const target = getSnapshotByHandle(target_handle);
        if (target == null) {
          const available = listSnapshots()
            .map(m => m.handle)
            .join(', ');
          return errorResult(
            `No resident snapshot with handle "${target_handle}". Resident: ${available || '(none)'}. Load the other snapshot with memlab_load_snapshot({file_path, keep_previous: true}).`,
          );
        }
        const targetMeta = getMetadataByHandle(target_handle);
        if (targetMeta?.light) {
          return errorResult(
            `Snapshot "${target_handle}" was loaded in LIGHT mode; matching compares retained sizes and retainer paths, which it does not have. Reload it without light.`,
          );
        }

        const src = source.getNodeById(node_id);
        if (!src) return errorResult(`Node @${node_id} not found.`);

        const srcShape = new Set(shapeOf(src));
        const srcRetainer = getFirstNonFrameworkRetainer(src);

        const candidates: Candidate[] = [];
        let sameClass = 0;
        let truncated = false;
        target.nodes.forEach(node => {
          if (node.id <= 3) return;
          if (node.name !== src.name || node.type !== src.type) return;
          sameClass++;
          if (candidates.length >= MAX_CANDIDATES) {
            truncated = true;
            return;
          }
          const shapeScore = jaccard(srcShape, new Set(shapeOf(node)));
          const retainerMatch =
            srcRetainer !== '(unknown)' &&
            getFirstNonFrameworkRetainer(node) === srcRetainer;
          const score = 0.7 * shapeScore + 0.3 * (retainerMatch ? 1 : 0);
          candidates.push({node, score, shapeScore, retainerMatch});
        });

        if (sameClass === 0) {
          return toolResult(
            `No node named \`${src.name}\` (${src.type}) exists in "${target_handle}". ` +
              'The class is absent from that snapshot entirely — which is itself the answer if you were asking whether these objects survive.',
          );
        }

        candidates.sort((a, b) => b.score - a.score);
        const shown = candidates
          .filter(c => c.score >= min_score)
          .slice(0, limit);

        const lines: string[] = [
          `## Cross-snapshot match for @${src.id} \`${truncateNodeName(src.name, src.type, src.self_size, 50)}\` (${src.type})`,
          '',
          `Source retains ${formatBytes(src.retainedSize)}; searched **${formatNumber(sameClass)}** same-class node(s) in "${target_handle}".`,
          '',
        ];

        if (shown.length === 0) {
          lines.push(
            `No candidate scored at or above ${min_score}. The class exists there but no instance resembles this one in shape or retainer path — lower \`min_score\` to see the closest anyway.`,
          );
          return toolResult(lines.join('\n'));
        }

        lines.push(
          markdownTable(
            [
              'Candidate',
              'Score',
              'Shape',
              'Same retainer',
              'Retained',
              'Δ vs source',
            ],
            shown.map(c => {
              const delta = c.node.retainedSize - src.retainedSize;
              return [
                `@${c.node.id}`,
                c.score.toFixed(2),
                `${Math.round(c.shapeScore * 100)}%`,
                c.retainerMatch ? 'yes' : 'no',
                formatBytes(c.node.retainedSize),
                `${delta >= 0 ? '+' : '−'}${formatBytes(Math.abs(delta))}`,
              ];
            }),
            new Set([1, 2, 4, 5]),
          ),
          '',
          `_Source retainer: \`${srcRetainer}\`._`,
        );
        if (truncated) {
          lines.push(
            '',
            `_⚠ Scoring stopped after ${formatNumber(MAX_CANDIDATES)} same-class candidates; ${formatNumber(sameClass)} exist. With this many instances a per-object identity match is weak evidence — compare counts and shapes instead._`,
          );
        }
        lines.push(
          '',
          '_Identity across captures is INFERRED from class, shape and retainer path — node ids are per-capture and cannot confirm it. A high score means "indistinguishable by the available evidence", not "the same object". Confirm with `memlab_retainer_trace` on both sides before drawing a conclusion._',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

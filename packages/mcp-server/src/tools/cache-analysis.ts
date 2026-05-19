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
import type {IHeapNode, IHeapEdge} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot, getSnapshotMetadata} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  truncateNodeName,
  errorResult,
  toolResult,
} from '../utils.js';

interface CacheEntry {
  nodeId: number;
  collectionType: string;
  entryCount: number;
  retainedSize: number;
  selfSize: number;
  ownerName: string;
  ownerEdge: string;
  hasWeakRefs: boolean;
}

function getOwnerInfo(node: IHeapNode): {name: string; edge: string} {
  if (!node.hasPathEdge) return {name: '(root)', edge: ''};
  const pathEdge: IHeapEdge | null = node.pathEdge;
  if (!pathEdge) return {name: '(unknown)', edge: ''};

  const from = pathEdge.fromNode;
  const edgeName = String(pathEdge.name_or_index);

  if (from.type === 'object' || from.type === 'closure') {
    return {
      name: truncateNodeName(from.name, from.type, from.self_size, 40),
      edge: edgeName,
    };
  }

  if (from.hasPathEdge) {
    const outerEdge: IHeapEdge | null = from.pathEdge;
    if (outerEdge) {
      const outer = outerEdge.fromNode;
      if (outer.type === 'object' || outer.type === 'closure') {
        return {
          name: truncateNodeName(outer.name, outer.type, outer.self_size, 40),
          edge: `${String(outerEdge.name_or_index)}.${edgeName}`,
        };
      }
    }
  }

  return {name: from.name, edge: edgeName};
}

function countEntries(node: IHeapNode): number {
  if (node.name === 'Map' || node.name === 'Set') {
    for (const edge of node.references) {
      if (edge.name_or_index === 'table' && edge.toNode.type === 'array') {
        let nonEmpty = 0;
        for (const e of edge.toNode.references) {
          if (e.toNode.type !== 'hidden' && e.toNode.id > 3) {
            nonEmpty++;
          }
        }
        return node.name === 'Map' ? Math.floor(nonEmpty / 2) : nonEmpty;
      }
    }
    return 0;
  }

  if (node.type === 'object' && node.name === 'Array') {
    return node.edge_count;
  }

  return node.edge_count;
}

function hasWeakRefEntries(node: IHeapNode): boolean {
  for (const edge of node.references) {
    if (edge.toNode.name === 'WeakRef' || edge.toNode.name === 'WeakMap') {
      return true;
    }
    if (edge.name_or_index === 'table' && edge.toNode.type === 'array') {
      for (const te of edge.toNode.references) {
        if (te.toNode.name === 'WeakRef') return true;
      }
    }
  }
  return false;
}

function sampleCacheEntries(
  node: IHeapNode,
  count: number,
): Array<{keyPreview: string; valuePreview: string}> {
  const entries: Array<{keyPreview: string; valuePreview: string}> = [];

  if (node.name === 'Map') {
    for (const edge of node.references) {
      if (edge.name_or_index === 'table' && edge.toNode.type === 'array') {
        const allRefs: IHeapNode[] = [];
        for (const te of edge.toNode.references) {
          allRefs.push(te.toNode);
        }
        for (let i = 0; i < allRefs.length && entries.length < count; i += 2) {
          const key = allRefs[i];
          const val = i + 1 < allRefs.length ? allRefs[i + 1] : null;
          if (key.type === 'hidden' || key.id <= 3) continue;
          const keyStr = key.isString
            ? `"${(key.toStringNode()?.stringValue ?? key.name).slice(0, 40)}"`
            : `${key.name} (${key.type})`;
          let valStr = '(missing)';
          if (val) {
            if (val.isString) {
              valStr = `"${(val.toStringNode()?.stringValue ?? val.name).slice(0, 40)}"`;
            } else {
              const props: string[] = [];
              for (const ve of val.references) {
                if (ve.type === 'property') {
                  props.push(String(ve.name_or_index));
                  if (props.length >= 3) break;
                }
              }
              valStr =
                props.length > 0
                  ? `${val.name} {${props.join(', ')}${val.edge_count > 3 ? ', …' : ''}}`
                  : `${val.name} (${val.type}, ${formatBytes(val.retainedSize)})`;
            }
          }
          entries.push({keyPreview: keyStr, valuePreview: valStr});
        }
        break;
      }
    }
  } else if (node.name === 'Set') {
    for (const edge of node.references) {
      if (edge.name_or_index === 'table' && edge.toNode.type === 'array') {
        for (const te of edge.toNode.references) {
          if (entries.length >= count) break;
          const entry = te.toNode;
          if (entry.type === 'hidden' || entry.id <= 3) continue;
          const preview = entry.isString
            ? `"${(entry.toStringNode()?.stringValue ?? entry.name).slice(0, 40)}"`
            : `${entry.name} (${entry.type}, ${formatBytes(entry.retainedSize)})`;
          entries.push({keyPreview: preview, valuePreview: '(Set entry)'});
        }
        break;
      }
    }
  } else if (node.name === 'Array') {
    let idx = 0;
    for (const edge of node.references) {
      if (entries.length >= count) break;
      if (edge.type !== 'element') continue;
      const entry = edge.toNode;
      if (entry.id <= 3) continue;
      const preview = entry.isString
        ? `"${(entry.toStringNode()?.stringValue ?? entry.name).slice(0, 40)}"`
        : `${entry.name} (${entry.type}, ${formatBytes(entry.retainedSize)})`;
      entries.push({keyPreview: `[${idx}]`, valuePreview: preview});
      idx++;
    }
  }

  return entries;
}

export function registerCacheAnalysis(server: McpServer): void {
  server.tool(
    'memlab_cache_analysis',
    'Detect unbounded caches — Map, Set, and Array objects that are large and likely missing eviction logic. The #1 cause of Node.js memory leaks. Reports entry count, retained size, owner object, and whether entries use WeakRef. Use this after memlab_auto_investigate or memlab_check_health flags suspicious collections.',
    {
      limit: z
        .number()
        .optional()
        .default(15)
        .describe('Maximum number of caches to return (default 15)'),
      min_entries: z
        .number()
        .optional()
        .default(50)
        .describe(
          'Minimum number of entries to consider a collection a potential cache (default 50)',
        ),
      min_retained_size: z
        .number()
        .optional()
        .default(524288)
        .describe('Minimum retained size in bytes (default 512 KB)'),
      collection_types: z
        .array(z.string())
        .optional()
        .default(['Map', 'Set', 'Array'])
        .describe('Collection types to scan (default: Map, Set, Array)'),
      sample_entries: z
        .number()
        .optional()
        .default(0)
        .describe(
          'Number of sample entries to show per cache (default 0). Inspects representative key-value pairs showing key type/preview and value shape. Saves 2-3 follow-up tool calls per cache.',
        ),
    },
    async ({
      limit,
      min_entries,
      min_retained_size,
      collection_types,
      sample_entries,
    }) => {
      try {
        const snapshot = getSnapshot();
        const meta = getSnapshotMetadata();
        const totalSize = meta?.totalSize ?? 0;

        const typeSet = new Set(collection_types);
        const caches: CacheEntry[] = [];

        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          if (!typeSet.has(node.name)) return;
          if (node.type !== 'object') return;
          if (node.retainedSize < min_retained_size) return;

          const entryCount = countEntries(node);
          if (entryCount < min_entries) return;

          const owner = getOwnerInfo(node);
          const entry: CacheEntry = {
            nodeId: node.id,
            collectionType: node.name,
            entryCount,
            retainedSize: node.retainedSize,
            selfSize: node.self_size,
            ownerName: owner.name,
            ownerEdge: owner.edge,
            hasWeakRefs: hasWeakRefEntries(node),
          };

          let inserted = false;
          for (let i = 0; i < caches.length; i++) {
            if (entry.retainedSize > caches[i].retainedSize) {
              caches.splice(i, 0, entry);
              inserted = true;
              break;
            }
          }
          if (!inserted) caches.push(entry);
          if (caches.length > limit) caches.length = limit;
        });

        if (caches.length === 0) {
          return toolResult(
            `No unbounded caches found with >= ${min_entries} entries and >= ${formatBytes(min_retained_size)} retained. Try lowering the thresholds.`,
          );
        }

        const headers = [
          'ID',
          'Type',
          'Entries',
          'Retained',
          '% Heap',
          'Owner',
          'Property',
          'Weak?',
        ];
        const rightCols = new Set([2, 3, 4]);
        const rows = caches.map(c => {
          const pct =
            totalSize > 0
              ? ((c.retainedSize / totalSize) * 100).toFixed(1) + '%'
              : '-';
          return [
            `@${c.nodeId}`,
            c.collectionType,
            formatNumber(c.entryCount),
            formatBytes(c.retainedSize),
            pct,
            c.ownerName,
            c.ownerEdge,
            c.hasWeakRefs ? 'Yes' : 'No',
          ];
        });

        const totalRetained = caches.reduce(
          (sum, c) => sum + c.retainedSize,
          0,
        );

        const lines = [
          `Cache analysis: ${caches.length} potential unbounded cache(s), ${formatBytes(totalRetained)} total retained`,
          '',
          markdownTable(headers, rows, rightCols),
          '',
          '**Risk indicators:**',
          '- **Weak? = No** means entries are strongly held and will never be evicted by GC',
          '- High entry count with no eviction suggests unbounded growth',
          '- Check if the owner has `clear()`, `delete()`, or LRU logic',
          '',
          '**Suggested next steps:**',
        ];

        const top = caches[0];
        lines.push(
          `- Inspect largest cache: \`memlab_object_shape(${top.nodeId})\``,
          `- See what it retains: \`memlab_dominator_subtree(${top.nodeId})\``,
          `- Trace its retainer: \`memlab_retainer_trace(${top.nodeId})\``,
          `- Check for common patterns: \`memlab_retainer_summary\` with node_ids from the top caches`,
        );

        if (sample_entries > 0) {
          lines.push('', '---', '');
          for (const c of caches.slice(0, 5)) {
            const node = snapshot.getNodeById(c.nodeId);
            if (!node) continue;
            const samples = sampleCacheEntries(node, sample_entries);
            if (samples.length === 0) continue;
            lines.push(
              `**@${c.nodeId} \`${c.collectionType}\` sample entries (${samples.length} of ${formatNumber(c.entryCount)}):**`,
            );
            for (const s of samples) {
              lines.push(`  - ${s.keyPreview} → ${s.valuePreview}`);
            }
            lines.push('');
          }
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

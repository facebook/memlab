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
import type {IHeapSnapshot} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {buildPathTree} from '../heap-families.js';
import type {PathTree} from '../heap-families.js';
import {errorResult, formatBytes, toolResult} from '../utils.js';

function describe(snapshot: IHeapSnapshot, idx: number): string {
  const node = snapshot.nodes.get(idx);
  if (node == null) return `#${idx}`;
  const e = node.pathEdge;
  const edge = e != null ? String(e.name_or_index) : '';
  const name = node.name.length > 48 ? `${node.name.slice(0, 45)}…` : node.name;
  return `${edge ? `${edge} → ` : ''}${name} [${node.type}] @${node.id}`;
}

function bigChildren(tree: PathTree, v: number, min: number): number[] {
  const out: number[] = [];
  for (let k = tree.childStart[v]; k < tree.childStart[v + 1]; k++) {
    const c = tree.children[k];
    if (tree.subtreeBytes[c] >= min) out.push(c);
  }
  return out.sort((a, b) => tree.subtreeBytes[b] - tree.subtreeBytes[a]);
}

/**
 * The shortest-path tree, expanded wherever a branch holds at least
 * `min_bytes`. Shortest-path subtrees partition the heap (a shared object has
 * exactly one parent here), so the sums add up — unlike dominator subtrees,
 * where everything with two owners collapses into the root.
 */
export function registerPathTree(server: McpServer): void {
  server.tool(
    'memlab_path_tree',
    'Show WHERE the memory sits as a tree: the shortest-retainer-path tree (each object hangs under the object on its shortest path from a GC root) with the app bytes of every subtree, expanded wherever a branch holds at least `min_bytes`, single-child chains collapsed onto one line. ' +
      'Shortest-path subtrees PARTITION the heap, so the sums add up and a cache whose entries are also referenced elsewhere still shows its real size — the dominator tree credits such objects to the root. ' +
      'Loaded code and bundle text count as 0. Pass `root_id` to expand one object instead of the GC roots.',
    {
      min_bytes: z
        .number()
        .optional()
        .default(300 * 1024)
        .describe(
          'Expand branches holding at least this many bytes (default 300 KB).',
        ),
      max_lines: z
        .number()
        .int()
        .optional()
        .default(150)
        .describe('Stop after this many lines (default 150).'),
      max_depth: z
        .number()
        .int()
        .optional()
        .default(30)
        .describe('Maximum expansion depth (default 30).'),
      root_id: z
        .number()
        .optional()
        .describe(
          'Expand under this node (by heap id) instead of the GC roots.',
        ),
    },
    async ({min_bytes, max_lines, max_depth, root_id}) => {
      try {
        const snapshot = getSnapshot();
        const tree = buildPathTree(snapshot);
        const lines: string[] = [];
        let truncated = false;
        const expand = (v: number, depth: number, indent: string): void => {
          if (depth > max_depth) return;
          for (const c of bigChildren(tree, v, min_bytes)) {
            if (lines.length >= max_lines) {
              truncated = true;
              return;
            }
            const chain = [c];
            let cur = c;
            for (;;) {
              const kk = bigChildren(tree, cur, min_bytes);
              if (
                kk.length === 1 &&
                tree.subtreeBytes[kk[0]] >= 0.85 * tree.subtreeBytes[cur] &&
                chain.length < 12
              ) {
                cur = kk[0];
                chain.push(cur);
              } else break;
            }
            const text =
              chain.length > 3
                ? `${describe(snapshot, chain[0])} … ${describe(snapshot, chain[chain.length - 2])} ${describe(snapshot, cur)}`
                : chain.map(i => describe(snapshot, i)).join(' ');
            lines.push(
              `${indent}${formatBytes(tree.subtreeBytes[c]).padStart(9)}  ${text}`,
            );
            expand(cur, depth + 1, `${indent}  `);
          }
        };
        let starts: number[];
        if (root_id != null) {
          const node = snapshot.getNodeById(root_id);
          if (node == null) throw new Error(`no node @${root_id}`);
          starts = [node.nodeIndex];
        } else {
          starts = tree.roots
            .filter(r => tree.subtreeBytes[r] >= min_bytes)
            .sort((a, b) => tree.subtreeBytes[b] - tree.subtreeBytes[a]);
        }
        for (const s of starts) {
          if (lines.length >= max_lines) break;
          lines.push(
            `${formatBytes(tree.subtreeBytes[s]).padStart(9)}  ${describe(snapshot, s)}`,
          );
          expand(s, 0, '  ');
        }
        return toolResult(
          [
            `## Shortest-path tree (branches ≥ ${formatBytes(min_bytes)})`,
            '',
            '```',
            ...lines,
            '```',
            truncated
              ? `_Stopped at ${max_lines} lines; raise \`max_lines\` or \`min_bytes\`, or expand one branch with \`root_id\`._`
              : '',
            '_Each line: subtree app bytes, then `edge → node [type] @id`; `…` marks a collapsed single-child chain. Loaded code and bundle text count as 0._',
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

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
  formatBytes,
  formatNodeInline,
  errorResult,
  toolResult,
} from '../utils.js';

function resolveStringValue(
  node: IHeapNode,
  maxLen: number,
): {value: string; truncated: boolean; encoding: string} {
  // Try the standard stringValue API first
  if (node.isString) {
    const strNode = node.toStringNode();
    if (strNode) {
      const val = strNode.stringValue;
      if (val.length > maxLen) {
        return {
          value: val.slice(0, maxLen),
          truncated: true,
          encoding: 'direct',
        };
      }
      return {value: val, truncated: false, encoding: 'direct'};
    }
  }

  // For concatenated strings, walk the first/second tree
  if (
    node.name === '(concatenated string)' ||
    node.type === 'concatenated string'
  ) {
    return resolveConcatenatedString(node, maxLen);
  }

  // For sliced strings, resolve the parent and extract the slice
  if (node.name === '(sliced string)' || node.type === 'sliced string') {
    return resolveSlicedString(node, maxLen);
  }

  // For cons strings (another name for concatenated)
  if (node.name === '(cons string)') {
    return resolveConcatenatedString(node, maxLen);
  }

  return {value: '', truncated: false, encoding: 'unknown'};
}

function resolveConcatenatedString(
  node: IHeapNode,
  maxLen: number,
): {value: string; truncated: boolean; encoding: string} {
  const parts: string[] = [];
  let totalLen = 0;
  let truncated = false;

  function walk(n: IHeapNode): void {
    if (truncated) return;

    // If this node is a flat string, get its value directly
    if (n.isString) {
      const strNode = n.toStringNode();
      if (strNode) {
        const val = strNode.stringValue;
        if (totalLen + val.length > maxLen) {
          parts.push(val.slice(0, maxLen - totalLen));
          totalLen = maxLen;
          truncated = true;
          return;
        }
        parts.push(val);
        totalLen += val.length;
        return;
      }
    }

    // Walk first and second edges for concatenated/cons strings
    let first: IHeapNode | null = null;
    let second: IHeapNode | null = null;

    for (const edge of n.references) {
      const name = String(edge.name_or_index);
      if (name === 'first') first = edge.toNode;
      else if (name === 'second') second = edge.toNode;
    }

    if (first) walk(first);
    if (second) walk(second);
  }

  walk(node);
  return {value: parts.join(''), truncated, encoding: 'concatenated'};
}

function resolveSlicedString(
  node: IHeapNode,
  maxLen: number,
): {value: string; truncated: boolean; encoding: string} {
  // Sliced strings have a "parent" edge pointing to the original string
  for (const edge of node.references) {
    const name = String(edge.name_or_index);
    if (name === 'parent') {
      const parent = edge.toNode;
      const resolved = resolveStringValue(parent, maxLen * 2);
      // The sliced string is a substring of the parent.
      // V8 stores offset and length internally, but the snapshot API
      // exposes the stringValue directly via toStringNode() which should
      // already handle this. If we got here, toStringNode() didn't work,
      // so return the parent's full value as context.
      return {
        value: resolved.value,
        truncated: resolved.truncated,
        encoding: `sliced (from parent @${parent.id}, ${formatBytes(parent.self_size)})`,
      };
    }
  }

  return {value: '', truncated: false, encoding: 'sliced (parent not found)'};
}

function getStringStructure(
  node: IHeapNode,
  depth = 0,
  maxDepth = 5,
): string[] {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);

  if (depth > maxDepth) {
    lines.push(`${indent}… (max depth reached)`);
    return lines;
  }

  const typeLabel =
    node.type === 'concatenated string'
      ? 'concat'
      : node.name === '(concatenated string)'
        ? 'concat'
        : node.name === '(cons string)'
          ? 'cons'
          : node.name === '(sliced string)'
            ? 'sliced'
            : node.isString
              ? 'flat'
              : node.type;

  if (
    node.isString &&
    node.type !== 'concatenated string' &&
    node.name !== '(concatenated string)' &&
    node.name !== '(cons string)'
  ) {
    const strNode = node.toStringNode();
    if (strNode) {
      const val = strNode.stringValue;
      const preview = val.length > 60 ? val.slice(0, 60) + '…' : val;
      lines.push(
        `${indent}@${node.id} [${typeLabel}] "${preview}" (${formatBytes(node.self_size)})`,
      );
      return lines;
    }
  }

  lines.push(
    `${indent}@${node.id} [${typeLabel}] (${formatBytes(node.self_size)})`,
  );

  for (const edge of node.references) {
    const name = String(edge.name_or_index);
    if (name === 'first' || name === 'second' || name === 'parent') {
      lines.push(`${indent}  ${name}:`);
      lines.push(...getStringStructure(edge.toNode, depth + 2, maxDepth));
    }
  }

  return lines;
}

export function registerGetString(server: McpServer): void {
  server.tool(
    'memlab_get_string',
    'Resolve any V8 string node to its full text value. Handles all V8 string encodings: ' +
      'flat strings, concatenated strings (ConsString with first/second tree), sliced strings ' +
      '(substring of a parent), and cons strings. Returns the resolved text value and optionally ' +
      'shows the internal string tree structure. Essential when investigating event names, log ' +
      'messages, or error strings that V8 stores as concatenated string trees rather than flat strings.',
    {
      node_id: z.number().describe('The numeric ID of the string node'),
      max_length: z
        .number()
        .optional()
        .default(10000)
        .describe(
          'Maximum characters to return (default 10000). Use higher values for full log messages.',
        ),
      show_structure: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Show the internal string tree structure (concatenation tree, parent references). Useful for understanding why a large parent string is kept alive by a small sliced substring.',
        ),
    },
    async ({node_id, max_length, show_structure}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(`Node with id ${node_id} not found`);
        }

        const isStringType =
          node.isString ||
          node.type === 'concatenated string' ||
          node.type === 'sliced string' ||
          node.name === '(concatenated string)' ||
          node.name === '(cons string)' ||
          node.name === '(sliced string)' ||
          node.type === 'string';

        if (!isStringType) {
          return toolResult(
            `Node @${node_id} is not a string node (type: "${node.type}", name: "${node.name}"). ` +
              'This tool is designed for string, concatenated string, sliced string, and cons string nodes.\n\n' +
              'If you need to read a string property of an object, use `memlab_get_property` to navigate to the string node first.',
          );
        }

        const resolved = resolveStringValue(node, max_length);
        const lines: string[] = [];

        lines.push(
          `**Node:** ${formatNodeInline(node.id, node.name, node.type, node.self_size)}`,
        );
        lines.push(
          `**Self Size:** ${formatBytes(node.self_size)} | **Retained Size:** ${formatBytes(node.retainedSize)}`,
        );
        lines.push(`**Encoding:** ${resolved.encoding}`);
        lines.push(
          `**Length:** ${resolved.value.length}${resolved.truncated ? ` (truncated from longer value, use max_length to see more)` : ''} characters`,
        );
        lines.push('');

        lines.push('**Value:**');
        lines.push('```');
        lines.push(resolved.value);
        lines.push('```');

        if (show_structure) {
          lines.push('');
          lines.push('**String Tree Structure:**');
          lines.push('```');
          lines.push(...getStringStructure(node));
          lines.push('```');
        }

        // Show referrers for context
        const referrerContexts: string[] = [];
        let refCount = 0;
        for (const edge of node.referrers) {
          if (refCount >= 5) break;
          if (edge.fromNode.id <= 3) continue;
          referrerContexts.push(
            `- \`${String(edge.name_or_index)}\` on @${edge.fromNode.id} \`${edge.fromNode.name}\` (${edge.fromNode.type})`,
          );
          refCount++;
        }

        if (referrerContexts.length > 0) {
          lines.push('');
          lines.push('**Referenced by:**');
          lines.push(...referrerContexts);
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

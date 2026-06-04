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
  suggestionsSuppressed,
} from '../utils.js';

function decodeSmi(node: IHeapNode): number | null {
  // V8 stores Small Integers (SMIs) with the value encoded in the node ID.
  // SMI node IDs are odd numbers; the actual value is id >> 1.
  // SMI nodes have type "number" and name "smi number" with self_size 0.
  if (node.name === 'smi number' && node.self_size === 0) {
    return node.id >> 1;
  }
  return null;
}

function decodeHeapNumber(node: IHeapNode): {
  value: number | null;
  raw: string | null;
} {
  // V8 stores heap numbers (doubles that don't fit in SMI range) as
  // separate heap objects. The actual IEEE 754 value is not directly
  // accessible via the heap snapshot API, but we can identify them.
  if (
    node.name === 'heap number' ||
    (node.type === 'number' && node.name !== 'smi number')
  ) {
    // Heap numbers have self_size of 12 or 16 bytes (object header + 8-byte double).
    // The value itself is not exposed in the standard heap snapshot format,
    // but we can check if it's referenced by a property edge to provide context.
    return {
      value: null,
      raw: 'IEEE 754 double (value not stored in snapshot format)',
    };
  }
  return {value: null, raw: null};
}

function getPropertyContext(node: IHeapNode): Array<{
  ownerName: string;
  ownerType: string;
  ownerId: number;
  propertyName: string;
}> {
  const contexts: Array<{
    ownerName: string;
    ownerType: string;
    ownerId: number;
    propertyName: string;
  }> = [];
  for (const edge of node.referrers) {
    if (
      edge.type === 'property' ||
      edge.type === 'element' ||
      edge.type === 'context'
    ) {
      const from = edge.fromNode;
      if (from.id <= 3) continue;
      contexts.push({
        ownerName: from.name,
        ownerType: from.type,
        ownerId: from.id,
        propertyName: String(edge.name_or_index),
      });
      if (contexts.length >= 10) break;
    }
  }
  return contexts;
}

export function registerGetValue(server: McpServer): void {
  server.tool(
    'memlab_get_value',
    'Decode the actual numeric value of a V8 SMI (Small Integer) or heap number node. ' +
      'V8 stores numbers as either SMI nodes (value encoded as id >> 1, self_size 0) or ' +
      'heap number nodes (IEEE 754 doubles). This tool decodes them and shows which objects ' +
      'reference the number and via which property name, providing the context needed to ' +
      'understand what the number represents. Essential when inspecting numeric properties ' +
      'like counters, capacities, or sizes that appear as opaque "smi number" or "heap number" nodes.',
    {
      node_id: z
        .number()
        .describe(
          'The numeric ID of the number node to decode, OR (with property_name) the owner object whose numeric property should be decoded.',
        ),
      property_name: z
        .string()
        .optional()
        .describe(
          'Optional: decode this numeric property of node_id instead of node_id itself. Lets you decode an inline SMI/number property by (node_id, property_name) without first looking up the value node.',
        ),
    },
    async ({node_id, property_name}) => {
      try {
        const snapshot = getSnapshot();
        const owner = snapshot.getNodeById(node_id);
        if (!owner) {
          return errorResult(`Node with id ${node_id} not found`);
        }
        let node = owner;
        if (property_name != null) {
          const edge = owner.references.find(
            e =>
              e.type === 'property' &&
              String(e.name_or_index) === property_name,
          );
          if (!edge) {
            return errorResult(
              `Property "${property_name}" not found on @${node_id} (${owner.name}).`,
            );
          }
          node = edge.toNode;
        }

        const lines: string[] = [];
        if (property_name != null) {
          lines.push(
            `**Property:** \`${property_name}\` on @${node_id} ${owner.name} (${owner.type})`,
          );
        }
        lines.push(
          `**Node:** ${formatNodeInline(node.id, node.name, node.type, node.self_size)}`,
        );
        lines.push(
          `**Self Size:** ${formatBytes(node.self_size)} | **Retained Size:** ${formatBytes(node.retainedSize)}`,
        );
        lines.push('');

        const smiValue = decodeSmi(node);
        if (smiValue !== null) {
          lines.push(`**Decoded SMI Value:** ${smiValue}`);
          lines.push(
            `**Encoding:** SMI (Small Integer) — value = node_id >> 1 = ${node.id} >> 1 = ${smiValue}`,
          );
        } else {
          const heapNum = decodeHeapNumber(node);
          if (heapNum.raw) {
            lines.push(`**Type:** Heap Number (boxed double-precision float)`);
            lines.push(`**Note:** ${heapNum.raw}`);
            lines.push('');
            lines.push(
              '_The V8 heap snapshot format does not include the raw IEEE 754 value for heap numbers. Check the property name and owner context below to infer meaning._',
            );
          } else if (node.type === 'number') {
            lines.push(`**Type:** Number node (unrecognized encoding)`);
          } else {
            lines.push(
              `**Note:** Node @${node.id} is not a number node (type: "${node.type}", name: "${node.name}").`,
            );
            lines.push(
              'This tool is designed for "smi number" and "heap number" nodes.',
            );
            if (node.isString) {
              const strNode = node.toStringNode();
              if (strNode) {
                const val = strNode.stringValue;
                const numVal = Number(val);
                if (!isNaN(numVal)) {
                  lines.push('');
                  lines.push(
                    `However, this is a string node with numeric content: "${val.slice(0, 100)}" (parsed as ${numVal})`,
                  );
                }
              }
            }
          }
        }

        const contexts = getPropertyContext(node);
        if (contexts.length > 0) {
          lines.push('');
          lines.push('**Referenced by:**');
          for (const ctx of contexts) {
            lines.push(
              `- \`${ctx.propertyName}\` on @${ctx.ownerId} \`${ctx.ownerName}\` (${ctx.ownerType})`,
            );
          }
        }

        if (!suggestionsSuppressed()) {
          lines.push('');
          lines.push('**Suggested next steps:**');
          if (contexts.length > 0) {
            lines.push(
              `- Inspect owner: \`memlab_object_shape(${contexts[0].ownerId})\``,
            );
            lines.push(
              `- Trace owner retention: \`memlab_retainer_trace(${contexts[0].ownerId})\``,
            );
          }
          lines.push(
            `- For all number properties on an object, use \`memlab_object_shape\` — it decodes SMI values inline`,
          );
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

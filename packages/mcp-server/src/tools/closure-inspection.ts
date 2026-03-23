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
  serializeNodeSummary,
  errorResult,
  textResult,
  formatBytes,
  formatNumber,
  formatNodeInline,
  markdownTable,
} from '../utils.js';

export function registerClosureInspection(server: McpServer): void {
  server.tool(
    'memlab_closure_inspection',
    'Inspect a closure (function) node to show its captured variables from the enclosing scope. Shows the function name, source location, and all context-bound variables with their types and sizes. Critical for diagnosing closure-based memory leaks where a function unintentionally retains large objects.',
    {
      node_id: z
        .number()
        .describe('The numeric ID of the closure/function node'),
    },
    async ({node_id}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(`Node with id ${node_id} not found`);
        }

        if (node.type !== 'closure') {
          return textResult(
            `Node @${node_id} is not a closure (type is "${node.type}"). This tool is designed for closure nodes.`,
          );
        }

        // Captured variables come via "context" type edges
        const capturedVars = node.references
          .filter(edge => edge.type === 'context')
          .sort((a, b) => b.toNode.retainedSize - a.toNode.retainedSize)
          .map(edge => {
            const target = edge.toNode;
            const v: Record<string, unknown> = {
              variable_name: String(edge.name_or_index),
              target_type: target.type,
              target_name: target.name,
              target_id: target.id,
              self_size: target.self_size,
              retained_size: target.retainedSize,
              retained_size_formatted: formatBytes(target.retainedSize),
            };
            if (target.isString) {
              const strNode = target.toStringNode();
              if (strNode) {
                const val = strNode.stringValue;
                v.string_value =
                  val.length > 200 ? val.slice(0, 200) + '...' : val;
              }
            }
            return v;
          });

        // Also look for the "shared" edge which points to SharedFunctionInfo
        // containing the function's source position
        const sharedEdge = node.references.find(
          e => String(e.name_or_index) === 'shared' && e.type === 'internal',
        );

        // Get the context chain — the scope object this closure closes over
        const contextEdge = node.references.find(
          e => String(e.name_or_index) === 'context' && e.type === 'internal',
        );

        const location = node.location
          ? {
              script_id: node.location.script_id,
              line: node.location.line,
              column: node.location.column,
            }
          : null;

        const totalCapturedRetained = capturedVars.reduce(
          (sum, v) => sum + (v.retained_size as number),
          0,
        );

        const lines = [
          `**Closure:** ${formatNodeInline(node.id, node.name, node.type)}`,
          `**Self Size:** ${formatBytes(node.self_size)} | **Retained Size:** ${formatBytes(node.retainedSize)}`,
        ];
        if (location) {
          lines.push(
            `**Location:** script ${location.script_id}, line ${location.line}, col ${location.column}`,
          );
        }
        if (contextEdge) {
          const ctx = contextEdge.toNode;
          lines.push(
            `**Scope Context:** ${formatNodeInline(ctx.id, ctx.name, ctx.type)}`,
          );
        }
        if (sharedEdge) {
          lines.push(
            `**Shared Function Info:** @${sharedEdge.toNode.id} ${sharedEdge.toNode.name}`,
          );
        }
        lines.push(
          `**Captured Variables:** ${formatNumber(capturedVars.length)}, total retained ${formatBytes(totalCapturedRetained)}`,
        );
        lines.push('');

        if (capturedVars.length > 0) {
          const headers = ['Variable', 'Target', 'Target Type', 'Retained'];
          const rightCols = new Set([3]);
          const rows = capturedVars.map(v => {
            let targetLabel = `@${v.target_id} ${v.target_name}`;
            if (v.string_value != null) {
              const sv = v.string_value as string;
              targetLabel = `@${v.target_id} "${sv.length > 60 ? sv.slice(0, 60) + '...' : sv}"`;
            }
            return [
              v.variable_name as string,
              targetLabel,
              v.target_type as string,
              formatBytes(v.retained_size as number),
            ];
          });
          lines.push(markdownTable(headers, rows, rightCols));
        }

        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

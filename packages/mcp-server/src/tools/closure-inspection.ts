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
  toolResult,
  formatBytes,
  formatNumber,
  formatNodeInline,
  markdownTable,
} from '../utils.js';

interface ScopeVariable {
  variable_name: string;
  target_type: string;
  target_name: string;
  target_id: number;
  self_size: number;
  retained_size: number;
  string_value?: string;
  depth: number;
}

function walkScopeChain(
  contextNode: IHeapNode,
  maxDepth: number,
): {variables: ScopeVariable[]; depth: number} {
  const allVars: ScopeVariable[] = [];
  const visited = new Set<number>();
  let currentContext: IHeapNode | null = contextNode;
  let depth = 0;

  while (
    currentContext &&
    depth <= maxDepth &&
    !visited.has(currentContext.id)
  ) {
    visited.add(currentContext.id);

    for (const edge of currentContext.references) {
      if (edge.type === 'context' || edge.type === 'property') {
        const name = String(edge.name_or_index);
        if (name === 'previous' || name === 'native_context') continue;
        const target = edge.toNode;
        if (target.id <= 3) continue;

        const v: ScopeVariable = {
          variable_name: name,
          target_type: target.type,
          target_name: target.name,
          target_id: target.id,
          self_size: target.self_size,
          retained_size: target.retainedSize,
          depth,
        };
        if (target.isString) {
          const strNode = target.toStringNode();
          if (strNode) {
            const val = strNode.stringValue;
            v.string_value = val.length > 200 ? val.slice(0, 200) + '...' : val;
          }
        }
        allVars.push(v);
      }
    }

    // Walk to the parent scope via "previous" edge
    let nextContext: IHeapNode | null = null;
    for (const edge of currentContext.references) {
      if (String(edge.name_or_index) === 'previous' && edge.toNode.id > 3) {
        nextContext = edge.toNode;
        break;
      }
    }
    currentContext = nextContext;
    depth++;
  }

  return {variables: allVars, depth};
}

export function registerClosureInspection(server: McpServer): void {
  server.tool(
    'memlab_closure_inspection',
    'Inspect a closure (function) node to show its captured variables from the enclosing scope. ' +
      'Walks the FULL scope chain via "previous" edges on V8 Context objects, reporting variables ' +
      'at each scope depth. Shows the function name, source location, and all context-bound ' +
      'variables with their types and sizes. Critical for diagnosing closure-based memory leaks ' +
      'where a function unintentionally retains large objects through nested scope contexts.',
    {
      node_id: z
        .number()
        .describe('The numeric ID of the closure/function node'),
      max_scope_depth: z
        .number()
        .optional()
        .default(10)
        .describe(
          'Maximum scope chain depth to walk (default 10). Increase for deeply nested closures.',
        ),
    },
    async ({node_id, max_scope_depth}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(`Node with id ${node_id} not found`);
        }

        if (node.type !== 'closure') {
          return toolResult(
            `Node @${node_id} is not a closure (type is "${node.type}"). This tool is designed for closure nodes.`,
          );
        }

        // Also look for the "shared" edge which points to SharedFunctionInfo
        const sharedEdge = node.references.find(
          e => String(e.name_or_index) === 'shared' && e.type === 'internal',
        );

        // Get the context chain — the scope object this closure closes over
        const contextEdge = node.references.find(
          e => String(e.name_or_index) === 'context' && e.type === 'internal',
        );

        // Also collect direct context-type edges from the closure itself
        const directVars = node.references
          .filter(edge => edge.type === 'context')
          .map(edge => {
            const target = edge.toNode;
            const v: ScopeVariable = {
              variable_name: String(edge.name_or_index),
              target_type: target.type,
              target_name: target.name,
              target_id: target.id,
              self_size: target.self_size,
              retained_size: target.retainedSize,
              depth: 0,
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

        // Walk the full scope chain if a context object exists
        let chainVars: ScopeVariable[] = [];
        let chainDepth = 0;
        if (contextEdge) {
          const chain = walkScopeChain(contextEdge.toNode, max_scope_depth);
          chainVars = chain.variables;
          chainDepth = chain.depth;
        }

        // Merge: direct vars at depth 0, then chain vars (shift depth by 1 if there are direct vars)
        const allVars = [...directVars];
        const directVarNames = new Set(
          directVars.map(v => `${v.variable_name}@${v.target_id}`),
        );
        for (const cv of chainVars) {
          const key = `${cv.variable_name}@${cv.target_id}`;
          if (!directVarNames.has(key)) {
            allVars.push(cv);
          }
        }

        allVars.sort((a, b) => b.retained_size - a.retained_size);

        const location = node.location
          ? {
              script_id: node.location.script_id,
              line: node.location.line,
              column: node.location.column,
            }
          : null;

        const totalCapturedRetained = allVars.reduce(
          (sum, v) => sum + v.retained_size,
          0,
        );

        const lines = [
          `**Closure:** ${formatNodeInline(node.id, node.name, node.type, node.self_size)}`,
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
            `**Scope Context:** ${formatNodeInline(ctx.id, ctx.name, ctx.type, ctx.self_size)}`,
          );
        }
        if (sharedEdge) {
          lines.push(
            `**Shared Function Info:** @${sharedEdge.toNode.id} ${sharedEdge.toNode.name}`,
          );
        }
        lines.push(
          `**Captured Variables:** ${formatNumber(allVars.length)}, total retained ${formatBytes(totalCapturedRetained)}` +
            (chainDepth > 1 ? ` (across ${chainDepth} scope levels)` : ''),
        );
        lines.push('');

        if (allVars.length > 0) {
          const hasMultipleDepths = new Set(allVars.map(v => v.depth)).size > 1;
          const headers = hasMultipleDepths
            ? ['Depth', 'Variable', 'Target', 'Target Type', 'Retained']
            : ['Variable', 'Target', 'Target Type', 'Retained'];
          const rightCols = hasMultipleDepths ? new Set([4]) : new Set([3]);
          const rows = allVars.map(v => {
            let targetLabel = `@${v.target_id} ${v.target_name}`;
            if (v.string_value != null) {
              const sv = v.string_value;
              targetLabel = `@${v.target_id} "${sv.length > 60 ? sv.slice(0, 60) + '...' : sv}"`;
            }
            const row = [
              v.variable_name,
              targetLabel,
              v.target_type,
              formatBytes(v.retained_size),
            ];
            if (hasMultipleDepths) {
              row.unshift(String(v.depth));
            }
            return row;
          });
          lines.push(markdownTable(headers, rows, rightCols));
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

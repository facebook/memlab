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

function findEdge(node: IHeapNode, name: string) {
  return node.references.find(e => String(e.name_or_index) === name) ?? null;
}

interface RegisterEntry {
  index: number;
  target: IHeapNode;
  resolvedName: string | null;
}

/**
 * For a suspended generator/async frame, enumerate its
 * `parameters_and_registers` FixedArray. Register slots are opaque numeric
 * indices in the snapshot, but values that are *also* context-allocated show
 * up as named variables in the scope chain — so we cross-reference by target
 * node id to recover source variable names where possible (Feedback §3a).
 */
function inspectFrameRegisters(
  generator: IHeapNode,
  nameById: Map<number, string>,
  minRetained: number,
): RegisterEntry[] {
  const parEdge = findEdge(generator, 'parameters_and_registers');
  if (!parEdge) return [];
  const arr = parEdge.toNode;
  const entries: RegisterEntry[] = [];
  for (const edge of arr.references) {
    if (edge.type !== 'element') continue;
    const target = edge.toNode;
    if (target.id <= 3) continue;
    if (target.name === 'undefined' || target.name === 'the_hole') continue;
    if (target.retainedSize < minRetained) continue;
    const idx = Number(edge.name_or_index);
    entries.push({
      index: Number.isFinite(idx) ? idx : -1,
      target,
      resolvedName: nameById.get(target.id) ?? null,
    });
  }
  entries.sort((a, b) => b.target.retainedSize - a.target.retainedSize);
  return entries;
}

export function registerClosureInspection(server: McpServer): void {
  server.tool(
    'memlab_closure_inspection',
    'Inspect a closure (function) OR a suspended generator/async frame to show its captured/live variables. ' +
      'For closures, walks the FULL scope chain via "previous" edges on V8 Context objects, reporting variables ' +
      'at each scope depth. For generators (suspended async functions), additionally decodes the ' +
      '`parameters_and_registers` array and resolves register slots to source variable names where the value is ' +
      'also context-allocated. Shows the function name, source location, and all bound variables with types and sizes. ' +
      'Critical for diagnosing closure- and suspended-async-based memory leaks where a frame unintentionally retains large objects.',
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
      min_retained_size: z
        .number()
        .optional()
        .default(0)
        .describe(
          'Only show captured variables retaining at least this many bytes (default 0 = show all). ' +
            'Use e.g. 10240 for 10 KB to filter noise in deeply nested closures.',
        ),
      max_variables: z
        .number()
        .optional()
        .default(0)
        .describe(
          'Limit output to the top N variables by retained size (default 0 = no limit). ' +
            'Useful for deeply nested closures with hundreds of captured variables.',
        ),
    },
    async ({node_id, max_scope_depth, min_retained_size, max_variables}) => {
      try {
        const snapshot = getSnapshot();
        const node = snapshot.getNodeById(node_id);
        if (!node) {
          return errorResult(`Node with id ${node_id} not found`);
        }

        // A suspended generator/async frame has a parameters_and_registers
        // array. Treat such nodes as inspectable frames too.
        const registersEdge = findEdge(node, 'parameters_and_registers');
        const isGenerator = registersEdge != null;

        if (node.type !== 'closure' && !isGenerator) {
          return toolResult(
            `Node @${node_id} is not a closure or generator frame (type is "${node.type}"). This tool is designed for closure nodes and suspended generator/async frames (which expose parameters_and_registers).`,
          );
        }

        // For a generator, the function/closure lives behind the "function"
        // edge; resolve scope context and shared info from there.
        const fnNode = isGenerator
          ? (findEdge(node, 'function')?.toNode ?? node)
          : node;

        // Also look for the "shared" edge which points to SharedFunctionInfo
        const sharedEdge =
          fnNode.references.find(
            e => String(e.name_or_index) === 'shared' && e.type === 'internal',
          ) ?? findEdge(fnNode, 'shared');

        // Get the context chain — the scope object this frame closes over
        const contextEdge =
          fnNode.references.find(
            e => String(e.name_or_index) === 'context' && e.type === 'internal',
          ) ??
          findEdge(node, 'context') ??
          findEdge(fnNode, 'context');

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

        const totalVarCount = allVars.length;
        const totalVarRetained = allVars.reduce(
          (sum, v) => sum + v.retained_size,
          0,
        );

        let filteredVars = allVars;
        if (min_retained_size > 0) {
          filteredVars = filteredVars.filter(
            v => v.retained_size >= min_retained_size,
          );
        }
        const effectiveMax =
          max_variables > 0 ? max_variables : filteredVars.length;
        const omittedVars = filteredVars.slice(effectiveMax);
        const omittedRetained = omittedVars.reduce(
          (sum, v) => sum + v.retained_size,
          0,
        );
        filteredVars = filteredVars.slice(0, effectiveMax);

        const locNode = fnNode.location ? fnNode : node;
        const location = locNode.location
          ? {
              script_id: locNode.location.script_id,
              line: locNode.location.line,
              column: locNode.location.column,
            }
          : null;

        const lines = [
          `**${isGenerator ? 'Suspended frame' : 'Closure'}:** ${formatNodeInline(node.id, node.name, node.type, node.self_size)}`,
          `**Self Size:** ${formatBytes(node.self_size)} | **Retained Size:** ${formatBytes(node.retainedSize)}`,
        ];
        if (isGenerator && fnNode !== node) {
          lines.push(
            `**Function:** ${formatNodeInline(fnNode.id, fnNode.name, fnNode.type, fnNode.self_size)}`,
          );
        }
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
        const showingNote =
          filteredVars.length < totalVarCount
            ? ` (showing ${formatNumber(filteredVars.length)} of ${formatNumber(totalVarCount)})`
            : '';
        lines.push(
          `**Captured Variables:** ${formatNumber(totalVarCount)}, total retained ${formatBytes(totalVarRetained)}` +
            (chainDepth > 1 ? ` (across ${chainDepth} scope levels)` : '') +
            showingNote,
        );
        lines.push('');

        if (filteredVars.length > 0) {
          const hasMultipleDepths =
            new Set(filteredVars.map(v => v.depth)).size > 1;
          const headers = hasMultipleDepths
            ? ['Depth', 'Variable', 'Target', 'Target Type', 'Retained']
            : ['Variable', 'Target', 'Target Type', 'Retained'];
          const rightCols = hasMultipleDepths ? new Set([4]) : new Set([3]);
          const rows = filteredVars.map(v => {
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

          if (omittedVars.length > 0) {
            lines.push('');
            lines.push(
              `… and ${formatNumber(omittedVars.length)} more variable(s) retaining ${formatBytes(omittedRetained)} total` +
                (min_retained_size > 0
                  ? ` (filtered below ${formatBytes(min_retained_size)})`
                  : ''),
            );
          }
        } else if (totalVarCount > 0) {
          lines.push(
            `All ${formatNumber(totalVarCount)} variables are below the ${formatBytes(min_retained_size)} threshold (${formatBytes(totalVarRetained)} total). Lower min_retained_size to see them.`,
          );
        }

        // For suspended generator/async frames, decode parameters_and_registers.
        if (isGenerator) {
          const nameById = new Map<number, string>();
          for (const v of allVars) {
            if (!nameById.has(v.target_id)) {
              nameById.set(v.target_id, v.variable_name);
            }
          }
          const regs = inspectFrameRegisters(node, nameById, min_retained_size);
          lines.push('');
          lines.push(
            `**Live registers (\`parameters_and_registers\`):** ${formatNumber(regs.length)} slot(s) retaining ≥ ${formatBytes(min_retained_size)}`,
          );
          if (regs.length > 0) {
            const effMax = max_variables > 0 ? max_variables : regs.length;
            const headers = [
              'Slot',
              'Source name',
              'Target',
              'Type',
              'Retained',
            ];
            const rightCols = new Set([4]);
            const rows = regs.slice(0, effMax).map(r => {
              let targetLabel = `@${r.target.id} ${r.target.name}`;
              if (r.target.isString) {
                const s = r.target.toStringNode();
                if (s) {
                  const v = s.stringValue;
                  targetLabel = `@${r.target.id} "${v.length > 50 ? v.slice(0, 50) + '...' : v}"`;
                }
              }
              return [
                r.index >= 0 ? `[${r.index}]` : '?',
                r.resolvedName ?? '(unnamed register)',
                targetLabel,
                r.target.type,
                formatBytes(r.target.retainedSize),
              ];
            });
            lines.push('');
            lines.push(markdownTable(headers, rows, rightCols));
            lines.push('');
            lines.push(
              '_Register slots are bytecode-local indices. Names are recovered when the value is also context-allocated (appears in the scope chain above); slots shown as "(unnamed register)" are stack-only temporaries whose source name is not in the snapshot._',
            );
          }
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

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
import {getSnapshot} from '../heap-state.js';
import {
  filterLargestObjects,
  formatBytes,
  truncateDomToTag,
  errorResult,
  toolResult,
} from '../utils.js';

interface TraceStep {
  name: string;
  type: string;
  edgeName?: string;
}

const FRAMEWORK_PATTERNS = new Set([
  'system / Context',
  'system / PromiseReaction',
  'system / NativeContext',
  'system / ScriptContext',
  'system / FunctionContext',
  'system / BlockContext',
  'system / CatchContext',
  'system / WithContext',
  'system / EvalContext',
  'system / ModuleContext',
  'system / Oddball',
  '(GC roots)',
  '(Strong roots)',
  '(Builtins)',
  '(Startup object cache)',
]);

function isFrameworkStep(step: TraceStep): boolean {
  if (FRAMEWORK_PATTERNS.has(step.name)) return true;
  if (step.name.startsWith('system / ')) return true;
  if (step.type === 'hidden' || step.type === 'synthetic') return true;
  if (step.name === 'require' && step.type === 'closure') return true;
  if (step.edgeName === 'cache' && step.name === 'Object') return true;
  return false;
}

function getRetainerTrace(node: IHeapNode): TraceStep[] | null {
  if (!node.hasPathEdge) return null;

  const visited = new Set<number>([node.id]);
  let curNode: IHeapNode | null = node;
  const reverseSteps: TraceStep[] = [{name: curNode.name, type: curNode.type}];

  while (curNode && curNode.hasPathEdge) {
    const edge: IHeapEdge | null = curNode.pathEdge;
    if (!edge) break;
    const fromNode: IHeapNode = edge.fromNode;
    if (visited.has(fromNode.id)) break;
    visited.add(fromNode.id);
    reverseSteps.push({
      name: fromNode.name,
      type: fromNode.type,
      edgeName: String(edge.name_or_index),
    });
    curNode = fromNode;
  }

  reverseSteps.reverse();
  return reverseSteps;
}

function normalizeEdgeName(name: string): string {
  return /^\d+$/.test(name) ? '*' : name;
}

function traceToKey(steps: TraceStep[], frameworkFilter: boolean): string {
  const filtered = frameworkFilter
    ? steps.filter(
        (s, i) => i === 0 || i === steps.length - 1 || !isFrameworkStep(s),
      )
    : steps;
  return filtered
    .map(s => {
      const edge =
        s.edgeName != null ? `--${normalizeEdgeName(s.edgeName)}-->` : '';
      return `${s.name}(${s.type})${edge}`;
    })
    .join(' ');
}

function shortenPath(name: string): string {
  const isDomLike =
    name.includes('class="') ||
    name.includes('aria-') ||
    name.startsWith('<') ||
    name.startsWith('Detached <');
  if (isDomLike) return truncateDomToTag(name);
  if (name.length <= 40) return name;
  const parts = name.split('/');
  if (parts.length <= 2) return name;
  const fileName = parts[parts.length - 1];
  const dir = parts[parts.length - 2];
  return `…/${dir}/${fileName}`;
}

function formatTraceChain(steps: TraceStep[]): string {
  const parts: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    parts.push(`${s.name} (${s.type})`);
    if (s.edgeName != null && i < steps.length - 1) {
      parts.push(` --${s.edgeName}--> `);
    }
  }
  return parts.join('');
}

function formatTraceChainCompact(
  steps: TraceStep[],
  frameworkFilter: boolean,
): string {
  const filtered = frameworkFilter
    ? steps.filter(
        (s, i) => i === 0 || i === steps.length - 1 || !isFrameworkStep(s),
      )
    : steps;
  const parts: string[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const s = filtered[i];
    const name = shortenPath(s.name);
    if (i === 0 || i === filtered.length - 1) {
      const suffix = s.type === 'closure' ? '()' : '';
      parts.push(`${name}${suffix}`);
    } else {
      parts.push(name);
    }
  }
  return parts.join(' → ');
}

export function registerRetainerSummary(server: McpServer): void {
  server.tool(
    'memlab_retainer_summary',
    'Trace retainer paths for multiple instances of a class (or a specific set of node IDs) and group by common patterns. Instead of tracing one node at a time, this samples N instances and shows how many share each retainer path pattern. Essential for confirming whether leaked objects share a single root cause. Use node_ids to cluster retainer patterns for specific nodes (e.g., example_node_ids from duplicated_strings). Set compact=true for abbreviated paths that use 50-70% fewer tokens.',
    {
      class_name: z
        .string()
        .optional()
        .describe(
          'The constructor/class name to analyze. Supports exact match and substring match (e.g., "Detached <div>" will match V8\'s detached DOM naming). Required if node_ids and name_prefix are not provided.',
        ),
      name_prefix: z
        .string()
        .optional()
        .describe(
          'Match nodes whose name starts with this prefix (e.g., "Detached" matches all detached DOM nodes regardless of element type). Use instead of class_name when the exact name varies.',
        ),
      shape: z
        .array(z.string())
        .optional()
        .describe(
          'Find objects by property shape — objects that have ALL of these property names. ' +
            'Use instead of class_name when constructor is "Object" and you know the property ' +
            'structure (e.g., ["callback", "context"]). Matches the {prop1, prop2} naming ' +
            'from shape_histogram output.',
        ),
      node_ids: z
        .array(z.number())
        .optional()
        .describe(
          'Specific node IDs to analyze instead of searching by class name. Use this with example_node_ids from duplicated_strings or other tools.',
        ),
      sample: z
        .number()
        .optional()
        .default(10)
        .describe(
          'Number of instances to sample, picked from the largest by retained size (default 10). Only applies when using class_name.',
        ),
      max_depth: z
        .number()
        .optional()
        .describe(
          'Truncate each retainer trace to this many nodes from the GC root before grouping. Useful for grouping traces that diverge only in the last few hops.',
        ),
      compact: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Use compact retainer path format with abbreviated names and → arrows. Reduces token usage by 50-70%.',
        ),
      framework_filter: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Exclude known V8/Node.js framework internals (system / Context, PromiseReaction, module cache patterns) from retainer paths. Helps surface application-level retention.',
        ),
      include_properties: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'For each sampled node, also show its direct property edges (name -> target type/name). ' +
            'Combines "where is it retained?" with "what does it contain?" in one call. ' +
            'Saves a follow-up memlab_object_shape call per node.',
        ),
    },
    async ({
      class_name,
      name_prefix,
      shape,
      node_ids,
      sample,
      max_depth,
      compact,
      framework_filter,
      include_properties,
    }) => {
      try {
        const snapshot = getSnapshot();

        let nodes: IHeapNode[];
        let label: string;

        if (node_ids && node_ids.length > 0) {
          nodes = [];
          for (const id of node_ids) {
            const node = snapshot.getNodeById(id);
            if (node) nodes.push(node);
          }
          label = `${nodes.length} specified node(s)`;
        } else if (shape && shape.length > 0) {
          const requiredProps = new Set(shape);
          nodes = filterLargestObjects(
            snapshot,
            node => {
              if (node.type !== 'object' || node.id <= 3) return false;
              const foundProps = new Set<string>();
              for (const edge of node.references) {
                if (edge.type === 'property') {
                  const name = String(edge.name_or_index);
                  if (requiredProps.has(name)) foundProps.add(name);
                }
              }
              return foundProps.size === requiredProps.size;
            },
            sample,
          );
          label = `shape {${shape.join(', ')}}`;
        } else if (name_prefix) {
          nodes = filterLargestObjects(
            snapshot,
            node => node.name.startsWith(name_prefix),
            sample,
          );
          label = `prefix "${name_prefix}"`;
        } else if (class_name) {
          // Try exact match first
          nodes = filterLargestObjects(
            snapshot,
            node => node.name === class_name,
            sample,
          );
          // Fall back to substring match (handles V8 detached DOM names
          // like "Detached <div>" which contain angle brackets)
          if (nodes.length === 0) {
            nodes = filterLargestObjects(
              snapshot,
              node => node.name.includes(class_name),
              sample,
            );
          }
          label = `"${class_name}"`;
        } else {
          return errorResult(
            new Error(
              'Either class_name, name_prefix, shape, or node_ids must be provided.',
            ),
          );
        }

        if (nodes.length === 0) {
          const suggestions: string[] = [`No objects found for ${label}.`, ''];
          if (class_name) {
            suggestions.push(
              `**Possible reasons:**`,
              `- The class name may not match exactly — V8 uses constructor names, not class declarations`,
              `- For DOM nodes, try \`name_prefix: "Detached"\` instead of class_name`,
              `- For shape-based queries, use \`memlab_find_by_shape\` with property names instead`,
              '',
              `**Try instead:**`,
              `- \`memlab_search_nodes\` with a regex pattern to find partial matches`,
              `- \`memlab_class_histogram\` to see all class names in the snapshot`,
              `- \`memlab_find_by_property\` if you know a property name on the target objects`,
            );
          }
          return toolResult(suggestions.join('\n'));
        }

        const patterns = new Map<
          string,
          {
            steps: TraceStep[];
            count: number;
            example_ids: number[];
            total_retained: number;
          }
        >();
        let noTrace = 0;
        let earlyStop = false;
        const EARLY_STOP_THRESHOLD = 5;

        for (let ni = 0; ni < nodes.length; ni++) {
          const node = nodes[ni];
          const trace = getRetainerTrace(node);
          if (!trace) {
            noTrace++;
            continue;
          }

          const steps =
            max_depth != null && max_depth > 0 && max_depth < trace.length
              ? trace.slice(0, max_depth)
              : trace;
          const key = traceToKey(steps, framework_filter);

          const existing = patterns.get(key);
          if (existing) {
            existing.count++;
            if (existing.example_ids.length < 3) {
              existing.example_ids.push(node.id);
            }
            existing.total_retained += node.retainedSize;
          } else {
            patterns.set(key, {
              steps,
              count: 1,
              example_ids: [node.id],
              total_retained: node.retainedSize,
            });
          }

          const tracedSoFar = ni + 1 - noTrace;
          if (
            tracedSoFar >= EARLY_STOP_THRESHOLD &&
            patterns.size === 1 &&
            ni < nodes.length - 1
          ) {
            earlyStop = true;
            break;
          }
        }

        const sorted = [...patterns.values()].sort((a, b) => b.count - a.count);
        const totalSampled = sorted.reduce((s, p) => s + p.count, 0) + noTrace;

        const modifiers: string[] = [];
        if (max_depth) modifiers.push(`depth limited to ${max_depth}`);
        if (compact) modifiers.push('compact');
        if (framework_filter) modifiers.push('framework filtered');
        if (earlyStop) modifiers.push('early termination — high confidence');
        const modStr = modifiers.length > 0 ? `, ${modifiers.join(', ')}` : '';

        const lines = [
          `Retainer summary for ${label} (${totalSampled} sampled${modStr})`,
          '',
        ];

        if (sorted.length === 1) {
          const conf = earlyStop
            ? ' (early termination — all samples matched)'
            : '';
          lines.push(
            `**All ${sorted[0].count} sampled instances share the same retainer pattern** — likely a single root cause.${conf}`,
            '',
          );
        } else {
          lines.push(
            `**${sorted.length} distinct retainer patterns found:**`,
            '',
          );
        }

        const filterSteps = (steps: TraceStep[]): TraceStep[] =>
          framework_filter
            ? steps.filter(
                (s, i) =>
                  i === 0 || i === steps.length - 1 || !isFrameworkStep(s),
              )
            : steps;
        const formatFn = compact
          ? (steps: TraceStep[]) =>
              formatTraceChainCompact(steps, framework_filter)
          : (steps: TraceStep[]) => formatTraceChain(filterSteps(steps));

        const getDisplaySteps = (p: {steps: TraceStep[]}) =>
          compact ? filterSteps(p.steps) : p.steps;

        let commonPrefixLen = 0;
        if (sorted.length > 1) {
          const allSteps = sorted.map(getDisplaySteps);
          const minLen = Math.min(...allSteps.map(s => s.length));
          for (let ci = 0; ci < minLen - 1; ci++) {
            const ref = allSteps[0][ci];
            const refKey = `${ref.name}(${ref.type})${ref.edgeName ?? ''}`;
            if (
              allSteps.every(s => {
                const step = s[ci];
                return (
                  `${step.name}(${step.type})${step.edgeName ?? ''}` === refKey
                );
              })
            ) {
              commonPrefixLen = ci + 1;
            } else {
              break;
            }
          }
        }

        if (commonPrefixLen >= 2) {
          const prefixSteps = getDisplaySteps(sorted[0]).slice(
            0,
            commonPrefixLen,
          );
          lines.push(`**Common prefix** (${commonPrefixLen} nodes):`);
          lines.push(formatFn(prefixSteps));
          lines.push('');
        }

        for (let i = 0; i < sorted.length; i++) {
          const p = sorted[i];
          const pct = ((p.count / totalSampled) * 100).toFixed(0);
          lines.push(
            `### Pattern ${i + 1}: ${p.count}/${totalSampled} instances (${pct}%), ${formatBytes(p.total_retained)} retained`,
          );
          lines.push('');
          const displaySteps =
            commonPrefixLen >= 2
              ? getDisplaySteps(p).slice(commonPrefixLen)
              : p.steps;
          lines.push(
            commonPrefixLen >= 2
              ? `… → ${formatFn(displaySteps)}`
              : formatFn(displaySteps),
          );
          lines.push('');
          lines.push(
            `Example nodes: ${p.example_ids.map(id => `@${id}`).join(', ')}`,
          );

          if (include_properties) {
            for (const exId of p.example_ids.slice(0, 2)) {
              const exNode = snapshot.getNodeById(exId);
              if (!exNode) continue;
              const props: string[] = [];
              for (const edge of exNode.references) {
                if (
                  edge.type === 'property' ||
                  edge.type === 'element' ||
                  edge.type === 'context'
                ) {
                  const target = edge.toNode;
                  if (target.id <= 3) continue;
                  let valPreview: string;
                  if (target.isString) {
                    const strNode = target.toStringNode();
                    const sv = strNode?.stringValue ?? target.name;
                    valPreview = `"${sv.length > 30 ? sv.slice(0, 27) + '...' : sv}"`;
                  } else {
                    valPreview = `${target.name} (${target.type})`;
                  }
                  props.push(`${String(edge.name_or_index)}: ${valPreview}`);
                  if (props.length >= 8) break;
                }
              }
              if (props.length > 0) {
                lines.push(`  @${exId} properties: {${props.join(', ')}}`);
              }
            }
          }

          lines.push('');
        }

        if (noTrace > 0) {
          const noTraceNodes = nodes.filter(n => !n.hasPathEdge);
          const withReferrers = noTraceNodes.filter(
            n => n.numOfReferrers > 0,
          ).length;
          const noReferrers = noTrace - withReferrers;
          const parts: string[] = [
            `${noTrace} instance(s) had no retainer path:`,
          ];
          if (noReferrers > 0) {
            parts.push(
              `${noReferrers} with no referrers (GC-eligible, safe to ignore)`,
            );
          }
          if (withReferrers > 0) {
            parts.push(
              `${withReferrers} with referrers but no GC root path (possibly weak-only retention — use \`memlab_get_referrers\` to inspect)`,
            );
          }
          lines.push(`(${parts.join('; ')})`);
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

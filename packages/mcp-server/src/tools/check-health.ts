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
import {getSnapshot, getSnapshotEnv} from '../heap-state.js';
import {formatBytes, formatNumber, errorResult, toolResult} from '../utils.js';

type Severity = 'critical' | 'warning' | 'info';

interface Finding {
  severity: Severity;
  title: string;
  detail: string;
  next_step: string;
}

export function registerCheckHealth(server: McpServer): void {
  server.tool(
    'memlab_check_health',
    'Run all heuristic health checks in one call and return a prioritized list of findings. This is the recommended first step after loading a snapshot — it replaces calling 4-5 individual tools to triage.',
    {},
    async () => {
      try {
        const snapshot = getSnapshot();
        const env = getSnapshotEnv();
        const findings: Finding[] = [];

        let totalSize = 0;
        let totalStringSize = 0;
        let detachedCount = 0;
        const classCounts = new Map<string, number>();
        const stringCounts = new Map<
          string,
          {count: number; totalSize: number}
        >();

        let largestObjId = 0;
        let largestObjName = '';
        let largestObjSize = 0;
        let largestObjType = '';

        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          totalSize += node.self_size;

          if (node.type === 'string') {
            totalStringSize += node.self_size;
            if (node.name !== 'system / SlicedString') {
              const key =
                node.name.length > 100 ? node.name.slice(0, 100) : node.name;
              const entry = stringCounts.get(key);
              if (entry) {
                entry.count++;
                entry.totalSize += node.retainedSize;
              } else {
                stringCounts.set(key, {count: 1, totalSize: node.retainedSize});
              }
            }
          }

          if (
            (node.type === 'object' ||
              node.type === 'closure' ||
              node.type === 'regexp') &&
            node.retainedSize > largestObjSize
          ) {
            largestObjId = node.id;
            largestObjName = node.name;
            largestObjSize = node.retainedSize;
            largestObjType = node.type;
          }

          if (env !== 'node') {
            if (node.is_detached || node.name.startsWith('Detached ')) {
              detachedCount++;
            }
          }

          if (node.type !== 'hidden' && node.type !== 'array') {
            classCounts.set(node.name, (classCounts.get(node.name) ?? 0) + 1);
          }
        });

        // Check 1: Single object retaining >5% of heap
        if (totalSize > 0 && largestObjSize >= totalSize * 0.05) {
          const pct = ((largestObjSize / totalSize) * 100).toFixed(0);
          const sev: Severity =
            largestObjSize >= totalSize * 0.3 ? 'critical' : 'warning';
          findings.push({
            severity: sev,
            title: `Single object retains ${pct}% of heap`,
            detail: `@${largestObjId} \`${largestObjName}\` (${largestObjType}) retains ${formatBytes(largestObjSize)}`,
            next_step: `memlab_retainer_trace with node_id ${largestObjId}`,
          });
        }

        // Check 2: String bytes > 30% of heap
        if (totalSize > 0 && totalStringSize >= totalSize * 0.3) {
          const pct = ((totalStringSize / totalSize) * 100).toFixed(0);
          findings.push({
            severity: 'warning',
            title: `Strings consume ${pct}% of heap (${formatBytes(totalStringSize)})`,
            detail:
              'High string memory usage may indicate duplicated strings, large JSON payloads, or template strings',
            next_step:
              'memlab_duplicated_strings followed by memlab_string_patterns',
          });
        }

        // Check 3: Heavily duplicated strings (>5 MB total)
        const heavyDups = [...stringCounts.entries()]
          .filter(([, s]) => s.count >= 100 && s.totalSize >= 5 * 1024 * 1024)
          .sort((a, b) => b[1].totalSize - a[1].totalSize)
          .slice(0, 3);
        for (const [val, stats] of heavyDups) {
          const display = val.length > 50 ? val.slice(0, 50) + '...' : val;
          findings.push({
            severity: 'warning',
            title: `"${display}" duplicated ${formatNumber(stats.count)} times`,
            detail: `Total retained: ${formatBytes(stats.totalSize)}`,
            next_step:
              'memlab_duplicated_strings then memlab_retainer_summary with class_name "string"',
          });
        }

        // Check 4: Detached DOM (browser only)
        if (env !== 'node' && detachedCount > 0) {
          const sev: Severity = detachedCount >= 100 ? 'warning' : 'info';
          findings.push({
            severity: sev,
            title: `${formatNumber(detachedCount)} detached DOM node(s)`,
            detail: 'Detached DOM elements still retained in memory',
            next_step: 'memlab_detached_dom',
          });
        }

        // Check 5: Subscription/listener accumulation
        const listenerKeywords = new Set([
          'callback',
          'handler',
          'listener',
          'fn',
        ]);
        const contextKeywords = new Set([
          'context',
          'ctx',
          'this',
          'target',
          'scope',
        ]);
        const shapeAccum = new Map<
          string,
          {count: number; totalSelfSize: number; exampleId: number}
        >();

        snapshot.nodes.forEach(node => {
          if (node.type !== 'object' || node.id <= 3) return;
          if (node.name !== 'Object') return;
          const names: string[] = [];
          for (const edge of node.references) {
            if (edge.type === 'property') {
              names.push(String(edge.name_or_index));
            }
          }
          if (names.length === 0 || names.length > 10) return;
          const hasListener = names.some(
            n => listenerKeywords.has(n) || n.startsWith('on'),
          );
          const hasContext = names.some(n => contextKeywords.has(n));
          if (!hasListener || !hasContext) return;
          names.sort();
          const key = names.join(',');
          const existing = shapeAccum.get(key);
          if (existing) {
            existing.count++;
            existing.totalSelfSize += node.self_size;
          } else {
            shapeAccum.set(key, {
              count: 1,
              totalSelfSize: node.self_size,
              exampleId: node.id,
            });
          }
        });

        for (const [shape, stats] of shapeAccum) {
          if (stats.count < 100000) continue;
          const sev: Severity =
            stats.totalSelfSize >= totalSize * 0.1
              ? 'critical'
              : stats.totalSelfSize >= totalSize * 0.05
                ? 'warning'
                : 'info';
          findings.push({
            severity: sev,
            title: `${formatNumber(stats.count)} listener/subscription objects with shape {${shape}}`,
            detail: `Total self size: ${formatBytes(stats.totalSelfSize)}. These objects have callback/handler + context properties, suggesting event listener or subscription registrations that are accumulating.`,
            next_step: `memlab_retainer_summary with node_ids [${stats.exampleId}] to trace the retention pattern`,
          });
        }

        // Check 6: Repeated Error accumulation
        const errorNames = new Set([
          'Error',
          'SyntaxError',
          'TypeError',
          'ReferenceError',
          'RangeError',
          'URIError',
          'EvalError',
          'AggregateError',
        ]);
        const errorMessages = new Map<
          string,
          {count: number; errorType: string; exampleId: number}
        >();

        snapshot.nodes.forEach(node => {
          if (node.type !== 'object' || node.id <= 3) return;
          if (!errorNames.has(node.name)) return;
          for (const edge of node.references) {
            if (
              String(edge.name_or_index) === 'message' &&
              edge.toNode.isString
            ) {
              const strNode = edge.toNode.toStringNode();
              if (!strNode) break;
              const msg = strNode.stringValue;
              const key = `${node.name}::${msg}`;
              const existing = errorMessages.get(key);
              if (existing) {
                existing.count++;
              } else {
                errorMessages.set(key, {
                  count: 1,
                  errorType: node.name,
                  exampleId: node.id,
                });
              }
              break;
            }
          }
        });

        for (const [, stats] of errorMessages) {
          if (stats.count < 50) continue;
          findings.push({
            severity: stats.count >= 500 ? 'warning' : 'info',
            title: `${formatNumber(stats.count)} identical \`${stats.errorType}\` instances`,
            detail:
              'Repeated identical error objects suggest a module failing to load or a retry loop',
            next_step: `memlab_get_node with node_id ${stats.exampleId} to inspect the error, then memlab_retainer_trace to find where it's created`,
          });
        }

        // Check 7: Classes with >10,000 instances
        const anomalousClasses = [...classCounts.entries()]
          .filter(([, count]) => count >= 10000)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);
        for (const [name, count] of anomalousClasses) {
          findings.push({
            severity: 'warning',
            title: `${formatNumber(count)} instances of \`${name}\``,
            detail:
              'Unusually high instance count may indicate accumulation or a leak',
            next_step: `memlab_retainer_summary with class_name "${name}"`,
          });
        }

        // Check 8: Retained module source code
        let moduleSourceSize = 0;
        let moduleSourceCount = 0;

        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          if (node.type !== 'string' && node.name !== 'system / ExternalString')
            return;
          if (node.self_size < 1024) return;
          const strNode = node.toStringNode();
          if (!strNode) return;
          const val = strNode.stringValue;
          if (
            val.includes('__d(') ||
            val.includes('define(') ||
            (val.includes('function(') && val.includes('module'))
          ) {
            moduleSourceSize += node.self_size;
            moduleSourceCount++;
          }
        });

        if (totalSize > 0 && moduleSourceSize >= 10 * 1024 * 1024) {
          const pct = ((moduleSourceSize / totalSize) * 100).toFixed(1);
          findings.push({
            severity: moduleSourceSize >= totalSize * 0.1 ? 'warning' : 'info',
            title: `${formatBytes(moduleSourceSize)} of retained module source code (${pct}% of heap)`,
            detail: `${formatNumber(moduleSourceCount)} string(s) containing JS module source (__d(), define(), function(module)). These are bundled source text retained after evaluation.`,
            next_step:
              'memlab_string_patterns to identify which modules are retained, then check if source can be released after evaluation',
          });
        }

        // Sort by severity
        const severityOrder: Record<Severity, number> = {
          critical: 0,
          warning: 1,
          info: 2,
        };
        findings.sort(
          (a, b) => severityOrder[a.severity] - severityOrder[b.severity],
        );

        if (findings.length === 0) {
          return toolResult(
            'No health issues detected. The heap looks healthy.\n\n' +
              'For deeper analysis, try `memlab_class_histogram` or `memlab_largest_objects`.',
          );
        }

        const icons: Record<Severity, string> = {
          critical: '🔴',
          warning: '🟡',
          info: '🔵',
        };
        const lines = findings.map(
          (f, i) =>
            `${i + 1}. ${icons[f.severity]} **${f.title}**\n` +
            `   ${f.detail}\n` +
            `   → Next: \`${f.next_step}\``,
        );

        return toolResult(
          `# Health Check: ${findings.length} finding(s)\n\n${lines.join('\n\n')}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

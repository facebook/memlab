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

        // Check 8: Meta module system accumulation (__d / require)
        let moduleDescriptorCount = 0;
        let moduleEntryCount = 0;

        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          if (node.type !== 'object') return;
          // Module descriptors created by __d() have a specific shape
          const hasFactory = node.references.some(
            e => String(e.name_or_index) === 'factory' && e.type === 'property',
          );
          const hasDependencies = node.references.some(
            e =>
              String(e.name_or_index) === 'dependencies' &&
              e.type === 'property',
          );
          if (hasFactory && hasDependencies) {
            moduleDescriptorCount++;
          }
          // Module entries in the require map
          if (node.name === 'Object') {
            const hasModule = node.references.some(
              e =>
                String(e.name_or_index) === 'module' && e.type === 'property',
            );
            const hasExports = node.references.some(
              e =>
                String(e.name_or_index) === 'exports' && e.type === 'property',
            );
            if (hasModule && hasExports) {
              moduleEntryCount++;
            }
          }
        });

        if (moduleDescriptorCount >= 10000 || moduleEntryCount >= 10000) {
          const total = moduleDescriptorCount + moduleEntryCount;
          findings.push({
            severity: total >= 100000 ? 'warning' : 'info',
            title: `Meta module system: ${formatNumber(moduleDescriptorCount)} descriptors, ${formatNumber(moduleEntryCount)} entries`,
            detail:
              'Large module registries from __d()/require() indicate the entire module graph is retained in memory. Check if unused modules can be lazily loaded or their factory functions released after initialization.',
            next_step:
              'memlab_find_by_shape with properties ["factory", "dependencies"] to inspect module descriptors',
          });
        }

        // Check 9: ALEA/AutoLogging event accumulation
        let aleaEventCount = 0;
        let aleaTotalSize = 0;

        snapshot.nodes.forEach(node => {
          if (node.id <= 3 || node.type !== 'object') return;
          const hasEventName = node.references.some(
            e =>
              (String(e.name_or_index) === 'event' ||
                String(e.name_or_index) === 'eventName' ||
                String(e.name_or_index) === 'event_name') &&
              e.type === 'property',
          );
          const hasLoggingData = node.references.some(
            e =>
              (String(e.name_or_index) === 'extra' ||
                String(e.name_or_index) === 'extraData' ||
                String(e.name_or_index) === 'loggingData') &&
              e.type === 'property',
          );
          if (hasEventName && hasLoggingData) {
            aleaEventCount++;
            aleaTotalSize += node.retainedSize;
          }
        });

        if (aleaEventCount >= 1000) {
          findings.push({
            severity: aleaTotalSize >= totalSize * 0.05 ? 'warning' : 'info',
            title: `${formatNumber(aleaEventCount)} AutoLogging/ALEA event objects (${formatBytes(aleaTotalSize)})`,
            detail:
              'Event objects with event/eventName + extra/loggingData properties are accumulating. This is a known pattern where logging events are queued but not flushed.',
            next_step:
              'memlab_find_by_shape with properties ["event", "extra"] to inspect event objects',
          });
        }

        // Check 10: Relay/Flux store sizes
        const storeNames = ['RelayModernStore', 'RelayStore', 'FluxStore'];
        snapshot.nodes.forEach(node => {
          if (node.id <= 3 || node.type !== 'object') return;
          if (!storeNames.includes(node.name)) return;
          if (node.retainedSize >= 5 * 1024 * 1024) {
            const pct =
              totalSize > 0
                ? ((node.retainedSize / totalSize) * 100).toFixed(1)
                : '?';
            findings.push({
              severity:
                node.retainedSize >= totalSize * 0.1 ? 'warning' : 'info',
              title: `\`${node.name}\` @${node.id} retains ${formatBytes(node.retainedSize)} (${pct}% of heap)`,
              detail:
                'Large Relay/Flux store may indicate stale query data or missing garbage collection of normalized records.',
              next_step: `memlab_dominator_subtree with node_id ${node.id} to see what the store retains`,
            });
          }
        });

        // Check 11: EventHandlerRefInternal leak pattern
        // Detects refs with non-null element but null handlers — the exact
        // pattern of a known memory leak where the DOM element is retained
        // after handlers are removed.
        let leakyHandlerRefCount = 0;
        let leakyHandlerRefExampleId = 0;
        let leakyHandlerRefTotalSize = 0;

        snapshot.nodes.forEach(node => {
          if (node.id <= 3 || node.type !== 'object') return;
          if (
            !node.name.includes('EventHandler') &&
            !node.name.includes('HandlerRef')
          )
            return;
          let hasElement = false;
          let handlersNull = false;
          for (const edge of node.references) {
            const eName = String(edge.name_or_index);
            if (
              (eName === '#element' ||
                eName === 'element' ||
                eName === '_element') &&
              edge.toNode.id > 3 &&
              edge.toNode.name !== 'undefined' &&
              edge.toNode.name !== 'null'
            ) {
              hasElement = true;
            }
            if (
              (eName === '#handlers' ||
                eName === 'handlers' ||
                eName === '_handlers') &&
              (edge.toNode.id <= 3 ||
                edge.toNode.name === 'null' ||
                edge.toNode.name === 'undefined')
            ) {
              handlersNull = true;
            }
          }
          if (hasElement && handlersNull) {
            leakyHandlerRefCount++;
            leakyHandlerRefTotalSize += node.retainedSize;
            if (!leakyHandlerRefExampleId) leakyHandlerRefExampleId = node.id;
          }
        });

        if (leakyHandlerRefCount >= 10) {
          findings.push({
            severity:
              leakyHandlerRefTotalSize >= totalSize * 0.01 ? 'warning' : 'info',
            title: `${formatNumber(leakyHandlerRefCount)} EventHandlerRef(s) with element but no handlers`,
            detail: `These refs retain DOM elements after their handlers were removed — a known leak pattern. Total retained: ${formatBytes(leakyHandlerRefTotalSize)}.`,
            next_step: `memlab_retainer_trace with node_id ${leakyHandlerRefExampleId} to trace the retention path`,
          });
        }

        // Check 12: Retained module source code
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

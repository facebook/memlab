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
import {getSnapshot, getSnapshotByHandle} from '../heap-state.js';
import {pageLines, paginate} from '../pagination.js';
import {
  analyzeContexts,
  scopeDeadBytes,
  type ContextAnalysis,
  type DeadScope,
} from '../context-analysis.js';
import {
  clampLabel,
  clampLabelTo,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

// One heap-wide pass per snapshot; paging and filters reuse it.
const cache = new WeakMap<IHeapSnapshot, ContextAnalysis>();

/** Dead slots as `contextId:name`, or null if the analysis has not run. */
export function cachedDeadSlots(snapshot: IHeapSnapshot): Set<string> | null {
  const analysis = cache.get(snapshot);
  if (analysis == null) return null;
  const slots = new Set<string>();
  for (const scope of analysis.scopes) {
    for (const ctx of scope.contexts) {
      for (const f of ctx.deadFields) slots.add(`${ctx.contextId}:${f.name}`);
    }
  }
  return slots;
}

export function deadContextAnalysis(snapshot: IHeapSnapshot): ContextAnalysis {
  let analysis = cache.get(snapshot);
  if (analysis == null) {
    analysis = analyzeContexts(snapshot);
    cache.set(snapshot, analysis);
  }
  return analysis;
}

function filterScopes(
  scopes: DeadScope[],
  script: string | undefined,
  minRetained: number,
): DeadScope[] {
  const needle = script?.toLowerCase();
  const out: DeadScope[] = [];
  for (const scope of scopes) {
    if (needle != null && !scope.scriptName.toLowerCase().includes(needle)) {
      continue;
    }
    if (minRetained <= 0) {
      out.push(scope);
      continue;
    }
    const contexts = scope.contexts
      .map(c => {
        const deadFields = c.deadFields.filter(
          f => f.retainedSize >= minRetained,
        );
        return {
          ...c,
          deadFields,
          deadRetainedSize: deadFields.reduce((s, f) => s + f.retainedSize, 0),
        };
      })
      .filter(c => c.deadFields.length > 0);
    if (contexts.length > 0) out.push({...scope, contexts});
  }
  return out;
}

function noMetadataText(analysis: ContextAnalysis): string {
  const scripts = analysis.scriptsWithoutScopes;
  const contexts = scripts.reduce((s, x) => s + x.contextCount, 0);
  return [
    '**Dead captured variables: not available for this snapshot.**',
    '',
    'The snapshot has no source scope tree (`meta.scope_fields` is absent). V8 writes it from version 15.6 (Chrome 156), and from 15.7 (Chrome 157) without script-level `let`/`const`, which any later script can read. Re-capture with Chrome 157 or newer to run this analysis.',
    '',
    `${formatNumber(contexts)} contexts in ${formatNumber(scripts.length)} scripts could not be checked. ` +
      'To inspect one closure by hand, use `memlab_closure_inspection`.',
  ].join('\n');
}

function scopeLabel(scope: DeadScope): string {
  const name = scope.scopeName || '(anonymous)';
  return `${name} [${scope.start}–${scope.end}]`;
}

export function registerDeadContextVariables(server: McpServer): void {
  server.tool(
    'memlab_dead_context_variables',
    'Find captured variables that no live code can read, heap-wide. Closures created in one scope share one Context, so a variable read only by a callback that is gone stays alive as long as ANY sibling closure does. ' +
      'Using the source scope tree V8 embeds in the snapshot (V8 15.6+ / Chrome 156+), this checks every Context slot against the closures and suspended async frames still on the heap and reports the slots nothing live can read, grouped by scope and ranked by the bytes they retain. ' +
      'Each row gives the script, the scope name and source offsets, the Context id and the dead value ids, ready for `memlab_retainer_trace` or `memlab_closure_inspection`. ' +
      'Snapshots from older V8 have no scope tree; the tool then says so and lists how many contexts could not be checked. Scripts that own contexts but have no scope tree are listed at the end.',
    {
      handle: z
        .string()
        .optional()
        .describe('Snapshot to analyze (defaults to the active one).'),
      script: z
        .string()
        .optional()
        .describe('Only scopes whose script name contains this text.'),
      min_retained_size: z
        .number()
        .optional()
        .default(0)
        .describe(
          'Only dead variables whose value retains at least this many bytes (default 0).',
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe('Index of the first scope to show (default 0).'),
      page_size: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(20)
        .describe('Scopes per page (default 20).'),
      contexts_per_scope: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(3)
        .describe('Contexts listed per scope, largest first (default 3).'),
      fields_per_context: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(5)
        .describe(
          'Dead variables listed per context, largest first (default 5).',
        ),
    },
    async ({
      handle,
      script,
      min_retained_size,
      offset,
      page_size,
      contexts_per_scope,
      fields_per_context,
    }) => {
      try {
        const snapshot =
          handle != null ? getSnapshotByHandle(handle) : getSnapshot();
        if (snapshot == null) {
          return errorResult(
            new Error(`Snapshot "${handle}" is not resident.`),
          );
        }
        const analysis = deadContextAnalysis(snapshot);
        if (!analysis.hasScopeMetadata) {
          return toolResult(noMetadataText(analysis));
        }

        const scopes = filterScopes(analysis.scopes, script, min_retained_size);
        const contextCount = scopes.reduce((s, x) => s + x.contexts.length, 0);
        const fieldCount = scopes.reduce(
          (s, x) => s + x.contexts.reduce((t, c) => t + c.deadFields.length, 0),
          0,
        );
        const deadBytes = scopes.reduce((s, x) => s + scopeDeadBytes(x), 0);
        const lines = [
          `**Dead captured variables:** ${formatNumber(fieldCount)} in ${formatNumber(contextCount)} contexts across ${formatNumber(scopes.length)} scopes, retaining ${formatBytes(deadBytes)}`,
          `Checked ${formatNumber(analysis.contextCount)} contexts against ${formatNumber(analysis.liveClosureCount)} live closures and suspended frames. ` +
            'Byte totals add up per-variable retained sizes; values reachable from two dead variables count once per variable.',
        ];
        if (scopes.length === 0) {
          lines.push('', 'No dead captured variables match.');
        }

        const paged = paginate(scopes, offset, page_size);
        const page = paged.items;
        const first = paged.offset;
        if (page.length > 0) {
          lines.push('');
          lines.push(
            markdownTable(
              [
                '#',
                'Scope',
                'Script',
                'Contexts',
                'Dead retained',
                'Dead variables',
              ],
              page.map((scope, i) => {
                const names = new Set<string>();
                for (const c of scope.contexts) {
                  for (const f of c.deadFields) names.add(f.name);
                }
                const shown = [...names].slice(0, 4).map(n => `\`${n}\``);
                if (names.size > 4) shown.push(`+${names.size - 4}`);
                return [
                  String(first + i + 1),
                  scopeLabel(scope),
                  // A script URL, not a node name: the session name width does
                  // not apply.
                  clampLabelTo(scope.scriptName || `@${scope.scriptId}`, 80),
                  formatNumber(scope.contexts.length),
                  formatBytes(scopeDeadBytes(scope)),
                  shown.join(', '),
                ];
              }),
              new Set([3, 4]),
            ),
          );
          const rootScopes = page.filter(s => s.isRootScope);
          for (const [i, scope] of page.entries()) {
            lines.push('');
            lines.push(
              `**${first + i + 1}. ${scopeLabel(scope)}** in ${scope.scriptName || `script @${scope.scriptId}`} (ScopeInfo @${scope.scopeInfoId}, ${formatNumber(scope.fieldCount)} context slots)`,
            );
            for (const ctx of scope.contexts.slice(0, contexts_per_scope)) {
              lines.push(
                `- Context @${ctx.contextId} (retains ${formatBytes(ctx.retainedSize)}; dead variables ${formatBytes(ctx.deadRetainedSize)})`,
              );
              for (const f of ctx.deadFields.slice(0, fields_per_context)) {
                const name = clampLabel(f.valueName, 60);
                lines.push(
                  `  - \`${f.name}\` → @${f.valueId} ${f.valueType} ${name} (retains ${formatBytes(f.retainedSize)})`,
                );
              }
              if (ctx.deadFields.length > fields_per_context) {
                lines.push(
                  `  - … ${formatNumber(ctx.deadFields.length - fields_per_context)} more`,
                );
              }
            }
            if (scope.contexts.length > contexts_per_scope) {
              lines.push(
                `- … ${formatNumber(scope.contexts.length - contexts_per_scope)} more contexts of this scope`,
              );
            }
          }
          if (rootScopes.length > 0) {
            lines.push('');
            lines.push(
              "_Rows for a script's root scope are module scopes on V8 15.7+. On a V8 15.6 capture they can be script-level `let`/`const`, which other scripts may read, so confirm those before acting._",
            );
          }
          lines.push('', ...pageLines(paged, 'scopes'));
        }

        const missing = analysis.scriptsWithoutScopes;
        if (missing.length > 0) {
          const contexts = missing.reduce((s, x) => s + x.contextCount, 0);
          lines.push('');
          lines.push(
            `**Scripts without a scope tree:** ${formatNumber(missing.length)} (${formatNumber(contexts)} contexts not checked): ` +
              missing
                .slice(0, 5)
                .map(
                  s =>
                    `${s.scriptName || `@${s.scriptId}`} (${formatNumber(s.contextCount)})`,
                )
                .join(', ') +
              (missing.length > 5 ? `, … ${missing.length - 5} more` : ''),
          );
        }
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

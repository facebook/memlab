/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Chains of contexts that share one ScopeInfo: context → closure (held in a
 * context variable) → the context that closure was created in, where both
 * contexts belong to the same function. Each call of that function pins the
 * previous call's scope, so a chain that lengthens per interaction is a leak
 * no class count shows (every link is a `system / Context`).
 *
 * The React Compiler's dev build makes the same shape by itself: it wraps
 * every hook call in a `_sN_$0` guard closure that captures the hook's
 * arguments, so V8 context-allocates the compiler temporaries `t0..tN`, and
 * cached effect closures then link each render's scope to the previous one.
 * The prod compile calls the hook directly and the chain cannot form; `tN`
 * names only survive unminified anyway. A chain linked only through them is
 * flagged rather than reported.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import memlabCore from '@memlab/core';
import {z} from 'zod';
import {isContext} from '../context-analysis.js';
import {getSnapshot} from '../heap-state.js';
import {
  armScanBudgetFor,
  resolveRungs,
  scaledTimeoutMs,
  withSnapshotAt,
} from '../snapshot-borrow.js';
import {rungPaths} from './eval-across.js';
import {sourceOfNode} from './module-attribution.js';
import {
  boundedDominatorRetainedSize,
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

const {NumericSet} = memlabCore;

const COMPILER_TEMP_RE = /^t\d+$/;

export interface ScopeChainGroup {
  scopeInfo: number;
  /** Contexts of this scope at either end of a link. */
  contexts: number;
  maxLength: number;
  /** Chains (from a head no link points at) of at least `minLength`. */
  chains: number;
  /** Linking variable -> how many links use it. */
  variables: Map<string, number>;
  /** Closure classes that carry the links. */
  closures: Map<string, number>;
  headOfLongest: number;
  devHookGuard: boolean;
  module: string | null;
  retained: number;
}

function ref(node: IHeapNode, name: string): IHeapNode | null {
  for (const e of node.references) {
    if (String(e.name_or_index) === name) return e.toNode;
  }
  return null;
}

/** Every same-ScopeInfo chain of at least `minLength` contexts, by scope. */
export function scopeChains(
  snapshot: IHeapSnapshot,
  minLength: number,
): ScopeChainGroup[] {
  // context id -> [variable, closure name, next context id] for links into a
  // context of the SAME scope.
  const links = new Map<number, Array<[string, string, number]>>();
  const scopeOf = new Map<number, number>();
  const pointedAt = new Set<number>();
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (!isContext(node)) return;
    const info = ref(node, 'scope_info');
    if (info == null) return;
    scopeOf.set(node.id, info.id);
  });
  snapshot.nodes.forEach((node: IHeapNode) => {
    const scope = scopeOf.get(node.id);
    if (scope == null) return;
    for (const e of node.references) {
      if (e.type !== 'context') continue;
      const closure = e.toNode;
      if (closure.type !== 'closure') continue;
      const next = ref(closure, 'context');
      if (next == null || next.id === node.id) continue;
      if (scopeOf.get(next.id) !== scope) continue;
      const list = links.get(node.id) ?? [];
      list.push([
        String(e.name_or_index),
        closure.name || '(anonymous)',
        next.id,
      ]);
      links.set(node.id, list);
      pointedAt.add(next.id);
    }
  });

  // Longest chain from each context, memoised; a cycle counts once.
  const depth = new Map<number, number>();
  const visiting = new Set<number>();
  const lengthFrom = (id: number): number => {
    const known = depth.get(id);
    if (known != null) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let best = 0;
    for (const [, , next] of links.get(id) ?? []) {
      best = Math.max(best, lengthFrom(next));
    }
    visiting.delete(id);
    depth.set(id, best + 1);
    return best + 1;
  };

  const groups = new Map<number, ScopeChainGroup>();
  const members = new Map<number, Set<number>>();
  for (const [id, list] of links) {
    const scope = scopeOf.get(id) as number;
    let g = groups.get(scope);
    if (g == null) {
      g = {
        scopeInfo: scope,
        contexts: 0,
        maxLength: 0,
        chains: 0,
        variables: new Map(),
        closures: new Map(),
        headOfLongest: id,
        devHookGuard: true,
        module: null,
        retained: 0,
      };
      groups.set(scope, g);
    }
    const seen = members.get(scope) ?? new Set<number>();
    members.set(scope, seen);
    seen.add(id);
    for (const [variable, closure, next] of list) {
      seen.add(next);
      g.variables.set(variable, (g.variables.get(variable) ?? 0) + 1);
      g.closures.set(closure, (g.closures.get(closure) ?? 0) + 1);
    }
    g.contexts = seen.size;
    const len = lengthFrom(id);
    if (!pointedAt.has(id) && len >= minLength) g.chains++;
    if (len > g.maxLength) {
      g.maxLength = len;
      g.headOfLongest = id;
    }
  }
  const out = [...groups.values()].filter(g => g.maxLength >= minLength);
  for (const g of out) {
    g.devHookGuard = [...g.variables.keys()].every(v =>
      COMPILER_TEMP_RE.test(v),
    );
    const head = snapshot.getNodeById(g.headOfLongest);
    if (head != null) {
      try {
        g.module = sourceOfNode(snapshot, head, 10).module;
      } catch {
        g.module = null;
      }
      const ids: number[] = [];
      for (
        let cur: number | undefined = g.headOfLongest;
        cur != null && ids.length < g.maxLength;
      ) {
        ids.push(cur);
        // Along the longest chain: the link whose chain from here is deepest.
        let next: number | undefined;
        for (const [, , n] of links.get(cur) ?? []) {
          if (next == null || (depth.get(n) ?? 0) > (depth.get(next) ?? 0)) {
            next = n;
          }
        }
        cur = next;
      }
      g.retained = boundedDominatorRetainedSize(
        new NumericSet(ids),
        snapshot,
      ).retained;
    }
  }
  return out.sort(
    (a, b) => b.maxLength - a.maxLength || b.contexts - a.contexts,
  );
}

function topEntries(m: Map<string, number>, n: number): string {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `\`${k}\`${m.size > 1 ? ` ×${formatNumber(v)}` : ''}`)
    .join(', ');
}

/**
 * The label that matches one scope across rungs: ScopeInfo ids differ per
 * capture, and the linking variables and their counts change as a chain grows.
 */
function scopeLabel(g: ScopeChainGroup): string {
  if (g.module != null) return g.module;
  const top = [...g.variables.entries()].sort((a, b) => b[1] - a[1])[0];
  return `(no module) via \`${top?.[0] ?? '?'}\``;
}

export function registerScopeChains(server: McpServer): void {
  server.tool(
    'memlab_scope_chains',
    "Chains of contexts that share one ScopeInfo — each call of a function pinning the previous call's scope through a closure held in a context variable. Every link is a `system / Context`, so no class count shows a chain that lengthens per interaction. Reports, per scope: the longest chain, how many chains, the linking variables and closures, the owning module and the longest chain's retained size. A chain linked only through React Compiler temporaries (`t0`..`tN`) is flagged as the dev hook-guard artifact, which a production compile does not create (confirm with `memlab_module_source` and `compare_to` a prod capture). With `run_dir` or `paths`, the longest chain per scope at every rung.",
    {
      min_length: z
        .number()
        .int()
        .min(2)
        .optional()
        .default(3)
        .describe('Shortest chain to report, in contexts (default 3).'),
      module: z
        .string()
        .optional()
        .describe('Only scopes whose module name contains this.'),
      run_dir: z
        .string()
        .optional()
        .describe('A leak-hunt round: measure the rungs of its ladder.'),
      rungs: z
        .array(z.number().int())
        .optional()
        .describe(
          'With `run_dir`, which rungs (0-based; negative counts from the end). Default: all.',
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Snapshot files to measure in order, instead of the active snapshot.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(15)
        .describe('Scopes to list (default 15).'),
    },
    async ({min_length, module, run_dir, rungs, paths, limit}) => {
      try {
        const keep = (gs: ScopeChainGroup[]) =>
          module != null && module !== ''
            ? gs.filter(g => (g.module ?? '').includes(module))
            : gs;
        const files =
          run_dir != null && run_dir !== ''
            ? rungPaths(run_dir, rungs)
            : (paths ?? []);
        if (files.length === 0) {
          const groups = keep(scopeChains(getSnapshot(), min_length));
          if (groups.length === 0) {
            return toolResult(
              `No same-scope context chain of ${min_length} or more in this snapshot.`,
            );
          }
          const rows = groups
            .slice(0, limit)
            .map(g => [
              g.module ?? '(no module)',
              topEntries(g.closures, 2),
              topEntries(g.variables, 3),
              formatNumber(g.maxLength),
              formatNumber(g.chains),
              formatNumber(g.contexts),
              formatBytes(g.retained),
              g.devHookGuard ? 'DEV hook-guard artifact' : 'app chain',
              `@${g.headOfLongest}`,
            ]);
          const artifacts = groups.filter(g => g.devHookGuard).length;
          return toolResult(
            [
              `## Same-scope context chains (≥${min_length})`,
              '',
              markdownTable(
                [
                  'Module',
                  'Closure',
                  'Linked by',
                  'Longest',
                  'Chains',
                  'Contexts',
                  'Longest retains',
                  'Kind',
                  'Head',
                ],
                rows,
                new Set([3, 4, 5, 6]),
              ),
              '',
              artifacts > 0
                ? `_${artifacts} scope(s) are linked only through compiler temporaries (\`t0\`..\`tN\`): the React Compiler dev hook guard context-allocates them, a prod compile does not. Confirm with \`memlab_module_source({module, compare_to: <prod capture>})\` before setting them aside._`
                : '_No chain here is linked only through compiler temporaries._',
              '_A chain that lengthens across rungs is the leak; a long but stable one is bounded. Pass `run_dir` for the per-rung lengths, and `memlab_retainer_trace` on a head for what holds it._',
            ].join('\n'),
          );
        }

        const {rungs: resolved, largestMB} = resolveRungs(files);
        const perRung: Map<string, number>[] = [];
        // Per label, at the latest rung it appears in: is EVERY chain under it
        // the dev hook-guard artifact? One real chain sharing the label is
        // enough to keep the row from being dismissed.
        const allGuard = new Map<string, boolean>();
        for (const rung of resolved) {
          armScanBudgetFor(scaledTimeoutMs(largestMB));
          const groups = await withSnapshotAt(rung.localPath, snap =>
            keep(scopeChains(snap, min_length)),
          );
          const lengths = new Map<string, number>();
          const guard = new Map<string, boolean>();
          for (const g of groups) {
            const label = scopeLabel(g);
            lengths.set(label, Math.max(lengths.get(label) ?? 0, g.maxLength));
            guard.set(label, (guard.get(label) ?? true) && g.devHookGuard);
          }
          for (const [label, v] of guard) allGuard.set(label, v);
          perRung.push(lengths);
        }
        const last = perRung[perRung.length - 1] ?? new Map();
        const labels = [...new Set(perRung.flatMap(m => [...m.keys()]))]
          .sort((a, b) => (last.get(b) ?? 0) - (last.get(a) ?? 0))
          .slice(0, limit);
        if (labels.length === 0) {
          return toolResult(
            `No same-scope context chain of ${min_length} or more at any of ${resolved.length} rung(s).`,
          );
        }
        const rows = labels.map(label => {
          const series = perRung.map(m => m.get(label) ?? 0);
          const everyRung =
            series.length > 1 &&
            series.every((v, i) => i === 0 || v > series[i - 1]);
          const grew = series[series.length - 1] > series[0];
          const gone =
            series[series.length - 1] === 0 && Math.max(...series) > 0;
          return [
            label,
            series.map(v => formatNumber(v)).join(' → '),
            allGuard.get(label) === true
              ? 'DEV hook-guard artifact'
              : gone
                ? 'gone by the last rung'
                : everyRung
                  ? '**lengthens every rung**'
                  : grew
                    ? 'grew, not every rung'
                    : 'bounded',
          ];
        });
        return toolResult(
          [
            `## Same-scope context chains per rung (longest, ≥${min_length})`,
            '',
            markdownTable(
              ['Scope (module)', 'Longest per rung', 'Reading'],
              rows,
            ),
            '',
            '_One row per module (the longest of its scopes), since ScopeInfo ids differ between captures. Run without `run_dir` on the last rung for heads and retained sizes._',
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

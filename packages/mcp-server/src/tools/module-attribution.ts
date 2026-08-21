/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * Attribute heap bytes to the MODULE that owns them.
 *
 * Why this exists, stated plainly because the failure it prevents is expensive:
 * in a bundled app every module-scope singleton is reached through the module
 * registry, so essentially every retainer path starts
 *
 *   Window -> requireDynamic -> .context -> modulesMap -> <Module> -> ...
 *
 * That prefix is shared by everything and therefore attributes nothing. A real
 * round sampled twelve instances of a growing class, observed that all twelve
 * "route through modulesMap", and concluded the growth was a known
 * module-registry leak. It was not — three unrelated telemetry modules were each
 * accumulating, and the registry was merely the road to all of them. The
 * sampling tool had even reported "0.0% sampled" and declined to name a cause;
 * the generic prefix made the wrong answer look confirmed.
 *
 * The fix is to report the MODULE NAME as the owner. `modulesMap` is a lookup
 * table whose property edges are module ids, so the module that owns a node is
 * the first module-export ancestor on its dominator chain.
 */

/** Edge names that bind a module registry in the bundler runtime's scope. */
const MODULE_REGISTRY_EDGE_NAMES = new Set([
  'modulesMap',
  'modules',
  '__webpack_module_cache__',
  'installedModules',
]);

/**
 * A registry has to be big to be a registry. A three-entry object called
 * `modules` is somebody's local variable, and attributing the heap to it would
 * be worse than not running.
 */
const MIN_REGISTRY_ENTRIES = 200;

interface Registry {
  node: IHeapNode;
  edgeName: string;
  /** module-export node id -> module id/name */
  moduleByNodeId: Map<number, string>;
}

export function findModuleRegistries(snapshot: IHeapSnapshot): Registry[] {
  const out: Registry[] = [];
  const seen = new Set<number>();
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.id <= 3) return;
    for (const edge of node.references) {
      const name = String(edge.name_or_index);
      if (!MODULE_REGISTRY_EDGE_NAMES.has(name)) continue;
      const reg = edge.toNode;
      if (reg == null || reg.id <= 3 || seen.has(reg.id)) continue;
      let entries = 0;
      const moduleByNodeId = new Map<number, string>();
      for (const e2 of reg.references) {
        if (e2.type !== 'property') continue;
        const key = String(e2.name_or_index);
        if (key === '__proto__') continue;
        entries++;
        const target = e2.toNode;
        if (target != null && target.id > 3) moduleByNodeId.set(target.id, key);
      }
      if (entries < MIN_REGISTRY_ENTRIES) continue;
      seen.add(reg.id);
      out.push({node: reg, edgeName: name, moduleByNodeId});
    }
  });
  return out;
}

interface ModuleStat {
  module: string;
  selfBytes: number;
  nodes: number;
}

/**
 * One pass with a memo indexed by `nodeIndex`: each node inherits its immediate
 * dominator's module unless it IS a module export, so the whole heap is
 * attributed in O(N) rather than one bounded walk per node.
 */
export function attributeByModule(
  snapshot: IHeapSnapshot,
  registries: Registry[],
): {stats: ModuleStat[]; attributed: number; unattributed: number} {
  const moduleOf = new Map<number, string>();
  for (const r of registries) {
    for (const [id, name] of r.moduleByNodeId) moduleOf.set(id, name);
  }
  const memo = new Map<number, string | null>();
  const resolve = (node: IHeapNode): string | null => {
    const direct = moduleOf.get(node.id);
    if (direct != null) return direct;
    const cached = memo.get(node.id);
    if (cached !== undefined) return cached;
    // Walk up, remembering the chain, then write the answer back to all of it.
    const chain: IHeapNode[] = [];
    let cur: IHeapNode | null = node;
    let answer: string | null = null;
    let hops = 0;
    const guard = new Set<number>();
    while (cur != null && hops < 200 && !guard.has(cur.id)) {
      guard.add(cur.id);
      const hit = moduleOf.get(cur.id);
      if (hit != null) {
        answer = hit;
        break;
      }
      const m = memo.get(cur.id);
      if (m !== undefined) {
        answer = m;
        break;
      }
      chain.push(cur);
      const dom: IHeapNode | null = cur.dominatorNode ?? null;
      if (dom == null || dom.id === cur.id) break;
      cur = dom;
      hops++;
    }
    for (const n of chain) memo.set(n.id, answer);
    return answer;
  };

  const byModule = new Map<string, ModuleStat>();
  let attributed = 0;
  let unattributed = 0;
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.id <= 3) return;
    const mod = resolve(node);
    if (mod == null) {
      unattributed += node.self_size;
      return;
    }
    attributed += node.self_size;
    let s = byModule.get(mod);
    if (!s) {
      s = {module: mod, selfBytes: 0, nodes: 0};
      byModule.set(mod, s);
    }
    s.selfBytes += node.self_size;
    s.nodes++;
  });
  return {
    stats: [...byModule.values()].sort((a, b) => b.selfBytes - a.selfBytes),
    attributed,
    unattributed,
  };
}

export function registerModuleAttribution(server: McpServer): void {
  server.tool(
    'memlab_module_attribution',
    'Attribute heap bytes to the MODULE that owns them, by walking the dominator tree up to the nearest module-registry export. ' +
      'Exists because in a bundled app the retainer path of every module-scope singleton begins with the same generic prefix — `Window -> require -> .context -> modulesMap -> <Module>` — which is shared by everything in the heap and therefore attributes NOTHING. ' +
      'A measured round sampled 12 instances of a growing class, saw that all 12 "route through modulesMap", and filed the growth as a known module-registry leak; in fact three unrelated telemetry modules were each accumulating and the registry was just the road to all of them. The sampling tool had reported "0.0% sampled" and refused to name a cause — the generic prefix is what made the wrong answer look confirmed. ' +
      'This reports the module name instead, so "the heap grew" becomes "WebLoom +63 MB, InteractionTracingMetrics +23 MB". Use it whenever a retainer trace bottoms out in a module registry.',
    {
      limit: z
        .number()
        .optional()
        .default(25)
        .describe('Maximum modules to report (default 25).'),
      min_bytes: z
        .number()
        .optional()
        .default(65536)
        .describe('Ignore modules attributed less than this (default 64 KB).'),
      name_pattern: z
        .string()
        .optional()
        .describe(
          'Optional case-insensitive substring/regex filter on the module id.',
        ),
    },
    async ({limit, min_bytes, name_pattern}) => {
      try {
        const snapshot = getSnapshot();
        if (!snapshot) {
          return errorResult(
            'No heap snapshot loaded. Use memlab_load_snapshot first.',
          );
        }
        const registries = findModuleRegistries(snapshot);
        if (registries.length === 0) {
          return errorResult(
            'No module registry found in this snapshot. This tool looks for a bundler registry bound as ' +
              [...MODULE_REGISTRY_EDGE_NAMES].map(n => `\`${n}\``).join(' / ') +
              ` with at least ${MIN_REGISTRY_ENTRIES} entries. ` +
              'If this app uses a different registry shape, attribute with `memlab_dominator_attribution` against candidate owners instead.',
          );
        }
        const {stats, attributed, unattributed} = attributeByModule(
          snapshot,
          registries,
        );
        let rows = stats.filter(s => s.selfBytes >= min_bytes);
        if (name_pattern != null && name_pattern.length > 0) {
          let re: RegExp;
          try {
            re = new RegExp(name_pattern, 'i');
          } catch {
            re = new RegExp(
              name_pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
              'i',
            );
          }
          rows = rows.filter(s => re.test(s.module));
        }
        const total = attributed + unattributed;
        const lines: string[] = [
          '## Heap attributed by owning module',
          '',
          `Registries found: ${registries
            .map(
              r =>
                `\`${r.edgeName}\` (${formatNumber(r.moduleByNodeId.size)} modules)`,
            )
            .join(', ')}`,
          `Attributed to a module: **${formatBytes(attributed)}**` +
            (total > 0
              ? ` (${((attributed / total) * 100).toFixed(1)}%)`
              : '') +
            ` · not owned by any module: ${formatBytes(unattributed)}`,
          '',
        ];
        if (rows.length === 0) {
          lines.push('_No module is attributed more than the floor._');
          return toolResult(lines.join('\n'));
        }
        lines.push(
          markdownTable(
            ['Module', 'Self bytes', '% of attributed', 'Nodes'],
            rows
              .slice(0, limit)
              .map(s => [
                s.module.length > 60 ? s.module.slice(0, 57) + '…' : s.module,
                formatBytes(s.selfBytes),
                attributed > 0
                  ? `${((s.selfBytes / attributed) * 100).toFixed(1)}%`
                  : '—',
                formatNumber(s.nodes),
              ]),
            new Set([1, 2, 3]),
          ),
        );
        lines.push(
          '',
          '_Attribution is by SELF size up the dominator tree, so the figures partition the heap and are additive — a node is counted under exactly one module. "Not owned by any module" is the DOM, native/Blink objects, V8 internals and anything a module does not dominate; a large remainder is normal and is not a gap in the measurement._',
          '_A module being large is not a leak. Compare two captures — run this on each and diff the table — to turn "large" into "growing"._',
        );
        return toolResult(lines.join('\n'));
      } catch (error) {
        return errorResult(
          `Failed to attribute by module: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}

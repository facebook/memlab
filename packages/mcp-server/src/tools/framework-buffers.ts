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
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import fs from 'fs';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {cachedPathLabeler, shapeFamilyOf} from '../heap-families.js';
import {moduleRecords, moduleScopeVars} from '../module-registry.js';
import {entriesRetainedOf} from './cache-analysis.js';
import {countEntries} from './collection-trend.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

interface BufferRow {
  buffer: string;
  where: string;
  entries: number | null;
  bytes: number;
  note: string;
}

const COLLECTIONS = new Set(['Map', 'Set', 'Array', 'WeakMap']);

function edgeTo(node: IHeapNode, name: string): IHeapNode | null {
  for (const e of node.references) {
    if (String(e.name_or_index) === name) return e.toNode;
  }
  return null;
}

function held(node: IHeapNode, snapshot: IHeapSnapshot): number {
  return Math.max(
    node.retainedSize,
    entriesRetainedOf(node, snapshot)?.retained ?? 0,
  );
}

/** The largest collection among a module's exports and top-level variables. */
function largestModuleCollection(
  snapshot: IHeapSnapshot,
  moduleName: string,
): IHeapNode | null {
  const rec = moduleRecords(snapshot).get(moduleName);
  if (rec == null) return null;
  const cands: IHeapNode[] = [];
  for (const v of moduleScopeVars(rec)) {
    if (v.node.type === 'object' && COLLECTIONS.has(v.node.name)) {
      cands.push(v.node);
    }
  }
  for (const root of [rec.exports, rec.defaultExport]) {
    if (root == null) continue;
    for (const e of root.references) {
      if (e.type !== 'property') continue;
      const t = e.toNode;
      if (t.type === 'object' && COLLECTIONS.has(t.name)) cands.push(t);
    }
  }
  let best: IHeapNode | null = null;
  let bestN = -1;
  for (const c of cands) {
    const n = countEntries(c) ?? 0;
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}

function propTo(node: IHeapNode, name: string): IHeapNode | null {
  for (const e of node.references) {
    if (e.type === 'property' && String(e.name_or_index) === name) {
      return e.toNode;
    }
  }
  return null;
}

/**
 * An app-specific buffer, described by where it lives. Which buffers a stack
 * keeps is knowledge about that stack, so it comes from a probe file rather
 * than from this package.
 */
export interface BufferProbe {
  buffer: string;
  note?: string;
  /** The largest collection among this module's exports and scope variables. */
  module?: string;
  /** A dotted path from the global object, e.g. `Telemetry.history`. */
  global?: string;
  /** Every object reached through a property of this name. */
  property?: string;
}

export function loadBufferProbes(configPath?: string): {
  probes: BufferProbe[];
  source: string | null;
} {
  const file = configPath ?? process.env.MEMLAB_FRAMEWORK_BUFFERS;
  if (file == null || file === '') return {probes: [], source: null};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    probes?: unknown;
  };
  if (!Array.isArray(parsed.probes)) {
    throw new Error(`${file}: expected {"probes": [...]}`);
  }
  const probes = (parsed.probes as BufferProbe[]).filter(
    p =>
      typeof p.buffer === 'string' &&
      [p.module, p.global, p.property].filter(x => typeof x === 'string')
        .length === 1,
  );
  return {probes, source: file};
}

/** Entries of a collection, or of the arrays an object holds. */
function entriesOf(node: IHeapNode): number {
  if (['Map', 'Set', 'Array', 'WeakMap'].includes(node.name)) {
    return countEntries(node) ?? 0;
  }
  let entries = 0;
  for (const e of node.references) {
    if (e.type === 'property' && e.toNode.name === 'Array') {
      entries += countEntries(e.toNode) ?? 0;
    }
  }
  return entries;
}

/**
 * Buffers that recur across apps: generic ones found by name or shape, plus
 * the app-specific probes. Each probe is minification-safe (module records,
 * globals, shapes) and reports "not present" rather than guessing.
 */
function probeBuffers(
  snapshot: IHeapSnapshot,
  probes: BufferProbe[],
): BufferRow[] {
  const rows: BufferRow[] = [];
  const labeler = cachedPathLabeler(snapshot);
  const globals: IHeapNode[] = [];
  const logArrays: IHeapNode[] = [];
  const byProperty = new Map<string, BufferProbe>();
  for (const p of probes) if (p.property != null) byProperty.set(p.property, p);
  const propertyHits: Array<{probe: BufferProbe; node: IHeapNode}> = [];
  const giant: IHeapNode[] = [];
  let timingRecords = 0;
  let timingBytes = 0;
  let resourceRecords = 0;
  let resourceBytes = 0;
  let schedulerTasks = 0;
  snapshot.nodes.forEach((n: IHeapNode) => {
    if (/^(Window|DedicatedWorkerGlobalScope) /.test(n.name)) globals.push(n);
    if (n.type === 'object' && n.edge_count > 5000) giant.push(n);
    for (const e of n.references) {
      if (e.type !== 'property') continue;
      const name = String(e.name_or_index);
      const probe = e.toNode.type === 'object' ? byProperty.get(name) : null;
      if (name === 'logs' && e.toNode.name === 'Array') {
        logArrays.push(e.toNode);
      } else if (probe != null) {
        propertyHits.push({probe, node: e.toNode});
      }
    }
    const fam = shapeFamilyOf(n);
    if (fam === 'module timing records') {
      timingRecords++;
      timingBytes += n.retainedSize;
    } else if (fam === 'lazy-loader resource records') {
      resourceRecords++;
      resourceBytes += n.retainedSize;
    }
    if (
      n.type === 'object' &&
      propTo(n, 'sortIndex') != null &&
      propTo(n, 'expirationTime') != null
    ) {
      schedulerTasks++;
    }
  });

  for (const p of probes) {
    if (p.global == null) continue;
    for (const g of globals) {
      let cur: IHeapNode | null = g;
      for (const part of p.global.split('.')) {
        cur = cur != null ? propTo(cur, part) : null;
      }
      if (cur == null) continue;
      rows.push({
        buffer: p.buffer,
        where: p.global,
        entries: entriesOf(cur),
        bytes: held(cur, snapshot),
        note: p.note ?? '',
      });
      break;
    }
  }
  for (const arr of logArrays) {
    const n = countEntries(arr) ?? 0;
    const bytes = held(arr, snapshot);
    // Entry counts can read low when elements live in a backing store, so
    // bytes decide too.
    if (n < 100 && bytes < 64 * 1024) continue;
    rows.push({
      buffer: 'in-memory log buffer',
      where: labeler.labelOf(arr),
      entries: n > 0 ? n : null,
      bytes,
      note: 'a `logs` array; check its cap',
    });
  }
  for (const {probe, node} of propertyHits) {
    rows.push({
      buffer: probe.buffer,
      where: labeler.labelOf(node),
      entries: entriesOf(node),
      bytes: held(node, snapshot),
      note: probe.note ?? '',
    });
  }
  for (const p of probes) {
    if (p.module == null) continue;
    const c = largestModuleCollection(snapshot, p.module);
    if (c == null) continue;
    rows.push({
      buffer: p.buffer,
      where: `${p.module} (${c.name})`,
      entries: countEntries(c),
      bytes: held(c, snapshot),
      note: p.note ?? '',
    });
  }
  if (resourceRecords > 0) {
    rows.push({
      buffer: 'lazy-loader resource registry',
      where: '{c, m, p, src, type} records',
      entries: resourceRecords,
      bytes: resourceBytes,
      note: 'static-resource metadata for every known resource',
    });
  }
  if (timingRecords > 0) {
    rows.push({
      buffer: 'module timing records',
      where: '{category, defined, factoryRun, …} records',
      entries: timingRecords,
      bytes: timingBytes,
      note: 'one per loaded module',
    });
  }
  if (schedulerTasks > 0) {
    rows.push({
      buffer: 'scheduler task queue',
      where: 'React Scheduler task records',
      entries: schedulerTasks,
      bytes: 0,
      note: 'pending timers; see memlab_timers for what they capture',
    });
  }
  const registryIds = new Set<number>();
  for (const rec of moduleRecords(snapshot).values()) {
    for (const e of rec.record.referrers) {
      if (e.type === 'property') registryIds.add(e.fromNode.id);
    }
  }
  giant
    .map(g => {
      let props = 0;
      for (const e of g.references) if (e.type === 'property') props++;
      return {g, props};
    })
    .filter(x => x.props > 5000)
    .sort((a, b) => b.props - a.props)
    .slice(0, 6)
    .forEach(({g, props}) => {
      // A module registry is wide by design and reaches the whole app; count
      // only its own table, not everything behind it.
      const isRegistry = registryIds.has(g.id);
      const table = edgeTo(g, 'properties');
      rows.push({
        buffer: isRegistry
          ? 'module registry table'
          : 'giant object (>5,000 own properties)',
        where: labeler.labelOf(g),
        entries: props,
        bytes: isRegistry
          ? g.self_size + (table?.self_size ?? 0)
          : g.retainedSize,
        note: isRegistry
          ? 'one entry per module; module state is attributed by memlab_module_attribution'
          : 'a prototype or table this wide is static cost paid at load',
      });
    });
  return rows;
}

export function registerFrameworkBuffers(server: McpServer): void {
  server.tool(
    'memlab_framework_buffers',
    'Size the framework buffers that recur in every hunt on the same stack, in ONE call, minification-safe. Generic probes: in-memory `logs` arrays, module timing records, a lazy-loader resource registry, the React Scheduler task queue, module registry tables and objects with more than 5,000 own properties. ' +
      'App-specific buffers (a telemetry queue, an error history, a trace store) come from a probe file: JSON `{"probes": [{"buffer", "note", and one of "module" | "global" | "property"}]}`, read from `config_path` or the MEMLAB_FRAMEWORK_BUFFERS environment variable. ' +
      'Each row has its entry count, held bytes (the larger of what the container dominates and what its entries retain) and what it is for. A buffer that is absent is omitted rather than reported as zero.',
    {
      config_path: z
        .string()
        .optional()
        .describe(
          'Probe file to use instead of MEMLAB_FRAMEWORK_BUFFERS (JSON, see the description).',
        ),
    },
    async ({config_path}) => {
      try {
        const snapshot = getSnapshot();
        // A bad probe file costs the app-specific rows, not the generic ones.
        let probes: BufferProbe[] = [];
        let source: string | null = null;
        let probeError: string | null = null;
        try {
          ({probes, source} = loadBufferProbes(config_path));
        } catch (err) {
          probeError = err instanceof Error ? err.message : String(err);
        }
        const rows = probeBuffers(snapshot, probes).sort(
          (a, b) => b.bytes - a.bytes,
        );
        const probeNote =
          probeError != null
            ? `⚠ Probe file not used (${probeError}); generic probes only.`
            : source != null
              ? `_${probes.length} app-specific probe(s) from \`${source}\`._`
              : '_Generic probes only: no probe file (`config_path` or MEMLAB_FRAMEWORK_BUFFERS) was given._';
        if (rows.length === 0) {
          return toolResult(
            `None of the known framework buffers are present.\n\n${probeNote}`,
          );
        }
        return toolResult(
          [
            `## Framework buffers — ${rows.length} found`,
            '',
            markdownTable(
              ['Buffer', 'Where', 'Entries', 'Held', 'What it is'],
              rows.map(r => [
                r.buffer,
                r.where.length > 60 ? `${r.where.slice(0, 57)}…` : r.where,
                r.entries != null ? formatNumber(r.entries) : '—',
                r.bytes > 0 ? formatBytes(r.bytes) : '—',
                r.note,
              ]),
              new Set([2, 3]),
            ),
            '',
            '_Held bytes overlap between buffers that share entries (one record held by two buffers counts in both); do not sum the column._',
            probeNote,
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

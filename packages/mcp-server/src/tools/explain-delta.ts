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
import {
  getSnapshotByHandle,
  getMetadataByHandle,
  getCurrentHandle,
  listSnapshots,
  findResidentByPath,
  handlesSharingBasename,
  resolveHandle,
} from '../heap-state.js';
import {sizeInput, withSizeHint} from '../byte-size.js';
import {getRegisteredTool} from '../tool-registry.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';
import {classifyArtifact} from '../artifact-classes.js';
import {normalizeClassName} from './sequence-analysis.js';
import {
  collectDevRoots,
  computeReachableWithoutDevRoots,
} from './dev-artifacts.js';

interface OwnerStats {
  selfBytes: number;
  nodes: number;
  /** The owner's largest single node, to tell a capacity step from growth. */
  maxNode: {bytes: number; name: string};
}

/** A backing store has no name; its type is the useful label. */
function nodeLabel(node: IHeapNode): string {
  return node.name.length > 0 ? node.name : `(${node.type})`;
}

/**
 * Per node, 1 when a production build would hold it too, or null when the
 * snapshot has no dev roots (everything counts).
 */
function productionReach(snapshot: IHeapSnapshot): Uint8Array | null {
  const devRoots = collectDevRoots(snapshot);
  return devRoots.byId.size > 0
    ? computeReachableWithoutDevRoots(snapshot, devRoots)
    : null;
}

/**
 * Attribute every node's SELF size to its immediate dominator's class.
 *
 * Self size, not retained: retained sizes overlap wherever objects nest, so
 * summing them per owner reports more memory than exists (a sum over one class
 * in a 200 MB heap has been measured at 5.9 GB). Self sizes partition the heap
 * exactly, which is what makes two snapshots comparable.
 *
 * Immediate dominator, not nearest app-owned ancestor: resolving an owner chain
 * per node needs a memo table the size of the heap, and on a multi-million-node
 * snapshot that is a large allocation to make while answering a question about
 * memory. The immediate dominator is already the accountable parent for the
 * bytes hanging off it, and it is one field read per node.
 */
function attributeByOwner(
  snapshot: IHeapSnapshot,
  reached: Uint8Array | null,
): {
  byOwner: Map<string, OwnerStats>;
  totalSelf: number;
  countedSelf: number;
} {
  const byOwner = new Map<string, OwnerStats>();
  let totalSelf = 0;
  let countedSelf = 0;
  snapshot.nodes.forEach(node => {
    if (node.id <= 3) return;
    totalSelf += node.self_size;
    if (reached != null && reached[node.nodeIndex] === 0) return;
    countedSelf += node.self_size;
    const dom = node.dominatorNode;
    // Normalize the per-instance node id V8 appends to Context/scope names
    // ("system / Context / scope @706909"). Those ids differ per capture, so
    // without this every scope looks like an owner that appeared from nothing
    // in the target and vanished from the baseline — pure phantom delta.
    const key =
      dom == null || dom.id === node.id
        ? '(GC roots)'
        : dom.name.length > 0
          ? normalizeClassName(dom.name)
          : `(unnamed ${dom.type})`;
    const e = byOwner.get(key);
    if (e) {
      e.selfBytes += node.self_size;
      e.nodes++;
      if (node.self_size > e.maxNode.bytes) {
        e.maxNode = {bytes: node.self_size, name: nodeLabel(node)};
      }
    } else {
      byOwner.set(key, {
        selfBytes: node.self_size,
        nodes: 1,
        maxNode: {bytes: node.self_size, name: nodeLabel(node)},
      });
    }
  });
  return {byOwner, totalSelf, countedSelf};
}

/**
 * The owner's delta is mostly ONE node of the same class that roughly doubled
 * (a hash table or array backing store reallocating), or null. That is a
 * one-time resize: an A/B arm that happened to cross the threshold "grows
 * more" by megabytes without any per-cycle difference.
 */
export function capacityStep(
  before: OwnerStats | undefined,
  after: OwnerStats | undefined,
  delta: number,
): {name: string; from: number; to: number} | null {
  if (before == null || after == null || delta <= 0) return null;
  const a = before.maxNode;
  const b = after.maxNode;
  if (a.name !== b.name || a.bytes <= 0 || b.bytes < 1024 * 1024) return null;
  const ratio = b.bytes / a.bytes;
  return ratio >= 1.4 && ratio <= 2.6 && b.bytes - a.bytes >= 0.5 * delta
    ? {name: b.name, from: a.bytes, to: b.bytes}
    : null;
}

/**
 * Resolve a `baseline` that turned out to be a file path by loading it into the
 * session (keeping whatever is already resident), and return its handle.
 *
 * Dispatches to the registered `memlab_load_snapshot` handler rather than
 * duplicating its guards — the ceilings, the memory-headroom check and the
 * already-resident fast path all still apply.
 */
async function loadSnapshotByPath(filePath: string): Promise<string | null> {
  const already = findResidentByPath(filePath);
  if (already != null) return already.handle;
  const entry = getRegisteredTool('memlab_load_snapshot');
  if (entry == null) return null;
  try {
    const args =
      entry.shape != null
        ? z
            .object(entry.shape as never)
            .parse({file_path: filePath, keep_previous: true})
        : {file_path: filePath, keep_previous: true};
    await entry.handler(args, {});
  } catch {
    return null;
  }
  return findResidentByPath(filePath)?.handle ?? null;
}

export function registerExplainDelta(server: McpServer): void {
  server.tool(
    'memlab_explain_delta',
    'Explain WHERE a heap grew between two loaded snapshots, attributed by dominator (who owns the new bytes) rather than by class (what the new bytes are). ' +
      '"Object grew by 99,418 instances" does not tell you what to fix; "the bytes hanging off CometStyleXSheet grew by 12 MB" does. Every node\'s SELF size is attributed to its immediate dominator\'s class and the two attributions are differenced, so the numbers partition the heap and add up — unlike a per-class sum of retained sizes, which double-counts nested objects and can exceed the heap. ' +
      'Known measurement-artifact owners (JIT warmup, CDP inspector, a11y caches, captured Error stacks) are flagged so an inspector-driven delta is not read as an application regression. Both snapshots must be resident: load them with keep_previous:true.',
    {
      baseline_handle: z
        .string()
        .optional()
        .describe(
          'Handle of the earlier snapshot (memlab_snapshots lists them). Its siblings memlab_artifact_budget and memlab_census_diff take a `baseline` PATH instead, so `baseline` is accepted here as an alias — a batch authored against the recipe used to fail argument validation on this one parameter alone.',
        ),
      baseline: z
        .string()
        .optional()
        .describe(
          'Alias for `baseline_handle`. Accepts a resident handle, or a file path — which is auto-loaded with keep_previous so the whole batch does not have to be re-authored.',
        ),
      target_handle: z
        .string()
        .optional()
        .describe(
          'Handle of the later snapshot. Defaults to the current snapshot.',
        ),
      // `baseline` has accepted a path for a while; `target` did not exist at
      // all, so the documented recipe ("both rungs resident") still had to be
      // followed by hand for the second snapshot — and loading two snapshots by
      // hand has its own trap: the ACTIVE snapshot becomes whichever loaded
      // last, so a follow-up memlab_eval silently runs against the baseline.
      // Symmetry removes both problems.
      target: z
        .string()
        .optional()
        .describe(
          'Alias for `target_handle`. Accepts a resident handle, or a file path — auto-loaded with keep_previous, exactly like `baseline`.',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum owners to report per direction (default 20).'),
      min_delta_bytes: sizeInput()
        .optional()
        .default(65536)
        .describe(
          withSizeHint(
            'Ignore owners whose attributed size moved by less than this (default 64 KB).',
          ),
        ),
      include_artifacts: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Include owners that are known measurement artifacts (default false: counted in a one-line summary instead).',
        ),
      include_dev: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Count memory only a dev build holds (reachable solely through a dev root or dev edge: Fast Refresh, React `_debug*`, devtools). Default false: the owners and the headline delta are production-only, with the raw total beside it.',
        ),
    },
    async ({
      baseline_handle,
      baseline: baselineAlias,
      target_handle,
      target: targetAlias,
      limit,
      min_delta_bytes,
      include_artifacts,
      include_dev,
    }) => {
      try {
        // `??` alone keeps an empty string, which then fails as "snapshot not
        // resident" instead of falling back to the default. A caller who
        // passes `""` means "not given".
        const blank = (v?: string): string | undefined =>
          v == null || v === '' ? undefined : v;
        // Captured BEFORE any auto-load. Loading a baseline path switches the
        // active snapshot, so resolving the default target afterwards resolved
        // it to the baseline that had just been loaded and failed with "the
        // same snapshot" — for a call whose target was the snapshot the
        // session was already on.
        const handleBeforeLoads = getCurrentHandle();
        // Two spellings of one argument must not silently become a choice.
        // `cycles` vs `cycles_per_rung` errors on conflict; this preferred the
        // `_handle` form and dropped the other without a word.
        if (
          blank(baseline_handle) != null &&
          blank(baselineAlias) != null &&
          baseline_handle !== baselineAlias
        ) {
          return errorResult(
            '`baseline_handle` and `baseline` are the same argument under two names and disagree — pass one.',
          );
        }
        if (
          blank(target_handle) != null &&
          blank(targetAlias) != null &&
          target_handle !== targetAlias
        ) {
          return errorResult(
            '`target_handle` and `target` are the same argument under two names and disagree — pass one.',
          );
        }
        let baselineRef = blank(baseline_handle) ?? blank(baselineAlias);
        if (baselineRef == null) {
          return errorResult(
            'Pass `baseline_handle` (a resident snapshot handle) or `baseline` (a handle or a file path).',
          );
        }
        // A path where a handle was expected is the documented sibling spelling,
        // not a mistake: `artifact_budget` and `census_diff` both take paths.
        // Loading it is exactly what the "must be resident" error tells the
        // caller to go and do by hand, and a re-authored batch costs a reload of
        // every rung.
        // Canonicalise first: a resident snapshot referred to by its FILENAME
        // (`rung_00_c0.heapsnapshot`) must compare equal to its handle
        // (`rung_00_c0`) below, or the same-snapshot check silently passes and
        // the tool diffs a snapshot against itself.
        baselineRef = resolveHandle(baselineRef) ?? baselineRef;
        if (
          getSnapshotByHandle(baselineRef) == null &&
          /[/\\.]/.test(baselineRef)
        ) {
          const loaded = await loadSnapshotByPath(baselineRef);
          if (loaded == null) {
            // An ambiguous basename resolves to null exactly like an unknown
            // one, so the generic message sent the operator looking for a file
            // that is in fact resident several times over. Name the candidates.
            const candidates = handlesSharingBasename(baselineRef);
            return errorResult(
              candidates.length > 1
                ? `\`baseline\` "${baselineRef}" matches ${candidates.length} resident snapshots ` +
                    `(${candidates.join(', ')}), so it cannot be resolved by name. Pass one of those handles.`
                : `\`baseline\` "${baselineRef}" is neither a resident handle nor a readable snapshot file.`,
            );
          }
          baselineRef = loaded;
        }
        let targetRef = blank(target_handle) ?? blank(targetAlias);
        if (targetRef != null) {
          targetRef = resolveHandle(targetRef) ?? targetRef;
          if (
            getSnapshotByHandle(targetRef) == null &&
            /[/\\.]/.test(targetRef)
          ) {
            const loadedTarget = await loadSnapshotByPath(targetRef);
            if (loadedTarget == null) {
              const candidates = handlesSharingBasename(targetRef);
              return errorResult(
                candidates.length > 1
                  ? `\`target\` "${targetRef}" matches ${candidates.length} resident snapshots ` +
                      `(${candidates.join(', ')}), so it cannot be resolved by name. Pass one of those handles.`
                  : `\`target\` "${targetRef}" is neither a resident handle nor a readable snapshot file.`,
              );
            }
            targetRef = loadedTarget;
          }
        }
        const targetHandle = targetRef ?? handleBeforeLoads;
        if (targetHandle == null) {
          return errorResult('No current snapshot; pass target_handle.');
        }
        if (targetHandle === baselineRef) {
          return errorResult(
            'baseline_handle and target_handle are the same snapshot.',
          );
        }
        const baselineSnapshot = getSnapshotByHandle(baselineRef);
        const target = getSnapshotByHandle(targetHandle);
        if (baselineSnapshot == null || target == null) {
          const available = listSnapshots()
            .map(m => m.handle)
            .join(', ');
          return errorResult(
            `Both snapshots must be resident. Missing: ${baselineSnapshot == null ? baselineRef : targetHandle}. Resident: ${available || '(none)'}. Load with memlab_load_snapshot({file_path, keep_previous: true}).`,
          );
        }
        for (const h of [baselineRef, targetHandle]) {
          if (getMetadataByHandle(h)?.light) {
            return errorResult(
              `Snapshot "${h}" was loaded in LIGHT mode and has no dominator tree, which this attribution requires. Reload it without light.`,
            );
          }
        }

        const reachA = include_dev ? null : productionReach(baselineSnapshot);
        const reachB = include_dev ? null : productionReach(target);
        // Both or neither: a production-only side against a raw side would
        // report the dev share as growth or shrinkage.
        const devSubtracted = reachA != null && reachB != null;
        const a = attributeByOwner(
          baselineSnapshot,
          devSubtracted ? reachA : null,
        );
        const b = attributeByOwner(target, devSubtracted ? reachB : null);

        interface Row {
          owner: string;
          delta: number;
          before: number;
          after: number;
          nodesDelta: number;
          artifact: boolean;
          step: ReturnType<typeof capacityStep>;
        }
        const rows: Row[] = [];
        const owners = new Set([...a.byOwner.keys(), ...b.byOwner.keys()]);
        for (const owner of owners) {
          const before = a.byOwner.get(owner);
          const after = b.byOwner.get(owner);
          const delta = (after?.selfBytes ?? 0) - (before?.selfBytes ?? 0);
          if (Math.abs(delta) < min_delta_bytes) continue;
          rows.push({
            owner,
            delta,
            before: before?.selfBytes ?? 0,
            after: after?.selfBytes ?? 0,
            nodesDelta: (after?.nodes ?? 0) - (before?.nodes ?? 0),
            artifact: classifyArtifact(owner) != null,
            step: capacityStep(before, after, delta),
          });
        }

        const signed = (n: number) =>
          `${n >= 0 ? 'grew' : 'shrank'} by **${formatBytes(Math.abs(n))}**`;
        const totalDelta = b.totalSelf - a.totalSelf;
        const countedDelta = b.countedSelf - a.countedSelf;
        const lines: string[] = [
          `## Heap delta by owner: "${baselineRef}" → "${targetHandle}"`,
          '',
          devSubtracted
            ? `Production-only self size ${signed(countedDelta)} (${formatBytes(a.countedSelf)} → ${formatBytes(b.countedSelf)}); the raw total ${signed(totalDelta)}, of which ${formatBytes(totalDelta - countedDelta)} is memory only a dev build holds. Owners below are production-only (\`include_dev: true\` for raw).`
            : `Total self size ${signed(totalDelta)} (${formatBytes(a.totalSelf)} → ${formatBytes(b.totalSelf)}).`,
          '',
        ];

        const artifactRows = rows.filter(r => r.artifact);
        const usable = include_artifacts ? rows : rows.filter(r => !r.artifact);
        const grew = usable
          .filter(r => r.delta > 0)
          .sort((x, y) => y.delta - x.delta)
          .slice(0, limit);
        const shrank = usable
          .filter(r => r.delta < 0)
          .sort((x, y) => x.delta - y.delta)
          .slice(0, limit);

        if (grew.length === 0 && shrank.length === 0) {
          lines.push(
            `No owner moved by at least ${formatBytes(min_delta_bytes)}. The change is spread thinly rather than concentrated under one owner — lower \`min_delta_bytes\`, or compare class counts with \`memlab_diff_snapshots\`.`,
          );
          return toolResult(lines.join('\n'));
        }

        const render = (rs: Row[]): string =>
          markdownTable(
            ['Owner (dominator class)', 'Δ self', 'Before', 'After', 'Δ nodes'],
            rs.map(r => [
              (r.owner.length > 44 ? r.owner.slice(0, 41) + '…' : r.owner) +
                (r.step != null ? ' ⚠ capacity step' : ''),
              `${r.delta >= 0 ? '+' : '−'}${formatBytes(Math.abs(r.delta))}`,
              formatBytes(r.before),
              formatBytes(r.after),
              `${r.nodesDelta >= 0 ? '+' : '−'}${formatNumber(Math.abs(r.nodesDelta))}`,
            ]),
            new Set([1, 2, 3, 4]),
          );

        if (grew.length > 0) {
          lines.push('### Owners that grew', '', render(grew), '');
        }
        if (shrank.length > 0) {
          lines.push('### Owners that shrank', '', render(shrank), '');
        }
        const steps = grew.flatMap(r =>
          r.step != null ? [{owner: r.owner, ...r.step}] : [],
        );
        if (steps.length > 0) {
          const bytes = steps.reduce((sum, r) => sum + (r.to - r.from), 0);
          const examples = steps
            .slice(0, 3)
            .map(
              r =>
                `\`${r.name.slice(0, 40)}\` under ${r.owner.slice(0, 40)} ${formatBytes(r.from)} → ${formatBytes(r.to)}`,
            )
            .join('; ');
          lines.push(
            `> ⚠ **${steps.length} owner(s) grew by a capacity step** (${formatBytes(bytes)} in total): one backing store reallocated to ~2x — ${examples}. A resize happens once, when a threshold is crossed; it is not a per-cycle rate. Do not judge an A/B by a total that includes one.`,
            '',
          );
        }
        if (!include_artifacts && artifactRows.length > 0) {
          const bytes = artifactRows.reduce((s, r) => s + r.delta, 0);
          lines.push(
            `> 🧹 **${formatNumber(artifactRows.length)} owner(s) suppressed as known measurement artifacts** (net ${bytes >= 0 ? '+' : '−'}${formatBytes(Math.abs(bytes))}) — JIT warmup, CDP inspector retention, a11y caches, captured Error stacks. Pass \`include_artifacts: true\` to see them.`,
            '> Note the split of responsibilities: the JIT-warmup families counted here (`system/Code`, `InstructionStream`, `BytecodeArray`, `ProtectedFixedArray`) are NOT counted by `memlab_dev_artifacts`, which measures retention by a dev root instead. Neither total is the whole artifact bill on its own — read both before deciding how much of a round is real.',
            '',
          );
        }
        lines.push(
          '_Attribution is by IMMEDIATE dominator and uses SELF size, so the rows partition the heap and sum to the total above. An owner growing does not prove a leak — a cache filling legitimately looks identical here; use `memlab_dominator_chain` on an instance to find the accountable application object, and a ladder (`memlab_leak_report`) to tell filling from unbounded growth._',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

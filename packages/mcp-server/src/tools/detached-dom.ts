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
import {z} from 'zod';
import {getSnapshot, getSnapshotEnv} from '../heap-state.js';
import type {IHeapNode, IHeapEdge, IHeapSnapshot} from '@memlab/core';
import {
  queryNodes,
  formatQueryNodesResult,
  formatBytes,
  formatNumber,
  isNodeWorthInspecting,
  markdownTable,
  truncateNodeName,
  errorResult,
  toolResult,
  boundedDominatorRetainedSize,
} from '../utils.js';
import memlabCore from '@memlab/core';
import type {ModuleProvenance} from '../dev-modules.js';
import {
  DEV_ONLY_FOOTNOTE,
  GATED_FOOTNOTE,
  moduleProvenanceOf,
  provenanceCell,
} from '../dev-modules.js';
import {
  resolveRungs,
  withSnapshotAt,
  armScanBudgetFor,
  scaledTimeoutMs,
} from '../snapshot-borrow.js';
import {
  describeSegmentSelection,
  resolveLadderInputs,
  SEGMENT_ARG_DESCRIPTION,
} from '../run-manifest.js';
const {NumericSet} = memlabCore;

/**
 * Detached population per rung, with the per-class breakdown of what grew.
 *
 * A single census answers "how many are detached", which is a working-set
 * number; the ladder answers "how many per interaction", which is the leak.
 * Assembling the second from the first meant N calls and a hand-diff, on the
 * detector most likely to be carrying the finding.
 */
async function detachedLadder(args: {
  run_dir?: string;
  paths?: string[];
  segment?: number | 'all';
  limit: number;
}): Promise<ReturnType<typeof toolResult>> {
  const inputs = resolveLadderInputs({
    run_dir: args.run_dir,
    paths: args.paths,
    segment: args.segment,
  });
  if (inputs.paths.length < 2) {
    return errorResult(
      new Error(
        'A ladder needs at least 2 rungs; with one, a census cannot be turned into a rate.',
      ),
    );
  }
  const {rungs, largestMB} = resolveRungs(inputs.paths);

  // One unreadable rung must not discard the rungs that DID scan. These are
  // the largest snapshots a hunt produces — the ones this mode exists for are
  // exactly the ones most likely to throw — so a rung that fails is recorded
  // and the ladder continues with a hole in it.
  const totals: Array<number | null> = [];
  const read: Array<{
    index: number;
    total: number;
    byClass: Map<string, number>;
  }> = [];
  const failures: string[] = [];
  for (const [index, rung] of rungs.entries()) {
    armScanBudgetFor(scaledTimeoutMs(largestMB));
    try {
      const counts = await withSnapshotAt(rung.localPath, snap => {
        const byClass = new Map<string, number>();
        let total = 0;
        snap.nodes.forEach(node => {
          if (!isDetachedDOMNode(node)) return;
          total++;
          const key = truncateNodeName(
            node.name,
            node.type,
            node.self_size,
            48,
          );
          byClass.set(key, (byClass.get(key) ?? 0) + 1);
        });
        return {total, byClass};
      });
      totals.push(counts.total);
      read.push({index, total: counts.total, byClass: counts.byClass});
    } catch (err) {
      totals.push(null);
      failures.push(
        `${rung.label.replace(/^.*\//, '')}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (read.length < 2) {
    return errorResult(
      new Error(
        `only ${read.length} of ${rungs.length} rungs could be read, and a rate needs 2.\n\n` +
          failures.map(f => `- ${f}`).join('\n'),
      ),
    );
  }
  const firstRead = read[0];
  const lastRead = read[read.length - 1];

  const axis = inputs.cyclesPerRung;
  // The span is between the rungs actually READ, not the first and last rung
  // requested: dividing by the full span after a rung dropped out would
  // understate every rate on the page.
  const span =
    axis != null && axis.length === totals.length
      ? axis[lastRead.index] - axis[firstRead.index]
      : null;
  const rate = (a: number, b: number): string =>
    span != null && span > 0 ? ((b - a) / span).toFixed(3) : '—';

  const first = firstRead.byClass;
  const last = lastRead.byClass;
  const names = new Set<string>([...first.keys(), ...last.keys()]);
  const changed = [...names]
    .map(n => ({
      name: n,
      a: first.get(n) ?? 0,
      b: last.get(n) ?? 0,
    }))
    .filter(r => r.b !== r.a);
  // Sorted by the MAGNITUDE of the change, not its sign. Ranking by signed
  // delta sorts every class that SHRANK to the bottom of the list, so on a
  // ladder with more changed classes than `limit` the largest decreases are
  // the first rows cut from a table headed "what changed".
  const rows = changed.sort(
    (x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a),
  );

  const segmentNote = describeSegmentSelection(inputs.segment, inputs.manifest);
  const lines: string[] = ['## Detached DOM across the ladder', ''];
  if (segmentNote != null) lines.push(segmentNote, '');
  lines.push(
    `_${rungs.length} rungs${axis != null ? `, cycle axis [${axis.join(', ')}] (${inputs.source === 'assumed-even' ? 'ASSUMED even — pass `run_dir` for the measured axis' : 'measured'})` : ', no cycle axis — pass `run_dir` for per-cycle rates'}._`,
    '',
    markdownTable(
      ['Rung', ...rungs.map(r => r.label.replace(/^.*\//, ''))],
      [
        [
          'Detached nodes',
          ...totals.map(v => (v == null ? '—' : formatNumber(v))),
        ],
      ],
      new Set(rungs.map((_, i) => i + 1)),
    ),
    '',
    `**${formatNumber(firstRead.total)} → ${formatNumber(lastRead.total)}** (${rate(firstRead.total, lastRead.total)}/cycle)`,
    '',
  );
  if (failures.length > 0) {
    lines.push(
      `_${failures.length} of ${rungs.length} rungs could not be read and are shown as \`—\`; the rate above spans the rungs that were. ${failures.join('; ')}._`,
      '',
    );
  }

  if (rows.length > 0) {
    lines.push(
      '### What changed, by element',
      '',
      markdownTable(
        ['Element', 'First', 'Last', 'Δ', 'Δ/cycle'],
        rows
          .slice(0, args.limit)
          .map(r => [
            r.name,
            formatNumber(r.a),
            formatNumber(r.b),
            formatNumber(r.b - r.a),
            rate(r.a, r.b),
          ]),
        new Set([1, 2, 3, 4]),
      ),
      '',
    );
    if (rows.length > args.limit) {
      lines.push(
        `_Showing ${args.limit} of ${rows.length} changed element types, largest absolute change first — raise \`limit\` for the rest._`,
        '',
      );
    }
    lines.push(
      '_A dead-exact integer rate is the signature of a fixed number of nodes stranded per interaction — count the elements the surface actually mints per cycle and see whether they match. Rows that did not change are omitted._',
      '',
      '_This is a COUNT ladder. It does not say who retains them: load the largest rung that fits and run `memlab_detached_dom({group_by: "dominator"})` for the owner, which also flags a dev-only or flag-gated owner before the bytes get quoted as production impact._',
    );
  } else {
    lines.push(
      '_No element type changed count across the ladder — the detached population is the same shape at both ends. Equal totals are not identity, but an unchanged per-class distribution is much stronger than an unchanged total._',
    );
  }
  // The census options are not silently dropped: a caller who asks for
  // `group_by: "dominator"` here — which the closing line above tells them to
  // run — would otherwise get the count ladder back with no indication that
  // the grouping was ignored.
  lines.push(
    '',
    '_Ladder mode reports COUNTS only. `output_mode`, `group_by`, `offset`, `classify_dev_only` and `only_with_retainer_path` apply to a single-snapshot census and are ignored here; load one rung without `run_dir`/`paths` to use them. Because of that, these totals count every detached node, including the GC-eligible, dev-only and browser-owned ones that the single-census path splits out and excludes from its leak total — expect this ladder to read higher than a census of the same rung._',
  );
  return toolResult(lines.join('\n'));
}
import type {OutputMode} from '../utils.js';
import {
  collectDevRoots,
  classifyDevOnly,
  computeReachableWithoutDevRoots,
  summarizeDevRoots,
} from './dev-artifacts.js';

export function isDetachedDOMNode(node: IHeapNode): boolean {
  if (node.id <= 3) return false;
  if (node.is_detached) return true;
  return node.name.startsWith('Detached ');
}

// A detached node is only an actual leak if it is still reachable from a GC
// root — i.e. it has a shortest-path retainer edge. Detached nodes with NO
// retainer path found are typically GC-eligible (about to be collected) or
// retained only through weak references, and should not be counted toward a
// leak total. This distinguishes the "which half is real" problem where a
// snapshot's detached-node list mixes genuinely-pinned nodes with transient
// ones. `hasPathEdge` is the same reachability signal used to walk retainers.
export function isPinned(node: IHeapNode): boolean {
  return Boolean(node.hasPathEdge);
}

/**
 * Detached browsing contexts (iframes) that no application object references.
 *
 * A detached `Window` / `HTMLDocument` / `NativeContext` whose only referrers
 * are other detached natives is retained by Blink's own binding layer — on one
 * measured capture the only path to a GC root ran
 * `Window -> History -> History.prototype -> get state (FunctionTemplateInfo)
 * -> WeakMap -> History -> .context -> Detached NativeContext -> Detached
 * Window -> Detached HTMLDocument`, with zero application referrers anywhere.
 *
 * These satisfy `isPinned` and were therefore reported as "actionable leak",
 * which on that capture was 274,935 of 330,334 detached nodes and roughly half
 * the reclaimable bytes. No application change can free them, so counting them
 * in a leak total overstates it by however many stale iframes the page has.
 */
const BROWSING_CONTEXT_NAMES = [
  'Detached Window',
  'Detached HTMLDocument',
  'Detached system / NativeContext',
];

function findBrowserOwnedContexts(snapshot: IHeapSnapshot): Set<number> {
  const roots = new Set<number>();
  snapshot.nodes.forEach(node => {
    if (!BROWSING_CONTEXT_NAMES.some(n => node.name.startsWith(n))) return;
    // "No application referrer" is the whole test: if app code holds it, the
    // app can let go of it and it is a real leak.
    let appReferrer = false;
    for (const ref of node.referrers) {
      const from = ref.fromNode;
      // `system / …` nodes are V8/Blink bookkeeping, not application
      // ownership; counting them as an app referrer would suppress the bucket
      // for exactly the contexts it exists to find.
      if (
        !from.name.startsWith('Detached ') &&
        !from.name.startsWith('system /') &&
        from.type !== 'synthetic'
      ) {
        appReferrer = true;
        break;
      }
    }
    if (!appReferrer) roots.add(node.id);
  });
  return roots;
}

/** Is this node inside one of those contexts? Bounded dominator walk. */
function isBrowserOwned(node: IHeapNode, roots: Set<number>): boolean {
  if (roots.size === 0) return false;
  let cur: IHeapNode | null = node;
  for (let i = 0; i < 30 && cur; i++) {
    if (roots.has(cur.id)) return true;
    cur = cur.dominatorNode ?? null;
  }
  return false;
}

interface ReachabilitySplit {
  pinnedCount: number;
  // Plain sum of per-node retained size. Nested detached subtrees are counted
  // once per ancestor AND once per descendant, so this OVERSTATES what freeing
  // the detached set would actually reclaim — see formatReachabilitySplit.
  pinnedRetained: number;
  noPathCount: number;
  noPathRetained: number;
  pinnedIds: number[];
  browserOwnedCount: number;
  browserOwnedIds: number[];
}

function emptySplit(): ReachabilitySplit {
  return {
    pinnedCount: 0,
    pinnedRetained: 0,
    noPathCount: 0,
    noPathRetained: 0,
    pinnedIds: [],
    browserOwnedCount: 0,
    browserOwnedIds: [],
  };
}

/**
 * Two different numbers, and quoting the wrong one has produced published
 * errors: on one round the plain sum read 9.7 MB where the amount actually
 * reclaimable was 308 KB. Lead with the dominator-deduped figure and keep the
 * sum visible but explicitly labelled.
 */
function formatReachabilitySplit(
  split: ReachabilitySplit,
  snapshot: IHeapSnapshot,
): string[] {
  const deduped = boundedDominatorRetainedSize(
    new NumericSet(split.pinnedIds),
    snapshot,
  );
  const bound = deduped.exact ? '' : ' (upper bound; deep dominator chain)';
  const browserOwnedDeduped = boundedDominatorRetainedSize(
    new NumericSet(split.browserOwnedIds),
    snapshot,
  );
  return [
    `- Pinned (retainer path to a GC root — actionable leak): ${formatNumber(split.pinnedCount)} nodes, **${formatBytes(deduped.retained)} reclaimable**${bound} (dominator-deduped)`,
    `  - sum over nodes: ${formatBytes(split.pinnedRetained)} — double-counts nested detached subtrees; do NOT quote this as the size of the leak`,
    `- No retainer path found (likely GC-eligible / weak-only — exclude from leak totals): ${formatNumber(split.noPathCount)} nodes, ${formatBytes(split.noPathRetained)}`,
    ...(split.browserOwnedCount > 0
      ? [
          `- **Of the pinned nodes, ${formatNumber(split.browserOwnedCount)} (${formatBytes(browserOwnedDeduped.retained)} dominator-deduped) sit inside DETACHED BROWSING CONTEXTS with no application referrer** — stale iframes held by Blink's binding layer. No application change frees these; subtract them before quoting a leak total. The app-attributable figure is therefore **${formatBytes(Math.max(0, deduped.retained - browserOwnedDeduped.retained))}**.`,
        ]
      : []),
  ];
}

export function extractElementTag(name: string): string {
  // V8 names detached DOM as "Detached <div>" or "Detached <div class="...">"
  const match = name.match(/^(?:Detached\s+)?<(\w+)/);
  return match ? match[1] : name;
}

function extractTestId(node: IHeapNode): string {
  // Look for data-testid in the node name (V8 includes attributes)
  const testIdMatch = node.name.match(/data-testid="([^"]+)"/);
  if (testIdMatch) return testIdMatch[1];
  return '(no testid)';
}

export function getFirstNonFrameworkRetainer(node: IHeapNode): string {
  const frameworkNames = new Set([
    'system / Context',
    '(GC roots)',
    '(Strong roots)',
    '(Builtins)',
    '(Startup object cache)',
  ]);
  let cur: IHeapNode | null = node;
  const visited = new Set<number>([node.id]);

  while (cur && cur.hasPathEdge) {
    const edge: IHeapEdge | null = cur.pathEdge;
    if (!edge) break;
    const from: IHeapNode = edge.fromNode;
    if (visited.has(from.id)) break;
    visited.add(from.id);

    if (
      !frameworkNames.has(from.name) &&
      !from.name.startsWith('system / ') &&
      from.type !== 'hidden' &&
      from.type !== 'array' &&
      from.type !== 'synthetic' &&
      from.type !== 'native'
    ) {
      const edgeName = String(edge.name_or_index);
      // V8 leaves anonymous functions/objects unnamed; printing the empty
      // string renders as a leading blank that reads like a formatting bug.
      const fromName = from.name.length > 0 ? from.name : '(anonymous)';
      return `${fromName} (${from.type}) .${edgeName}`;
    }
    cur = from;
  }
  return '(unknown)';
}

// Climbing more than this many dominator hops means the detached subtree is
// pathologically deep; give up rather than pay for it on every node.
const MAX_DOMINATOR_HOPS = 64;

// Distinct owners tracked per group before the count is reported as "N+".
// Bounds memory when a group spans one owner per node (100k+ detached nodes).
const MAX_TRACKED_OWNERS = 1000;

/**
 * Resolve the node that is ACCOUNTABLE for a detached node: the nearest
 * dominator above it that is not itself detached DOM and is worth naming.
 *
 * Why this is not the same as `getFirstNonFrameworkRetainer`: that walks the
 * shortest RETAINER path, which is only one of possibly many references and need
 * not dominate the node at all. Grouping by it and then saying "fixing this
 * frees X" is wrong whenever the group's nodes are also held elsewhere — the
 * whole point of the dominator tree is that freeing a dominator DOES free
 * everything below it.
 *
 * Returns a resolver closure rather than a bare function so the walk can be
 * memoized: sibling detached nodes share ancestors, and every chain member's
 * answer is the same node. Cached entries are per-load only (the closure lives
 * for one tool call).
 */
function makeDominatorResolver(): (node: IHeapNode) => IHeapNode | null {
  const cache = new Map<number, IHeapNode | null>();
  return function resolve(node: IHeapNode): IHeapNode | null {
    const chain: number[] = [];
    const seen = new Set<number>([node.id]);
    let cur: IHeapNode | null = node.dominatorNode ?? null;
    let owner: IHeapNode | null = null;
    let hops = 0;
    // Whether the walk ended for a reason intrinsic to the graph (found an
    // owner, or ran out of dominators) rather than because THIS walk ran out of
    // budget. Only an intrinsic result may be memoized — see below.
    let conclusive = false;

    while (cur && hops < MAX_DOMINATOR_HOPS) {
      const cached = cache.get(cur.id);
      if (cached !== undefined) {
        owner = cached;
        conclusive = true;
        break;
      }
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      chain.push(cur.id);
      if (
        !isDetachedDOMNode(cur) &&
        cur.name !== '(GC roots)' &&
        isNodeWorthInspecting(cur)
      ) {
        owner = cur;
        conclusive = true;
        break;
      }
      const next: IHeapNode | null = cur.dominatorNode ?? null;
      if (!next || next.id === cur.id) {
        // The chain genuinely ends here: there is no owner above, and that is a
        // property of the graph, not of this walk.
        conclusive = true;
        break;
      }
      cur = next;
      hops++;
    }

    // Memoize ONLY a conclusive result. Caching a hop-cap or cycle-break exit
    // would store "no owner" — a fact about this walk's 64-hop budget — as if it
    // were a fact about the node. A later, deeper node whose own budget WOULD
    // have reached a real owner then short-circuits on the poisoned entry and is
    // reported as "no single owner", which is precisely the unsound ownership
    // claim this grouping exists to eliminate.
    if (conclusive) {
      for (const id of chain) cache.set(id, owner);
    }
    return owner;
  };
}

interface GroupStats {
  count: number;
  totalRetained: number;
  exampleId: number;
  maxRetainedSize: number;
  // How many nodes in this group are retained ONLY via dev/automation roots.
  devOnlyCount: number;
  // Distinct accountable dominators across the group's nodes, capped at
  // MAX_TRACKED_OWNERS. A group with more than one is NOT freed by fixing a
  // single owner — the headline "fixing this frees X" only holds at 1.
  ownerIds: Set<number>;
  ownersTruncated: boolean;
  // Nodes whose accountable dominator could not be resolved (GC-root-dominated,
  // or the hop cap was hit).
  ownerlessCount: number;
  // Dominator mode only: what the owner itself retains — the amount actually
  // freed by releasing it, which includes whatever else it holds besides this
  // group's detached DOM.
  ownerRetained: number;
  // Provenance of the accountable owner, so a dominator that is dev-only or
  // flag-gated is visible in the row rather than only after someone thinks to
  // check the gate by hand. This table is where a 116.4 MB "production leak"
  // was read off a Redblock Map whose gate passes 0.0000% of production.
  provenance: ModuleProvenance | null;
}

export function registerDetachedDom(server: McpServer): void {
  server.tool(
    'memlab_detached_dom',
    'Find detached DOM elements still retained in memory. These are common sources of memory leaks — DOM nodes removed from the document but kept alive by JavaScript references. Supports count-only and ids-only modes for large result sets. Use group_by to aggregate by dominator (accountable owner), element tag, retainer pattern, or data-testid. ' +
      'Prefer group_by: "dominator" when you intend to act on the result: it groups by the nearest non-detached DOMINATOR, so releasing that one object provably frees the whole group. The other groupings key on a shortest retainer path, which need not dominate the nodes — they report an "Owners" column (distinct accountable dominators) so a group split across many owners is not mistaken for a single fix. ' +
      'Reports a pinned-vs-GC-eligible split: detached nodes with a retainer path to a GC root are actual leaks, while nodes with no retainer path found are typically GC-eligible (transient / weak-only) and should be excluded from leak totals — set only_with_retainer_path to list/aggregate just the pinned ones. ' +
      'Pass `run_dir` (or `paths`) for a LADDER: the detached population per rung with a per-cycle rate and the per-element breakdown of what grew. A single census is a working-set number; the rate is what makes it a leak. ' +
      '⚠ Full-heap scan — slow on very large heaps (millions of nodes); use count-only / ids-only modes and group_by to bound output.',
    {
      output_mode: z
        .enum(['full', 'count', 'ids'])
        .optional()
        .default('full')
        .describe(
          'Output verbosity: "full" returns node summaries (default), "count" returns only the total count, "ids" returns only node IDs',
        ),
      group_by: z
        .enum(['element', 'retainer', 'testid', 'dominator'])
        .optional()
        .describe(
          'Group detached DOM nodes instead of listing individually. "dominator" groups by the nearest non-detached dominator — the object that provably frees the whole group when released (use this to decide what to fix); "element" groups by HTML tag (div, span, button); "retainer" groups by first non-framework retainer on the shortest path (which need not dominate the nodes); "testid" groups by data-testid attribute.',
        ),
      offset: z
        .number()
        .optional()
        .default(0)
        .describe('Skip the first N results (for pagination)'),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe(
          'Maximum number of results (default 20, up to 10000 for ids mode)',
        ),
      classify_dev_only: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Report how much detached DOM is retained ONLY via dev/automation artifacts — dev/extension globals (__REACT_DEVTOOLS_GLOBAL_HOOK__, window.Debug, …) or the Blink a11y/CDP cache (AXObjectCacheImpl, which co-retains detached DOM under automation) — and so should be excluded from production leak totals (default true). Use memlab_dev_artifacts for the full breakdown.',
        ),
      run_dir: z
        .string()
        .optional()
        .describe(
          "A leak-hunt round's output directory (the one holding run.json and snapshots/). Reports the detached population PER RUNG with a per-cycle rate and the per-class breakdown of what grew, instead of a single census that cannot distinguish a leak from a working set.",
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Ordered snapshot paths (oldest first), as an alternative to `run_dir`. Ignored when `run_dir` is given.',
        ),
      segment: z
        .union([z.number().int().min(0), z.literal('all')])
        .optional()
        .describe(SEGMENT_ARG_DESCRIPTION),
      only_with_retainer_path: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Only include detached nodes that have a retainer path to a GC root (i.e. actually pinned / leaked). When false (default) all detached nodes are included, but the summary always reports the pinned-vs-GC-eligible split so transient / weak-only detached DOM is not mistaken for a leak.',
        ),
    },
    async ({
      output_mode,
      group_by,
      offset,
      limit,
      classify_dev_only,
      only_with_retainer_path,
      run_dir,
      paths,
      segment,
    }) => {
      try {
        // Ladder mode. A single detached census is a population; the RATE is
        // what says whether it is a leak, and assembling that meant one call
        // per rung plus arithmetic by hand — on the detector most likely to
        // carry the finding.
        if (
          (paths != null && paths.length > 0) ||
          (run_dir != null && run_dir !== '')
        ) {
          return await detachedLadder({run_dir, paths, segment, limit});
        }
        const env = getSnapshotEnv();
        if (env === 'node') {
          return toolResult(
            'This is a Node.js snapshot — DOM nodes do not exist in this environment.\n\n' +
              'For Node.js memory investigation, try instead:\n' +
              '- `memlab_duplicated_strings` — find duplicated string instances\n' +
              '- `memlab_closure_inspection` — inspect closure captured variables\n' +
              '- `memlab_largest_objects` — find objects consuming the most memory\n' +
              '- `memlab_class_histogram` — per-class instance counts and sizes',
          );
        }
        const snapshot = getSnapshot();
        const devRoots = classify_dev_only ? collectDevRoots(snapshot) : null;
        // Reachability pass (dev roots as sinks) so co-retention via multiple
        // dev roots — e.g. detached DOM held by BOTH the DevTools console and
        // the a11y cache — is correctly counted as a dev/automation artifact.
        const reached =
          devRoots && devRoots.byId.size > 0
            ? computeReachableWithoutDevRoots(snapshot, devRoots)
            : undefined;

        if (group_by) {
          const groups = new Map<string, GroupStats>();
          const resolveOwner = makeDominatorResolver();
          let totalDetached = 0;
          let totalRetainedAll = 0;
          let devOnlyRetained = 0;
          const split: ReachabilitySplit = emptySplit();
          const browserContexts = findBrowserOwnedContexts(snapshot);

          snapshot.nodes.forEach(node => {
            if (!isDetachedDOMNode(node)) return;
            totalDetached++;
            totalRetainedAll += node.retainedSize;
            const pinned = isPinned(node);
            if (pinned) {
              split.pinnedCount++;
              split.pinnedRetained += node.retainedSize;
              split.pinnedIds.push(node.id);
              if (isBrowserOwned(node, browserContexts)) {
                split.browserOwnedCount++;
                split.browserOwnedIds.push(node.id);
              }
            } else {
              split.noPathCount++;
              split.noPathRetained += node.retainedSize;
            }
            const nodeIsDevOnly = devRoots
              ? classifyDevOnly(node, devRoots, reached).devOnly
              : false;
            if (nodeIsDevOnly) {
              devOnlyRetained += node.retainedSize;
            }

            // With only_with_retainer_path, exclude GC-eligible (no-path) nodes
            // from the group aggregation — they are still counted in the split.
            if (only_with_retainer_path && !pinned) return;

            // Resolved for every grouping, not just 'dominator': the other keys
            // need it to report how many distinct owners they span.
            const owner = resolveOwner(node);

            let key: string;
            switch (group_by) {
              case 'element':
                key = extractElementTag(node.name);
                break;
              case 'retainer':
                key = getFirstNonFrameworkRetainer(node);
                break;
              case 'testid':
                key = extractTestId(node);
                break;
              case 'dominator':
                // No owner = the dominator is the GC root itself, i.e. the node
                // is reachable through two or more independent paths. Naming
                // that outcome matters more than the others: it is precisely the
                // case where "fix this retainer and X is freed" is false.
                key = owner
                  ? `@${owner.id} ${truncateNodeName(owner.name, owner.type, owner.self_size, 60)}`
                  : '(no single owner — dominated by the GC root, i.e. reachable via ≥2 independent paths)';
                break;
            }

            const existing = groups.get(key);
            if (existing) {
              existing.count++;
              existing.totalRetained += node.retainedSize;
              if (nodeIsDevOnly) existing.devOnlyCount++;
              if (owner) {
                if (existing.ownerIds.size < MAX_TRACKED_OWNERS) {
                  existing.ownerIds.add(owner.id);
                } else if (!existing.ownerIds.has(owner.id)) {
                  existing.ownersTruncated = true;
                }
              } else {
                existing.ownerlessCount++;
              }
              if (node.retainedSize > existing.maxRetainedSize) {
                existing.exampleId = node.id;
                existing.maxRetainedSize = node.retainedSize;
              }
            } else {
              groups.set(key, {
                count: 1,
                totalRetained: node.retainedSize,
                exampleId: node.id,
                maxRetainedSize: node.retainedSize,
                devOnlyCount: nodeIsDevOnly ? 1 : 0,
                ownerIds: new Set(owner ? [owner.id] : []),
                ownersTruncated: false,
                ownerlessCount: owner ? 0 : 1,
                // The owner's own retained size, not the sum of the group's
                // detached nodes: releasing it frees everything it dominates.
                ownerRetained: owner ? owner.retainedSize : 0,
                provenance: owner ? moduleProvenanceOf(owner) : null,
              });
            }
          });

          if (groups.size === 0) {
            if (totalDetached > 0) {
              return toolResult(
                [
                  `Detached DOM grouped by ${group_by}: ${formatNumber(totalDetached)} total nodes, ${formatBytes(totalRetainedAll)} total retained`,
                  ...formatReachabilitySplit(split, snapshot),
                  only_with_retainer_path
                    ? '_No pinned (retainer-path) detached nodes — all detached DOM is GC-eligible / weak-only, not a leak._'
                    : '',
                ].join('\n'),
              );
            }
            return toolResult('No detached DOM nodes found.');
          }

          const sorted = [...groups.entries()]
            .sort((a, b) => b[1].totalRetained - a[1].totalRetained)
            .slice(0, limit);

          const groupLabel =
            group_by === 'element'
              ? 'Element'
              : group_by === 'retainer'
                ? 'Retainer'
                : group_by === 'dominator'
                  ? 'Dominator (accountable owner)'
                  : 'data-testid';

          // Per-group dev-only share. Without this the caller has to run
          // dev_artifacts separately and mentally join the two outputs, which is
          // exactly the step that gets skipped before a group is reported as a
          // production leak.
          const showDevOnly =
            devRoots != null &&
            sorted.some(([, stats]) => stats.devOnlyCount > 0);
          // In dominator mode the owner count is 1 by construction, so the
          // interesting column is what that owner frees; for every other
          // grouping it is how many owners the group is split across.
          const isDominatorMode = group_by === 'dominator';
          // Only widen the table when there is something to say: on a heap with
          // no dev-only or flag-gated owner the column is dead weight.
          const anyFlaggedProvenance = sorted.some(
            ([, st]) =>
              st.provenance != null &&
              (st.provenance.prodReachable === 'no' ||
                st.provenance.prodReachable === 'gated'),
          );
          const ownerCountLabel = (stats: GroupStats): string => {
            const n = stats.ownerIds.size;
            const shown = stats.ownersTruncated ? `${n}+` : String(n);
            if (n === 0) return stats.ownerlessCount > 0 ? 'none' : '-';
            return stats.ownerlessCount > 0 ? `${shown} (+unowned)` : shown;
          };
          const headers = [
            groupLabel,
            'Count',
            ...(showDevOnly ? ['Dev-only'] : []),
            'Total Retained',
            '% of Detached',
            ...(isDominatorMode ? ['Owner Frees'] : ['Owners']),
            ...(anyFlaggedProvenance ? ['Owner is'] : []),
            'Example ID',
          ];
          const rightCols = new Set(
            showDevOnly ? [1, 2, 3, 4, 5] : [1, 2, 3, 4],
          );
          const rows = sorted.map(([key, stats]) => {
            const pct =
              totalRetainedAll > 0
                ? ((stats.totalRetained / totalRetainedAll) * 100).toFixed(1) +
                  '%'
                : '-';
            return [
              key.length > 60 ? key.slice(0, 57) + '...' : key,
              formatNumber(stats.count),
              ...(showDevOnly
                ? [
                    stats.devOnlyCount === 0
                      ? '—'
                      : stats.devOnlyCount === stats.count
                        ? 'ALL'
                        : `${formatNumber(stats.devOnlyCount)}/${formatNumber(stats.count)}`,
                  ]
                : []),
              formatBytes(stats.totalRetained),
              pct,
              isDominatorMode
                ? stats.ownerRetained > 0
                  ? formatBytes(stats.ownerRetained)
                  : '-'
                : ownerCountLabel(stats),
              ...(anyFlaggedProvenance
                ? [
                    stats.provenance == null
                      ? ''
                      : provenanceCell(stats.provenance),
                  ]
                : []),
              `@${stats.exampleId}`,
            ];
          });

          // The dev-only share belongs in the HEADER, not only in a per-group
          // column. A reader who takes the total at face value files a finding:
          // one measured capture was 98.3% React Fast Refresh, and another was
          // 83% browser-owned `History .context`, in both cases with a real
          // GC-root path so the per-node classification said "pinned —
          // actionable leak". The share is the first thing that decides whether
          // the total means anything.
          const devOnlyTotal = sorted.reduce(
            (sum, [, st]) => sum + st.devOnlyCount,
            0,
          );
          const devOnlyPct =
            totalDetached > 0 ? (devOnlyTotal / totalDetached) * 100 : 0;
          const lines = [
            `Detached DOM grouped by ${group_by}: ${formatNumber(totalDetached)} total nodes, ${formatBytes(totalRetainedAll)} total retained`,
            ...(devOnlyTotal > 0
              ? [
                  `**${formatNumber(devOnlyTotal)} of them (${devOnlyPct.toFixed(1)}%) are dev-only** ` +
                    '(React Fast Refresh, DevTools, or the automation bridge) and do not exist in ' +
                    'production. Subtract them before quoting a total: a measured capture read 98.3% ' +
                    'Fast Refresh while every per-node check still said "pinned — actionable leak".',
                ]
              : []),
            ...formatReachabilitySplit(split, snapshot),
          ];
          if (only_with_retainer_path) {
            lines.push('_(groups below show pinned nodes only)_');
          }
          lines.push('', markdownTable(headers, rows, rightCols));

          if (isDominatorMode) {
            const ownerless = sorted.find(
              ([, s]) => s.ownerIds.size === 0 && s.ownerlessCount > 0,
            );
            lines.push(
              '',
              "_Grouped by the nearest non-detached **dominator**: releasing that object frees every detached node in its row. **Owner Frees** is the owner's own retained size — the true, non-overlapping figure, and the amount actually reclaimed (it also covers whatever else the owner holds). Total Retained is a plain sum over the group, so it double-counts nested detached subtrees and can exceed Owner Frees._",
              ...(anyFlaggedProvenance
                ? ['', DEV_ONLY_FOOTNOTE, GATED_FOOTNOTE]
                : []),
            );
            if (ownerless) {
              lines.push(
                `_⚠ ${formatNumber(ownerless[1].count)} node(s) (${formatBytes(ownerless[1].totalRetained)}) have **no single owner** — their dominator is the GC root, so they are reachable through two or more independent paths and no one object frees them. Use \`memlab_retainer_summary\` / \`memlab_get_referrers\` to enumerate every path; all of them must be cut._`,
              );
            }
          } else {
            const notSingleOwner = sorted.filter(
              ([, s]) =>
                s.ownerIds.size === 0 ||
                s.ownerIds.size + (s.ownerlessCount > 0 ? 1 : 0) > 1,
            ).length;
            lines.push(
              '',
              `_**Owners** = distinct accountable dominators the group spans (\`none\` = dominated by the GC root, i.e. reachable via ≥2 independent paths). This grouping keys on ${group_by === 'retainer' ? 'the first non-framework retainer along the SHORTEST retainer path, which need not dominate the nodes' : `the node's ${group_by}`}, so only a group with **Owners = 1** is freed by fixing one object.${notSingleOwner > 0 ? ` ${formatNumber(notSingleOwner)} of the ${formatNumber(sorted.length)} groups below are not single-owner — for those, "fixing this frees X" is wrong; re-run with \`group_by: "dominator"\` to see what actually frees them.` : ''}_`,
            );
          }

          if (devRoots && devRoots.byId.size > 0 && devOnlyRetained > 0) {
            const pct =
              totalRetainedAll > 0
                ? ((devOnlyRetained / totalRetainedAll) * 100).toFixed(0)
                : '0';
            lines.push(
              '',
              `⚠ **${formatBytes(devOnlyRetained)} (${pct}%) of this detached DOM is retained ONLY via dev/automation artifacts** (${summarizeDevRoots(devRoots)}) — dev-global retention would be GC'd in production, and a11y/CDP-cache retention is automation-inflated (not present at that scale in a normal session). Exclude it from leak totals; run \`memlab_dev_artifacts\` for the breakdown.`,
            );
          }

          if (sorted.length > 0) {
            // In dominator mode point at the largest row that HAS an owner —
            // the ownerless bucket can top the table, and "run dominator_chain
            // on it" is meaningless there (it is already at the root).
            const topOwned = isDominatorMode
              ? sorted.find(([, s]) => s.ownerIds.size > 0)
              : undefined;
            lines.push(
              '',
              isDominatorMode
                ? topOwned
                  ? `**Suggested action:** Run \`memlab_dominator_chain\` on the largest owned group's owner to find the accountable application object, then \`memlab_retainer_summary\` on its example (\`@${topOwned[1].exampleId}\`) for the reference that holds it.`
                  : '**Suggested action:** No group has a single owner — every detached node here is reachable via multiple independent paths. Use `memlab_retainer_summary` on an example to enumerate the paths; each one must be cut.'
                : `**Suggested action:** Use \`memlab_retainer_summary\` with node_ids from the top group's example to trace the common retention pattern. Before acting on a group, confirm its **Owners** is 1 — or re-run with \`group_by: "dominator"\`, which groups by what a fix actually frees.`,
            );
          }

          return toolResult(lines.join('\n'));
        }

        const split: ReachabilitySplit = emptySplit();
        const browserContexts2 = findBrowserOwnedContexts(snapshot);
        snapshot.nodes.forEach(node => {
          if (!isDetachedDOMNode(node)) return;
          if (isPinned(node)) {
            split.pinnedCount++;
            split.pinnedRetained += node.retainedSize;
            split.pinnedIds.push(node.id);
            if (isBrowserOwned(node, browserContexts2)) {
              split.browserOwnedCount++;
              split.browserOwnedIds.push(node.id);
            }
          } else {
            split.noPathCount++;
            split.noPathRetained += node.retainedSize;
          }
        });

        const predicate = only_with_retainer_path
          ? (n: IHeapNode): boolean => isDetachedDOMNode(n) && isPinned(n)
          : isDetachedDOMNode;

        const effectiveLimit =
          output_mode === 'ids' ? Math.min(limit, 10000) : Math.min(limit, 500);

        const result = queryNodes(snapshot, predicate, {
          limit: effectiveLimit,
          offset,
          outputMode: output_mode as OutputMode,
        });

        const splitBlock =
          output_mode === 'ids'
            ? ''
            : formatReachabilitySplit(split, snapshot).join('\n') + '\n\n';
        const output = splitBlock + formatQueryNodesResult(result, offset);
        if (result.total_count > 0 && output_mode === 'full') {
          const devNote =
            devRoots && devRoots.byId.size > 0
              ? ` Dev/extension globals (${summarizeDevRoots(devRoots)}) are present — run \`memlab_dev_artifacts\` to exclude DevTools-only retention from leak totals.`
              : '';
          const pinnedNote =
            split.noPathCount > 0
              ? ` ${formatNumber(split.noPathCount)} detached node(s) have no retainer path (likely GC-eligible / weak-only) — pass only_with_retainer_path to focus on the ${formatNumber(split.pinnedCount)} pinned one(s).`
              : '';
          return toolResult(
            output +
              '\n\n---\n\n' +
              '**Suggested action:** Check for missing `removeEventListener` calls, ' +
              'React component cleanup in `useEffect` return, or refs not cleared on unmount. ' +
              'Use `memlab_retainer_trace` on top entries to find the retention path. ' +
              'Use `group_by: "dominator"` to see which objects are accountable for the most detached DOM (releasing one frees its whole group), or `group_by: "retainer"` for the shortest-path view.' +
              pinnedNote +
              devNote,
          );
        }
        return toolResult(output);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

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
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {z} from 'zod';
import {
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';

/**
 * A cross-round index of leak findings, keyed by a normalized retainer-path
 * signature.
 *
 * The problem this solves is the most expensive one a hunt hits: rounds
 * re-discover leaks that are already known or already fixed. One measured round
 * produced three findings — a listener accumulation, a completion-map grower and
 * a module-registry grower — all three of which were known, two already fixed
 * behind gates, and the first only visible because the gated fixes were not
 * enabled. That is an entire round spent re-deriving history.
 *
 * Why a retainer-path signature rather than the class name: the class that grows
 * is rarely distinctive (`Object`, `Array`, `(object properties)` are the top
 * growers in almost every heap), while the PATH that retains it is. Node ids,
 * array indices and per-instance scope ids differ per capture, so they are
 * stripped; what remains — the ordered edge names and class names — is stable
 * across captures of the same leak and different between different leaks.
 *
 * Deliberately local (a JSON file), not a service: the index is only useful if
 * it is written by default on every round, and anything requiring a backend
 * would not be. It is seeded from prior runs' manifests.
 */

/**
 * Where the index lives, most specific wins.
 *
 * The default is a per-machine home directory, and that default is the reason
 * the tool has already produced a wrong verdict: an index with no history
 * answers `check` with **NEW** for a finding that is fully documented and
 * already has a fix diff. A home-dir file cannot be shared, does not survive a
 * host change, and is empty on every new devserver — so the failure recurs for
 * every operator rather than once.
 *
 * `MEMLAB_FINDINGS_INDEX` therefore points at a checked-in, shared file, and
 * `workstream` scopes several of them side by side. The home-dir path is kept as
 * the fallback so nothing that already works breaks.
 */
/** A `.json` suffix in any case means the override names a FILE, not a dir. */
function isJsonPath(p: string): boolean {
  return /\.json$/i.test(p);
}

/**
 * A workstream becomes part of a FILENAME, so it must not be able to be a path.
 *
 * `findings.${workstream}.json` with a workstream of `../../x` escapes the
 * index directory, and the index is written with mkdir -p — so an unsanitised
 * name turns "which findings file do I read" into an arbitrary JSON write.
 */
function safeWorkstream(ws: string): string {
  const cleaned = ws.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  return cleaned === '' ? 'default' : cleaned;
}

export function resolveIndexPath(workstream?: string): string {
  const override = process.env.MEMLAB_FINDINGS_INDEX;
  if (override != null && override !== '') {
    if (workstream == null || workstream === '') {
      // A DIRECTORY override has to resolve to a file inside it, not to the
      // directory. Returning the directory made the unscoped index unreadable
      // (so every check answered NEW against a freshly seeded in-memory index)
      // AND put sibling-index discovery in the wrong parent, so the scoped
      // index sitting right there was never mentioned.
      return isJsonPath(override)
        ? override
        : path.join(override, 'findings.json');
    }
    // Treat the override as a directory when a workstream is named, so one
    // shared location can hold several workstreams without collision.
    const ws = safeWorkstream(workstream);
    return isJsonPath(override)
      ? override.replace(/\.json$/i, `.${ws}.json`)
      : path.join(override, `findings.${ws}.json`);
  }
  const base = path.join(process.env.HOME ?? '/tmp', '.memlab-mcp');
  return path.join(
    base,
    workstream != null && workstream !== ''
      ? `findings.${safeWorkstream(workstream)}.json`
      : 'findings.json',
  );
}

interface Finding {
  fingerprint: string;
  signature: string;
  growing_classes: string[];
  first_seen_round: string;
  last_seen_round: string;
  status: 'new' | 'known' | 'fixed' | 'retracted' | 'artifact';
  fixed_behind?: string;
  /**
   * Diffs that carry the fix, as D-numbers.
   *
   * Separate from the free-text `fixed_behind` because that field has been
   * carrying load-bearing structure as prose — "D1 stacked on D2, BOTH required",
   * "effective only if <other gate> is also on". A reader has to parse a sentence
   * to learn which diffs to check, and a tool cannot reconcile it at all.
   */
  fixed_by_diffs?: string[];
  /** Whether a real before/after A/B confirmed the fix, rather than reasoning. */
  verified_by_ab?: boolean;
  /**
   * Whether the gate named in `fixed_behind` is actually SERVING the fix.
   *
   * A fix recorded as "fixed behind <gate>" reads as done, and `check` said so
   * for a gate whose experiment had expired three weeks earlier and whose code
   * branch had since been deleted. The result was two successive wrong
   * recommendations ("re-allocate and A/B it", then "the mechanism is gone").
   * A fix is only a fix while its gate is allocated AND its code still exists.
   */
  gate_state?: 'allocated' | 'expired' | 'deallocated' | 'code_removed';
  /** When `gate_state` was last confirmed, so a stale answer can be spotted. */
  gate_checked_on?: string;
  /** Why a finding was withdrawn; required in practice for `retracted`. */
  retraction_reason?: string;
  note?: string;
  seen_count: number;
}

interface FindingIndex {
  version: number;
  findings: Record<string, Finding>;
  combos_driven: Record<string, string[]>;
}

/**
 * Accept BOTH shapes an index file can legitimately have on disk.
 *
 * `findings` is keyed by fingerprint everywhere in this module, but `export`
 * writes a plain ARRAY — and the message it prints tells the operator to point
 * `MEMLAB_FINDINGS_INDEX` at that very file. Loading it back as an array made
 * every `index.findings[fingerprint]` lookup miss, so `check` answered NEW for
 * findings that were in the file, which is the exact silent failure this tool
 * exists to prevent. `hasAppHistory` did not catch it either: `Object.values`
 * of a non-empty array is non-empty, so the "index is empty" warning stayed
 * quiet. Re-keying on load fixes the exported file and any hand-written array.
 */
function normalizeFindings(
  findings: FindingIndex['findings'] | Finding[] | undefined,
): Record<string, Finding> {
  if (findings == null) return {};
  if (!Array.isArray(findings)) return findings;
  const keyed: Record<string, Finding> = {};
  for (const f of findings) {
    // Prefer a recomputed fingerprint over the stored one: a hand-edited row
    // can carry a `fingerprint` that no longer matches its own signature and
    // classes, and the lookup key is what has to be right.
    //
    // Normalized first, exactly as `importFindings` and `check` do. An
    // exported row is already normalized, so this is a no-op there — but the
    // hand-written array this function exists to accept can hold a RAW
    // retainer path, and keying that verbatim produces a fingerprint `check`
    // never computes, which is the same silent miss in a new place.
    const signature =
      f?.signature != null ? normalizeRetainerPath(f.signature) : null;
    const key =
      signature != null
        ? fingerprintOf(signature, f.growing_classes ?? [])
        : f?.fingerprint;
    if (key == null || key === '') continue;
    keyed[key] = {
      ...f,
      fingerprint: key,
      ...(signature != null ? {signature} : {}),
    };
  }
  return keyed;
}

function loadIndex(indexPath: string): FindingIndex {
  try {
    if (fs.existsSync(indexPath)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (parsed != null && typeof parsed === 'object') {
        const idx = parsed as Partial<FindingIndex>;
        return {
          version: idx.version ?? 1,
          findings: normalizeFindings(idx.findings),
          combos_driven: idx.combos_driven ?? {},
        };
      }
    }
  } catch {
    // A corrupt index must not block a hunt — but it must not be silently
    // erased either: returning empty here means the next `record` overwrites
    // the file wholesale and every prior fingerprint is gone, which defeats the
    // one thing this tool exists to do. Preserve it for recovery first.
    try {
      if (fs.existsSync(indexPath)) {
        fs.renameSync(indexPath, `${indexPath}.corrupt`);
      }
    } catch {
      // Best effort; a failed rename must not block the hunt either.
    }
  }
  // A brand-new index is seeded with the artifact families rather than left
  // empty, so the very first `check` can answer KNOWN for a population that is
  // documented and is not app memory. Seeding on CREATION (not on every load)
  // means a caller who deliberately removes one keeps it removed.
  const fresh: FindingIndex = {version: 1, findings: {}, combos_driven: {}};
  importFindings(fresh, builtinSeedFindings());
  return fresh;
}

function saveIndex(indexPath: string, idx: FindingIndex): void {
  fs.mkdirSync(path.dirname(indexPath), {recursive: true});
  fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2));
}

/**
 * Findings accepted by `action: "import"`.
 *
 * Loose on purpose: the source is a hand-maintained team document or a previous
 * round's notes, and rejecting a row for a missing optional field would mean the
 * bootstrap does not happen at all — which is the status quo this fixes.
 */
const IMPORTED_FINDING_SCHEMA = z.object({
  retainer_path: z.string().optional(),
  signature: z.string().optional(),
  growing_classes: z.array(z.string()).optional(),
  round: z.string().optional(),
  status: z.enum(['new', 'known', 'fixed', 'retracted', 'artifact']).optional(),
  gate_state: z
    .enum(['allocated', 'expired', 'deallocated', 'code_removed'])
    .optional(),
  gate_checked_on: z.string().optional(),
  fixed_behind: z.string().optional(),
  fixed_by_diffs: z.array(z.string()).optional(),
  verified_by_ab: z.boolean().optional(),
  retraction_reason: z.string().optional(),
  note: z.string().optional(),
});

type ImportedFinding = z.infer<typeof IMPORTED_FINDING_SCHEMA>;

export function importFindings(
  index: FindingIndex,
  incoming: ImportedFinding[],
): {imported: number; updated: number; skipped: string[]} {
  let imported = 0;
  let updated = 0;
  const skipped: string[] = [];

  incoming.forEach((raw, i) => {
    const source = raw.retainer_path ?? raw.signature;
    if (source == null || source === '') {
      skipped.push(`entry ${i}: neither retainer_path nor signature`);
      return;
    }
    // A `signature` is already normalized by definition; normalizing again is a
    // no-op on well-formed input and repairs a hand-written one.
    const signature = normalizeRetainerPath(source);
    const classes = raw.growing_classes ?? [];
    const fingerprint = fingerprintOf(signature, classes);
    const existing = index.findings[fingerprint];
    const round = raw.round ?? 'imported';
    index.findings[fingerprint] = {
      fingerprint,
      signature,
      growing_classes: classes,
      first_seen_round: existing?.first_seen_round ?? round,
      last_seen_round: round,
      // `new` is a check VERDICT, not a state a finding can be stored in —
      // an entry that exists in the index is by definition not new, and
      // storing it read back as KNOWN anyway. Normalised on the way in so
      // what is written is what is reported.
      status: storableStatus(raw.status ?? existing?.status),
      fixed_behind: raw.fixed_behind ?? existing?.fixed_behind,
      fixed_by_diffs: raw.fixed_by_diffs ?? existing?.fixed_by_diffs,
      verified_by_ab: raw.verified_by_ab ?? existing?.verified_by_ab,
      gate_state: raw.gate_state ?? existing?.gate_state,
      gate_checked_on: raw.gate_checked_on ?? existing?.gate_checked_on,
      retraction_reason: raw.retraction_reason ?? existing?.retraction_reason,
      note: raw.note ?? existing?.note,
      // An import is history, not a sighting: it must not inflate seen_count
      // for a finding this operator has never actually observed.
      seen_count: existing?.seen_count ?? 1,
    };
    if (existing) updated++;
    else imported++;
  });

  return {imported, updated, skipped};
}

/**
 * Normalize a retainer path into a signature that is stable across captures.
 *
 * Strips exactly the things that differ per capture and nothing else:
 *  - `@12345` node ids, including the ` @…`-suffixed Context/scope names;
 *  - numeric array indices (`[47]`, `.47`), which depend on insertion order;
 *  - hex/long digit runs inside names (ids embedded in keys, e.g. a chat id).
 */
export function normalizeRetainerPath(raw: string): string {
  return (
    raw
      .replace(/@\d+/g, '@')
      .replace(/\[\d+\]/g, '[i]')
      // Broad lookahead: retainer paths carry trailing `)`, `]`, `>` and the
      // separator inserted below, so a `\\s|$|\\.`-only lookahead leaves `.47)` /
      // `.47>` unnormalized and feeds per-capture noise into the fingerprint.
      .replace(/\.\d+(?=[^\w]|$)/g, '.i')
      .replace(/\b\d{4,}\b/g, 'N')
      .replace(/\s*(-->|--|→|->)\s*/g, ' > ')
      // `-->` would otherwise match `--` and `->` in turn, doubling the separator.
      .replace(/(?: > )+/g, ' > ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function fingerprintOf(signature: string, classes: string[]): string {
  const material = `${signature}||${[...classes].sort().join(',')}`;
  return crypto.createHash('sha1').update(material).digest('hex').slice(0, 12);
}

/**
 * Artifact families every hunt re-derives, seeded into a fresh index.
 *
 * An empty index answers NEW to everything — including populations that are
 * documented, well understood, and not app memory at all. That makes the first
 * `check` of a workstream actively misleading rather than merely unhelpful, and
 * hand-seeding never happens because it is a step nobody is prompted to take.
 *
 * These entries are deliberately the GENERIC, tool-detectable families (the
 * same taxonomy `artifact-classes.ts` classifies, plus the two dev-build
 * registries `dev_artifacts` detects). They are marked `known` rather than
 * `fixed`: they are not defects to be fixed, they are populations a hunt must
 * subtract. Anything app-specific belongs in a real `action: "import"`.
 */
/**
 * The status an entry can actually be STORED with.
 *
 * `new` is a verdict `check` returns, not a state: anything present in the
 * index has been seen before. Both write schemas accepted it, and it then read
 * back as KNOWN — the index reporting something other than what was written.
 */
function storableStatus(s?: Finding['status']): Finding['status'] {
  return s == null || s === 'new' ? 'known' : s;
}

export function builtinSeedFindings(): ImportedFinding[] {
  const seed = (
    signature: string,
    growing_classes: string[],
    note: string,
  ): ImportedFinding => ({
    signature,
    growing_classes,
    round: 'builtin',
    // Every builtin seed is a measurement artifact — JIT warmup, CDP
    // bookkeeping, a11y caches, Fast Refresh registries, the automation
    // bridge. Seeding them as `known` meant the strongest thing the index can
    // say ("stop, this is not app memory") was never actually said by the
    // families it was written for; a check answered KNOWN, which only means
    // someone has seen it before.
    status: 'artifact',
    note,
  });
  return [
    seed(
      'V8 JIT/compile warmup structures',
      [
        'Code',
        'BytecodeArray',
        'FeedbackVector',
        'ScopeInfo',
        'InstructionStream',
      ],
      'Exercising new code paths during a hunt JIT-compiles them, so this family climbs every step without being an app leak. Not a finding.',
    ),
    seed(
      'Blink accessibility cache inflated by automation',
      ['AXObjectCacheImpl', 'AXNodeObject', 'AXDirtyObject'],
      'CDP-driven automation builds the a11y tree. These co-retain detached DOM, so retainer traces can route through them and mislead.',
    ),
    seed(
      'CDP inspector network log',
      ['NetworkResourcesData', 'XHRReplayData', 'PerformanceResourceTiming'],
      'Every request made while CDP is attached is retained by the DevToolsSession for the session. A dev build that polls grows this forever. Not app memory.',
    ),
    seed(
      'CDP inspector performance timeline',
      ['PerformanceLongTaskTiming', 'PerformanceScriptTiming', 'LayoutShift'],
      'Accumulates because something is observing it, not because the app leaks.',
    ),
    seed(
      'CDP inspector console retention',
      ['ConsoleMessage'],
      'Console-retained memory scales with how much the app logs, not with what it holds. A dev build logging per cycle produces a clean linear "leak" that does not exist in production.',
    ),
    seed(
      'Captured Error stacks (React DEV owner stacks)',
      ['StackFrameInfo', 'ErrorStackData'],
      'Usually React DEV `_debugStack` or dev-build logging capturing a stack per record. Dev-build only, but a production build can legitimately grow these — check before dismissing.',
    ),
    seed(
      'React Fast Refresh registries (dev-only)',
      ['allFamiliesByID', 'allFamiliesByType', 'allSignaturesByType'],
      'Dev-only hot-reload bookkeeping. The backing tables are large and sparse and V8 never shrinks an EphemeronHashTable, so they present as a big anonymous array at the top of a leak report.',
    ),
    seed(
      'Automation/tool bridge bundle',
      ['(concatenated string)', '(string)'],
      'The browser-automation bridge is re-evaluated per call and its source is retained per copy. Presents as many megabytes of duplicated script text that no production user ever loads.',
    ),
  ];
}

/**
 * Known entries that share a growing class with the candidate.
 *
 * The fingerprint is an EXACT match on signature + class set, which is right for
 * "have we filed this before" and useless for "is this population a known
 * artifact". Measured against a freshly-seeded index: a realistic check —
 * retainer path `(GC roots) > (Global handles) > Object.allSignaturesByType`,
 * growing class `allSignaturesByType` — returned NEW, even though the React Fast
 * Refresh registry entry naming that exact class was sitting in the index. A
 * caller has to reproduce the seeded signature string verbatim to get a hit,
 * which nobody will ever do, so without this the seeding is decorative.
 *
 * Reported ALONGSIDE the NEW verdict rather than replacing it: a class overlap
 * is a lead, not an identification, and silently converting NEW to KNOWN on one
 * shared class name would suppress real findings.
 */
export function relatedByClass(
  index: FindingIndex,
  classes: readonly string[],
  excludeFingerprint: string,
): Finding[] {
  if (classes.length === 0) return [];
  const wanted = new Set(classes);
  return Object.values(index.findings)
    .filter(f => f.fingerprint !== excludeFingerprint)
    .map(f => ({
      f,
      shared: f.growing_classes.filter(c => wanted.has(c)),
    }))
    .filter(x => x.shared.length > 0)
    .sort((a, b) => b.shared.length - a.shared.length)
    .slice(0, 5)
    .map(x => x.f);
}

/**
 * Does the index hold anything beyond the generic built-in artifact families?
 *
 * `loadIndex` seeds a fresh index with those families, so a plain
 * `Object.keys(findings).length === 0` is never true and every "is this index
 * usable" guard built on it silently never fires. The question that actually
 * matters is whether the index carries history for THIS app; built-in entries
 * are stamped `first_seen_round: 'builtin'` and say nothing about it.
 */
export function hasAppHistory(index: {
  findings: Record<string, {first_seen_round: string}>;
}): boolean {
  return Object.values(index.findings).some(
    f => f.first_seen_round !== 'builtin',
  );
}

/**
 * Fingerprint a candidate and look it up, for callers that are not the
 * `memlab_finding_index` tool itself.
 *
 * Exists because the index only prevents re-discovery if somebody remembers to
 * consult it, and in practice nobody does: a measured session produced three
 * findings that were all already fixed behind gates, and never called `check`
 * once. The tools that actually surface findings — `auto_investigate`,
 * `leak_report` — now annotate inline instead of relying on that recall.
 *
 * Returns `indexEmpty` so the caller can say the verdict means nothing rather
 * than printing a confident NEW from an index that has never been seeded.
 */
export type FindingLookup = {
  verdict: 'NEW' | 'KNOWN' | 'KNOWN-AND-FIXED' | 'ARTIFACT' | 'RETRACTED';
  fixedBehind?: string;
  /** Set when the hit is `fixed` and its gate is known not to be serving. */
  gateState?: 'allocated' | 'expired' | 'deallocated' | 'code_removed';
  gateCheckedOn?: string;
  note?: string;
  round?: string;
  related: string[];
  indexEmpty: boolean;
  indexPath: string;
};

/**
 * The index, read once, for callers that look up many candidates in a row.
 *
 * `lookupFinding` reads and parses the index file on every call, which is
 * fine for a one-off check and wasteful inside a report loop that annotates
 * every finding — that turns one read into N reads of the same file.
 */
export type LoadedFindingIndex = {
  index: FindingIndex;
  indexPath: string;
};

/**
 * The workstream the last `import` / `record` in this server session used.
 *
 * `import` writes a workstream-scoped file (findings.<ws>.json) while a later
 * `check` with no `workstream` reads the UNSCOPED one — so a freshly seeded
 * index still answered "NEW, and by the way this index is empty" to everything.
 * Measured: 18 findings imported, next `check` read an 8-entry default index and
 * printed the empty-index banner. Remembering the last scope makes the common
 * seed-then-check sequence work without the caller repeating it.
 */
/**
 * Process-global, which is safe ONLY because this server speaks stdio to one
 * client. If it is ever given a multi-client transport, this has to move onto
 * a per-session object — two hunts with different workstreams would otherwise
 * overwrite each other's remembered scope and read the wrong index.
 */
let lastWorkstream: string | undefined;

/** Exported for tests; resets the sticky scope. */
export function setLastWorkstream(ws?: string): void {
  lastWorkstream = ws;
}

export function stickyWorkstream(ws?: string): string | undefined {
  return ws != null && ws !== '' ? ws : lastWorkstream;
}

export function loadFindingIndex(workstream?: string): LoadedFindingIndex {
  // The remembered scope is applied HERE, not only in the tool handler. This
  // is the read path every inline annotation goes through (`memlab_leak_report`,
  // `memlab_auto_investigate`), and leaving it unscoped meant a bare `check`
  // read the seeded workstream index while an annotation for the same
  // candidate read the empty unscoped one — two different verdicts for one
  // population, in the same session.
  const indexPath = resolveIndexPath(stickyWorkstream(workstream));
  return {index: loadIndex(indexPath), indexPath};
}

export function lookupFinding(
  retainerPath: string,
  classes: readonly string[],
  workstream?: string,
): FindingLookup {
  return lookupFindingIn(loadFindingIndex(workstream), retainerPath, classes);
}

export function lookupFindingIn(
  loaded: LoadedFindingIndex,
  retainerPath: string,
  classes: readonly string[],
): FindingLookup {
  const {index, indexPath} = loaded;
  const signature = normalizeRetainerPath(retainerPath);
  const classList = [...classes];
  const fingerprint = fingerprintOf(signature, classList);
  const hit = index.findings[fingerprint];
  const indexEmpty = !hasAppHistory(index);
  if (hit) {
    return {
      // `retracted` is mapped here, not only in the `check` renderer. Inline
      // annotations (`memlab_leak_report`, `memlab_auto_investigate`) go
      // through this function, and showing a withdrawn finding as KNOWN loses
      // the one instruction that matters — that a previous round investigated
      // it and took it back.
      verdict:
        hit.status === 'artifact'
          ? 'ARTIFACT'
          : hit.status === 'retracted'
            ? 'RETRACTED'
            : hit.status === 'fixed'
              ? 'KNOWN-AND-FIXED'
              : 'KNOWN',
      fixedBehind: hit.fixed_behind,
      gateState: hit.gate_state,
      gateCheckedOn: hit.gate_checked_on,
      note: hit.note,
      round: hit.first_seen_round,
      related: [],
      indexEmpty,
      indexPath,
    };
  }
  return {
    verdict: 'NEW',
    related: relatedByClass(index, classList, fingerprint).map(
      f =>
        `${f.growing_classes.join(', ')}${f.fixed_behind ? ` (fixed behind ${f.fixed_behind})` : ''}`,
    ),
    indexEmpty,
    indexPath,
  };
}

/**
 * The sentence a KNOWN-AND-FIXED verdict needs when its gate is not serving.
 *
 * "Fixed behind <gate>" reads as done. It is only true while the gate is
 * allocated and the code behind it still exists — and a recorded fix whose
 * experiment had expired and whose branch had been deleted produced two
 * successive wrong recommendations before anyone checked.
 */
function renderGateWarning(l: FindingLookup): string {
  // Rendered for ANY status, not just `fixed`. A gate state recorded against
  // a `known` or `artifact` finding was stored and then never shown, so the
  // field silently did nothing for three of the five statuses that accept it.
  if (l.gateState == null || l.gateState === 'allocated') return '';
  const when = l.gateCheckedOn != null ? ` (checked ${l.gateCheckedOn})` : '';
  const what =
    l.gateState === 'code_removed'
      ? 'its code branch has been REMOVED from the tree, so re-enabling the gate does nothing'
      : `its gate is recorded as ${l.gateState.toUpperCase()}, so the fix is NOT serving`;
  // The date belongs on every branch: gate state is a fact with an expiry, and
  // "code_removed" is the one a reader is most likely to act on without
  // re-checking. Omitting it here disagreed with the `check` rendering, which
  // did print it.
  return ` — ⚠️ ${what}${when}. Verify before planning an A/B against it.`;
}

/** One-line renderer for an inline verdict badge. */
export function renderFindingVerdict(l: FindingLookup): string {
  // ARTIFACT is deliberately its own verdict rather than a flavour of KNOWN.
  // It is the single most important thing the index can say — "this population
  // is not app memory at all" ends the investigation, where KNOWN only means
  // "someone has seen this before". Folding the two together forced artifact
  // seeds to be imported as `known` with the word ARTIFACT in the title, so the
  // distinction survived only in prose a tool could not read.
  if (l.verdict === 'ARTIFACT') {
    return (
      `\`ARTIFACT — not production memory\`${l.round ? ` (recorded ${l.round})` : ''}${l.note ? `: ${l.note}` : ''}` +
      renderGateWarning(l)
    );
  }
  if (l.verdict === 'RETRACTED') {
    return (
      `\`RETRACTED — investigated and WITHDRAWN\`${l.round ? ` (${l.round})` : ''}${l.note ? `: ${l.note}` : ''}` +
      renderGateWarning(l)
    );
  }
  if (l.verdict === 'KNOWN-AND-FIXED') {
    return (
      `\`KNOWN-AND-FIXED\`${l.fixedBehind ? ` — fixed behind \`${l.fixedBehind}\`; confirm the gate is ON in this capture before treating it as a finding` : ''}` +
      renderGateWarning(l)
    );
  }
  if (l.verdict === 'KNOWN') {
    return (
      `\`KNOWN\`${l.round ? ` — first seen ${l.round}` : ''}${l.note ? `: ${l.note}` : ''}` +
      renderGateWarning(l)
    );
  }
  const related =
    l.related.length > 0
      ? ` (but shares a growing class with: ${l.related.slice(0, 2).join('; ')} — a lead, not an identification)`
      : '';
  return `\`NEW\`${related}`;
}

/**
 * Other workstream indexes sitting next to the one that was just read.
 *
 * The failure this prevents: `import` writes `findings.<ws>.json` while a later
 * `check` with no `workstream` reads the unscoped `findings.json`, so a freshly
 * seeded index still answers "NEW, and this index is empty". Session
 * stickiness fixes the common sequence, but it cannot survive a server restart
 * — and the operator has no way to tell the two indexes apart from the output.
 * Naming the neighbours turns a misleading verdict into an obvious one.
 */
function siblingWorkstreamIndexes(
  indexPath: string,
): Array<{workstream: string; count: number; path: string}> {
  try {
    const dir = path.dirname(indexPath);
    const self = path.basename(indexPath);
    return fs
      .readdirSync(dir)
      .filter(f => f !== self && /^findings\..+\.json$/i.test(f))
      .map(f => {
        const full = path.join(dir, f);
        let count = 0;
        try {
          const raw = JSON.parse(fs.readFileSync(full, 'utf8')) as {
            findings?:
              | Record<string, {first_seen_round?: string}>
              | Array<{first_seen_round?: string}>;
          };
          const found = raw.findings;
          const entries = Array.isArray(found)
            ? found
            : Object.values(found ?? {});
          // APP history only. Every index is created pre-seeded with the
          // builtin artifact families, so counting raw entries advertised a
          // never-used neighbour as "8 finding(s)" and sent the operator to a
          // second empty index — the same misleading verdict this hint exists
          // to prevent, one file over.
          count = entries.filter(e => e?.first_seen_round !== 'builtin').length;
        } catch {
          // An unreadable neighbour is not worth failing a check over.
        }
        return {
          workstream: f.replace(/^findings\./i, '').replace(/\.json$/i, ''),
          count,
          path: full,
        };
      })
      .filter(e => e.count > 0);
  } catch {
    return [];
  }
}

/**
 * The banner to print once per report when the index cannot support a verdict.
 */
export function findingIndexEmptyBanner(indexPath: string): string {
  return (
    `> ⚠️ **The findings index at \`${indexPath}\` is EMPTY, so every \`NEW\` below means "not in an empty list" and carries no information.** ` +
    'Seed it with `memlab_finding_index({action: "import"})` before trusting any verdict here. ' +
    'An unseeded index is how a round spends itself re-deriving a finding that was already filed and already fixed.'
  );
}

export function registerFindingIndex(server: McpServer): void {
  server.tool(
    'memlab_finding_index',
    'Fingerprint a leak finding by its retainer path and check it against findings from previous rounds, so a hunt does not spend itself re-discovering a known or already-fixed leak. ' +
      'This is the highest-cost failure a leak hunt has: a measured round produced three findings that were all already known — two already fixed behind gates — which is an entire round spent re-deriving history. Class names cannot detect that (`Object` and `Array` top every heap); the retainer PATH can, so the fingerprint is a normalized path signature with node ids, array indices and per-capture scope ids stripped. ' +
      'Actions: "check" fingerprints a candidate and reports NEW / KNOWN / KNOWN-AND-FIXED / RETRACTED / ARTIFACT; a RETRACTED finding is one a previous round investigated and WITHDREW (a measurement error, a structural population mistaken for a rate) — re-deriving one costs the same round as re-deriving a fixed leak and is harder to notice, because the population really is present. ARTIFACT is the stronger statement and its own verdict: the population is real and reproducible but is NOT app memory (an automation bridge, a DevTools hook, a dev-only registry), so it must be excluded from any total rather than re-investigated; "record" adds it; "import" bootstraps history in bulk from a team doc or a JSON file; "list" prints the index; "cover" records which combos a round drove, so the "do not repeat covered combos" rule stops depending on someone remembering.\n\n' +
      'IMPORTANT: a verdict of NEW is only as good as the index behind it. A newly-created index is pre-seeded with the generic ARTIFACT families (JIT warmup, CDP network/perf/console retention, a11y caches, React Fast Refresh registries, captured Error stacks, the automation bridge bundle), so the first `check` can already answer KNOWN for a population that is documented and is not app memory — but it knows nothing about YOUR app. Seed that with `action: "import"` before trusting the first `check` of a workstream. Set `MEMLAB_FINDINGS_INDEX` to a checked-in path to share the index across hosts and operators instead of keeping it in a per-machine home directory.',
    {
      action: z
        .enum(['check', 'record', 'list', 'cover', 'import', 'export'])
        .describe(
          '"check" (fingerprint + look up, no write), "record" (add/update), "import" (bulk-seed history), "export" (write the whole index to a file so it can be checked in), "list", "cover" (log combos driven in a round).',
        ),
      retainer_path: z
        .string()
        .optional()
        .describe(
          "The finding's retainer path, as printed by memlab_retainer_summary / memlab_retainer_trace. Required for check and record.",
        ),
      growing_classes: z
        .array(z.string())
        .optional()
        .default([])
        .describe(
          'Classes that grew across the ladder for this finding. Folded into the fingerprint so the same path holding a different class set is a different finding.',
        ),
      round: z
        .string()
        .optional()
        .describe(
          'Round identifier (e.g. "r59"), recorded as first/last seen.',
        ),
      status: z
        .enum(['new', 'known', 'fixed', 'retracted', 'artifact'])
        .optional()
        .default('known')
        .describe(
          'Status to record. Use "fixed" together with `fixed_behind` and `fixed_by_diffs`. Use "retracted" with `retraction_reason` for a finding that was investigated and WITHDRAWN — a measurement error, a structural population mistaken for a rate. Use "artifact" for a population that is REAL and reproducible but is not the app: a devtools bridge, a dev-only cache, a Fast Refresh record. The two are different instructions to the next round — "do not trust this number" versus "this number is right and belongs to the harness" — and collapsing them into "retracted" is how an artifact gets re-investigated as a candidate leak.',
        ),
      fixed_behind: z
        .string()
        .optional()
        .describe('Gate/ABProp the fix sits behind, if it is fixed.'),
      fixed_by_diffs: z
        .array(z.string())
        .optional()
        .describe(
          'D-numbers carrying the fix, e.g. ["D123", "D124"]. Structured because `fixed_behind` has been carrying this as prose ("D1 stacked on D2, BOTH required"), which a reader has to parse and a tool cannot reconcile.',
        ),
      gate_state: z
        .enum(['allocated', 'expired', 'deallocated', 'code_removed'])
        .optional()
        .describe(
          'Whether the gate in `fixed_behind` is actually SERVING the fix. "Fixed behind <gate>" reads as done, but it is only true while the gate is allocated AND its code still exists — a recorded fix whose experiment had expired and whose branch had since been deleted produced two successive wrong recommendations before anyone checked. `check` warns loudly on anything but "allocated".',
        ),
      gate_checked_on: z
        .string()
        .optional()
        .describe(
          'When `gate_state` was last confirmed (e.g. "2026-09-23"), so a stale answer can be spotted rather than trusted.',
        ),
      verified_by_ab: z
        .boolean()
        .optional()
        .describe(
          'True when a real before/after A/B confirmed the fix rather than reasoning about it. A fix recorded without this is a claim, not a result.',
        ),
      retraction_reason: z
        .string()
        .optional()
        .describe(
          'Why the finding was withdrawn. Required in practice for status "retracted" — a retraction with no reason cannot stop the next round re-deriving it.',
        ),
      note: z
        .string()
        .optional()
        .describe('Free-text note stored with the finding.'),
      combos: z
        .array(z.string())
        .optional()
        .default([])
        .describe('For action "cover": combo names driven in this round.'),
      workstream: z
        .string()
        .optional()
        .describe(
          'Scopes the index file, so one shared location can hold several hunts side by side (e.g. "wa-web"). Omit to use the unscoped index.',
        ),
      to: z
        .string()
        .optional()
        .describe(
          'For action "export": the file to write the index to. Point it at a checked-in path and set MEMLAB_FINDINGS_INDEX to the same path.',
        ),
      from: z
        .string()
        .optional()
        .describe(
          'For action "import": path to a JSON file holding either an array of findings or {findings: [...]}. Each entry needs retainer_path (or signature) and may carry growing_classes, round, status, fixed_behind, note.',
        ),
      findings: z
        .array(IMPORTED_FINDING_SCHEMA)
        .optional()
        .describe(
          'For action "import": findings passed inline, for seeding straight from a team doc without writing a file first.',
        ),
    },
    async ({
      action,
      retainer_path,
      growing_classes,
      round,
      status,
      fixed_behind,
      fixed_by_diffs,
      verified_by_ab,
      gate_state,
      gate_checked_on,
      retraction_reason,
      note,
      combos,
      workstream,
      from,
      to,
      findings,
    }) => {
      try {
        // A WRITE never inherits a remembered scope. Convenience for a bare
        // `check` is worth a remembered scope; silently filing a finding into
        // whichever index a previous call happened to touch is not — the
        // finding lands somewhere the caller did not name and the next round
        // does not find it. Reads may inherit; writes use what was passed.
        const isWrite =
          action === 'import' || action === 'record' || action === 'cover';
        const effectiveWorkstream = isWrite
          ? workstream
          : stickyWorkstream(workstream);
        // Remembered from ANY call that names one, including `check`. Updating
        // it only on writes meant a bare check after an explicit check reverted
        // to an older scope.
        if (workstream != null && workstream !== '') {
          lastWorkstream = workstream;
        } else if (isWrite) {
          // A bare WRITE goes to the unscoped index, so the remembered scope
          // has to go with it. Leaving it set sent the next bare `check` to a
          // different file than the import that had just run — the import
          // appeared to have done nothing.
          lastWorkstream = undefined;
        }
        const indexPath = resolveIndexPath(effectiveWorkstream);
        const index = loadIndex(indexPath);
        // Printed on EVERY action. The index a call actually read is the one
        // fact needed to tell "this candidate is new" from "I read the wrong
        // file", and it used to appear only in the empty-index banner.
        const indexPathLine = `_Index: \`${indexPath}\`${
          effectiveWorkstream != null && effectiveWorkstream !== ''
            ? ` (workstream \`${effectiveWorkstream}\`${workstream == null || workstream === '' ? ', remembered from an earlier call in this session' : ''})`
            : ' (unscoped)'
        }._`;

        // Appended to EVERY action, not just `check`. The path is the one
        // signal that separates "this candidate really is new" from "I read
        // the wrong file", and a write benefits from it most — an import that
        // landed in a neighbouring index looks identical to one that worked.
        const result = (text: string): ReturnType<typeof toolResult> =>
          toolResult(
            text.includes(indexPathLine) ? text : `${text}\n\n${indexPathLine}`,
          );

        if (action === 'export') {
          // The round trip `import` always implied. A previous sweep recorded
          // that it had "checked in" its seeded index, but the file exists in
          // neither the repo nor the plugin — because there was no way to get
          // the index back OUT. Without this the index is per-machine by
          // construction, and the next host starts empty and answers NEW to
          // everything.
          // `index` is already loaded from `indexPath` above; re-reading and
          // re-parsing the same file gave two copies that could only drift.
          const idx = index;
          // Deliberately NOT `to ?? from`. `from` is the import SOURCE, so a
          // call that passed only `from` — e.g. the checked-in seed file it
          // just imported — overwrote that file with the current export, and
          // if the live index held fewer findings the checked-in history was
          // lost. The error below already says export needs `to`.
          const dest = to;
          if (dest == null || dest === '') {
            return errorResult(
              'export needs `to` (the path to write). Point it at a checked-in ' +
                'file and set MEMLAB_FINDINGS_INDEX to the same path so the next ' +
                'session inherits it.',
            );
          }
          const dir = path.dirname(dest);
          if (dir !== '' && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, {recursive: true});
          }
          const payload = {
            workstream: effectiveWorkstream ?? null,
            exported_at: new Date().toISOString(),
            findings: Object.values(idx.findings ?? {}),
            combos_driven: idx.combos_driven ?? {},
          };
          fs.writeFileSync(
            dest,
            JSON.stringify(payload, null, 2) + '\n',
            'utf8',
          );
          const n = payload.findings.length;
          // `n === 0` is unreachable in the common case — `loadIndex` seeds a
          // brand-new index with `builtinSeedFindings()`, so a host that never
          // recorded anything still exports a non-empty file. `hasAppHistory`
          // is the distinction that was actually wanted: generic artifact seeds
          // and no app history at all.
          return result(
            `Exported **${n}** finding(s)${
              workstream != null ? ` for workstream \`${workstream}\`` : ''
            } to \`${dest}\`.\n\n` +
              (!hasAppHistory(idx)
                ? '_This index holds only the built-in artifact seeds — no finding from ' +
                  'an actual round. Record or `import` some history first, or a `check` ' +
                  'against this file will answer NEW to everything real._'
                : '_Check this file in and point `MEMLAB_FINDINGS_INDEX` at it, so the ' +
                  'next host and the next operator inherit the history instead of ' +
                  'starting from zero._'),
          );
        }

        if (action === 'import') {
          const incoming: ImportedFinding[] = [...(findings ?? [])];
          const fileErrors: string[] = [];
          let combosImported = 0;
          if (from != null && from !== '') {
            if (!fs.existsSync(from)) {
              return errorResult(`import source not found: ${from}`);
            }
            const parsed: unknown = JSON.parse(fs.readFileSync(from, 'utf8'));
            // `export` takes care to write `combos_driven`, but import used to
            // read only `findings`, so the round trip dropped the driven-combo
            // coverage every time.
            const incomingCombos = Array.isArray(parsed)
              ? null
              : ((parsed as {combos_driven?: Record<string, unknown>})
                  ?.combos_driven ?? null);
            if (incomingCombos != null) {
              for (const [round, combos] of Object.entries(incomingCombos)) {
                if (!Array.isArray(combos)) continue;
                const existing = index.combos_driven[round] ?? [];
                const merged = [
                  ...new Set([
                    ...existing,
                    ...combos.filter((c): c is string => typeof c === 'string'),
                  ]),
                ];
                if (merged.length !== existing.length) combosImported++;
                // Skip empty merges so `import` never creates a bare, content-
                // free `combos_driven[round]`. Such an entry does not bump
                // `combosImported`, so with no findings the early-return below
                // would drop it before `saveIndex` ran — leaving the in-memory
                // index and the persisted file disagreeing over a key that
                // carries nothing anyway.
                if (merged.length > 0) index.combos_driven[round] = merged;
              }
            }
            const fromFile = Array.isArray(parsed)
              ? parsed
              : ((parsed as {findings?: unknown[]})?.findings ?? null);
            if (!Array.isArray(fromFile)) {
              return errorResult(
                `${from} must hold a JSON array of findings, or an object with a "findings" array.`,
              );
            }
            // Validate each row with the SAME schema the inline `findings`
            // argument gets. A bare `as ImportedFinding[]` here let a row whose
            // `growing_classes` is a string reach `fingerprintOf`, which sorts
            // and joins it — producing a fingerprint no real `check` can ever
            // match, and silently defeating the seeding this action exists for.
            // A malformed row is reported as skipped, never cast through.
            fromFile.forEach((row, i) => {
              const parsedRow = IMPORTED_FINDING_SCHEMA.safeParse(row);
              if (parsedRow.success) {
                incoming.push(parsedRow.data);
              } else {
                fileErrors.push(
                  `${from} entry ${i}: ${parsedRow.error.issues
                    .map(
                      issue =>
                        `${issue.path.join('.') || '(root)'} ${issue.message}`,
                    )
                    .join('; ')}`,
                );
              }
            });
          }
          const gaveSource =
            (findings != null && findings.length > 0) ||
            (from != null && from !== '');
          if (!gaveSource) {
            return errorResult(
              'action "import" needs `findings` (inline) or `from` (a JSON file path).',
            );
          }
          // A source that was read and held nothing NEW is a no-op, not a
          // missing argument. Reporting it as the latter sent the operator
          // looking for an argument they had in fact passed.
          if (incoming.length === 0 && combosImported === 0) {
            return result(
              `Nothing to import: ${
                from != null && from !== ''
                  ? `\`${from}\` was read but yielded no usable finding, and its driven-combo coverage was already recorded`
                  : 'the `findings` array was empty'
              }. The index still holds ${formatNumber(
                Object.keys(index.findings).length,
              )} finding(s).` +
                (fileErrors.length > 0
                  ? `\n\nSkipped ${fileErrors.length}:\n${fileErrors
                      .map(s => `- ${s}`)
                      .join('\n')}`
                  : ''),
            );
          }
          const {imported, updated, skipped} = importFindings(index, incoming);
          skipped.unshift(...fileErrors);
          saveIndex(indexPath, index);
          return result(
            [
              `Imported **${imported} new** and updated **${updated}** finding(s) into \`${indexPath}\`; ` +
                `the index now holds ${formatNumber(Object.keys(index.findings).length)}.` +
                (combosImported > 0
                  ? ` Also merged driven-combo coverage for ${combosImported} round(s).`
                  : ''),
              skipped.length > 0
                ? `\nSkipped ${skipped.length}:\n${skipped.map(s => `- ${s}`).join('\n')}`
                : '',
              '\n`check` verdicts of NEW are now meaningful for anything this history covers. ' +
                'Imported entries carry `seen_count: 1` — they are history, not sightings by this operator.',
            ]
              .filter(Boolean)
              .join('\n'),
          );
        }

        if (action === 'list') {
          const all = Object.values(index.findings);
          if (!hasAppHistory(index)) {
            return result(
              `The findings index at \`${indexPath}\` is **empty**, so every \`check\` in this ` +
                'session will answer NEW — including for findings that are already documented ' +
                'and already fixed. Seed it first with `action: "import"` from the workstream\'s ' +
                'history, then record findings as you confirm them (`action: "record"`).\n\n' +
                'The leak-hunt skill ships checked-in seeds, so this usually does not need ' +
                'writing by hand:\n\n' +
                '    memlab_finding_index({action: "import", workstream: "comet",\n' +
                '      from: "<plugin>/skills/leak-hunt/references/findings.comet.json"})\n\n' +
                'Point `MEMLAB_FINDINGS_INDEX` at a checked-in path afterwards so the next host ' +
                'and the next operator inherit the index instead of starting empty again.',
            );
          }
          // `fixed_behind` is free text and in practice holds a sentence or
          // three — which gate, which diffs, what else has to be on. Printed in
          // full it sets the column width for the whole table and pushes every
          // other column off the readable area; one observed index rendered a
          // 300-character status cell next to a 12-character fingerprint. The
          // detail is worth keeping, so it moves below the table rather than
          // being dropped.
          // A hard cap on the RENDERED cell, wrapper included. Budgeting only
          // the text inside `fixed (…)` left a ~70-character cell, which still
          // set the table width — the thing the cap exists to stop.
          const STATUS_CELL_MAX = 48;
          // Free text also means a `|` or a newline, either of which splits the
          // row and silently rewrites the table around it. Truncation bounds the
          // WIDTH; this bounds the cell to one table cell.
          const cellSafe = (text: string): string =>
            text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
          const SEE_BELOW = '… — see below';
          /**
           * The status cell for one finding, plus the detail line it displaced.
           *
           * Returns the detail rather than pushing it, so building the rows has
           * no side effect on an accumulator declared elsewhere — the row
           * pipeline can be reordered or filtered without silently changing
           * what appears under the table.
           */
          const statusCell = (
            f: Finding,
          ): {cell: string; detail: string | null} => {
            if (f.status !== 'fixed') return {cell: f.status, detail: null};
            const behind = cellSafe(f.fixed_behind ?? '?');
            const full = `fixed (${behind})`;
            if (full.length <= STATUS_CELL_MAX)
              return {cell: full, detail: null};
            const room = STATUS_CELL_MAX - 'fixed ()'.length - SEE_BELOW.length;
            return {
              cell: `fixed (${behind.slice(0, Math.max(room, 0))}${SEE_BELOW})`,
              detail: `- \`${f.fingerprint}\` fixed behind: ${behind}`,
            };
          };
          const listed = all
            .sort((a, b) => b.seen_count - a.seen_count)
            .slice(0, 40)
            .map(f => ({finding: f, status: statusCell(f)}));
          const fixedDetails = listed
            .map(r => r.status.detail)
            .filter((d): d is string => d != null);
          const rows = listed.map(({finding: f, status}) => [
            f.fingerprint,
            status.cell,
            f.growing_classes.slice(0, 3).join(', ') || '—',
            `${f.first_seen_round}${f.last_seen_round !== f.first_seen_round ? `→${f.last_seen_round}` : ''}`,
            String(f.seen_count),
            f.signature.length > 60
              ? f.signature.slice(0, 57) + '…'
              : f.signature,
          ]);
          // Sort by round id rather than trusting object insertion order: a
          // re-recorded round moves in the object and "the last 8" silently
          // stops meaning the most recent ones.
          const covered = Object.entries(index.combos_driven)
            .sort((a, b) =>
              a[0].localeCompare(b[0], undefined, {numeric: true}),
            )
            .slice(-8)
            .map(([r, c]) => `${r}: ${c.join(', ')}`);
          return result(
            [
              `## Findings index (${formatNumber(all.length)}) — \`${indexPath}\``,
              '',
              markdownTable(
                [
                  'Fingerprint',
                  'Status',
                  'Classes',
                  'Rounds',
                  'Seen',
                  'Signature',
                ],
                rows,
                new Set([4]),
              ),
              // Each block contributes its heading only when it has rows;
              // pushing an empty string unconditionally leaves a stray blank
              // line between the table and whatever follows.
              ...(fixedDetails.length > 0
                ? ['\n### Fix details (truncated above)\n', ...fixedDetails]
                : []),
              ...(covered.length > 0
                ? [
                    '\n### Combo coverage by round\n',
                    ...covered.map(c => `- ${c}`),
                  ]
                : []),
            ].join('\n'),
          );
        }

        if (action === 'cover') {
          if (!round) return errorResult('action "cover" requires a round.');
          index.combos_driven[round] = combos;
          saveIndex(indexPath, index);
          return result(
            `Recorded ${combos.length} combo(s) driven in ${round}: ${combos.join(', ') || '(none)'}.`,
          );
        }

        if (!retainer_path) {
          return errorResult(`action "${action}" requires a retainer_path.`);
        }
        const signature = normalizeRetainerPath(retainer_path);
        const fingerprint = fingerprintOf(signature, growing_classes);
        const existing = index.findings[fingerprint];

        if (action === 'check') {
          if (!existing) {
            // The single most damaging thing this tool can do is answer NEW from
            // an index that has never been seeded — the verdict looks identical
            // to a real one, and it has already sent a round off to re-derive a
            // documented, already-fixed finding. Say so at the point of use.
            const indexSize = Object.keys(index.findings).length;
            const siblings = !hasAppHistory(index)
              ? siblingWorkstreamIndexes(indexPath)
              : [];
            const unreliable = !hasAppHistory(index)
              ? [
                  '',
                  `> ⚠️ **The index at \`${indexPath}\` is EMPTY, so this verdict carries no information.** ` +
                    'Every candidate reads as NEW. Seed the workstream history with ' +
                    '`action: "import"` before treating a NEW here as evidence of anything.',
                  ...(siblings.length > 0
                    ? [
                        '>',
                        '> **But there is seeded history right next to it** — ' +
                          siblings
                            .map(
                              sib =>
                                `\`workstream: "${sib.workstream}"\` (${formatNumber(sib.count)} finding(s))`,
                            )
                            .join(', ') +
                          '. `import` writes a workstream-scoped file and `check` ' +
                          'defaults to the unscoped one, so this is very likely the ' +
                          'wrong index rather than an unseeded one. Re-run `check` with ' +
                          'that `workstream`.',
                      ]
                    : []),
                ]
              : [];
            const related = relatedByClass(index, growing_classes, fingerprint);
            const relatedLines =
              related.length === 0
                ? []
                : [
                    '',
                    `### ⚠️ ${related.length} known entr${related.length === 1 ? 'y shares' : 'ies share'} a growing class with this`,
                    '',
                    ...related.map(
                      f =>
                        `- **${f.signature}** (${f.first_seen_round}, ${f.status})` +
                        ` — shares \`${f.growing_classes.filter(c => growing_classes.includes(c)).join('`, `')}\`` +
                        (f.note ? `. ${f.note}` : ''),
                    ),
                    '',
                    'A shared class is a LEAD, not an identification — the fingerprint above really is new. ' +
                      'But if one of these is an artifact family, the population you are looking at is ' +
                      'probably not app memory, and that is worth settling before spending the round on it.',
                  ];
            return result(
              [
                `## NEW finding — fingerprint \`${fingerprint}\``,
                '',
                `Signature: \`${signature}\``,
                ...unreliable,
                '',
                `No previous round in this index (${formatNumber(indexSize)} finding(s)) recorded this ` +
                  'retainer path with this class set. Confirm it, then `action: "record"` so the next ' +
                  'round recognizes it.',
                '',
                indexPathLine,
                ...relatedLines,
              ].join('\n'),
            );
          }
          // Not gated on `status === 'fixed'`. A gate state recorded against
          // an `artifact` or `known` entry warned in the inline badge and read
          // as clean here — the same field saying two different things in the
          // same session.
          const gateWarning =
            existing.gate_state != null && existing.gate_state !== 'allocated'
              ? existing.gate_state === 'code_removed'
                ? `\n\n> ⚠️ **The code behind \`${existing.fixed_behind ?? 'that gate'}\` has been REMOVED from the tree**` +
                  `${existing.gate_checked_on != null ? ` (checked ${existing.gate_checked_on})` : ''}. ` +
                  'Re-enabling the gate does nothing. Do not plan an A/B against it.'
                : `\n\n> ⚠️ **That gate is recorded as ${existing.gate_state.toUpperCase()}**` +
                  `${existing.gate_checked_on != null ? ` (checked ${existing.gate_checked_on})` : ''}, ` +
                  'so the fix is NOT serving. "Fixed behind <gate>" is only true while the gate is ' +
                  'allocated AND its code still exists — verify both before treating this as fixed ' +
                  'or planning an A/B against it.'
              : '';
          const label =
            existing.status === 'artifact'
              ? `ARTIFACT — NOT PRODUCTION MEMORY (${existing.first_seen_round})`
              : existing.status === 'fixed'
                ? `KNOWN-AND-FIXED-BEHIND(${existing.fixed_behind ?? 'unknown gate'})`
                : existing.status === 'retracted'
                  ? `RETRACTED (${existing.first_seen_round})`
                  : `KNOWN (${existing.first_seen_round})`;
          return result(
            [
              `## ${label} — fingerprint \`${fingerprint}\``,
              '',
              `Signature: \`${signature}\``,
              `First seen: ${existing.first_seen_round}; last seen: ${existing.last_seen_round}; seen ${existing.seen_count}×.`,
              indexPathLine,
              existing.note ? `Note: ${existing.note}` : '',
              '',
              existing.fixed_by_diffs != null &&
              existing.fixed_by_diffs.length > 0
                ? `Fixed by: ${existing.fixed_by_diffs.join(', ')}${existing.verified_by_ab === true ? ' (A/B verified)' : ' (NOT A/B verified — the fix is a claim, not a measured result)'}`
                : '',
              existing.status === 'artifact'
                ? '**Stop here — this population is NOT production memory.** A previous round ' +
                  'identified it as a measurement artifact (an automation bridge, a DevTools ' +
                  'hook, a dev-only registry, CDP bookkeeping). It will be present and may well ' +
                  'grow, and neither fact makes it a finding. Exclude it from any total you quote.'
                : existing.status === 'fixed'
                  ? `**Stop here.** This leak is already fixed behind \`${existing.fixed_behind}\`. If it is still reproducing, the gate is probably not enabled in this run — verify the gating state before treating it as a finding.${gateWarning}`
                  : existing.status === 'retracted'
                    ? `**Stop here — this was investigated and WITHDRAWN.** ${existing.retraction_reason ?? 'No reason was recorded, which is itself worth fixing in the index.'} Re-deriving a retracted finding is the same wasted round as re-deriving a fixed one, and it is harder to notice because the population really is there. If you believe the retraction was wrong, say what new evidence changes it before reopening.`
                    : '**This is not a new finding.** Check whether the earlier round already root-caused it before spending the rest of this one on it.',
              // Appended outside the status branches so a gate state recorded
              // against a non-`fixed` entry is not silently dropped. The
              // `fixed` branch interpolates it inline, so it is skipped here
              // rather than printed twice.
              existing.status !== 'fixed' ? gateWarning : '',
            ]
              .filter(Boolean)
              .join('\n'),
          );
        }

        // record
        const roundId = round ?? 'unknown';
        index.findings[fingerprint] = {
          fingerprint,
          signature,
          growing_classes,
          first_seen_round: existing?.first_seen_round ?? roundId,
          last_seen_round: roundId,
          status: storableStatus(status),
          fixed_behind: fixed_behind ?? existing?.fixed_behind,
          gate_state: gate_state ?? existing?.gate_state,
          gate_checked_on: gate_checked_on ?? existing?.gate_checked_on,
          fixed_by_diffs: fixed_by_diffs ?? existing?.fixed_by_diffs,
          verified_by_ab: verified_by_ab ?? existing?.verified_by_ab,
          retraction_reason: retraction_reason ?? existing?.retraction_reason,
          note: note ?? existing?.note,
          seen_count: (existing?.seen_count ?? 0) + 1,
        };
        saveIndex(indexPath, index);
        const recorded = index.findings[fingerprint];
        const extras: string[] = [];
        if (
          recorded.fixed_by_diffs != null &&
          recorded.fixed_by_diffs.length > 0
        ) {
          extras.push(`fixed by ${recorded.fixed_by_diffs.join(', ')}`);
        }
        if (recorded.verified_by_ab === true) extras.push('A/B verified');
        if (recorded.retraction_reason != null) {
          extras.push(`retracted: ${recorded.retraction_reason}`);
        }
        // A fix recorded with no gate, no diffs and no A/B is a claim with
        // nothing behind it, and the next round has no way to tell that from a
        // verified one. Say so at the moment of recording, where it is cheap to
        // fix, rather than leaving it to be discovered when the leak reappears.
        // Against the MERGED record, not the raw args: the record inherits a
        // gate or a diff list from the previous recording, so a re-record that
        // only updates the round would otherwise be told it has neither.
        const thinFix =
          status === 'fixed' &&
          recorded.fixed_behind == null &&
          (recorded.fixed_by_diffs == null ||
            recorded.fixed_by_diffs.length === 0);
        const missingReason =
          status === 'retracted' && recorded.retraction_reason == null;
        return result(
          `Recorded \`${fingerprint}\` as **${recorded.status}**${recorded.fixed_behind ? ` (behind \`${recorded.fixed_behind}\`)` : ''}` +
            `${extras.length > 0 ? ` — ${extras.join('; ')}` : ''} for round ${roundId}. ` +
            `Signature: \`${signature}\`. The index now holds ${formatNumber(Object.keys(index.findings).length)} finding(s).` +
            (thinFix
              ? '\n\n⚠️ Recorded as fixed with neither a gate nor a diff. A later `check` will say ' +
                'KNOWN-AND-FIXED and stop a hunt, with no way to confirm the fix is actually live — ' +
                'add `fixed_behind` and/or `fixed_by_diffs`.'
              : '') +
            (missingReason
              ? '\n\n⚠️ Retracted with no `retraction_reason`. The point of the retracted state is to stop ' +
                'the next round re-deriving the finding; without the reason it cannot.'
              : ''),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

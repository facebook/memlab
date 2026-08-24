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
export function resolveIndexPath(workstream?: string): string {
  const override = process.env.MEMLAB_FINDINGS_INDEX;
  if (override != null && override !== '') {
    if (workstream == null || workstream === '') return override;
    // Treat the override as a directory when a workstream is named, so one
    // shared location can hold several workstreams without collision.
    return override.endsWith('.json')
      ? override.replace(/\.json$/, `.${workstream}.json`)
      : path.join(override, `findings.${workstream}.json`);
  }
  const base = path.join(process.env.HOME ?? '/tmp', '.memlab-mcp');
  return path.join(
    base,
    workstream != null && workstream !== ''
      ? `findings.${workstream}.json`
      : 'findings.json',
  );
}

interface Finding {
  fingerprint: string;
  signature: string;
  growing_classes: string[];
  first_seen_round: string;
  last_seen_round: string;
  status: 'new' | 'known' | 'fixed';
  fixed_behind?: string;
  note?: string;
  seen_count: number;
}

interface FindingIndex {
  version: number;
  findings: Record<string, Finding>;
  combos_driven: Record<string, string[]>;
}

function loadIndex(indexPath: string): FindingIndex {
  try {
    if (fs.existsSync(indexPath)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (parsed != null && typeof parsed === 'object') {
        const idx = parsed as Partial<FindingIndex>;
        return {
          version: idx.version ?? 1,
          findings: idx.findings ?? {},
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
  status: z.enum(['new', 'known', 'fixed']).optional(),
  fixed_behind: z.string().optional(),
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
      status: raw.status ?? existing?.status ?? 'known',
      fixed_behind: raw.fixed_behind ?? existing?.fixed_behind,
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
export function builtinSeedFindings(): ImportedFinding[] {
  const seed = (
    signature: string,
    growing_classes: string[],
    note: string,
  ): ImportedFinding => ({
    signature,
    growing_classes,
    round: 'builtin',
    status: 'known',
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

export function registerFindingIndex(server: McpServer): void {
  server.tool(
    'memlab_finding_index',
    'Fingerprint a leak finding by its retainer path and check it against findings from previous rounds, so a hunt does not spend itself re-discovering a known or already-fixed leak. ' +
      'This is the highest-cost failure a leak hunt has: a measured round produced three findings that were all already known — two already fixed behind gates — which is an entire round spent re-deriving history. Class names cannot detect that (`Object` and `Array` top every heap); the retainer PATH can, so the fingerprint is a normalized path signature with node ids, array indices and per-capture scope ids stripped. ' +
      'Actions: "check" fingerprints a candidate and reports NEW / KNOWN / KNOWN-AND-FIXED; "record" adds it; "import" bootstraps history in bulk from a team doc or a JSON file; "list" prints the index; "cover" records which combos a round drove, so the "do not repeat covered combos" rule stops depending on someone remembering.\n\n' +
      'IMPORTANT: a verdict of NEW is only as good as the index behind it. A newly-created index is pre-seeded with the generic ARTIFACT families (JIT warmup, CDP network/perf/console retention, a11y caches, React Fast Refresh registries, captured Error stacks, the automation bridge bundle), so the first `check` can already answer KNOWN for a population that is documented and is not app memory — but it knows nothing about YOUR app. Seed that with `action: "import"` before trusting the first `check` of a workstream. Set `MEMLAB_FINDINGS_INDEX` to a checked-in path to share the index across hosts and operators instead of keeping it in a per-machine home directory.',
    {
      action: z
        .enum(['check', 'record', 'list', 'cover', 'import'])
        .describe(
          '"check" (fingerprint + look up, no write), "record" (add/update), "import" (bulk-seed history), "list", "cover" (log combos driven in a round).',
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
        .enum(['new', 'known', 'fixed'])
        .optional()
        .default('known')
        .describe('Status to record. Use "fixed" together with fixed_behind.'),
      fixed_behind: z
        .string()
        .optional()
        .describe('Gate/ABProp the fix sits behind, if it is fixed.'),
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
      note,
      combos,
      workstream,
      from,
      findings,
    }) => {
      try {
        const indexPath = resolveIndexPath(workstream);
        const index = loadIndex(indexPath);

        if (action === 'import') {
          const incoming: ImportedFinding[] = [...(findings ?? [])];
          const fileErrors: string[] = [];
          if (from != null && from !== '') {
            if (!fs.existsSync(from)) {
              return errorResult(`import source not found: ${from}`);
            }
            const parsed: unknown = JSON.parse(fs.readFileSync(from, 'utf8'));
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
          if (incoming.length === 0) {
            return errorResult(
              'action "import" needs `findings` (inline) or `from` (a JSON file path).',
            );
          }
          const {imported, updated, skipped} = importFindings(index, incoming);
          skipped.unshift(...fileErrors);
          saveIndex(indexPath, index);
          return toolResult(
            [
              `Imported **${imported} new** and updated **${updated}** finding(s) into \`${indexPath}\`; ` +
                `the index now holds ${formatNumber(Object.keys(index.findings).length)}.`,
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
          if (all.length === 0) {
            return toolResult(
              `The findings index at \`${indexPath}\` is **empty**, so every \`check\` in this ` +
                'session will answer NEW — including for findings that are already documented ' +
                'and already fixed. Seed it first with `action: "import"` from the workstream\'s ' +
                'history, then record findings as you confirm them (`action: "record"`).',
            );
          }
          const rows = all
            .sort((a, b) => b.seen_count - a.seen_count)
            .slice(0, 40)
            .map(f => [
              f.fingerprint,
              f.status === 'fixed'
                ? `fixed (${f.fixed_behind ?? '?'})`
                : f.status,
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
          return toolResult(
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
              covered.length > 0 ? '\n### Combo coverage by round\n' : '',
              ...covered.map(c => `- ${c}`),
            ].join('\n'),
          );
        }

        if (action === 'cover') {
          if (!round) return errorResult('action "cover" requires a round.');
          index.combos_driven[round] = combos;
          saveIndex(indexPath, index);
          return toolResult(
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
            const unreliable =
              indexSize === 0
                ? [
                    '',
                    `> ⚠️ **The index at \`${indexPath}\` is EMPTY, so this verdict carries no information.** ` +
                      'Every candidate reads as NEW. Seed the workstream history with ' +
                      '`action: "import"` before treating a NEW here as evidence of anything.',
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
            return toolResult(
              [
                `## NEW finding — fingerprint \`${fingerprint}\``,
                '',
                `Signature: \`${signature}\``,
                ...unreliable,
                '',
                `No previous round in this index (${formatNumber(indexSize)} finding(s)) recorded this ` +
                  'retainer path with this class set. Confirm it, then `action: "record"` so the next ' +
                  'round recognizes it.',
                ...relatedLines,
              ].join('\n'),
            );
          }
          const label =
            existing.status === 'fixed'
              ? `KNOWN-AND-FIXED-BEHIND(${existing.fixed_behind ?? 'unknown gate'})`
              : `KNOWN (${existing.first_seen_round})`;
          return toolResult(
            [
              `## ${label} — fingerprint \`${fingerprint}\``,
              '',
              `Signature: \`${signature}\``,
              `First seen: ${existing.first_seen_round}; last seen: ${existing.last_seen_round}; seen ${existing.seen_count}×.`,
              existing.note ? `Note: ${existing.note}` : '',
              '',
              existing.status === 'fixed'
                ? `**Stop here.** This leak is already fixed behind \`${existing.fixed_behind}\`. If it is still reproducing, the gate is probably not enabled in this run — verify the gating state before treating it as a finding.`
                : '**This is not a new finding.** Check whether the earlier round already root-caused it before spending the rest of this one on it.',
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
          status,
          fixed_behind: fixed_behind ?? existing?.fixed_behind,
          note: note ?? existing?.note,
          seen_count: (existing?.seen_count ?? 0) + 1,
        };
        saveIndex(indexPath, index);
        return toolResult(
          `Recorded \`${fingerprint}\` as **${status}**${fixed_behind ? ` (behind \`${fixed_behind}\`)` : ''} for round ${roundId}. ` +
            `Signature: \`${signature}\`. The index now holds ${formatNumber(Object.keys(index.findings).length)} finding(s).`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

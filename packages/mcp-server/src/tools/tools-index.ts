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
import {listToolNames} from '../tool-registry.js';
import {errorResult, makeNamePatternTest, textResult} from '../utils.js';

/**
 * The tool list, grouped by the QUESTION each tool answers.
 *
 * Why a hand-written index rather than a generated list of names and
 * descriptions: an agent picks a tool by matching its goal to a question, not by
 * reading 69 descriptions. Measured on one long investigation, 28 of the shipped
 * tools were used and 41 never were — including several that would have answered
 * the question at hand in one call (`app_heap` reframed the entire heap on the
 * last day of a week-long hunt; `hypothesis` and `dominator_chain` were never
 * reached at all). Under deferred tool loading the problem is structural: a
 * client sees only the names whose schemas it has already fetched, so it cannot
 * browse what it does not know to ask for.
 *
 * Entries are (tool, one-line "use it when"). The ORDER inside a group is the
 * order to try them in.
 */
interface Group {
  question: string;
  tools: Array<[name: string, when: string]>;
}

const GROUPS: Group[] = [
  {
    question: 'What is this heap actually made of?',
    tools: [
      [
        'memlab_app_heap',
        'START HERE on an unfamiliar app: splits the heap into application data vs bundle source vs V8 machinery. On one app this showed ~55% of the heap was JS bundle source, which reframed every number that followed.',
      ],
      [
        'memlab_quick_diagnosis',
        'One call for summary + biggest objects + class histogram + duplicated strings.',
      ],
      [
        'memlab_snapshot_summary',
        'Node/edge counts and totals, when you only need the shape of the capture.',
      ],
      [
        'memlab_class_histogram',
        'Counts and sizes per class; `name_pattern` answers "is class X present?" in one row.',
      ],
      ['memlab_largest_objects', 'The single biggest retainers, ranked.'],
      [
        'memlab_shape_histogram',
        'Groups plain objects by their property set — finds record types the class name hides behind `Object`.',
      ],
      [
        'memlab_object_cost_breakdown',
        'Where one class’s bytes actually go (self vs properties vs elements).',
      ],
      [
        'memlab_unit_cost',
        'Retained bytes per instance, AVERAGE and MARGINAL — the number a cap, an LRU size or an eviction policy is sized against.',
      ],
    ],
  },
  {
    question: 'Is anything growing — and is it a leak?',
    tools: [
      [
        'memlab_leak_report',
        'The ladder verdict: per-class growth across an ordered set of snapshots.',
      ],
      [
        'memlab_sequence_analysis',
        'Per-class trend across a ladder, with artifact families flagged.',
      ],
      [
        'memlab_collection_trend',
        'Entry counts of NAMED collections across a ladder, with growth per interaction cycle.',
      ],
      [
        'memlab_population_diff',
        'Whether two snapshots hold the same POPULATION or just the same count — equal totals are not identity.',
      ],
      [
        'memlab_settle_check',
        'Backlog or leak? Compares a busy rung against one captured after idle + GC — growth that comes back was work in flight.',
      ],
      [
        'memlab_growth_signals',
        'Single-snapshot signals that something is accumulating.',
      ],
      [
        'memlab_diff_snapshots',
        'Raw per-class deltas between two resident snapshots.',
      ],
      [
        'memlab_hypothesis',
        'State a leak hypothesis and have it checked against the ladder instead of arguing it.',
      ],
      [
        'memlab_verify_fix',
        'Did the fix work? Compares per-cycle growth RATES between a before ladder and an after ladder.',
      ],
      [
        'memlab_ladder',
        'Name a ladder once and reference it as `ladder:<name>` from every trend tool.',
      ],
    ],
  },
  {
    question: 'Who owns the growth / why is X retained?',
    tools: [
      [
        'memlab_explain_delta',
        'WHERE a heap grew, attributed to the object that owns the new bytes rather than to what they are.',
      ],
      [
        'memlab_dominator_chain',
        'From one node up to the accountable application object.',
      ],
      [
        'memlab_dominator_attribution',
        'Given several candidate retainers, how much each one actually dominates — a zero refutes a hypothesis.',
      ],
      ['memlab_retainer_trace', 'The shortest retainer path for one node.'],
      [
        'memlab_retainer_summary',
        'Retainer paths across many instances, clustered by shape.',
      ],
      ['memlab_referrer_summary', 'Who points at this, grouped by edge.'],
      [
        'memlab_pinch_points',
        'Single objects whose release would free the most.',
      ],
      ['memlab_dominator_subtree', 'What one object holds, expanded downward.'],
      [
        'memlab_retainer_layers',
        'The retention structure around a node, layer by layer.',
      ],
      ['memlab_trace_dominators', 'Dominator path for a set of nodes at once.'],
    ],
  },
  {
    question: 'Is it real, or a measurement artifact?',
    tools: [
      [
        'memlab_dev_artifacts',
        'Memory retained ONLY by dev/automation roots — DevTools, extensions, React Fast Refresh, the a11y cache. Run before calling anything a production leak.',
      ],
      [
        'memlab_explain_delta',
        'Counts the OTHER artifact family — V8 JIT warmup — which dev_artifacts does not. Read both.',
      ],
      [
        'memlab_check_health',
        'Prioritized triage that separates likely-real from likely-noise.',
      ],
    ],
  },
  {
    question: 'Detached DOM and event listeners',
    tools: [
      [
        'memlab_detached_dom',
        'Detached nodes, with a pinned-vs-GC-eligible split; `group_by:"dominator"` groups by what a fix would actually free.',
      ],
      ['memlab_event_listener_leaks', 'Listeners that outlived their target.'],
      ['memlab_event_registry', 'What is registered on what.'],
    ],
  },
  {
    question: 'Collections and caches',
    tools: [
      [
        'memlab_cache_analysis',
        'Unbounded or oversized caches in one snapshot.',
      ],
      [
        'memlab_stale_collections',
        'Collections holding entries nothing else references.',
      ],
      [
        'memlab_collection_trend',
        'The same collections tracked ACROSS a ladder.',
      ],
      [
        'memlab_map_entries',
        'Enumerate a Map/Set correctly (SMI gaps and browser slot typing handled).',
      ],
      ['memlab_weakmap_entries', 'Enumerate a WeakMap.'],
      [
        'memlab_array_group_by',
        'Group an array’s elements by a property to see what is piling up.',
      ],
      [
        'memlab_property_distribution',
        'Cardinality and top values of one property across instances.',
      ],
    ],
  },
  {
    question: 'Strings and duplication',
    tools: [
      [
        'memlab_intern_opportunities',
        'What an intern pool would actually reclaim, grouped by property x parent shape. Start here for an interning decision.',
      ],
      ['memlab_duplicated_strings', 'The raw per-value duplication table.'],
      [
        'memlab_string_patterns',
        'Group strings by prefix to find families (URLs, ids, payloads).',
      ],
      ['memlab_sliced_strings', 'Substrings pinning huge parents.'],
      [
        'memlab_duplicate_objects',
        'The same question for objects rather than strings.',
      ],
      ['memlab_search_strings', 'Find a string value in the heap.'],
      ['memlab_get_string', 'Read one string node’s value.'],
    ],
  },
  {
    question: 'Inspect or find specific objects',
    tools: [
      [
        'memlab_find_nodes_by_class',
        'By exact class name, or by `name_pattern` regex/substring.',
      ],
      ['memlab_search_nodes', 'By name/type/size predicates.'],
      ['memlab_find_by_property', 'By a property name/value.'],
      ['memlab_find_by_shape', 'By property set.'],
      ['memlab_match_object', 'By a structural pattern.'],
      ['memlab_get_node', 'One node’s details.'],
      ['memlab_object_shape', 'One object’s properties and their sizes.'],
      ['memlab_get_references', 'Outgoing edges.'],
      ['memlab_get_referrers', 'Incoming edges.'],
      ['memlab_get_property', 'One property of one object.'],
      ['memlab_get_value', 'A scalar value, where the format allows it.'],
      [
        'memlab_closure_inspection',
        'What a closure captured, and what that costs.',
      ],
      ['memlab_global_variables', 'What is hanging off the global object.'],
      ['memlab_aggregate', 'Sum/count over a node set.'],
      ['memlab_for_each', 'Run one tool over many nodes.'],
    ],
  },
  {
    question: 'None of the above — ask the heap directly',
    tools: [
      [
        'memlab_eval',
        'Arbitrary JS over the snapshot, with indexed helpers (`byClass`, `iterByType`, `classCounts`, `entries`, `dominates`, `pathBetween`). Use `mode:"describe_env"` for the calling convention. This is the escape hatch when no fixed-shape tool matches the question.',
      ],
      [
        'memlab_eval_across',
        'The same eval program run against several snapshots at once — comparative questions without the switch-and-diff.',
      ],
      [
        'memlab_auto_investigate',
        'When you do not yet have a question: runs the standard deep-dive and reports what it found.',
      ],
      [
        'memlab_tools',
        'This index. Filter it with `question` or look a tool up with `tool`.',
      ],
    ],
  },
  {
    question: 'Session, batching and write-ups',
    tools: [
      [
        'memlab_load_snapshot',
        'Load a local path, a manifold:// URL, or a bare Nest filename.',
      ],
      [
        'memlab_snapshots',
        'List / switch / unload resident snapshots; set session output controls.',
      ],
      [
        'memlab_batch',
        'Several tools against ONE load — the load is the expensive part.',
      ],
      [
        'memlab_snapshot_header',
        'Node/edge counts WITHOUT loading the snapshot.',
      ],
      [
        'memlab_server_status',
        'Confirm the server is alive; returns instantly.',
      ],
      [
        'memlab_finding_index',
        'Record findings as you go so the write-up is not reconstructed from memory.',
      ],
      ['memlab_reports', 'Render the findings.'],
      ['memlab_hunt_report', 'Render a leak-hunt run.'],
      [
        'memlab_analyze_run',
        'Point at a run.json and get the WHOLE analysis protocol — trend, owner attribution, population diff, artifact classification, caveats — in one call.',
      ],
    ],
  },
];

export function registerToolsIndex(server: McpServer): void {
  server.tool(
    'memlab_tools',
    'Index of every memlab tool, grouped by the QUESTION it answers ("what is this heap made of", "is anything growing", "why is X retained", "is it real or an artifact", …). Call this first when you are not sure which tool fits, or when you suspect the server has something better than the one you were about to use — it costs one call and lists tools whose schemas have not been fetched yet, which is otherwise impossible to discover under deferred tool loading. Pass `question` to filter to matching groups, or `tool` to find which group a tool belongs to.',
    {
      question: z
        .string()
        .optional()
        .describe(
          'Filter to groups matching this text (case-insensitive regex, substring fallback) — e.g. "growing", "retained", "artifact", "string".',
        ),
      tool: z
        .string()
        .optional()
        .describe(
          'Show the group(s) containing this tool name (with or without the memlab_ prefix).',
        ),
    },
    async ({question, tool}) => {
      try {
        const registered = new Set(listToolNames());
        const wanted = tool
          ? tool.startsWith('memlab_')
            ? tool
            : `memlab_${tool}`
          : null;
        const matchesQuestion = makeNamePatternTest(question);
        const indexed = new Set(GROUPS.flatMap(g => g.tools.map(([n]) => n)));
        const uncategorized = [...registered].filter(n => !indexed.has(n));

        let groups = GROUPS;
        if (wanted != null) {
          groups = groups.filter(g => g.tools.some(([n]) => n === wanted));
          if (groups.length === 0) {
            // This branch returns immediately, so the uncategorized list has to
            // be rendered HERE. Pointing at the drift-guard section further
            // down sent the reader to output this call never produces.
            const parts = [
              `\`${wanted}\` is not in the index${registered.has(wanted) ? ' (but it IS registered — the index is missing an entry)' : ' and is not a registered tool'}.`,
            ];
            if (uncategorized.length > 0) {
              parts.push(
                `Registered but not categorized: ${uncategorized.map(n => `\`${n}\``).join(', ')}.`,
              );
            }
            parts.push(`Registered tools: ${[...registered].join(', ')}`);
            return textResult(parts.join('\n\n'));
          }
        }
        if (question != null) {
          groups = groups.filter(
            g =>
              matchesQuestion(g.question) ||
              g.tools.some(
                ([n, w]) => matchesQuestion(n) || matchesQuestion(w),
              ),
          );
        }

        const lines: string[] = [
          `# memlab tools by question (${registered.size} registered)`,
          '',
        ];
        if (groups.length === 0) {
          // Name BOTH filters when both were passed: `tool` narrows first, so
          // "no group matches <question>" alone describes the wrong search and
          // suggests re-running with no arguments when dropping one would do.
          const filterDesc =
            wanted != null && question != null
              ? `\`${wanted}\` and "${question}" together`
              : question != null
                ? `"${question}"`
                : 'that filter';
          lines.push(
            `No group matches ${filterDesc}. ` +
              (wanted != null && question != null
                ? `\`${wanted}\` is in the index, but not in a group matching "${question}" — drop one of the two, or call \`memlab_tools\` with no arguments for the full index.`
                : 'Call `memlab_tools` with no arguments for the full index.'),
          );
          return textResult(lines.join('\n'));
        }
        for (const g of groups) {
          lines.push(`## ${g.question}`, '');
          for (const [name, when] of g.tools) {
            // A name in the index that is no longer registered is worse than a
            // missing one: it sends the caller after a tool that will fail.
            const missing = registered.has(name) ? '' : ' _(not registered)_';
            lines.push(`- \`${name}\`${missing} — ${when}`);
          }
          lines.push('');
        }

        // Drift guard. The index is hand-written for usefulness, so a newly
        // added tool would otherwise be invisible here — which is the exact
        // failure this tool exists to fix, reproduced one level up.
        if (question == null && wanted == null) {
          if (uncategorized.length > 0) {
            lines.push(
              '## Not yet categorized',
              '',
              `These are registered but missing from the index above: ${uncategorized.map(n => `\`${n}\``).join(', ')}. Their own descriptions are the only documentation.`,
              '',
            );
          }
        }
        lines.push(
          '_A tool listed under several questions is genuinely useful for each. Where a group is ordered, the first entry is the one to try first._',
        );
        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

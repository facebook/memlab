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
import {getSnapshot} from '../heap-state.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/** How many near-miss suggestions to offer for an absent name. */
const MAX_SUGGESTIONS = 5;

/** Ignore candidates this short — minified heaps are full of `l`, `i`, `n`. */
const MIN_SUGGESTION_LENGTH = 3;

/**
 * Minimum length ratio (shorter/longer) for two names to count as similar.
 * A bare substring test is worthless on a minified heap: measured on an
 * 892k-node capture, `NetworkRequestPipelineStats` came back "similar to:
 * l, i, n" because every one-letter class name is a substring of it.
 */
const MIN_SUGGESTION_OVERLAP = 0.4;

export function registerModulePresent(server: McpServer): void {
  server.tool(
    'memlab_module_present',
    'Pre-flight: does a class/constructor appear in this heap AT ALL? Answers "is the code I am about to instrument actually running on this surface", which is a different question from "is it leaking" and much cheaper to ask. ' +
      'Ask it BEFORE building a round on a module. A whole leak-hunt — instrumented debug diff, gated fix, module-level A/B — was once built around a class the app under test never constructs (it belonged to a legacy player the surface had replaced), and nothing in the workflow prompted the one query that would have shown zero instances. ' +
      'Absent is reported as ABSENT rather than as a count of 0, with near-miss names when something similar exists, because "0 instances" and "you spelled it differently" need different next steps. ' +
      'Light-snapshot safe: reads names and self sizes only, no dominator pass.',
    {
      names: z
        .array(z.string())
        .min(1)
        .describe(
          'Class / constructor names to look for, e.g. ["NetworkRequestPipelineStats", "VideoPlayerNextgendashEngine"]. Exact match, case-sensitive.',
        ),
      suggest: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'For an absent name, offer near-miss class names present in the heap (default true). Set false to skip the extra scan on very large heaps.',
        ),
    },
    async ({names, suggest}) => {
      try {
        const snapshot = getSnapshot();
        const want = new Set(names);
        const counts = new Map<string, number>();
        const selfBytes = new Map<string, number>();
        for (const n of names) {
          counts.set(n, 0);
          selfBytes.set(n, 0);
        }

        // Lower-cased index of every class name, built only when something is
        // absent and suggestions were asked for — the common case is "present",
        // and that needs one pass with no extra allocation.
        const allNames = suggest ? new Set<string>() : null;

        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          const name = node.name;
          if (allNames != null && node.type === 'object') {
            allNames.add(name);
          }
          if (!want.has(name)) return;
          counts.set(name, (counts.get(name) ?? 0) + 1);
          selfBytes.set(name, (selfBytes.get(name) ?? 0) + node.self_size);
        });

        const rows: string[][] = [];
        const absent: string[] = [];
        for (const n of names) {
          const c = counts.get(n) ?? 0;
          if (c === 0) absent.push(n);
          rows.push([
            `\`${n}\``,
            c === 0 ? '**ABSENT**' : 'present',
            c === 0 ? '—' : formatNumber(c),
            c === 0 ? '—' : formatBytes(selfBytes.get(n) ?? 0),
          ]);
        }

        const lines: string[] = [
          '## Module presence',
          '',
          markdownTable(
            ['Name', 'Status', 'Instances', 'Self size'],
            rows,
            new Set([2, 3]),
          ),
        ];

        if (absent.length > 0) {
          lines.push('');
          lines.push(
            `**${absent.length} of ${names.length} name(s) do not appear in this heap.** ` +
              'That is consistent with the code not running on this surface at all — a ' +
              'different implementation being selected by a gate or router, a module that ' +
              'is lazily loaded and was never reached, or simply a different name. It is ' +
              'NOT evidence about leaking; a class that is never constructed cannot leak, ' +
              'and instrumenting it will produce silence that looks like a clean result.',
          );
          if (allNames != null) {
            for (const missing of absent) {
              const needle = missing.toLowerCase();
              const near = [...allNames]
                .filter(n => {
                  if (n === missing || n.length < MIN_SUGGESTION_LENGTH) {
                    return false;
                  }
                  const other = n.toLowerCase();
                  if (!other.includes(needle) && !needle.includes(other)) {
                    return false;
                  }
                  // Substring alone is useless on a minified heap: class names
                  // like `l` or `in` are a substring of nearly every symbol, so
                  // an absent name came back "similar to: l, i, n". Require the
                  // shorter of the two to be a real fraction of the longer.
                  const shorter = Math.min(other.length, needle.length);
                  const longer = Math.max(other.length, needle.length);
                  return shorter / longer >= MIN_SUGGESTION_OVERLAP;
                })
                .slice(0, MAX_SUGGESTIONS);
              if (near.length > 0) {
                lines.push(
                  `- \`${missing}\` — similar names present: ${near
                    .map(n => `\`${n}\``)
                    .join(', ')}`,
                );
              }
            }
          }
        }

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

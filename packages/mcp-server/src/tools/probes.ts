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
import {probeStorePath, readProbeSets, writeProbeSets} from '../probe-sets.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

export function registerProbes(server: McpServer): void {
  server.tool(
    'memlab_probes',
    "Save named probes for an app once, and have the ladder tools run them by themselves. A probe is `memlab_eval` code assigning a number to `result`, with an optional `cap` and `expect` (`flat` / `bounded`). Probes live in named sets on disk (`~/.memlab/probes.json`, or `MEMLAB_STATE_DIR`). A set with `match` is picked up automatically by `memlab_ladder_probe`, `memlab_ab_compare` and `memlab_analysis_battery` when the round's URL filter contains it; any of them also takes `probes: <set>`. Modes: `save` (one probe, or the set's `match` / `prelude`), `list`, `show` (a set's code), `forget` (a probe, or a whole set).",
    {
      mode: z
        .enum(['save', 'list', 'show', 'forget'])
        .optional()
        .default('list')
        .describe('What to do (default "list").'),
      set: z
        .string()
        .optional()
        .describe('Probe set name, e.g. the app ("wa_web").'),
      name: z.string().optional().describe('Probe name within the set.'),
      code: z
        .string()
        .optional()
        .describe(
          'With `save` and `name`: the probe, assigning a number to `result`.',
        ),
      cap: z
        .number()
        .optional()
        .describe(
          'With `save`: the size a fix bounds this population at; `ab_compare` reports CANNOT JUDGE when the OFF arm never reached it.',
        ),
      expect: z
        .enum(['flat', 'bounded', 'any'])
        .optional()
        .describe(
          'With `save`: what a healthy round shows. The ladder tools then print OK or VIOLATED per probe.',
        ),
      note: z.string().optional().describe('With `save`: free text.'),
      match: z
        .string()
        .optional()
        .describe(
          "With `save`: substring of a round's URL filter (run.json `config.url_filter`) that selects this set automatically.",
        ),
      prelude: z
        .string()
        .optional()
        .describe('With `save`: source run before every probe of the set.'),
    },
    async ({mode, set, name, code, cap, expect, note, match, prelude}) => {
      try {
        const sets = readProbeSets();
        if (mode === 'list') {
          const names = Object.keys(sets).sort();
          if (names.length === 0) {
            return toolResult(
              `No probe sets saved (\`${probeStorePath()}\`). Save one with \`memlab_probes({mode: "save", set, name, code, expect?})\`.`,
            );
          }
          return toolResult(
            [
              `## Probe sets — \`${probeStorePath()}\``,
              '',
              markdownTable(
                ['Set', 'Match', 'Probes'],
                names.map(n => [
                  n,
                  sets[n].match != null ? `\`${sets[n].match}\`` : '—',
                  Object.entries(sets[n].probes)
                    .map(([p, s]) =>
                      s.expect != null ? `${p} (${s.expect})` : p,
                    )
                    .join(', '),
                ]),
              ),
            ].join('\n'),
          );
        }
        if (set == null || set === '') {
          return errorResult(new Error(`\`${mode}\` needs \`set\`.`));
        }
        if (mode === 'show') {
          const s = sets[set];
          if (s == null)
            return errorResult(new Error(`No probe set "${set}".`));
          return toolResult(
            [
              `## Probe set \`${set}\``,
              '',
              s.match != null
                ? `Match: \`${s.match}\``
                : 'No `match`: pass `probes: "' + set + '"` to use it.',
              ...(s.prelude != null
                ? ['', 'Prelude:', '```js', s.prelude, '```']
                : []),
              ...Object.entries(s.probes).flatMap(([p, spec]) => [
                '',
                `**${p}**${spec.expect != null ? ` — expect ${spec.expect}` : ''}${spec.cap != null ? `, cap ${formatNumber(spec.cap)}` : ''}${spec.note != null ? ` — ${spec.note}` : ''}`,
                '```js',
                spec.code,
                '```',
              ]),
            ].join('\n'),
          );
        }
        if (mode === 'forget') {
          if (sets[set] == null) {
            return errorResult(new Error(`No probe set "${set}".`));
          }
          if (name != null && name !== '') {
            if (sets[set].probes[name] == null) {
              return errorResult(new Error(`No probe "${name}" in "${set}".`));
            }
            delete sets[set].probes[name];
          } else {
            delete sets[set];
          }
          writeProbeSets(sets);
          return toolResult(
            name != null && name !== ''
              ? `Forgot probe \`${name}\` from \`${set}\`.`
              : `Forgot probe set \`${set}\`.`,
          );
        }
        // save
        const s = sets[set] ?? {probes: {}};
        if (match != null) s.match = match;
        if (prelude != null) s.prelude = prelude;
        if (name != null && name !== '') {
          if (code == null || code.trim() === '') {
            return errorResult(
              new Error(
                'Saving a probe needs `code` that assigns a number to `result`.',
              ),
            );
          }
          s.probes[name] = {
            code,
            ...(cap != null ? {cap} : {}),
            ...(expect != null ? {expect} : {}),
            ...(note != null ? {note} : {}),
          };
        } else if (match == null && prelude == null) {
          return errorResult(
            new Error(
              '`save` needs `name` + `code`, or a set-level `match` / `prelude`.',
            ),
          );
        }
        sets[set] = s;
        writeProbeSets(sets);
        return toolResult(
          `Saved ${name != null && name !== '' ? `probe \`${name}\` in ` : ''}set \`${set}\` (${formatNumber(Object.keys(s.probes).length)} probe(s)${s.match != null ? `, match \`${s.match}\`` : ''}).`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

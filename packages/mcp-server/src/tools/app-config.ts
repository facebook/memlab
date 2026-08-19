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
import type {IHeapNode} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {calibrateSmiDecode, decodeSmi} from './get-value.js';
import {
  errorResult,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * Reading a feature flag out of a heap snapshot.
 *
 * Half of "is this leak still there?" is "was the fix even ON in this capture?",
 * and that question was being answered by inference: the code says the cleanup
 * is gated, the capture looks like the cleanup did not run, therefore the gate
 * was off. That reasoning is circular — the same evidence is what the gate is
 * being invoked to explain. The snapshot contains the answer, because the
 * config the app read is still resident in it.
 *
 * A flag registry is recognised by shape rather than by name: many entries,
 * keys shaped like config identifiers, values that are booleans or small
 * numbers. That is deliberately generic — the tool should not need to know
 * about any one company's flag system to read one.
 */
const CONFIG_KEY_RE = /^[a-z][a-z0-9]*(?:[_.][a-z0-9]+){1,}$/;

type FlagValue = boolean | number | string | null;

const MAX_ARRAY_ELEMENTS = 6;

function readValue(
  node: IHeapNode,
  smiTrusted: boolean,
  depth = 0,
): {value: FlagValue; note?: string} {
  // A config entry is very often an array rather than a scalar: a flag record
  // carrying [code, type, prod-default, debug-default], a tuple of thresholds,
  // an allowlist. Reporting those as "(unreadable)" makes the tool answer
  // "no" to a question it can actually answer, which is worse than not asking.
  if (depth === 0 && node.type === 'object' && node.name === 'Array') {
    const parts: string[] = [];
    let count = 0;
    for (const edge of node.references) {
      if (edge.type !== 'element') continue;
      count++;
      if (parts.length >= MAX_ARRAY_ELEMENTS) continue;
      const {value} = readValue(edge.toNode, smiTrusted, depth + 1);
      parts.push(value === null ? '?' : String(value));
    }
    if (count === 0) return {value: '[]'};
    return {
      value: `[${parts.join(', ')}${count > parts.length ? `, …+${count - parts.length}` : ''}]`,
    };
  }
  // V8 reports the shared `true`/`false` oddballs as type "native", not
  // "object" — keying on the type here silently turned every boolean flag in
  // the heap into "(unreadable)".
  if (node.name === 'true' || node.name === 'false') {
    return {value: node.name === 'true'};
  }
  if (node.type === 'string' || node.type === 'concatenated string') {
    return {value: node.name};
  }
  if (node.type === 'number') {
    const smi = decodeSmi(node);
    if (smi != null) {
      return smiTrusted
        ? {value: smi}
        : {value: smi, note: 'SMI decode unverified in this capture'};
    }
    // A heap number's value is not stored in the snapshot at all.
    return {
      value: null,
      note: 'heap number — value not recorded in the capture',
    };
  }
  if (node.name === 'null' || node.name === 'undefined') {
    return {value: null, note: node.name};
  }
  return {value: null, note: `${node.name} (${node.type})`};
}

interface Registry {
  node: IHeapNode;
  entries: Array<{key: string; node: IHeapNode}>;
}

function collectRegistries(
  snapshot: ReturnType<typeof getSnapshot>,
  minEntries: number,
): Registry[] {
  const out: Registry[] = [];
  snapshot.nodes.forEach(node => {
    if (node.id <= 3 || node.type !== 'object') return;
    const entries: Array<{key: string; node: IHeapNode}> = [];
    let props = 0;
    for (const edge of node.references) {
      if (edge.type !== 'property') continue;
      props++;
      // Bail early on objects that are plainly not registries; walking every
      // property of every object in a 2.5M-node heap otherwise dominates.
      if (props > 5000) break;
      const key = String(edge.name_or_index);
      if (!CONFIG_KEY_RE.test(key)) continue;
      entries.push({key, node: edge.toNode});
    }
    if (entries.length >= minEntries) out.push({node, entries});
  });
  return out.sort((a, b) => b.entries.length - a.entries.length);
}

export function registerAppConfig(server: McpServer): void {
  server.tool(
    'memlab_app_config',
    'Read the feature flags and config values the app was actually running with, out of the snapshot itself.\n\n' +
      'Half of "is this leak still there?" is "was the fix even enabled in this capture?" — and that gets answered by inference: the code says the cleanup is gated, the capture looks like the cleanup did not run, therefore the gate was off. That is circular, because the same evidence is what the gate is being invoked to explain. The config the app read is still resident in the heap, so the question is answerable directly.\n\n' +
      'Registries are found by SHAPE, not by name — an object with many entries whose keys look like config identifiers (`some_feature_enabled`, `web.thing.limit`) and whose values are booleans or small numbers. `key` looks up one flag across every registry found.',
    {
      key: z
        .string()
        .optional()
        .describe(
          'Look up this exact config key (or a substring of it) across all registries found, and report its value.',
        ),
      min_entries: z
        .number()
        .optional()
        .default(20)
        .describe(
          'Minimum config-shaped keys for an object to count as a registry (default 20). Lower it if the app splits config across small objects.',
        ),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe('Registries (or matching keys) to report (default 10).'),
      samples: z
        .number()
        .optional()
        .default(5)
        .describe('Sample entries to show per registry in discover mode.'),
    },
    async ({key, min_entries, limit, samples}) => {
      try {
        const snapshot = getSnapshot({allowLight: true});
        const calibration = calibrateSmiDecode(snapshot, 25);
        const smiTrusted = calibration.verdict === 'holds';
        const registries = collectRegistries(snapshot, min_entries);

        if (registries.length === 0) {
          return toolResult(
            [
              `No config-shaped registry found (needed ≥ ${formatNumber(min_entries)} keys matching \`${CONFIG_KEY_RE.source}\` on one object).`,
              '',
              'That is a statement about the shape looked for, not about the app: config held in a Map, keyed by camelCase, or split across many small objects will not match. Try a lower `min_entries`, or find it directly with `memlab_find_by_property` on a flag name you already know.',
            ].join('\n'),
          );
        }

        if (key != null && key !== '') {
          const needle = key.toLowerCase();
          const hits: Array<{
            reg: Registry;
            key: string;
            value: FlagValue;
            note?: string;
          }> = [];
          for (const reg of registries) {
            for (const e of reg.entries) {
              if (!e.key.toLowerCase().includes(needle)) continue;
              const {value, note} = readValue(e.node, smiTrusted);
              hits.push({reg, key: e.key, value, note});
            }
          }
          if (hits.length === 0) {
            return toolResult(
              `No key matching \`${key}\` in the ${formatNumber(registries.length)} registry/registries found (${formatNumber(registries.reduce((a, r) => a + r.entries.length, 0))} keys total). The flag may be held under a different name, or read once and never stored.`,
            );
          }
          const rows = hits
            .slice(0, limit)
            .map(h => [
              h.key,
              h.value === null ? '(unreadable)' : String(h.value),
              `@${h.reg.node.id} ${h.reg.node.name}`,
              h.note ?? '',
            ]);
          return toolResult(
            [
              `## Config lookup: \`${key}\``,
              '',
              markdownTable(
                ['Key', 'Value', 'Registry', 'Note'],
                rows,
                new Set(),
              ),
              '',
              hits.length > limit
                ? `_${formatNumber(hits.length - limit)} further match(es); raise \`limit\` or pass the exact key._\n`
                : '',
              '_This is the value RESIDENT in the capture, which is what the app read — not what the config service would return now. A value the app read once and never stored is not here at all, and absence is not evidence the flag was off._',
              '',
              '_An ARRAY value is the record exactly as stored. For a flag-definition record (`[code, type, prod-default, debug-default]` and similar) those are the DEFAULTS, and the value the app resolved at runtime may differ — check where the app reads the record before quoting an element as the effective setting._',
            ].join('\n'),
          );
        }

        const rows = registries.slice(0, limit).map(r => {
          const sample = r.entries
            .slice(0, samples)
            .map(e => {
              const {value} = readValue(e.node, smiTrusted);
              return `${e.key}=${value === null ? '?' : String(value)}`;
            })
            .join(', ');
          return [
            `@${r.node.id} ${r.node.name}`,
            formatNumber(r.entries.length),
            sample.length > 90 ? sample.slice(0, 87) + '…' : sample,
          ];
        });
        return toolResult(
          [
            `## Config registries (${formatNumber(registries.length)} found)`,
            '',
            markdownTable(
              ['Object', 'Config-shaped keys', 'Sample'],
              rows,
              new Set([1]),
            ),
            '',
            smiTrusted
              ? ''
              : '⚠ Numeric values come from the SMI node-id decode, and the self-check against known array lengths FAILED in this capture — treat every number above as unverified.\n',
            'Look one up with `memlab_app_config({key: "..."})`. Boolean and string values are read directly; a heap number\'s value is not recorded in a snapshot at all and reports as unreadable.',
          ].join('\n'),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

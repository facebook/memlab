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
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';

export function registerSearchStrings(server: McpServer): void {
  server.tool(
    'memlab_search_strings',
    'Search the content (stringValue) of all string nodes in the heap snapshot. ' +
      'Unlike memlab_search_nodes which searches by node name/class, this searches the ' +
      'actual text content of strings. Essential for finding string constants (error messages, ' +
      'event names, config keys, URLs) and tracing them back to their origin. ' +
      'Supports exact substring match and regex patterns.',
    {
      pattern: z
        .string()
        .describe(
          'The search pattern. Plain text for substring match, or prefix with "/" for regex ' +
            '(e.g., "/change:ack.*directPath/i" for case-insensitive regex).',
        ),
      limit: z
        .number()
        .optional()
        .default(20)
        .describe('Maximum number of matching strings to return (default 20)'),
      min_length: z
        .number()
        .optional()
        .default(0)
        .describe(
          'Minimum string length to search (default 0). Use to skip short strings.',
        ),
      max_length: z
        .number()
        .optional()
        .describe(
          'Maximum string length to search. Use to skip very large strings for faster results.',
        ),
      show_referrers: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Show which objects reference each matching string (default true). Disable for faster results when you only need the string values.',
        ),
    },
    async ({pattern, limit, min_length, max_length, show_referrers}) => {
      try {
        const snapshot = getSnapshot();

        let regex: RegExp | null = null;
        let substring: string | null = null;

        if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
          const lastSlash = pattern.lastIndexOf('/');
          const regexPattern = pattern.slice(1, lastSlash);
          const flags = pattern.slice(lastSlash + 1);
          regex = new RegExp(regexPattern, flags);
        } else {
          substring = pattern;
        }

        interface Match {
          nodeId: number;
          stringValue: string;
          selfSize: number;
          retainedSize: number;
          nodeType: string;
          nodeName: string;
        }

        const matches: Match[] = [];
        let scannedCount = 0;
        let totalStringNodes = 0;

        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          if (!node.isString) return;
          totalStringNodes++;

          const strNode = node.toStringNode();
          if (!strNode) return;
          const val = strNode.stringValue;

          if (val.length < min_length) return;
          if (max_length != null && val.length > max_length) return;
          scannedCount++;

          let isMatch = false;
          if (regex) {
            isMatch = regex.test(val);
          } else if (substring) {
            isMatch = val.includes(substring);
          }

          if (!isMatch) return;

          const size = node.retainedSize;
          let inserted = false;
          for (let i = 0; i < matches.length; i++) {
            if (size > matches[i].retainedSize) {
              matches.splice(i, 0, {
                nodeId: node.id,
                stringValue: val,
                selfSize: node.self_size,
                retainedSize: size,
                nodeType: node.type,
                nodeName: node.name,
              });
              inserted = true;
              break;
            }
          }
          if (!inserted)
            matches.push({
              nodeId: node.id,
              stringValue: val,
              selfSize: node.self_size,
              retainedSize: size,
              nodeType: node.type,
              nodeName: node.name,
            });
          if (matches.length > limit) matches.length = limit;
        });

        const patternDesc = regex ? `regex ${pattern}` : `"${pattern}"`;

        if (matches.length === 0) {
          return toolResult(
            `No strings matching ${patternDesc} found.\n\n` +
              `Scanned ${formatNumber(scannedCount)} of ${formatNumber(totalStringNodes)} string nodes` +
              (min_length > 0 ? ` (filtered to length >= ${min_length})` : '') +
              '.\n\n' +
              '**Try:**\n' +
              '- Use a shorter or less specific pattern\n' +
              '- Use regex for flexible matching: `/partial.*match/i`\n' +
              '- Remove min_length/max_length filters\n' +
              '- Use `memlab_duplicated_strings` if looking for repeated strings',
          );
        }

        const lines = [
          `## String Content Search`,
          `Found ${formatNumber(matches.length)} string(s) matching ${patternDesc} (scanned ${formatNumber(scannedCount)} of ${formatNumber(totalStringNodes)} string nodes)`,
          '',
        ];

        const headers = ['ID', 'Preview', 'Length', 'Self Size', 'Retained'];
        const rightCols = new Set([2, 3, 4]);
        const rows = matches.map(m => {
          const preview =
            m.stringValue.length > 80
              ? m.stringValue.slice(0, 77) + '...'
              : m.stringValue;
          return [
            `@${m.nodeId}`,
            `"${preview.replace(/\n/g, '\\n').replace(/\|/g, '\\|')}"`,
            formatNumber(m.stringValue.length),
            formatBytes(m.selfSize),
            formatBytes(m.retainedSize),
          ];
        });
        lines.push(markdownTable(headers, rows, rightCols));

        if (show_referrers && matches.length > 0) {
          lines.push('');
          lines.push('**Referrer context for top matches:**');
          for (const m of matches.slice(0, 5)) {
            const node = snapshot.getNodeById(m.nodeId);
            if (!node) continue;
            const referrers: string[] = [];
            let count = 0;
            for (const edge of node.referrers) {
              if (count >= 3) break;
              if (edge.fromNode.id <= 3) continue;
              referrers.push(
                `\`${String(edge.name_or_index)}\` on @${edge.fromNode.id} \`${edge.fromNode.name}\``,
              );
              count++;
            }
            if (referrers.length > 0) {
              const preview =
                m.stringValue.length > 40
                  ? m.stringValue.slice(0, 37) + '...'
                  : m.stringValue;
              lines.push(
                `- @${m.nodeId} "${preview.replace(/\n/g, '\\n')}": ${referrers.join(', ')}`,
              );
            }
          }
        }

        lines.push('');
        lines.push('**Suggested next steps:**');
        const top = matches[0];
        lines.push(
          `- Inspect string: \`memlab_get_string(${top.nodeId})\` for full value`,
        );
        lines.push(
          `- Trace retention: \`memlab_retainer_trace(${top.nodeId})\``,
        );
        lines.push(
          `- Find duplicates: \`memlab_retainer_summary\` with \`node_ids\` from matching strings`,
        );

        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

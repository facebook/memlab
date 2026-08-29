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
import type {AnonymizeReport} from '@memlab/core';
import fs from 'fs';
import path from 'path';
import {z} from 'zod';
import memlabCore from '@memlab/core';
import {resolveSnapshotPath} from './load-snapshot.js';
import {errorResult, formatBytes, formatNumber, textResult} from '../utils.js';

const {anonymizeHeapSnapshotFile, auditHeapSnapshotFile, resolveForComparison} =
  memlabCore;

/**
 * memlab_anonymize_snapshot — make a capture shareable, and say what is left.
 *
 * A heap snapshot is a verbatim dump of everything the page had in memory:
 * message bodies, tokens, account identifiers, serialized DOM. Attaching one to
 * a task, or handing it to a model, publishes all of it.
 *
 * The reason this is a tool rather than advice is that doing it by hand goes
 * wrong in a way that looks fine. One capture anonymized by hand had every
 * string VALUE replaced — and still carried 26,303 account handles and 1,325
 * serialized DOM fragments in the clear, because those are property names and
 * node names rather than string values. Nothing in the file looked suspicious;
 * the redaction was visibly thorough where anyone would think to look.
 *
 * So the output always ends with what was NOT removed. A tool that lists only
 * what it took invites the reader to assume the rest was safe.
 */
function renderReport(
  report: AnonymizeReport,
  wroteTo: string | null,
  inputLabel: string,
  inputBytes: number,
  outputBytes: number | null,
  elapsedMs: number,
): string {
  const lines: string[] = [];
  lines.push(
    wroteTo != null
      ? `# Anonymized \`${inputLabel}\` → \`${wroteTo}\``
      : `# Anonymization audit of \`${inputLabel}\` (nothing written)`,
  );
  lines.push('');
  lines.push(
    `Mode \`${report.mode}\`${report.salted ? ' (salted)' : ' (unsalted)'} · ` +
      `${formatBytes(inputBytes)} in` +
      (outputBytes != null ? ` · ${formatBytes(outputBytes)} out` : '') +
      ` · ${(elapsedMs / 1000).toFixed(1)}s`,
  );
  lines.push('');
  lines.push('## Removed');
  lines.push('');
  lines.push('| what | count |');
  lines.push('| --- | ---: |');
  lines.push(
    `| heap string values (every string on the heap) | ${formatNumber(report.valuesRedacted)} |`,
  );
  for (const rule of report.contentRedactedByRule) {
    lines.push(`| ${rule.rule} | ${formatNumber(rule.count)} |`);
  }
  lines.push(
    `| _string table entries_ | _${formatNumber(report.stringTableSize)} total, ${formatNumber(report.entriesSplit)} split to preserve a label_ |`,
  );
  lines.push('');
  lines.push(
    'Class names, function names and ordinary property keys are deliberately kept, so retainer traces, ' +
      'class histograms, dominator trees and shape analyses all still work on the result.',
  );
  lines.push('');
  lines.push('## Still in the clear — review before sharing');
  lines.push('');
  if (report.unclassifiedLabelFamilies.length === 0) {
    lines.push('No machine-generated-looking labels remain.');
  } else {
    lines.push('| count | shape | examples |');
    lines.push('| ---: | --- | --- |');
    for (const family of report.unclassifiedLabelFamilies) {
      const examples = family.examples
        .map(e => (e.length > 38 ? `${e.slice(0, 35)}…` : e))
        .map(e => `\`${e.replace(/\|/g, '\\|')}\``)
        .join(' ');
      lines.push(
        `| ${formatNumber(family.count)} | \`${family.shape}\` | ${examples} |`,
      );
    }
    lines.push('');
    lines.push(
      '**Anything above that is an identifier in THIS application is a residual leak.** No fixed rule set can know ' +
        "an application's own identifier scheme, which is why they are reported rather than guessed at. To remove one, " +
        're-run from the API with a `shouldRedact` callback (`@memlab/core`), or add it to `extra_patterns`.',
    );
  }
  return lines.join('\n');
}

export function registerAnonymizeSnapshot(server: McpServer): void {
  server.tool(
    'memlab_anonymize_snapshot',
    'Rewrite a .heapsnapshot so it can be shared: replaces the content of every string on the heap, plus any property name or node name that looks like an identifier, a credential or serialized DOM — while KEEPING class names, function names and ordinary property keys, so retainer traces, histograms, dominator trees and shape analyses still work on the result. Lengths are preserved exactly, and by default so is distinctness, so duplication and interning figures stay accurate. Always reports what it did NOT remove: a capture anonymized by hand had every string value replaced and still carried 26,303 account handles as property names. Set audit_only to inspect a capture someone else anonymized without writing anything. Set salt for anything leaving your trust boundary, and reuse one salt across a set of snapshots so they stay comparable.',
    {
      file_path: z
        .string()
        .describe(
          'A local absolute path to a .heapsnapshot file, a manifold:// URL, or a bare snapshot filename to fetch.',
        ),
      output_path: z
        .string()
        .optional()
        .describe(
          'Absolute path to write the anonymized snapshot to. Required unless audit_only is set. Must differ from the input.',
        ),
      audit_only: z
        .boolean()
        .default(false)
        .describe(
          'Report what would be redacted and what would be left in the clear, without writing a file.',
        ),
      mode: z
        .enum(['stable', 'uniform'])
        .default('stable')
        .describe(
          '"stable" (default) keeps distinct values distinct, so duplication and interning figures remain accurate. "uniform" replaces every character with "?", which leaks less but collapses distinct values of equal length together and makes every duplication figure fiction.',
        ),
      salt: z
        .string()
        .optional()
        .describe(
          'Salt for the replacement text. Without one the mapping is identical in every capture — convenient for diffing a ladder, but it lets anyone holding a candidate value confirm its presence. Use the SAME salt for every file in a set.',
        ),
      extra_patterns: z
        .array(z.string())
        .optional()
        .describe(
          'Additional regular expressions; any string table entry matching one is redacted wherever it appears. Use this for identifier schemes specific to this application.',
        ),
      keep_patterns: z
        .array(z.string())
        .optional()
        .describe(
          'Regular expressions that must never be redacted; these win over every built-in rule.',
        ),
    },
    async ({
      file_path,
      output_path,
      audit_only,
      mode,
      salt,
      extra_patterns,
      keep_patterns,
    }) => {
      try {
        let resolved: string;
        try {
          resolved = resolveSnapshotPath(file_path).localPath;
        } catch (fetchErr) {
          const msg =
            fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          return errorResult(
            new Error(`Failed to resolve "${file_path}": ${msg}`),
          );
        }
        if (!fs.existsSync(resolved)) {
          return errorResult(new Error(`File not found: ${resolved}`));
        }

        let extraPatterns: RegExp[] | undefined;
        let keepPatterns: RegExp[] | undefined;
        try {
          extraPatterns = extra_patterns?.map(p => new RegExp(p));
          keepPatterns = keep_patterns?.map(p => new RegExp(p));
        } catch (reErr) {
          return errorResult(
            new Error(
              `Invalid regular expression: ${reErr instanceof Error ? reErr.message : String(reErr)}`,
            ),
          );
        }

        const options = {mode, salt, extraPatterns, keepPatterns};
        const inputBytes = fs.statSync(resolved).size;
        const inputLabel = path.basename(resolved);
        const started = Date.now();

        if (audit_only) {
          const report = await auditHeapSnapshotFile(resolved, options);
          return textResult(
            renderReport(
              report,
              null,
              inputLabel,
              inputBytes,
              null,
              Date.now() - started,
            ),
          );
        }

        if (!output_path) {
          // Not defaulted to a path beside the input on purpose: writing an
          // anonymized copy somewhere the caller did not name is how a capture
          // gets shared by accident.
          return errorResult(
            new Error(
              'Set output_path to write the anonymized snapshot to, or audit_only:true to only report what would be redacted.',
            ),
          );
        }
        // Canonical comparison, not `path.resolve`: a symlink pointing at the
        // input resolves to a different string but the same file, and writing
        // there destroys the only unredacted copy.
        if (
          resolveForComparison(output_path) === resolveForComparison(resolved)
        ) {
          return errorResult(
            new Error(
              'output_path must differ from the input; anonymizing in place would destroy the only unredacted copy.',
            ),
          );
        }

        const report = await anonymizeHeapSnapshotFile(
          resolved,
          output_path,
          options,
        );
        return textResult(
          renderReport(
            report,
            output_path,
            inputLabel,
            inputBytes,
            fs.statSync(output_path).size,
            Date.now() - started,
          ),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

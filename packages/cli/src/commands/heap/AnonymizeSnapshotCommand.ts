/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {AnonymizeReport, CLIOptions} from '@memlab/core';

import type {AnonymizePhase} from '@memlab/core';

import fs from 'fs';
import {
  anonymizeHeapSnapshotFile,
  auditHeapSnapshotFile,
  BaseOption,
  info,
  resolveForComparison,
  utils,
} from '@memlab/core';
import BaseCommand, {CommandCategory} from '../../BaseCommand';
import AnonymizeAuditOnlyOption from '../../options/heap/AnonymizeAuditOnlyOption';
import AnonymizeModeOption from '../../options/heap/AnonymizeModeOption';
import AnonymizeOutputOption from '../../options/heap/AnonymizeOutputOption';
import AnonymizeSaltOption from '../../options/heap/AnonymizeSaltOption';
import optionConstants from '../../options/lib/OptionConstant';
import SnapshotDirectoryOption from '../../options/heap/SnapshotDirectoryOption';
import SnapshotFileOption from '../../options/heap/SnapshotFileOption';

/** Thousands separators. 186913 is not a number anyone reads at a glance. */
function num(n: number): string {
  return n.toLocaleString('en-US');
}

function fileSize(file: string): string {
  try {
    const bytes = fs.statSync(file).size;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } catch {
    return 'unknown size';
  }
}

/** `read` -> what the user should understand is happening. */
const PHASE_LABEL: Record<AnonymizePhase, string> = {
  read: 'Reading snapshot',
  anonymize: 'Redacting strings',
  write: 'Writing output',
};

/**
 * The callback fires as a phase STARTS, so `step` counts the phase now running,
 * not work finished. Rendering it directly puts the bar at 100% the moment the
 * write begins — on a multi-GB capture that is minutes of a full bar, and the
 * obvious reading of a full bar is that the command is done and hung. The label
 * names what is running; the bar shows phases actually completed.
 */
function onPhase(phase: AnonymizePhase, step: number, total: number): void {
  info.progress(step - 1, total, {message: PHASE_LABEL[phase]});
}

function printReport(
  report: AnonymizeReport,
  input: string,
  wrote: string | null,
): void {
  // What happened, before any counts. The previous version opened with a bare
  // "Audit only", which tells a first-time reader neither what ran nor on what.
  if (wrote != null) {
    info.topLevel('Anonymized snapshot written');
    info.lowLevel(`  from  ${input} (${fileSize(input)})`);
    info.lowLevel(`  to    ${wrote} (${fileSize(wrote)})`);
  } else {
    info.topLevel('Audit only — nothing was written');
    info.lowLevel(`  input  ${input} (${fileSize(input)})`);
    info.lowLevel(
      '  This reports what anonymizing WOULD remove. Re-run with --output <FILE> to produce a shareable copy.',
    );
  }

  // Each line says what the number MEANS, not just what it is counted as. The
  // old labels ("entries split to keep a label") were internal vocabulary.
  info.topLevel('What was removed');
  info.lowLevel(
    `  ${num(report.valuesRedacted)} string values redacted   (the text your app stored — names, messages, tokens)`,
  );
  // The colon is only earned when rows follow it. A run with no content-rule
  // hits printed "0 more redacted ... :" and then nothing, which reads as
  // truncated output rather than as a clean result.
  if (report.contentRedacted > 0) {
    info.lowLevel(
      `  ${num(report.contentRedacted)} more redacted because their CONTENT looked sensitive:`,
    );
    for (const rule of report.contentRedactedByRule) {
      info.lowLevel(`      ${rule.rule.padEnd(18)} ${num(rule.count)}`);
    }
  } else {
    info.lowLevel(
      '  0 more redacted by content rules (no digit runs, hashes or tokens matched)',
    );
  }
  info.lowLevel(
    `  ${num(report.entriesSplit)} entries split so a structural label could be kept readable`,
  );
  info.lowLevel(
    `  out of ${num(report.stringTableSize)} strings in the capture; mode "${report.mode}"${
      report.salted ? ', salted' : ''
    }`,
  );

  // Printed even when it is empty, and printed last, because it is the part a
  // reader has to act on. A tool that only lists what it removed invites the
  // reader to assume the rest was safe.
  info.topLevel('Still in the clear — review before sharing');
  if (report.unclassifiedLabelFamilies.length === 0) {
    info.lowLevel('  (no machine-generated-looking labels remain)');
    return;
  }
  // The action comes BEFORE the list. Previously it sat underneath a dozen
  // rows of shape families, which is where a reader has already stopped.
  info.lowLevel(
    '  These are property names and labels, NOT string values — they were kept because',
  );
  info.lowLevel(
    '  they look like code identifiers. Any that is an identifier in YOUR application',
  );
  info.lowLevel(
    '  is a residual: anonymize again from the API with a `shouldRedact` callback.',
  );
  info.lowLevel('');
  info.lowLevel(
    '  Grouped by SHAPE, where a=lowercase run, A=uppercase, d=digits — so "a$d"',
  );
  info.lowLevel(
    '  covers require$$99, module$42, and anything else like them.',
  );
  info.lowLevel('');
  info.lowLevel(`  ${'count'.padStart(7)}  shape                 examples`);
  for (const family of report.unclassifiedLabelFamilies) {
    const examples = family.examples
      .map(e => (e.length > 34 ? `${e.slice(0, 31)}...` : e))
      .join(', ');
    info.lowLevel(
      `  ${num(family.count).padStart(7)}  ${family.shape.padEnd(20).slice(0, 20)}  ${examples}`,
    );
  }
}

export default class AnonymizeSnapshotCommand extends BaseCommand {
  getCommandName(): string {
    return 'anonymize';
  }

  getDescription(): string {
    return 'remove user data from a heap snapshot so it can be shared';
  }

  getCategory(): CommandCategory {
    return CommandCategory.COMMON;
  }

  getExamples(): string[] {
    return [
      '--snapshot <HEAP_SNAPSHOT_FILE> --output <OUTPUT_FILE>',
      '--snapshot <HEAP_SNAPSHOT_FILE> --output <OUTPUT_FILE> --anonymize-salt <SALT>',
      '--snapshot <HEAP_SNAPSHOT_FILE> --audit-only',
    ];
  }

  getOptions(): BaseOption[] {
    return [
      new SnapshotFileOption(),
      new SnapshotDirectoryOption(),
      new AnonymizeOutputOption(),
      new AnonymizeModeOption(),
      new AnonymizeSaltOption(),
      new AnonymizeAuditOnlyOption(),
    ];
  }

  async run(options: CLIOptions): Promise<void> {
    const args = options.cliArgs;
    const names = optionConstants.optionNames;
    const input = utils.getSingleSnapshotFileForAnalysis();
    const output = args[names.ANONYMIZE_OUTPUT] as string | undefined;
    const auditOnly = Boolean(args[names.ANONYMIZE_AUDIT_ONLY]);

    const anonymizeOptions = {
      mode: args[names.ANONYMIZE_MODE] as 'stable' | 'uniform' | undefined,
      salt: args[names.ANONYMIZE_SALT] as string | undefined,
    };

    if (auditOnly) {
      if (output) {
        // Said out loud rather than ignored. The whole point of this command is
        // that the caller knows exactly what did and did not happen to their
        // capture; silently dropping the output path leaves them looking for a
        // file that was never written.
        info.warning(
          `--${names.ANONYMIZE_AUDIT_ONLY} writes nothing, so ` +
            `--${names.ANONYMIZE_OUTPUT}=${output} is ignored. Re-run without ` +
            `--${names.ANONYMIZE_AUDIT_ONLY} to produce that file.`,
        );
      }
      printReport(
        await auditHeapSnapshotFile(input, anonymizeOptions, onPhase),
        input,
        null,
      );
      return;
    }

    if (!output) {
      // Refusing rather than defaulting to a path next to the input: writing an
      // anonymized copy somewhere the caller did not name is how a file ends up
      // shared by accident, and overwriting the original would destroy the only
      // unredacted copy.
      utils.haltOrThrow(
        `Specify --${names.ANONYMIZE_OUTPUT} <FILE> to write the anonymized ` +
          `snapshot to, or --${names.ANONYMIZE_AUDIT_ONLY} to only report ` +
          `what would be redacted.`,
      );
      return;
    }
    // Compared canonically, not as strings. `input` arrives already resolved
    // from `getSingleSnapshotFileForAnalysis`, while `output` is whatever the
    // user typed, so `./capture.heapsnapshot`, a relative path, or a symlink to
    // the input are all spellings this guard has to catch — missing one
    // overwrites the only unredacted copy, which is the thing it exists to
    // prevent. The API refuses too; this is here to fail with a CLI-shaped
    // message before any work starts.
    if (resolveForComparison(output) === resolveForComparison(input)) {
      utils.haltOrThrow(
        `--${names.ANONYMIZE_OUTPUT} resolves to the same file as the input ` +
          `snapshot; anonymizing in place would destroy the original capture.`,
      );
      return;
    }

    printReport(
      await anonymizeHeapSnapshotFile(input, output, anonymizeOptions, onPhase),
      input,
      output,
    );
  }
}

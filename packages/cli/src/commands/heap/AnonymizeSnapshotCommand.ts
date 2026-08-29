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

function printReport(report: AnonymizeReport, wrote: string | null): void {
  info.topLevel(
    wrote != null ? `Anonymized snapshot written to ${wrote}` : 'Audit only',
  );
  info.lowLevel(`  mode: ${report.mode}${report.salted ? ' (salted)' : ''}`);
  info.lowLevel(`  string table entries: ${report.stringTableSize}`);
  info.lowLevel(`  heap string values redacted: ${report.valuesRedacted}`);
  info.lowLevel(`  entries split to keep a label: ${report.entriesSplit}`);
  info.lowLevel(`  entries redacted by content: ${report.contentRedacted}`);
  for (const rule of report.contentRedactedByRule) {
    info.lowLevel(`    ${rule.rule}: ${rule.count}`);
  }

  // Printed even when it is empty, and printed last, because it is the part a
  // reader has to act on. A tool that only lists what it removed invites the
  // reader to assume the rest was safe.
  info.topLevel('Still in the clear — review before sharing:');
  if (report.unclassifiedLabelFamilies.length === 0) {
    info.lowLevel('  (no machine-generated-looking labels remain)');
    return;
  }
  for (const family of report.unclassifiedLabelFamilies) {
    const examples = family.examples
      .map(e => (e.length > 40 ? `${e.slice(0, 37)}...` : e))
      .join(', ');
    info.lowLevel(`  ${family.count} x ${family.shape}   e.g. ${examples}`);
  }
  info.lowLevel(
    '  Any of these that is an identifier in YOUR application is a residual; ' +
      'anonymize again from the API with a `shouldRedact` callback to remove it.',
  );
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
      printReport(await auditHeapSnapshotFile(input, anonymizeOptions), null);
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
      await anonymizeHeapSnapshotFile(input, output, anonymizeOptions),
      output,
    );
  }
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import config from '../../lib/Config';
import fs from 'fs';
import path from 'path';
import HeapParser from '../../lib/HeapParser';
import {
  anonymizeHeapSnapshot,
  anonymizeHeapSnapshotFile,
  auditHeapSnapshotFile,
} from '../../lib/HeapAnonymizer';
import {dumpNodeHeapSnapshot} from '../../lib/NodeHeap';
import {serializeHeapSnapshot} from '../../lib/HeapSerializer';

beforeEach(() => {
  config.isTest = true;
});

const timeout = 5 * 60 * 1000;

/**
 * The canary values are ASSEMBLED AT RUNTIME rather than written as literals.
 *
 * This test file's own source text ends up in the snapshot's string table — V8
 * keeps script sources on the heap like any other string. A literal canary
 * would therefore be present in the capture twice: once as the object's value,
 * and once inside the script source. Both get redacted, so the test would still
 * pass — but it would pass without ever proving that the OBJECT's value was
 * handled, which is the thing under test. Assembling at runtime means the full
 * value exists only as a heap string.
 */
function canaryValue(): string {
  return ['MEMLAB', 'ANON', 'CANARY', 'a7f3c1d9e2b4'].join('-');
}

/** An identifier-shaped map key: structurally a label, semantically a payload. */
function canaryIdKey(): string {
  return ['77', '3105482913'].join('');
}

/**
 * Build a canary variant.
 *
 * Uses `join` rather than a template literal on purpose. Template
 * concatenation produces a `concatenated string`, and V8 stores those as a pair
 * of pointers to their halves — the joined text never becomes an entry in the
 * string table, so a canary built that way is not actually in the capture and
 * the positive controls below correctly refuse to pass. `join` flattens.
 */
function canaryVariant(suffix: string): string {
  return [canaryValue(), suffix].join('-');
}

class AnonymizerCanaryHolder {
  public secretValue: string;
  public anonymizerCanaryDescriptiveKey = 'a value under a descriptive name';
  public byContactId: Record<string, number> = {};

  constructor(secret: string, idKey: string) {
    this.secretValue = secret;
    this.byContactId[idKey] = 1;
  }
}

test(
  'anonymizing a heap snapshot removes heap string values',
  async () => {
    const secret = canaryValue();
    const idKey = canaryIdKey();
    const holder = new AnonymizerCanaryHolder(secret, idKey);

    const sourceFile = dumpNodeHeapSnapshot();
    const outputFile = `${sourceFile}.anonymized`;

    try {
      // POSITIVE CONTROL. Without this the whole test can pass for the wrong
      // reason: if the canary were optimized away or collected before the dump,
      // "absent afterwards" would be trivially true and the assertions below
      // would prove nothing.
      const before = fs.readFileSync(sourceFile, 'utf8');
      expect(before.includes(secret)).toBe(true);
      expect(before.includes(idKey)).toBe(true);

      const heap = await HeapParser.parse(sourceFile, {});
      const report = anonymizeHeapSnapshot(heap);
      serializeHeapSnapshot(heap, outputFile);

      // Scan the RAW BYTES rather than the parsed string table, so a value that
      // survived somewhere unexpected — an edge name, a node name — is caught
      // too. Absence from the file is the property being claimed.
      const after = fs.readFileSync(outputFile, 'utf8');
      expect(after.includes(secret)).toBe(false);
      expect(after.includes(idKey)).toBe(false);

      // ... and it must be redaction, not destruction: the labels a retainer
      // trace is built from have to survive, or the capture is unanalyzable.
      expect(after.includes('anonymizerCanaryDescriptiveKey')).toBe(true);
      expect(after.includes('AnonymizerCanaryHolder')).toBe(true);

      expect(report.valuesRedacted).toBeGreaterThan(0);

      // The result still has to be a readable snapshot describing the same
      // graph — redaction must not change the shape of the heap.
      const reparsed = await HeapParser.parse(outputFile, {});
      expect(reparsed.nodes.length).toBe(heap.nodes.length);
      expect(reparsed.edges.length).toBe(heap.edges.length);
    } finally {
      // Every run creates its own snapshot directory, and both files are
      // removed here, so re-running neither accumulates captures nor lets a
      // previous run's output satisfy this one's assertions.
      for (const file of [sourceFile, outputFile]) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
    }

    // Keep the holder reachable until after the dump; an unreferenced local
    // can be collected before the snapshot is taken, which would silently
    // remove the very object being tested.
    expect(holder.secretValue).toBe(secret);
  },
  timeout,
);

test(
  'stable mode keeps distinct values distinct, uniform mode does not',
  async () => {
    const holder = {
      distinctValues: [
        canaryVariant('one'),
        canaryVariant('two'),
        canaryVariant('six'),
      ],
    };

    const sourceFile = dumpNodeHeapSnapshot();
    try {
      const before = fs.readFileSync(sourceFile, 'utf8');
      expect(before.includes(holder.distinctValues[0])).toBe(true);

      const stableHeap = await HeapParser.parse(sourceFile, {});
      anonymizeHeapSnapshot(stableHeap, {mode: 'stable'});
      const uniformHeap = await HeapParser.parse(sourceFile, {});
      anonymizeHeapSnapshot(uniformHeap, {mode: 'uniform'});

      // Same length, three different values. `stable` must map them to three
      // different tokens; `uniform` collapses them to one, which is exactly the
      // behaviour that manufactures fake string duplication.
      const lengths = holder.distinctValues.map(v => v.length);
      expect(new Set(lengths).size).toBe(1);

      const tokensOfLength = (heap: {
        snapshot: {strings: string[]};
      }): Set<string> =>
        new Set(heap.snapshot.strings.filter(s => s.length === lengths[0]));

      const stableTokens = tokensOfLength(stableHeap);
      const uniformTokens = tokensOfLength(uniformHeap);
      expect(uniformTokens.has('?'.repeat(lengths[0]))).toBe(true);
      expect(stableTokens.size).toBeGreaterThan(uniformTokens.size);
    } finally {
      if (fs.existsSync(sourceFile)) {
        fs.unlinkSync(sourceFile);
      }
    }
  },
  timeout,
);

test(
  'anonymization is deterministic and repeatable for the same input',
  async () => {
    const holder = {value: canaryVariant('repeatable')};

    const sourceFile = dumpNodeHeapSnapshot();
    try {
      expect(fs.readFileSync(sourceFile, 'utf8').includes(holder.value)).toBe(
        true,
      );

      const first = await HeapParser.parse(sourceFile, {});
      const second = await HeapParser.parse(sourceFile, {});
      const firstReport = anonymizeHeapSnapshot(first, {salt: 'test-salt'});
      const secondReport = anonymizeHeapSnapshot(second, {salt: 'test-salt'});

      expect(secondReport.valuesRedacted).toBe(firstReport.valuesRedacted);
      expect(first.snapshot.strings).toEqual(second.snapshot.strings);

      // A different salt must produce different tokens, or the salt is not
      // doing the one job it has.
      const third = await HeapParser.parse(sourceFile, {});
      anonymizeHeapSnapshot(third, {salt: 'another-salt'});
      expect(third.snapshot.strings).not.toEqual(first.snapshot.strings);
    } finally {
      if (fs.existsSync(sourceFile)) {
        fs.unlinkSync(sourceFile);
      }
    }
  },
  timeout,
);

/**
 * Field names, not computed keys, because only fast-mode properties become
 * LABELS.
 *
 * `obj[key] = v` on a plain object puts it in dictionary mode, where V8 stores
 * the key as a value inside a name dictionary rather than as a named edge — so
 * such keys are already covered by the node-type rule and prove nothing about
 * the callback. A declared field is emitted as a property edge name, which is
 * the case that needs a caller-supplied decision.
 */
class AnonymizerCallbackHolder {
  // An application-private identifier scheme: no digits, not an address, not
  // base64, not markup. Every built-in rule is blind to it BY DESIGN — memlab
  // must not ship other people's formats.
  //
  // The values are objects, not numbers, and that is load-bearing: V8 emits no
  // edge for a small-integer property because there is no heap object to point
  // at, so an `= 1` field name never becomes a label at all and the test would
  // silently exercise the wrong path.
  public ORD_kfmqvzhtbewx: {n: number} = {n: 1};
  // ... and one a built-in rule DOES take, to test the other direction: the
  // callback has to be able to protect as well as redact.
  public col_987654321012: {n: number} = {n: 2};
}

test(
  'a shouldRedact callback covers a scheme no built-in rule knows',
  async () => {
    const appKey = 'ORD_kfmqvzhtbewx';
    const builtInKey = 'col_987654321012';
    const holder = new AnonymizerCallbackHolder();

    const sourceFile = dumpNodeHeapSnapshot();
    const defaultOut = `${sourceFile}.default`;
    const customOut = `${sourceFile}.custom`;

    try {
      const before = fs.readFileSync(sourceFile, 'utf8');
      expect(before.includes(appKey)).toBe(true);
      expect(before.includes(builtInKey)).toBe(true);

      // POSITIVE CONTROL for the callback's reason to exist: with defaults the
      // app-private key survives because nothing knows it, while the key with a
      // long digit run does not. If this ever flips, the assertions below stop
      // proving that the callback reached something the rules could not.
      const plain = await HeapParser.parse(sourceFile, {});
      anonymizeHeapSnapshot(plain);
      serializeHeapSnapshot(plain, defaultOut);
      const plainText = fs.readFileSync(defaultOut, 'utf8');
      expect(plainText.includes(appKey)).toBe(true);
      expect(plainText.includes(builtInKey)).toBe(false);

      const custom = await HeapParser.parse(sourceFile, {});
      const shapes: string[] = [];
      const report = anonymizeHeapSnapshot(custom, {
        shouldRedact: (value, context) => {
          if (value === appKey) {
            shapes.push(context.shape);
            return true;
          }
          if (value === builtInKey) {
            return false;
          }
          return undefined;
        },
      });
      serializeHeapSnapshot(custom, customOut);

      const customText = fs.readFileSync(customOut, 'utf8');
      expect(customText.includes(appKey)).toBe(false);
      expect(customText.includes(builtInKey)).toBe(true);
      expect(
        report.contentRedactedByRule.some(r => r.rule === 'custom-callback'),
      ).toBe(true);

      // The context has to carry something usable for matching a whole scheme
      // by shape rather than value by value.
      expect(shapes.length).toBeGreaterThan(0);
      expect(shapes[0]).toBe('A_a');
    } finally {
      for (const file of [sourceFile, defaultOut, customOut]) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
    }

    expect(holder.ORD_kfmqvzhtbewx.n).toBe(1);
  },
  timeout,
);

test(
  'the file API anonymizes without building the object graph',
  async () => {
    const secret = canaryVariant('fileapi');
    const holder = {value: secret};

    const sourceFile = dumpNodeHeapSnapshot();
    const outputFile = `${sourceFile}.fileapi`;
    try {
      expect(fs.readFileSync(sourceFile, 'utf8').includes(secret)).toBe(true);

      const audit = await auditHeapSnapshotFile(sourceFile);
      expect(audit.valuesRedacted).toBeGreaterThan(0);
      // auditing must not write anything, including over the input
      expect(fs.existsSync(outputFile)).toBe(false);
      expect(fs.readFileSync(sourceFile, 'utf8').includes(secret)).toBe(true);

      const report = await anonymizeHeapSnapshotFile(sourceFile, outputFile);
      expect(report.valuesRedacted).toBe(audit.valuesRedacted);
      expect(fs.readFileSync(outputFile, 'utf8').includes(secret)).toBe(false);

      // and the file it wrote still has to be a readable snapshot
      const reparsed = await HeapParser.parse(outputFile, {});
      expect(reparsed.nodes.length).toBeGreaterThan(0);
    } finally {
      for (const file of [sourceFile, outputFile]) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
    }

    expect(holder.value).toBe(secret);
  },
  timeout,
);

test(
  'the file API refuses to overwrite its own input, however it is spelled',
  async () => {
    const sourceFile = dumpNodeHeapSnapshot();
    const dir = path.dirname(sourceFile);
    const base = path.basename(sourceFile);
    const linkPath = `${sourceFile}.link`;
    const before = fs.readFileSync(sourceFile, 'utf8');

    // Every one of these names the same file as `sourceFile`. A plain string
    // comparison catches none of them, and the cost of missing one is the only
    // unredacted copy of the capture.
    fs.symlinkSync(sourceFile, linkPath);
    const aliases = [
      sourceFile,
      path.join(dir, '.', base),
      path.join(dir, 'x', '..', base),
      linkPath,
    ];

    try {
      for (const alias of aliases) {
        await expect(
          anonymizeHeapSnapshotFile(sourceFile, alias),
        ).rejects.toThrow(/same file/);
      }
      // and the input is untouched by the refusals
      expect(fs.readFileSync(sourceFile, 'utf8')).toBe(before);

      // a genuinely different path still works
      const out = `${sourceFile}.out`;
      await anonymizeHeapSnapshotFile(sourceFile, out);
      expect(fs.existsSync(out)).toBe(true);
      fs.unlinkSync(out);
    } finally {
      for (const file of [linkPath, sourceFile]) {
        if (
          fs.existsSync(file) ||
          fs.lstatSync(file, {throwIfNoEntry: false})
        ) {
          fs.unlinkSync(file);
        }
      }
    }
  },
  timeout,
);

test(
  'keepPatterns and shouldRedact(false) protect string VALUES, not just labels',
  async () => {
    // Both options promise an entry is never redacted. The string-VALUE pass
    // does not consult the content rules, so honouring them only there would
    // silently break the promise for exactly the entries a caller named.
    const keptByPattern = canaryVariant('keepme');
    const keptByCallback = canaryVariant('callbackkeep');
    const notKept = canaryVariant('notkept');
    const holder = {a: keptByPattern, b: keptByCallback, c: notKept};

    const sourceFile = dumpNodeHeapSnapshot();
    const out = `${sourceFile}.kept`;
    try {
      const before = fs.readFileSync(sourceFile, 'utf8');
      for (const v of [keptByPattern, keptByCallback, notKept]) {
        expect(before.includes(v)).toBe(true);
      }

      const heap = await HeapParser.parse(sourceFile, {});
      anonymizeHeapSnapshot(heap, {
        keepPatterns: [new RegExp(`${canaryValue()}-keepme$`)],
        shouldRedact: value => (value === keptByCallback ? false : undefined),
      });
      serializeHeapSnapshot(heap, out);

      const after = fs.readFileSync(out, 'utf8');
      expect(after.includes(keptByPattern)).toBe(true);
      expect(after.includes(keptByCallback)).toBe(true);
      // the control: an unprotected value of the same shape is still redacted,
      // so the assertions above cannot pass by anonymization simply not running
      expect(after.includes(notKept)).toBe(false);
    } finally {
      for (const file of [sourceFile, out]) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
    }
    expect(holder.a).toBe(keptByPattern);
  },
  timeout,
);

test(
  'an out-of-range minDigitRunLength is rejected rather than matching everything',
  async () => {
    const sourceFile = dumpNodeHeapSnapshot();
    try {
      const heap = await HeapParser.parse(sourceFile, {});
      // `\d{0,}` matches every string, so this would redact the entire label
      // vocabulary and still look like a successful run.
      for (const bad of [0, -1, 2.5]) {
        expect(() =>
          anonymizeHeapSnapshot(heap, {minDigitRunLength: bad}),
        ).toThrow(/positive integer/);
      }
      // a valid value is still honoured
      expect(() =>
        anonymizeHeapSnapshot(heap, {minDigitRunLength: 4}),
      ).not.toThrow();
    } finally {
      if (fs.existsSync(sourceFile)) {
        fs.unlinkSync(sourceFile);
      }
    }
  },
  timeout,
);

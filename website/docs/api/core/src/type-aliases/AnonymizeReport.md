# Type Alias: AnonymizeReport

> **AnonymizeReport** = `object`

Defined in: core/src/lib/HeapAnonymizer.ts:204

What [anonymizeHeapSnapshot](../functions/anonymizeHeapSnapshot.md) did, and — just as importantly — what it
left behind.

## Properties

### contentRedacted

> **contentRedacted**: `number`

Defined in: core/src/lib/HeapAnonymizer.ts:221

entries redacted everywhere because their content looked sensitive

***

### contentRedactedByRule

> **contentRedactedByRule**: [`AnonymizeRuleCount`](AnonymizeRuleCount.md)[]

Defined in: core/src/lib/HeapAnonymizer.ts:223

the per-rule breakdown of `contentRedacted`

***

### entriesSplit

> **entriesSplit**: `number`

Defined in: core/src/lib/HeapAnonymizer.ts:219

how many redacted values were written to an APPENDED table entry rather
than over the original. The string table is deduplicated, so one entry can
be both a string's value and a property name; splitting is what keeps
redaction from destroying the label.

***

### mode

> **mode**: [`AnonymizationMode`](AnonymizationMode.md)

Defined in: core/src/lib/HeapAnonymizer.ts:206

the mode that was applied

***

### salted

> **salted**: `boolean`

Defined in: core/src/lib/HeapAnonymizer.ts:208

whether a non-empty salt was used

***

### stringTableSize

> **stringTableSize**: `number`

Defined in: core/src/lib/HeapAnonymizer.ts:210

number of entries in the string table before anonymization

***

### unclassifiedLabelFamilies

> **unclassifiedLabelFamilies**: [`UnclassifiedLabelFamily`](UnclassifiedLabelFamily.md)[]

Defined in: core/src/lib/HeapAnonymizer.ts:230

machine-generated-looking labels still in the clear, most common first.
Review these: anything here that is an identifier in YOUR application is a
residual leak, and the fix is to pass it as an `extraPatterns` entry. See
[UnclassifiedLabelFamily](UnclassifiedLabelFamily.md).

***

### valuesRedacted

> **valuesRedacted**: `number`

Defined in: core/src/lib/HeapAnonymizer.ts:212

string values redacted because they are the content of a string node

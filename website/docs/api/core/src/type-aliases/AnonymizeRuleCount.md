# Type Alias: AnonymizeRuleCount

> **AnonymizeRuleCount** = `object`

Defined in: core/src/lib/HeapAnonymizer.ts:193

One rule's contribution, as reported by [AnonymizeReport](AnonymizeReport.md).

## Properties

### count

> **count**: `number`

Defined in: core/src/lib/HeapAnonymizer.ts:197

how many distinct string table entries it matched

***

### rule

> **rule**: `string`

Defined in: core/src/lib/HeapAnonymizer.ts:195

the rule that matched, e.g. `dom-text` or `digit-run`

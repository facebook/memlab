# Type Alias: AnonymizeProgressCallback

> **AnonymizeProgressCallback** = (`phase`, `step`, `totalSteps`) => `void`

Defined in: core/src/lib/HeapAnonymizer.ts:848

Called as each phase STARTS, so a caller can show which one is running.

Phase-level rather than byte-level on purpose: the parse is a single
`JSON.parse` over the non-typed-array remainder, so there is no honest
intermediate percentage to report from inside it. Saying "reading" and
meaning it beats a bar that fabricates progress.

## Parameters

### phase

[`AnonymizePhase`](AnonymizePhase.md)

### step

`number`

### totalSteps

`number`

## Returns

`void`

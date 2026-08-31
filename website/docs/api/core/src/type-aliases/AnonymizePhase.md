# Type Alias: AnonymizePhase

> **AnonymizePhase** = `"read"` \| `"anonymize"` \| `"write"`

Defined in: core/src/lib/HeapAnonymizer.ts:838

The three phases [anonymizeHeapSnapshotFile](../functions/anonymizeHeapSnapshotFile.md) moves through. Reading is
the slow one on a large capture — a multi-hundred-MB `.heapsnapshot` spends
most of its wall clock in the parse, before anything is redacted.

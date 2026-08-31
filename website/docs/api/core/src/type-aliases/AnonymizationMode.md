# Type Alias: AnonymizationMode

> **AnonymizationMode** = `"stable"` \| `"uniform"`

Defined in: core/src/lib/HeapAnonymizer.ts:73

How redacted text is generated.

- `stable` — length-preserving, and derived from the value, so equal inputs
  stay equal and distinct inputs stay distinct. Duplication, interning and
  dedup analyses therefore keep reporting the truth.
- `uniform` — length-preserving fill with a single repeated character. Leaks
  strictly less (not even equality), but it collapses every distinct value of
  the same length into one, which MANUFACTURES string duplication: on one
  measured capture 272,234 distinct values collapsed to 607, and duplication
  tools then reported tens of megabytes of savings that do not exist.

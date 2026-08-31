# Type Alias: AnonymizeOptions

> **AnonymizeOptions** = `object`

Defined in: core/src/lib/HeapAnonymizer.ts:78

Options accepted by [anonymizeHeapSnapshot](../functions/anonymizeHeapSnapshot.md).

## Properties

### extraPatterns?

> `optional` **extraPatterns?**: `RegExp`[]

Defined in: core/src/lib/HeapAnonymizer.ts:112

extra patterns to redact, matched against the string table entry

***

### keepPatterns?

> `optional` **keepPatterns?**: `RegExp`[]

Defined in: core/src/lib/HeapAnonymizer.ts:114

patterns that must NEVER be redacted; these win over every built-in rule

***

### minDigitRunLength?

> `optional` **minDigitRunLength?**: `number`

Defined in: core/src/lib/HeapAnonymizer.ts:110

how many consecutive digits make a string an identifier rather than an
array index, defaults to `9`. Chosen from the data: V8 emits exhaustive
runs of short numeric index names (10 one-digit, 90 two-digit, 900
three-digit ... 138,432 six-digit on one capture) and then the count falls
off a cliff, so a floor in that gap separates indices from ids.

***

### mode?

> `optional` **mode?**: [`AnonymizationMode`](AnonymizationMode.md)

Defined in: core/src/lib/HeapAnonymizer.ts:83

how replacement text is generated, defaults to `stable`
(see [AnonymizationMode](AnonymizationMode.md))

***

### redactDomText?

> `optional` **redactDomText?**: `boolean`

Defined in: core/src/lib/HeapAnonymizer.ts:96

also redact node names that look like serialized DOM, defaults to `true`

***

### redactIdentifierKeys?

> `optional` **redactIdentifierKeys?**: `boolean`

Defined in: core/src/lib/HeapAnonymizer.ts:102

also redact string table entries whose CONTENT looks like an identifier,
wherever they are referenced — including as property names, defaults to
`true`

***

### salt?

> `optional` **salt?**: `string`

Defined in: core/src/lib/HeapAnonymizer.ts:92

salt mixed into `stable` replacements. The default is the empty string,
which is deterministic ACROSS FILES — the same value anonymizes to the
same token in every capture, so a ladder of snapshots stays diffable. That
also means a deterministic token is confirmable by anyone holding a
candidate value; pass an explicit salt for anything leaving your trust
boundary, and reuse that one salt across every file in the set.

***

### shouldRedact?

> `optional` **shouldRedact?**: (`value`, `context`) => `boolean` \| `undefined`

Defined in: core/src/lib/HeapAnonymizer.ts:134

the final say on any entry, consulted BEFORE every built-in rule.

No fixed rule set can know an identifier scheme private to one application,
and guessing at one inside memlab would mean shipping other people's
formats to everybody. This is the seam for that instead: return `true` to
redact, `false` to protect, or `undefined` to let the built-in rules
decide. `AnonymizeReport.unclassifiedLabelFamilies` is the companion — it
names the shapes still in the clear, which is where a caller finds out what
their own scheme looks like.

```typescript
anonymizeHeapSnapshot(heap, {
  // this app keys caches by order id: ORD-<digits>
  shouldRedact: (value, ctx) =>
    ctx.isLabel && value.startsWith('ORD-') ? true : undefined,
});
```

#### Parameters

##### value

`string`

##### context

[`RedactionContext`](RedactionContext.md)

#### Returns

`boolean` \| `undefined`

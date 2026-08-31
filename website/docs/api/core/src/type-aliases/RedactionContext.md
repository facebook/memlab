# Type Alias: RedactionContext

> **RedactionContext** = `object`

Defined in: core/src/lib/HeapAnonymizer.ts:164

What is known about one string table entry when [AnonymizeOptions.shouldRedact](AnonymizeOptions.md#shouldredact)
is asked to judge it.

## Properties

### isLabel

> **isLabel**: `boolean`

Defined in: core/src/lib/HeapAnonymizer.ts:176

true when this entry is used as a class name, function name, property key,
closure variable or context slot — i.e. as part of the vocabulary a
retainer trace is written in. Redacting one of these costs debuggability,
so it is the decision worth thinking about.

***

### isValue

> **isValue**: `boolean`

Defined in: core/src/lib/HeapAnonymizer.ts:169

true when this entry is the CONTENT of a string on the heap. Redacting one
of these is what the node-type rule already does by default.

***

### labelUseCount

> **labelUseCount**: `number`

Defined in: core/src/lib/HeapAnonymizer.ts:183

how many edges in the whole snapshot use this entry as their name. A
programmer-written property name is reused; an identifier minted per record
is used once or twice. Useful for telling one from the other without
knowing the format.

***

### shape

> **shape**: `string`

Defined in: core/src/lib/HeapAnonymizer.ts:189

character-class shape with runs collapsed, e.g. `d@a` for `4155551234@ex`
or `dadada-ada-da` for a UUID prefix. Lets a caller match a scheme by shape
instead of writing a precise regex.

# Type Alias: UnclassifiedLabelFamily

> **UnclassifiedLabelFamily** = `object`

Defined in: core/src/lib/HeapAnonymizer.ts:149

A family of labels left in the clear that share one machine-generated shape.

This is how the tool generalizes past its own pattern list. No fixed set of
formats can know an identifier scheme private to one application, so rather
than guess, the report names what it could not classify and lets the caller
decide. A family here is a prompt to look, not a finding: `d.d.d` is a
version number in one app and an account id in another.

## Properties

### count

> **count**: `number`

Defined in: core/src/lib/HeapAnonymizer.ts:155

how many distinct labels in the string table share it

***

### examples

> **examples**: `string`[]

Defined in: core/src/lib/HeapAnonymizer.ts:157

up to three of them, verbatim, so the shape can be recognized

***

### shape

> **shape**: `string`

Defined in: core/src/lib/HeapAnonymizer.ts:153

character-class shape with runs collapsed, e.g. `d@a` for `4155551234@ex`

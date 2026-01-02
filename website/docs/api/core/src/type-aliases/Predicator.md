# Type Alias: Predicator()\<T\>

> **Predicator**\<`T`\> = (`entity`) => `boolean`

Defined in: core/src/lib/Types.ts:220

the predicate callback is used to decide if an
entity of type `T` meets certain criteria.
For more concrete examples on where it is used,
check out findAnyReference, findAnyReferrer,
and findReferrers.

## Type Parameters

### T

`T`

the type of the entity to be checked

## Parameters

### entity

`T`

the entity to be checked

## Returns

`boolean`

whether the entity passes the predicate check

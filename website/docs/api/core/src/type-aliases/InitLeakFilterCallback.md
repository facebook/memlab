# Type Alias: InitLeakFilterCallback()

> **InitLeakFilterCallback** = (`snapshot`, `leakedNodeIds`) => `void`

Defined in: core/src/lib/Types.ts:554

Lifecycle function callback that is invoked initially once before calling any
leak filter function.
For concrete example, check out beforeLeakFilter.

## Parameters

### snapshot

[`IHeapSnapshot`](../interfaces/IHeapSnapshot.md)

heap snapshot see [IHeapSnapshot](../interfaces/IHeapSnapshot.md)

### leakedNodeIds

`HeapNodeIdSet`

the set of leaked object (node) ids.

## Returns

`void`

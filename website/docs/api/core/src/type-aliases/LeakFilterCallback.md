# Type Alias: LeakFilterCallback()

> **LeakFilterCallback** = (`node`, `snapshot`, `leakedNodeIds`) => `boolean`

Defined in: core/src/lib/Types.ts:581

Callback that can be used to define a logic to filter the
leaked objects. The callback is only called for every node
allocated but not released from the target interaction
in the heap snapshot.

For concrete examples, check out leakFilter.

## Parameters

### node

[`IHeapNode`](../interfaces/IHeapNode.md)

the node that is kept alive in the memory in the heap snapshot

### snapshot

[`IHeapSnapshot`](../interfaces/IHeapSnapshot.md)

the snapshot of target interaction

### leakedNodeIds

`HeapNodeIdSet`

the set of leaked node ids

## Returns

`boolean`

the value indicating whether the given node in the snapshot
should be considered as leaked.
* **Examples**:
```javascript
// any node in the heap snapshot that is greater than 1MB
function leakFilter(node, _snapshot, _leakedNodeIds) {
 return node.retainedSize > 1000000;
};
```

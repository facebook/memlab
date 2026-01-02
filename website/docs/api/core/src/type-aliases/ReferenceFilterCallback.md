# Type Alias: ReferenceFilterCallback()

> **ReferenceFilterCallback** = (`edge`, `snapshot`, `isReferenceUsedByDefault`) => `boolean`

Defined in: core/src/lib/Types.ts:624

Callback that can be used to define a logic to decide whether
a reference should be filtered (included) for some
calculations (e.g., retainer trace calculation)

For concrete examples, check out leakFilter.

## Parameters

### edge

[`IHeapEdge`](../interfaces/IHeapEdge.md)

the reference (edge) that is considered
for calcualting the retainer trace

### snapshot

[`IHeapSnapshot`](../interfaces/IHeapSnapshot.md)

the final snapshot taken after all browser
interactions are done.

### isReferenceUsedByDefault

`boolean`

MemLab has its own default logic for
whether a reference should be filtered (included), if this parameter is true,
it means MemLab will consider this reference for inclusion

## Returns

`boolean`

the value indicating whether the given reference should be
filtered (i.e., included)

Please also be aware that some edges like self-referencing edges,
JS engine's internal edges, and hidden edges should not be considered
as part of the retainer trace. These edges could make the retainer trace
unncessarily complex and cause confusion. `isReferenceUsedByDefault` will
be `false` for these types of edges.

* **Examples**:
```javascript
// exclude react fiber references
function retainerReferenceFilter(edge, _snapshot, _isReferenceUsedByDefault) {
  if (edge.name_or_index.toString().startsWith('__reactFiber$')) {
    return false;
  }
  // exclude other references here
  // ...
  return true;
};
```

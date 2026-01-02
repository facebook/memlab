# Interface: IHeapEdge

Defined in: core/src/lib/Types.ts:1662

An `IHeapEdge` instance represents a JS reference in a heap snapshot.
A heap snapshot is generally a graph where graph nodes are JS heap objects
and graph edges are JS references among JS heap objects.

 it is not recommended to modify any `IHeapEdge` instance

* **Examples**: V8 or hermes heap snapshot can be parsed by the
getFullHeapFromFile API.

```typescript
import type {IHeapSnapshot, IHeapEdge} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);

  // iterate over each edge (JS reference in heap)
  heap.edges.forEach((edge: IHeapEdge, i: number) => {
    // use the heap edge APIs here
    const nameOrIndex = edge.name_or_index;
    // ...
  });
})();
```

## Properties

### edgeIndex

> **edgeIndex**: `number`

Defined in: core/src/lib/Types.ts:1670

index of this JS reference inside the `edge.snapshot.edges` pseudo array

***

### fromNode

> **fromNode**: [`IHeapNode`](IHeapNode.md)

Defined in: core/src/lib/Types.ts:1691

returns an [IHeapNode](IHeapNode.md) instance representing the hosting
JS heap object where this reference starts

***

### is\_index

> **is\_index**: `boolean`

Defined in: core/src/lib/Types.ts:1677

if `true`, means this is a reference to an array element
or internal table element (`edge.name_or_index` will return a number),
otherwise this is a reference with a string name (`edge.name_or_index`
will return a string)

***

### name\_or\_index

> **name\_or\_index**: `string` \| `number`

Defined in: core/src/lib/Types.ts:1626

name of the JS reference. If this is a reference to an array element
or internal table element, it is an numeric index

#### Inherited from

`IHeapEdgeBasic.name_or_index`

***

### snapshot

> **snapshot**: [`IHeapSnapshot`](IHeapSnapshot.md)

Defined in: core/src/lib/Types.ts:1666

get the [IHeapSnapshot](IHeapSnapshot.md) containing this JS reference

***

### to\_node

> **to\_node**: `number`

Defined in: core/src/lib/Types.ts:1681

the index of the JS heap object pointed to by this reference

***

### toNode

> **toNode**: [`IHeapNode`](IHeapNode.md)

Defined in: core/src/lib/Types.ts:1686

returns an [IHeapNode](IHeapNode.md) instance representing the JS heap object
pointed to by this reference

***

### type

> **type**: `string`

Defined in: core/src/lib/Types.ts:1631

type of the JS reference, all types:
`context`, `element`, `property`, `internal`, `hidden`, `shortcut`, `weak`

#### Inherited from

`IHeapEdgeBasic.type`

## Methods

### getJSONifyableObject()

> **getJSONifyableObject**(): `AnyRecord`

Defined in: core/src/lib/Types.ts:1699

convert to a concise readable object that can be used for serialization
(like calling `JSON.stringify(node, ...args)`).

This API does not contain all the information
captured by the hosting object.

#### Returns

`AnyRecord`

***

### toJSONString()

> **toJSONString**(...`args`): `string`

Defined in: core/src/lib/Types.ts:1712

convert to a concise readable string output
(like calling `JSON.stringify(node, ...args)`).

Note: Please be aware that using `JSON.stringify(node, ...args)` is
not recommended as it will generate a JSON representation of the host
object that is too large to be easily readable due to its connections
to other parts of the data structures within the heap snapshot.

This API does not completely serialize all the information
captured by the hosting object.

#### Parameters

##### args

...`any`[]

#### Returns

`string`

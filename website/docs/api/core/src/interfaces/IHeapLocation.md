# Interface: IHeapLocation

Defined in: core/src/lib/Types.ts:1576

An `IHeapLocation` instance contains a source location information
associated with a JS heap object.
A heap snapshot is generally a graph where graph nodes are JS heap objects
and graph edges are JS references among JS heap objects.

 it is not recommended to modify any `IHeapLocation` instance

* **Examples**: V8 or hermes heap snapshot can be parsed by the
getFullHeapFromFile API.

```typescript
import type {IHeapSnapshot, IHeapNode, IHeapLocation} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);

  // iterate over each node (heap object)
  heap.nodes.forEach((node: IHeapNode, i: number) => {
    const location: Nullable<IHeapLocation> = node.location;
    if (location) {
      // use the location API here
      location.line;
      // ...
    }
  });
})();
```

## Properties

### column

> **column**: `number`

Defined in: core/src/lib/Types.ts:1596

get the column number

***

### line

> **line**: `number`

Defined in: core/src/lib/Types.ts:1592

get the line number

***

### node

> **node**: [`Nullable`](../type-aliases/Nullable.md)\<[`IHeapNode`](IHeapNode.md)\>

Defined in: core/src/lib/Types.ts:1584

get the heap object this location this location represents

***

### script\_id

> **script\_id**: `number`

Defined in: core/src/lib/Types.ts:1588

get the script ID of the source file

***

### snapshot

> **snapshot**: [`IHeapSnapshot`](IHeapSnapshot.md)

Defined in: core/src/lib/Types.ts:1580

get the [IHeapSnapshot](IHeapSnapshot.md) containing this location instance

## Methods

### getJSONifyableObject()

> **getJSONifyableObject**(): `AnyRecord`

Defined in: core/src/lib/Types.ts:1604

convert to a concise readable object that can be used for serialization
(like calling `JSON.stringify(node, ...args)`).

This API does not contain all the information
captured by the hosting object.

#### Returns

`AnyRecord`

***

### toJSONString()

> **toJSONString**(...`args`): `string`

Defined in: core/src/lib/Types.ts:1617

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

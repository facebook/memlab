---
id: "core_src.IHeapLocation"
title: "Interface: IHeapLocation"
sidebar_label: "IHeapLocation"
custom_edit_url: null
---

An `IHeapLocation` instance contains a source location information
associated with a JS heap object.
A heap snapshot is generally a graph where graph nodes are JS heap objects
and graph edges are JS references among JS heap objects.

**`readonly`** it is not recommended to modify any `IHeapLocation` instance

* **Examples**: V8 or hermes heap snapshot can be parsed by the
[getFullHeapFromFile](../modules/heap_analysis_src.md#getfullheapfromfile) API.

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

### <a id="column" name="column"></a> **column**: `number`

get the column number

 * **Source**:
    * core/src/lib/Types.ts:1293

___

### <a id="line" name="line"></a> **line**: `number`

get the line number

 * **Source**:
    * core/src/lib/Types.ts:1289

___

### <a id="node" name="node"></a> **node**: `Nullable`<[`IHeapNode`](core_src.IHeapNode.md)\>

get the heap object this location this location represents

 * **Source**:
    * core/src/lib/Types.ts:1281

___

### <a id="script\_id" name="script\_id"></a> **script\_id**: `number`

get the script ID of the source file

 * **Source**:
    * core/src/lib/Types.ts:1285

___

### <a id="snapshot" name="snapshot"></a> **snapshot**: [`IHeapSnapshot`](core_src.IHeapSnapshot.md)

get the [IHeapSnapshot](core_src.IHeapSnapshot.md) containing this location instance

 * **Source**:
    * core/src/lib/Types.ts:1277

## Methods

### <a id="tojsonstring"></a>**toJSONString**(...`args`)

convert to a concise readable string output
(like calling `JSON.stringify(node, ...args)`).
Note: calling `JSON.stringify(node, ...args)` will not work
since the string is too large and not readable.

This API does not completely serialize all the information
captured by the hosting object.

 * **Parameters**:
    * `...args`: `any`[]
 * **Returns**: `string`
 * **Source**:
    * core/src/lib/Types.ts:1303

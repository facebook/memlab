---
id: "core_src.IHeapSnapshot"
title: "Interface: IHeapSnapshot"
sidebar_label: "IHeapSnapshot"
custom_edit_url: null
---

A heap snapshot is generally a graph where graph nodes are JS heap objects
and graph edges are JS references among JS heap objects. For more details
on the structure of nodes and edges in the heap graph, check out
[IHeapNode](core_src.IHeapNode.md) and [IHeapEdge](core_src.IHeapEdge.md).

## Properties

### <a id="edges" name="edges"></a> **edges**: [`IHeapEdges`](core_src.IHeapEdges.md)

A pseudo array containing all heap graph edges (references to heap objects
in heap). A JS heap could contain millions of references, so memlab uses
a pseudo array as the collection of all the heap edges. The pseudo
array provides API to query and traverse all heap references.

* **Examples**:
```typescript
import type {IHeapSnapshot, IHeapEdge} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);

  // get the total number of heap references
  heap.edges.length;

  heap.edges.forEach((edge: IHeapEdge) => {
    // traverse each reference in the heap
  });
})();
```

 * **Source**:
    * core/src/lib/Types.ts:1294

___

### <a id="nodes" name="nodes"></a> **nodes**: [`IHeapNodes`](core_src.IHeapNodes.md)

A pseudo array containing all heap graph nodes (JS objects in heap).
A JS heap could contain millions of heap objects, so memlab uses
a pseudo array as the collection of all the heap objects. The pseudo
array provides API to query and traverse all heap objects.

* **Examples**:
```typescript
import type {IHeapSnapshot, IHeapNode} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);

  // get the total number of heap objects
  heap.nodes.length;

  heap.nodes.forEach((node: IHeapNode) => {
    // traverse each heap object
  });
})();
```

 * **Source**:
    * core/src/lib/Types.ts:1268

## Methods

### <a id="getanyobjectwithclassname"></a>**getAnyObjectWithClassName**(`className`)

Search for the heap and get one of the JS object instances with
a specified constructor name (if there is any).

 * **Parameters**:
    * `className`: `string` | The constructor name of the object instance
 * **Returns**: [`Nullable`](../modules/core_src.md#nullable)<[`IHeapNode`](core_src.IHeapNode.md)\> | a handle pointing to any one of the object instances, returns
         `null` if no such object exists in the heap.

* **Examples**:
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import {takeNodeMinimalHeap} from '@memlab/core';

class TestObject {
  public arr1 = [1, 2, 3];
  public arr2 = ['1', '2', '3'];
}

(async function () {
  const obj = new TestObject();
  // get a heap snapshot of the current program state
  const heap: IHeapSnapshot = await takeNodeMinimalHeap();

  const node = heap.getAnyObjectWithClassName('TestObject');
  console.log(node?.name); // should be 'TestObject'
})();
```

 * **Source**:
    * core/src/lib/Types.ts:1435

___

### <a id="getnodebyid"></a>**getNodeById**(`id`)

If you have the id of a heap node (JS object in heap), use this API
to get an [IHeapNode](core_src.IHeapNode.md) associated with the id.

 * **Parameters**:
    * `id`: `number` | id of the heap node (JS object in heap) you would like to query
 * **Returns**: [`Nullable`](../modules/core_src.md#nullable)<[`IHeapNode`](core_src.IHeapNode.md)\> | the API returns `null` if no heap object has the specified id.

* **Examples**:
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);

  const node = heap.getNodeById(351);
  node?.id; // should be 351
})();
```

 * **Source**:
    * core/src/lib/Types.ts:1316

___

### <a id="getnodesbyidset"></a>**getNodesByIdSet**(`ids`)

Given a set of ids of heap nodes (JS objects in heap), use this API
to get a set of those heap nodes.

 * **Parameters**:
    * `ids`: `Set`<`number`\> | id set of the heap nodes (JS objects in heap) you would like to query
 * **Returns**: `Set`<[`IHeapNode`](core_src.IHeapNode.md)\> | a set of those heap nodes. The set will only include
nodes that are found in the heap. If none of the input ids are found,
this API will return an empty set.

* **Examples**:
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);

  // suppose 1000 is not a valid id in the heap
  const set = heap.getNodesByIdSet(new Set([1, 2, 1000, 3]));
  set // should be Set([node1, node2, node3])
})();
```

 * **Source**:
    * core/src/lib/Types.ts:1368

___

### <a id="getnodesbyids"></a>**getNodesByIds**(`ids`)

Given an array of ids of heap nodes (JS objects in heap), use this API
to get an array of those heap nodes.

 * **Parameters**:
    * `ids`: `number`[] | id array of the heap nodes (JS objects in heap) you would like to query
 * **Returns**: [`Nullable`](../modules/core_src.md#nullable)<[`IHeapNode`](core_src.IHeapNode.md)\>[] | an array of those heap nodes. The return array will preserve the
order of the input array. If an id is not found in the heap, the
corresponding element in the return array will be `null`.

* **Examples**:
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);

  // suppose 1000 is not a valid id in the heap
  const nodes = heap.getNodesByIds([1, 2, 1000, 3]);
  nodes // should be [node1, node2, null, node3]
})();
```

 * **Source**:
    * core/src/lib/Types.ts:1342

___

### <a id="hasobjectwithclassname"></a>**hasObjectWithClassName**(`className`)

Search for the heap and check if there is any JS object instance with
a specified constructor name.

 * **Parameters**:
    * `className`: `string` | The constructor name of the object instance
 * **Returns**: `boolean` | `true` if there is at least one such object in the heap

* **Examples**: you can write a jest unit test with memory assertions:
```typescript
// save as example.test.ts
import type {IHeapSnapshot, Nullable} from '@memlab/core';
import {config, takeNodeMinimalHeap} from '@memlab/core';

class TestObject {
  public arr1 = [1, 2, 3];
  public arr2 = ['1', '2', '3'];
}

test('memory test with heap assertion', async () => {
  config.muteConsole = true; // no console output

  let obj: Nullable<TestObject> = new TestObject();
  // get a heap snapshot of the current program state
  let heap: IHeapSnapshot = await takeNodeMinimalHeap();

  // call some function that may add references to obj
  rabbitHole(obj)

  expect(heap.hasObjectWithClassName('TestObject')).toBe(true);
  obj = null;

  heap = await takeNodeMinimalHeap();
  // if rabbitHole does not have any side effect that
  // adds new references to obj, then obj can be GCed
  expect(heap.hasObjectWithClassName('TestObject')).toBe(false);

}, 30000);
```

 * **Source**:
    * core/src/lib/Types.ts:1407

___

### <a id="hasobjectwithpropertyname"></a>**hasObjectWithPropertyName**(`nameOrIndex`)

Search for the heap and check if there is any JS object instance with
a specified property name.

 * **Parameters**:
    * `nameOrIndex`: `string` \| `number` | The property name (string) or element index (number) on the object instance
 * **Returns**: `boolean` | returns `true` if there is at least one such object in the heap

* **Examples**:
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const object = {'memlab-test-heap-property': 'memlab-test-heap-value'};

  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);

  // should be true
  console.log(heap.hasObjectWithPropertyName('memlab-test-heap-property'));
})();
```

 * **Source**:
    * core/src/lib/Types.ts:1461

___

### <a id="hasobjectwithtag"></a>**hasObjectWithTag**(`tag`)

Search for the heap and check if there is any JS object instance with
a marker tagged by [tagObject](../modules/core_src.md#tagobject).

The `tagObject` API does not modify the object instance in any way
(e.g., no additional or hidden properties added to the tagged object).

 * **Parameters**:
    * `tag`: `string` | marker name on the object instances tagged by [tagObject](../modules/core_src.md#tagobject)
 * **Returns**: `boolean` | returns `true` if there is at least one such object in the heap

```typescript
import type {IHeapSnapshot, AnyValue} from '@memlab/core';
import {config, takeNodeMinimalHeap, tagObject} from '@memlab/core';

test('memory test', async () => {
  config.muteConsole = true;
  const o1: AnyValue = {};
  let o2: AnyValue = {};

  // tag o1 with marker: "memlab-mark-1", does not modify o1 in any way
  tagObject(o1, 'memlab-mark-1');
  // tag o2 with marker: "memlab-mark-2", does not modify o2 in any way
  tagObject(o2, 'memlab-mark-2');

  o2 = null;

  const heap: IHeapSnapshot = await takeNodeMinimalHeap();

  // expect object with marker "memlab-mark-1" exists
  expect(heap.hasObjectWithTag('memlab-mark-1')).toBe(true);

  // expect object with marker "memlab-mark-2" can be GCed
  expect(heap.hasObjectWithTag('memlab-mark-2')).toBe(false);

}, 30000);
```

 * **Source**:
    * core/src/lib/Types.ts:1499

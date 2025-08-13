---
id: "core_src.IHeapNode"
title: "Interface: IHeapNode"
sidebar_label: "IHeapNode"
custom_edit_url: null
---

An `IHeapNode` instance represents a JS heap object in a heap snapshot.
A heap snapshot is generally a graph where graph nodes are JS heap objects
and graph edges are JS references among JS heap objects.

**`readonly`** it is not recommended to modify any `IHeapNode` instance

* **Examples**: V8 or hermes heap snapshot can be parsed by the
[getFullHeapFromFile](../modules/heap_analysis_src.md#getfullheapfromfile) API.

```typescript
import type {IHeapSnapshot, IHeapNode} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);

  // iterate over each node (heap object)
  heap.nodes.forEach((node: IHeapNode, i: number) => {
    // use the heap node APIs here
    const id = node.id;
    const type = node.type;
    // ...
  });
})();
```

## Hierarchy

- `IHeapNodeBasic`

  ↳ **`IHeapNode`**

  ↳↳ [`IHeapStringNode`](core_src.IHeapStringNode.md)

## Properties

### <a id="dominatornode" name="dominatornode"></a> **dominatorNode**: [`Nullable`](../modules/core_src.md#nullable)<[`IHeapNode`](core_src.IHeapNode.md)\>

Gets the dominator node of this node. If the dominator node gets released
there will be no path from GC to this node, and therefore this node can
also be released.
For more information on what a dominator node is, please check out
[this doc](https://developer.chrome.com/docs/devtools/memory-problems/memory-101/#dominators).

 * **Source**:
    * core/src/lib/Types.ts:1905

___

### <a id="edge\_count" name="edge\_count"></a> **edge\_count**: `number`

The total number of outgoing JS references (including engine-internal,
native, and JS references).

 * **Source**:
    * core/src/lib/Types.ts:1859

___

### <a id="haspathedge" name="haspathedge"></a> **hasPathEdge**: `boolean`

Returns true if the heap node has been set an incoming edge
which leads to the parent node on the shortest path to GC root.

 * **Source**:
    * core/src/lib/Types.ts:1881

___

### <a id="id" name="id"></a> **id**: `number`

Unique id of the heap object.

 * **Source**:
    * core/src/lib/Types.ts:1787

___

### <a id="isstring" name="isstring"></a> **isString**: `boolean`

Checks if this is a string node (normal string node, concatenated string node
or sliced string node).

 * **Source**:
    * core/src/lib/Types.ts:1917

___

### <a id="is\_detached" name="is\_detached"></a> **is\_detached**: `boolean`

* If the heap object is a DOM element and the DOM element is detached
from the DOM tree, `is_detached` will be `true`;
* If the heap object is a React Fiber node and the Fiber node is unmounted
from the React Fiber tree, `is_detached` will be `true`;
otherwise it will be `false`.

 * **Source**:
    * core/src/lib/Types.ts:1841

___

### <a id="location" name="location"></a> **location**: [`Nullable`](../modules/core_src.md#nullable)<[`IHeapLocation`](core_src.IHeapLocation.md)\>

Source location information of this heap object (if it is recorded by
the heap snapshot).

 * **Source**:
    * core/src/lib/Types.ts:1910

___

### <a id="name" name="name"></a> **name**: `string`

This is the `name` field associated with the heap object.
For JS object instances (type `object`), `name` is the constructor's name
of the object instance. For `string`, `name` is the string value.

 * **Source**:
    * core/src/lib/Types.ts:1783

___

### <a id="nodeindex" name="nodeindex"></a> **nodeIndex**: `number`

Index of this heap object inside the `node.snapshot.nodes` pseudo array.

 * **Source**:
    * core/src/lib/Types.ts:1890

___

### <a id="numofreferrers" name="numofreferrers"></a> **numOfReferrers**: `number`

Gets the number of all incoming references pointing to this heap object
(including engine-internal, native, and JS references).

 * **Source**:
    * core/src/lib/Types.ts:1876

___

### <a id="pathedge" name="pathedge"></a> **pathEdge**: ``null`` \| [`IHeapEdge`](core_src.IHeapEdge.md)

The incoming edge which leads to the parent node
on the shortest path to GC root.

 * **Source**:
    * core/src/lib/Types.ts:1886

___

### <a id="references" name="references"></a> **references**: [`IHeapEdge`](core_src.IHeapEdge.md)[]

Gets a JS array containing all outgoing JS references from this heap object
(including engine-internal, native, and JS references).

 * **Source**:
    * core/src/lib/Types.ts:1866

___

### <a id="referrers" name="referrers"></a> **referrers**: [`IHeapEdge`](core_src.IHeapEdge.md)[]

Gets a JS array containing all incoming JS references pointing to this heap
object (including engine-internal, native, and JS references).

 * **Source**:
    * core/src/lib/Types.ts:1871

___

### <a id="retainedsize" name="retainedsize"></a> **retainedSize**: `number`

The *retained size* of the heap object (i.e., the total size of memory that
could be released if this object is released). For difference between
**retained size** and **shallow size**, check out
[this doc](https://developer.chrome.com/docs/devtools/memory-problems/memory-101/#object_sizes).

 * **Source**:
    * core/src/lib/Types.ts:1897

___

### <a id="self\_size" name="self\_size"></a> **self\_size**: `number`

The *shallow size* of the heap object (i.e., the size of memory that is held
by the object itself). For difference between **shallow size** and
**retained size**, check out
[this doc](https://developer.chrome.com/docs/devtools/memory-problems/memory-101/#object_sizes).

 * **Source**:
    * core/src/lib/Types.ts:1854

___

### <a id="snapshot" name="snapshot"></a> **snapshot**: [`IHeapSnapshot`](core_src.IHeapSnapshot.md)

Gets the [IHeapSnapshot](core_src.IHeapSnapshot.md) containing this heap object.

 * **Source**:
    * core/src/lib/Types.ts:1833

___

### <a id="type" name="type"></a> **type**: `string`

The type of the heap node object. All possible types:
This is engine-specific, for example all types in V8:
`hidden`, `array`, `string`, `object`, `code`, `closure`, `regexp`,
`number`, `native`, `synthetic`, `concatenated string`, `sliced string`,
`symbol`, `bigint`

 * **Source**:
    * core/src/lib/Types.ts:1777

## Methods

### <a id="findanyreference"></a>**findAnyReference**(`predicate`)

Executes a provided predicate callback once for each JavaScript reference
in the hosting node (or outgoing edges from the node) until the predicate
returns `true`.

 * **Parameters**:
    * `predicate`: [`Predicator`](../modules/core_src.md#predicator)<[`IHeapEdge`](core_src.IHeapEdge.md)\> | the callback for each outgoing JavaScript reference
 * **Returns**: [`Nullable`](../modules/core_src.md#nullable)<[`IHeapEdge`](core_src.IHeapEdge.md)\> | the first outgoing edge for which the predicate returns `true`,
otherwise returns `null` if no such edge is found.

* **Examples**:
```typescript
const reference = node.findAnyReference((edge: IHeapEdge) => {
  // find the outgoing reference with name "ref"
  return edge.name_or_index === 'ref';
});
```

 * **Source**:
    * core/src/lib/Types.ts:1997

___

### <a id="findanyreferrer"></a>**findAnyReferrer**(`predicate`)

Executes a provided predicate callback once for each JavaScript reference
pointing to the hosting node (or incoming edges to the node) until the
predicate returns `true`.

 * **Parameters**:
    * `predicate`: [`Predicator`](../modules/core_src.md#predicator)<[`IHeapEdge`](core_src.IHeapEdge.md)\> | the callback for each incoming JavaScript reference
 * **Returns**: [`Nullable`](../modules/core_src.md#nullable)<[`IHeapEdge`](core_src.IHeapEdge.md)\> | the first incoming edge for which the predicate returns `true`,
otherwise returns `null` if no such edge is found.

* **Examples**:
```typescript
const referrer = node.findAnyReferrer((edge: IHeapEdge) => {
  // find the incoming reference with name "ref"
  return edge.name_or_index === 'ref';
});
```

 * **Source**:
    * core/src/lib/Types.ts:2014

___

### <a id="findanyreferrernode"></a>**findAnyReferrerNode**(`predicate`)

Executes a provided predicate callback once for each JavaScript heap
object (heap graph node) pointing to the hosting node
(or nodes having edges to the hosting node) until the predicate
returns `true`.

 * **Parameters**:
    * `predicate`: [`Predicator`](../modules/core_src.md#predicator)<[`IHeapNode`](core_src.IHeapNode.md)\> | the callback for each incoming JavaScript heap object
 * **Returns**: [`Nullable`](../modules/core_src.md#nullable)<[`IHeapNode`](core_src.IHeapNode.md)\> | the first referring node for which the predicate returns `true`,
otherwise returns `null` if no such node is found.

* **Examples**:
```typescript
const referrer = node.findAnyReferrerNode((node: IHeapNode) => {
  // find the referring node with name "Parent"
  return node.name === 'Parent';
});
```

 * **Source**:
    * core/src/lib/Types.ts:2032

___

### <a id="findreferrernodes"></a>**findReferrerNodes**(`predicate`)

Executes a provided predicate callback once for each JavaScript heap
object (heap graph node) pointing to the hosting node
(or nodes having edges to the hosting node).

 * **Parameters**:
    * `predicate`: [`Predicator`](../modules/core_src.md#predicator)<[`IHeapNode`](core_src.IHeapNode.md)\> | the callback for each referrer nodes
 * **Returns**: [`IHeapNode`](core_src.IHeapNode.md)[] | an array containing all the referrer nodes for which the
predicate returns `true`, otherwise returns an empty array if no such
node is found.

* **Examples**:
```typescript
const referrerNodes = node.findReferrerNodes((node: IHeapNode) => {
  // find all the referring nodes with name "Parent"
  return node.name === 'Parent';
});
```

 * **Source**:
    * core/src/lib/Types.ts:2067

___

### <a id="findreferrers"></a>**findReferrers**(`predicate`)

Executes a provided predicate callback once for each JavaScript reference
pointing to the hosting node (or incoming edges to the node).

 * **Parameters**:
    * `predicate`: [`Predicator`](../modules/core_src.md#predicator)<[`IHeapEdge`](core_src.IHeapEdge.md)\> | the callback for each incoming JavaScript reference
 * **Returns**: [`IHeapEdge`](core_src.IHeapEdge.md)[] | an array containing all the incoming edges for which the
predicate returns `true`, otherwise returns an empty array if no such
edge is found.

* **Examples**:
```typescript
const referrers = node.findReferrers((edge: IHeapEdge) => {
  // find all the incoming references with name "ref"
  return edge.name_or_index === 'ref';
});
```

 * **Source**:
    * core/src/lib/Types.ts:2049

___

### <a id="foreachreference"></a>**forEachReference**(`callback`)

Executes a provided callback once for each JavaScript reference in the
hosting node (or outgoing edges from the node).

 * **Parameters**:
    * `callback`: [`EdgeIterationCallback`](../modules/core_src.md#edgeiterationcallback) | the callback for each outgoing JavaScript reference
 * **Returns**: `void` | this API returns void

* **Examples**:
```typescript
node.forEachReference((edge: IHeapEdge) => {
  // process edge ...

  // if no need to iterate over remaining edges after
  // the current edge in the node.references list
  return {stop: true};
});
```

 * **Source**:
    * core/src/lib/Types.ts:1962

___

### <a id="foreachreferrer"></a>**forEachReferrer**(`callback`)

Executes a provided callback once for each JavaScript reference pointing
to the hosting node (or incoming edges to the node).

 * **Parameters**:
    * `callback`: [`EdgeIterationCallback`](../modules/core_src.md#edgeiterationcallback) | the callback for each incoming JavaScript reference
 * **Returns**: `void` | this API returns void

* **Examples**:
```typescript
node.forEachReferrer((edge: IHeapEdge) => {
  // process edge ...

  // if no need to iterate over remaining edges after
  // the current edge in the node.referrers list
  return {stop: true};
});
```

 * **Source**:
    * core/src/lib/Types.ts:1980

___

### <a id="getanyreferrer"></a>**getAnyReferrer**(`edgeName`, `edgeType?`)

Given a JS reference's name and type, this API finds an incoming JS
reference pointing to the hosting node.

 * **Parameters**:
    * `edgeName`: `string` \| `number` | the name of the incoming JavaScript reference
    * `edgeType?`: `string` | optional parameter specifying the type of the incoming JavaScript reference
 * **Returns**: [`Nullable`](../modules/core_src.md#nullable)<[`IHeapEdge`](core_src.IHeapEdge.md)\> | the incoming edge that meets the specification

* **Examples**:
```typescript
// find one of the JS reference named "ref" pointing to node
const reference = node.getAnyReferrer('ref', 'property');
```

 * **Source**:
    * core/src/lib/Types.ts:2122

___

### <a id="getanyreferrernode"></a>**getAnyReferrerNode**(`edgeName`, `edgeType?`)

Given a JS reference's name and type, this API finds one of the incoming JS
references pointing to the hosting node, and returns the JS heap object
containing the incoming reference.

 * **Parameters**:
    * `edgeName`: `string` \| `number` | the name of the incoming JavaScript reference
    * `edgeType?`: `string` | optional parameter specifying the type of the incoming JavaScript reference
 * **Returns**: [`Nullable`](../modules/core_src.md#nullable)<[`IHeapNode`](core_src.IHeapNode.md)\> | the node containing the incoming JS reference that meets
the specification

* **Examples**:
```typescript
// find one of the JS heap object with a JS reference
// named "ref" pointing to node
const n1 = node.getAnyReferrerNode('ref', 'property');
// this is equivalent to
const n2 = node.getAnyReferrer('ref', 'property')?.fromNode;
```

 * **Source**:
    * core/src/lib/Types.ts:2145

___

### <a id="getjsonifyableobject"></a>**getJSONifyableObject**()

Converts to a concise readable object that can be used for serialization
(like calling `JSON.stringify(node, ...args)`).

This API does not contain all the information
captured by the hosting object.

 * **Returns**: `AnyRecord`
 * **Source**:
    * core/src/lib/Types.ts:1931

___

### <a id="getreference"></a>**getReference**(`edgeName`, `edgeType?`)

Given a JS reference's name and type, this API finds an outgoing JS
reference from the hosting node.

 * **Parameters**:
    * `edgeName`: `string` \| `number` | the name of the outgoing JavaScript reference
    * `edgeType?`: `string` | optional parameter specifying the type of the outgoing JavaScript reference
 * **Returns**: [`Nullable`](../modules/core_src.md#nullable)<[`IHeapEdge`](core_src.IHeapEdge.md)\> | the outgoing edge that meets the specification

* **Examples**:
```typescript
// find the internal reference to node's hidden class
const reference = node.getReference('map', 'hidden');
```

 * **Source**:
    * core/src/lib/Types.ts:2082

___

### <a id="getreferencenode"></a>**getReferenceNode**(`edgeName`, `edgeType?`)

Given a JS reference's name and type, this API finds the outgoing JS
reference from the hosting node, and returns the JS heap object pointed to
by the outgoing JS reference.

 * **Parameters**:
    * `edgeName`: `string` \| `number` | the name of the outgoing JavaScript reference
    * `edgeType?`: `string` | optional parameter specifying the type of the outgoing JavaScript reference
 * **Returns**: [`Nullable`](../modules/core_src.md#nullable)<[`IHeapNode`](core_src.IHeapNode.md)\> | the node pointed to by the outgoing reference that meets
the specification

* **Examples**:
```typescript
// find the node's hidden class
const hiddenClassNode = node.getReferenceNode('map', 'hidden');
// this is equivalent to
const hiddenClassNode2 = node.getReference('map', 'hidden')?.toNode;
```

 * **Source**:
    * core/src/lib/Types.ts:2104

___

### <a id="getreferrernodes"></a>**getReferrerNodes**(`edgeName`, `edgeType?`)

Given a JS reference's name and type, this API finds all of the incoming JS
references pointing to the hosting node, and returns an array containing
the hosting node for each of the incoming JS references.

 * **Parameters**:
    * `edgeName`: `string` \| `number` | the name of the incoming JavaScript reference
    * `edgeType?`: `string` | optional parameter specifying the type of the incoming JavaScript reference
 * **Returns**: [`IHeapNode`](core_src.IHeapNode.md)[] | an array containing the hosting nodes, with each node corresponds
to each incoming JS reference that meets the specification

* **Examples**:
```typescript
// find all of the JS heap objects with a JS reference
// named "ref" pointing to node
const nodes1 = node.getReferrerNodes('ref', 'property');
// this is equivalent to
const nodes2 = node.getReferrers('ref', 'property')
  .map(edge => edge.fromNode);
```

 * **Source**:
    * core/src/lib/Types.ts:2185

___

### <a id="getreferrers"></a>**getReferrers**(`edgeName`, `edgeType?`)

Given a JS reference's name and type, this API finds all the incoming JS
references pointing to the hosting node.

 * **Parameters**:
    * `edgeName`: `string` \| `number` | the name of the incoming JavaScript reference
    * `edgeType?`: `string` | optional parameter specifying the type of the incoming JavaScript reference
 * **Returns**: [`IHeapEdge`](core_src.IHeapEdge.md)[] | an array containing all the incoming edges that
meet the specification

* **Examples**:
```typescript
// find all of the JS references named "ref" pointing to node
const referrers = node.getReferrers('ref', 'property');
```

 * **Source**:
    * core/src/lib/Types.ts:2164

___

### <a id="tojsonstring"></a>**toJSONString**(...`args`)

Converts to a concise readable string output
(like calling `JSON.stringify(node, ...args)`).

Note: Please be aware that using `JSON.stringify(node, ...args)` is
not recommended as it will generate a JSON representation of the host
object that is too large to be easily readable due to its connections
to other parts of the data structures within the heap snapshot.

This API does not completely serialize all the information
captured by the hosting object.

 * **Parameters**:
    * `...args`: `any`[]
 * **Returns**: `string`
 * **Source**:
    * core/src/lib/Types.ts:1944

___

### <a id="tostringnode"></a>**toStringNode**()

Converts to an [IHeapStringNode](core_src.IHeapStringNode.md) object if this node is a string node.
The [IHeapStringNode](core_src.IHeapStringNode.md) object supports querying the string content
inside the string node.

 * **Returns**: [`Nullable`](../modules/core_src.md#nullable)<[`IHeapStringNode`](core_src.IHeapStringNode.md)\>
 * **Source**:
    * core/src/lib/Types.ts:1923

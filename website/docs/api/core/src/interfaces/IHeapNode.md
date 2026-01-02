# Interface: IHeapNode

Defined in: core/src/lib/Types.ts:1829

An `IHeapNode` instance represents a JS heap object in a heap snapshot.
A heap snapshot is generally a graph where graph nodes are JS heap objects
and graph edges are JS references among JS heap objects.

 it is not recommended to modify any `IHeapNode` instance

* **Examples**: V8 or hermes heap snapshot can be parsed by the
getFullHeapFromFile API.

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

## Extended by

- [`IHeapStringNode`](IHeapStringNode.md)

## Properties

### dominatorNode

> **dominatorNode**: [`Nullable`](../type-aliases/Nullable.md)\<`IHeapNode`\>

Defined in: core/src/lib/Types.ts:1905

Gets the dominator node of this node. If the dominator node gets released
there will be no path from GC to this node, and therefore this node can
also be released.
For more information on what a dominator node is, please check out
[this doc](https://developer.chrome.com/docs/devtools/memory-problems/memory-101/#dominators).

***

### edge\_count

> **edge\_count**: `number`

Defined in: core/src/lib/Types.ts:1859

The total number of outgoing JS references (including engine-internal,
native, and JS references).

***

### findAnyReference()

> **findAnyReference**: (`predicate`) => [`Nullable`](../type-aliases/Nullable.md)\<[`IHeapEdge`](IHeapEdge.md)\>

Defined in: core/src/lib/Types.ts:1997

Executes a provided predicate callback once for each JavaScript reference
in the hosting node (or outgoing edges from the node) until the predicate
returns `true`.

#### Parameters

##### predicate

[`Predicator`](../type-aliases/Predicator.md)\<[`IHeapEdge`](IHeapEdge.md)\>

the callback for each outgoing JavaScript reference

#### Returns

[`Nullable`](../type-aliases/Nullable.md)\<[`IHeapEdge`](IHeapEdge.md)\>

the first outgoing edge for which the predicate returns `true`,
otherwise returns `null` if no such edge is found.

* **Examples**:
```typescript
const reference = node.findAnyReference((edge: IHeapEdge) => {
  // find the outgoing reference with name "ref"
  return edge.name_or_index === 'ref';
});
```

***

### findAnyReferrer()

> **findAnyReferrer**: (`predicate`) => [`Nullable`](../type-aliases/Nullable.md)\<[`IHeapEdge`](IHeapEdge.md)\>

Defined in: core/src/lib/Types.ts:2014

Executes a provided predicate callback once for each JavaScript reference
pointing to the hosting node (or incoming edges to the node) until the
predicate returns `true`.

#### Parameters

##### predicate

[`Predicator`](../type-aliases/Predicator.md)\<[`IHeapEdge`](IHeapEdge.md)\>

the callback for each incoming JavaScript reference

#### Returns

[`Nullable`](../type-aliases/Nullable.md)\<[`IHeapEdge`](IHeapEdge.md)\>

the first incoming edge for which the predicate returns `true`,
otherwise returns `null` if no such edge is found.

* **Examples**:
```typescript
const referrer = node.findAnyReferrer((edge: IHeapEdge) => {
  // find the incoming reference with name "ref"
  return edge.name_or_index === 'ref';
});
```

***

### findReferrerNodes()

> **findReferrerNodes**: (`predicate`) => `IHeapNode`[]

Defined in: core/src/lib/Types.ts:2067

Executes a provided predicate callback once for each JavaScript heap
object (heap graph node) pointing to the hosting node
(or nodes having edges to the hosting node).

#### Parameters

##### predicate

[`Predicator`](../type-aliases/Predicator.md)\<`IHeapNode`\>

the callback for each referrer nodes

#### Returns

`IHeapNode`[]

an array containing all the referrer nodes for which the
predicate returns `true`, otherwise returns an empty array if no such
node is found.

* **Examples**:
```typescript
const referrerNodes = node.findReferrerNodes((node: IHeapNode) => {
  // find all the referring nodes with name "Parent"
  return node.name === 'Parent';
});
```

***

### findReferrers()

> **findReferrers**: (`predicate`) => [`IHeapEdge`](IHeapEdge.md)[]

Defined in: core/src/lib/Types.ts:2049

Executes a provided predicate callback once for each JavaScript reference
pointing to the hosting node (or incoming edges to the node).

#### Parameters

##### predicate

[`Predicator`](../type-aliases/Predicator.md)\<[`IHeapEdge`](IHeapEdge.md)\>

the callback for each incoming JavaScript reference

#### Returns

[`IHeapEdge`](IHeapEdge.md)[]

an array containing all the incoming edges for which the
predicate returns `true`, otherwise returns an empty array if no such
edge is found.

* **Examples**:
```typescript
const referrers = node.findReferrers((edge: IHeapEdge) => {
  // find all the incoming references with name "ref"
  return edge.name_or_index === 'ref';
});
```

***

### getAnyReferrer()

> **getAnyReferrer**: (`edgeName`, `edgeType?`) => [`Nullable`](../type-aliases/Nullable.md)\<[`IHeapEdge`](IHeapEdge.md)\>

Defined in: core/src/lib/Types.ts:2122

Given a JS reference's name and type, this API finds an incoming JS
reference pointing to the hosting node.

#### Parameters

##### edgeName

the name of the incoming JavaScript reference

`string` | `number`

##### edgeType?

`string`

optional parameter specifying the type of the incoming
JavaScript reference

#### Returns

[`Nullable`](../type-aliases/Nullable.md)\<[`IHeapEdge`](IHeapEdge.md)\>

the incoming edge that meets the specification

* **Examples**:
```typescript
// find one of the JS reference named "ref" pointing to node
const reference = node.getAnyReferrer('ref', 'property');
```

***

### getAnyReferrerNode()

> **getAnyReferrerNode**: (`edgeName`, `edgeType?`) => [`Nullable`](../type-aliases/Nullable.md)\<`IHeapNode`\>

Defined in: core/src/lib/Types.ts:2145

Given a JS reference's name and type, this API finds one of the incoming JS
references pointing to the hosting node, and returns the JS heap object
containing the incoming reference.

#### Parameters

##### edgeName

the name of the incoming JavaScript reference

`string` | `number`

##### edgeType?

`string`

optional parameter specifying the type of the incoming
JavaScript reference

#### Returns

[`Nullable`](../type-aliases/Nullable.md)\<`IHeapNode`\>

the node containing the incoming JS reference that meets
the specification

* **Examples**:
```typescript
// find one of the JS heap object with a JS reference
// named "ref" pointing to node
const n1 = node.getAnyReferrerNode('ref', 'property');
// this is equivalent to
const n2 = node.getAnyReferrer('ref', 'property')?.fromNode;
```

***

### getReference()

> **getReference**: (`edgeName`, `edgeType?`) => [`Nullable`](../type-aliases/Nullable.md)\<[`IHeapEdge`](IHeapEdge.md)\>

Defined in: core/src/lib/Types.ts:2082

Given a JS reference's name and type, this API finds an outgoing JS
reference from the hosting node.

#### Parameters

##### edgeName

the name of the outgoing JavaScript reference

`string` | `number`

##### edgeType?

`string`

optional parameter specifying the type of the outgoing
JavaScript reference

#### Returns

[`Nullable`](../type-aliases/Nullable.md)\<[`IHeapEdge`](IHeapEdge.md)\>

the outgoing edge that meets the specification

* **Examples**:
```typescript
// find the internal reference to node's hidden class
const reference = node.getReference('map', 'hidden');
```

***

### getReferenceNode()

> **getReferenceNode**: (`edgeName`, `edgeType?`) => [`Nullable`](../type-aliases/Nullable.md)\<`IHeapNode`\>

Defined in: core/src/lib/Types.ts:2104

Given a JS reference's name and type, this API finds the outgoing JS
reference from the hosting node, and returns the JS heap object pointed to
by the outgoing JS reference.

#### Parameters

##### edgeName

the name of the outgoing JavaScript reference

`string` | `number`

##### edgeType?

`string`

optional parameter specifying the type of the outgoing
JavaScript reference

#### Returns

[`Nullable`](../type-aliases/Nullable.md)\<`IHeapNode`\>

the node pointed to by the outgoing reference that meets
the specification

* **Examples**:
```typescript
// find the node's hidden class
const hiddenClassNode = node.getReferenceNode('map', 'hidden');
// this is equivalent to
const hiddenClassNode2 = node.getReference('map', 'hidden')?.toNode;
```

***

### getReferrerNodes()

> **getReferrerNodes**: (`edgeName`, `edgeType?`) => `IHeapNode`[]

Defined in: core/src/lib/Types.ts:2185

Given a JS reference's name and type, this API finds all of the incoming JS
references pointing to the hosting node, and returns an array containing
the hosting node for each of the incoming JS references.

#### Parameters

##### edgeName

the name of the incoming JavaScript reference

`string` | `number`

##### edgeType?

`string`

optional parameter specifying the type of the incoming
JavaScript reference

#### Returns

`IHeapNode`[]

an array containing the hosting nodes, with each node corresponds
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

***

### getReferrers()

> **getReferrers**: (`edgeName`, `edgeType?`) => [`IHeapEdge`](IHeapEdge.md)[]

Defined in: core/src/lib/Types.ts:2164

Given a JS reference's name and type, this API finds all the incoming JS
references pointing to the hosting node.

#### Parameters

##### edgeName

the name of the incoming JavaScript reference

`string` | `number`

##### edgeType?

`string`

optional parameter specifying the type of the incoming
JavaScript reference

#### Returns

[`IHeapEdge`](IHeapEdge.md)[]

an array containing all the incoming edges that
meet the specification

* **Examples**:
```typescript
// find all of the JS references named "ref" pointing to node
const referrers = node.getReferrers('ref', 'property');
```

***

### hasPathEdge

> **hasPathEdge**: `boolean`

Defined in: core/src/lib/Types.ts:1881

Returns true if the heap node has been set an incoming edge
which leads to the parent node on the shortest path to GC root.

***

### id

> **id**: `number`

Defined in: core/src/lib/Types.ts:1787

Unique id of the heap object.

#### Inherited from

`IHeapNodeBasic.id`

***

### is\_detached

> **is\_detached**: `boolean`

Defined in: core/src/lib/Types.ts:1841

* If the heap object is a DOM element and the DOM element is detached
from the DOM tree, `is_detached` will be `true`;
* If the heap object is a React Fiber node and the Fiber node is unmounted
from the React Fiber tree, `is_detached` will be `true`;
otherwise it will be `false`.

***

### isString

> **isString**: `boolean`

Defined in: core/src/lib/Types.ts:1917

Checks if this is a string node (normal string node, concatenated string node
or sliced string node).

***

### location

> **location**: [`Nullable`](../type-aliases/Nullable.md)\<[`IHeapLocation`](IHeapLocation.md)\>

Defined in: core/src/lib/Types.ts:1910

Source location information of this heap object (if it is recorded by
the heap snapshot).

***

### name

> **name**: `string`

Defined in: core/src/lib/Types.ts:1783

This is the `name` field associated with the heap object.
For JS object instances (type `object`), `name` is the constructor's name
of the object instance. For `string`, `name` is the string value.

#### Inherited from

`IHeapNodeBasic.name`

***

### nodeIndex

> **nodeIndex**: `number`

Defined in: core/src/lib/Types.ts:1890

Index of this heap object inside the `node.snapshot.nodes` pseudo array.

***

### numOfReferrers

> **numOfReferrers**: `number`

Defined in: core/src/lib/Types.ts:1876

Gets the number of all incoming references pointing to this heap object
(including engine-internal, native, and JS references).

***

### pathEdge

> **pathEdge**: [`IHeapEdge`](IHeapEdge.md) \| `null`

Defined in: core/src/lib/Types.ts:1886

The incoming edge which leads to the parent node
on the shortest path to GC root.

***

### references

> **references**: [`IHeapEdge`](IHeapEdge.md)[]

Defined in: core/src/lib/Types.ts:1866

Gets a JS array containing all outgoing JS references from this heap object
(including engine-internal, native, and JS references).

***

### referrers

> **referrers**: [`IHeapEdge`](IHeapEdge.md)[]

Defined in: core/src/lib/Types.ts:1871

Gets a JS array containing all incoming JS references pointing to this heap
object (including engine-internal, native, and JS references).

***

### retainedSize

> **retainedSize**: `number`

Defined in: core/src/lib/Types.ts:1897

The *retained size* of the heap object (i.e., the total size of memory that
could be released if this object is released). For difference between
**retained size** and **shallow size**, check out
[this doc](https://developer.chrome.com/docs/devtools/memory-problems/memory-101/#object_sizes).

***

### self\_size

> **self\_size**: `number`

Defined in: core/src/lib/Types.ts:1854

The *shallow size* of the heap object (i.e., the size of memory that is held
by the object itself). For difference between **shallow size** and
**retained size**, check out
[this doc](https://developer.chrome.com/docs/devtools/memory-problems/memory-101/#object_sizes).

***

### snapshot

> **snapshot**: [`IHeapSnapshot`](IHeapSnapshot.md)

Defined in: core/src/lib/Types.ts:1833

Gets the [IHeapSnapshot](IHeapSnapshot.md) containing this heap object.

***

### type

> **type**: `string`

Defined in: core/src/lib/Types.ts:1777

The type of the heap node object. All possible types:
This is engine-specific, for example all types in V8:
`hidden`, `array`, `string`, `object`, `code`, `closure`, `regexp`,
`number`, `native`, `synthetic`, `concatenated string`, `sliced string`,
`symbol`, `bigint`

#### Inherited from

`IHeapNodeBasic.type`

## Methods

### findAnyReferrerNode()

> **findAnyReferrerNode**(`predicate`): [`Nullable`](../type-aliases/Nullable.md)\<`IHeapNode`\>

Defined in: core/src/lib/Types.ts:2032

Executes a provided predicate callback once for each JavaScript heap
object (heap graph node) pointing to the hosting node
(or nodes having edges to the hosting node) until the predicate
returns `true`.

#### Parameters

##### predicate

[`Predicator`](../type-aliases/Predicator.md)\<`IHeapNode`\>

the callback for each incoming JavaScript heap object

#### Returns

[`Nullable`](../type-aliases/Nullable.md)\<`IHeapNode`\>

the first referring node for which the predicate returns `true`,
otherwise returns `null` if no such node is found.

* **Examples**:
```typescript
const referrer = node.findAnyReferrerNode((node: IHeapNode) => {
  // find the referring node with name "Parent"
  return node.name === 'Parent';
});
```

***

### forEachReference()

> **forEachReference**(`callback`): `void`

Defined in: core/src/lib/Types.ts:1962

Executes a provided callback once for each JavaScript reference in the
hosting node (or outgoing edges from the node).

#### Parameters

##### callback

[`EdgeIterationCallback`](../type-aliases/EdgeIterationCallback.md)

the callback for each outgoing JavaScript reference

#### Returns

`void`

this API returns void

* **Examples**:
```typescript
node.forEachReference((edge: IHeapEdge) => {
  // process edge ...

  // if no need to iterate over remaining edges after
  // the current edge in the node.references list
  return {stop: true};
});
```

***

### forEachReferrer()

> **forEachReferrer**(`callback`): `void`

Defined in: core/src/lib/Types.ts:1980

Executes a provided callback once for each JavaScript reference pointing
to the hosting node (or incoming edges to the node).

#### Parameters

##### callback

[`EdgeIterationCallback`](../type-aliases/EdgeIterationCallback.md)

the callback for each incoming JavaScript reference

#### Returns

`void`

this API returns void

* **Examples**:
```typescript
node.forEachReferrer((edge: IHeapEdge) => {
  // process edge ...

  // if no need to iterate over remaining edges after
  // the current edge in the node.referrers list
  return {stop: true};
});
```

***

### getJSONifyableObject()

> **getJSONifyableObject**(): `AnyRecord`

Defined in: core/src/lib/Types.ts:1931

Converts to a concise readable object that can be used for serialization
(like calling `JSON.stringify(node, ...args)`).

This API does not contain all the information
captured by the hosting object.

#### Returns

`AnyRecord`

***

### toJSONString()

> **toJSONString**(...`args`): `string`

Defined in: core/src/lib/Types.ts:1944

Converts to a concise readable string output
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

***

### toStringNode()

> **toStringNode**(): [`Nullable`](../type-aliases/Nullable.md)\<[`IHeapStringNode`](IHeapStringNode.md)\>

Defined in: core/src/lib/Types.ts:1923

Converts to an [IHeapStringNode](IHeapStringNode.md) object if this node is a string node.
The [IHeapStringNode](IHeapStringNode.md) object supports querying the string content
inside the string node.

#### Returns

[`Nullable`](../type-aliases/Nullable.md)\<[`IHeapStringNode`](IHeapStringNode.md)\>

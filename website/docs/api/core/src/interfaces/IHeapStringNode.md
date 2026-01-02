# Interface: IHeapStringNode

Defined in: core/src/lib/Types.ts:2221

An `IHeapStringNode` instance represents a JS string in a heap snapshot.
A heap snapshot is generally a graph where graph nodes are JS heap objects
and graph edges are JS references among JS heap objects.

 it is not recommended to modify any `IHeapStringNode` instance

* **Examples**: V8 or hermes heap snapshot can be parsed by the
getFullHeapFromFile API.

```typescript
import type {IHeapSnapshot, IHeapNode, IHeapStringNode} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);

  // iterate over each node (heap object)
  heap.nodes.forEach((node: IHeapNode, i: number) => {
    if (node.isString) {
      const stringNode: IHeapStringNode = node.toStringNode();
      // get the string value
      stringNode.stringValue;
    }
  });
})();
```

## Extends

- [`IHeapNode`](IHeapNode.md)

## Properties

### dominatorNode

> **dominatorNode**: [`Nullable`](../type-aliases/Nullable.md)\<[`IHeapNode`](IHeapNode.md)\>

Defined in: core/src/lib/Types.ts:1905

Gets the dominator node of this node. If the dominator node gets released
there will be no path from GC to this node, and therefore this node can
also be released.
For more information on what a dominator node is, please check out
[this doc](https://developer.chrome.com/docs/devtools/memory-problems/memory-101/#dominators).

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`dominatorNode`](IHeapNode.md#dominatornode)

***

### edge\_count

> **edge\_count**: `number`

Defined in: core/src/lib/Types.ts:1859

The total number of outgoing JS references (including engine-internal,
native, and JS references).

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`edge_count`](IHeapNode.md#edge_count)

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

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`findAnyReference`](IHeapNode.md#findanyreference)

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

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`findAnyReferrer`](IHeapNode.md#findanyreferrer)

***

### findReferrerNodes()

> **findReferrerNodes**: (`predicate`) => [`IHeapNode`](IHeapNode.md)[]

Defined in: core/src/lib/Types.ts:2067

Executes a provided predicate callback once for each JavaScript heap
object (heap graph node) pointing to the hosting node
(or nodes having edges to the hosting node).

#### Parameters

##### predicate

[`Predicator`](../type-aliases/Predicator.md)\<[`IHeapNode`](IHeapNode.md)\>

the callback for each referrer nodes

#### Returns

[`IHeapNode`](IHeapNode.md)[]

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

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`findReferrerNodes`](IHeapNode.md#findreferrernodes)

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

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`findReferrers`](IHeapNode.md#findreferrers)

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

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`getAnyReferrer`](IHeapNode.md#getanyreferrer)

***

### getAnyReferrerNode()

> **getAnyReferrerNode**: (`edgeName`, `edgeType?`) => [`Nullable`](../type-aliases/Nullable.md)\<[`IHeapNode`](IHeapNode.md)\>

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

[`Nullable`](../type-aliases/Nullable.md)\<[`IHeapNode`](IHeapNode.md)\>

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

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`getAnyReferrerNode`](IHeapNode.md#getanyreferrernode)

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

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`getReference`](IHeapNode.md#getreference)

***

### getReferenceNode()

> **getReferenceNode**: (`edgeName`, `edgeType?`) => [`Nullable`](../type-aliases/Nullable.md)\<[`IHeapNode`](IHeapNode.md)\>

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

[`Nullable`](../type-aliases/Nullable.md)\<[`IHeapNode`](IHeapNode.md)\>

the node pointed to by the outgoing reference that meets
the specification

* **Examples**:
```typescript
// find the node's hidden class
const hiddenClassNode = node.getReferenceNode('map', 'hidden');
// this is equivalent to
const hiddenClassNode2 = node.getReference('map', 'hidden')?.toNode;
```

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`getReferenceNode`](IHeapNode.md#getreferencenode)

***

### getReferrerNodes()

> **getReferrerNodes**: (`edgeName`, `edgeType?`) => [`IHeapNode`](IHeapNode.md)[]

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

[`IHeapNode`](IHeapNode.md)[]

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

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`getReferrerNodes`](IHeapNode.md#getreferrernodes)

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

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`getReferrers`](IHeapNode.md#getreferrers)

***

### hasPathEdge

> **hasPathEdge**: `boolean`

Defined in: core/src/lib/Types.ts:1881

Returns true if the heap node has been set an incoming edge
which leads to the parent node on the shortest path to GC root.

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`hasPathEdge`](IHeapNode.md#haspathedge)

***

### id

> **id**: `number`

Defined in: core/src/lib/Types.ts:1787

Unique id of the heap object.

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`id`](IHeapNode.md#id)

***

### is\_detached

> **is\_detached**: `boolean`

Defined in: core/src/lib/Types.ts:1841

* If the heap object is a DOM element and the DOM element is detached
from the DOM tree, `is_detached` will be `true`;
* If the heap object is a React Fiber node and the Fiber node is unmounted
from the React Fiber tree, `is_detached` will be `true`;
otherwise it will be `false`.

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`is_detached`](IHeapNode.md#is_detached)

***

### isString

> **isString**: `boolean`

Defined in: core/src/lib/Types.ts:1917

Checks if this is a string node (normal string node, concatenated string node
or sliced string node).

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`isString`](IHeapNode.md#isstring)

***

### location

> **location**: [`Nullable`](../type-aliases/Nullable.md)\<[`IHeapLocation`](IHeapLocation.md)\>

Defined in: core/src/lib/Types.ts:1910

Source location information of this heap object (if it is recorded by
the heap snapshot).

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`location`](IHeapNode.md#location)

***

### name

> **name**: `string`

Defined in: core/src/lib/Types.ts:1783

This is the `name` field associated with the heap object.
For JS object instances (type `object`), `name` is the constructor's name
of the object instance. For `string`, `name` is the string value.

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`name`](IHeapNode.md#name)

***

### nodeIndex

> **nodeIndex**: `number`

Defined in: core/src/lib/Types.ts:1890

Index of this heap object inside the `node.snapshot.nodes` pseudo array.

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`nodeIndex`](IHeapNode.md#nodeindex)

***

### numOfReferrers

> **numOfReferrers**: `number`

Defined in: core/src/lib/Types.ts:1876

Gets the number of all incoming references pointing to this heap object
(including engine-internal, native, and JS references).

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`numOfReferrers`](IHeapNode.md#numofreferrers)

***

### pathEdge

> **pathEdge**: [`IHeapEdge`](IHeapEdge.md) \| `null`

Defined in: core/src/lib/Types.ts:1886

The incoming edge which leads to the parent node
on the shortest path to GC root.

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`pathEdge`](IHeapNode.md#pathedge)

***

### references

> **references**: [`IHeapEdge`](IHeapEdge.md)[]

Defined in: core/src/lib/Types.ts:1866

Gets a JS array containing all outgoing JS references from this heap object
(including engine-internal, native, and JS references).

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`references`](IHeapNode.md#references)

***

### referrers

> **referrers**: [`IHeapEdge`](IHeapEdge.md)[]

Defined in: core/src/lib/Types.ts:1871

Gets a JS array containing all incoming JS references pointing to this heap
object (including engine-internal, native, and JS references).

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`referrers`](IHeapNode.md#referrers)

***

### retainedSize

> **retainedSize**: `number`

Defined in: core/src/lib/Types.ts:1897

The *retained size* of the heap object (i.e., the total size of memory that
could be released if this object is released). For difference between
**retained size** and **shallow size**, check out
[this doc](https://developer.chrome.com/docs/devtools/memory-problems/memory-101/#object_sizes).

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`retainedSize`](IHeapNode.md#retainedsize)

***

### self\_size

> **self\_size**: `number`

Defined in: core/src/lib/Types.ts:1854

The *shallow size* of the heap object (i.e., the size of memory that is held
by the object itself). For difference between **shallow size** and
**retained size**, check out
[this doc](https://developer.chrome.com/docs/devtools/memory-problems/memory-101/#object_sizes).

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`self_size`](IHeapNode.md#self_size)

***

### snapshot

> **snapshot**: [`IHeapSnapshot`](IHeapSnapshot.md)

Defined in: core/src/lib/Types.ts:1833

Gets the [IHeapSnapshot](IHeapSnapshot.md) containing this heap object.

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`snapshot`](IHeapNode.md#snapshot)

***

### stringValue

> **stringValue**: `string`

Defined in: core/src/lib/Types.ts:2226

Gets the string value of the JS string heap object associated with
this `IHeapStringNode` instance in heap.

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

[`IHeapNode`](IHeapNode.md).[`type`](IHeapNode.md#type)

## Methods

### findAnyReferrerNode()

> **findAnyReferrerNode**(`predicate`): [`Nullable`](../type-aliases/Nullable.md)\<[`IHeapNode`](IHeapNode.md)\>

Defined in: core/src/lib/Types.ts:2032

Executes a provided predicate callback once for each JavaScript heap
object (heap graph node) pointing to the hosting node
(or nodes having edges to the hosting node) until the predicate
returns `true`.

#### Parameters

##### predicate

[`Predicator`](../type-aliases/Predicator.md)\<[`IHeapNode`](IHeapNode.md)\>

the callback for each incoming JavaScript heap object

#### Returns

[`Nullable`](../type-aliases/Nullable.md)\<[`IHeapNode`](IHeapNode.md)\>

the first referring node for which the predicate returns `true`,
otherwise returns `null` if no such node is found.

* **Examples**:
```typescript
const referrer = node.findAnyReferrerNode((node: IHeapNode) => {
  // find the referring node with name "Parent"
  return node.name === 'Parent';
});
```

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`findAnyReferrerNode`](IHeapNode.md#findanyreferrernode)

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

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`forEachReference`](IHeapNode.md#foreachreference)

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

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`forEachReferrer`](IHeapNode.md#foreachreferrer)

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

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`getJSONifyableObject`](IHeapNode.md#getjsonifyableobject)

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

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`toJSONString`](IHeapNode.md#tojsonstring)

***

### toStringNode()

> **toStringNode**(): [`Nullable`](../type-aliases/Nullable.md)\<`IHeapStringNode`\>

Defined in: core/src/lib/Types.ts:1923

Converts to an IHeapStringNode object if this node is a string node.
The IHeapStringNode object supports querying the string content
inside the string node.

#### Returns

[`Nullable`](../type-aliases/Nullable.md)\<`IHeapStringNode`\>

#### Inherited from

[`IHeapNode`](IHeapNode.md).[`toStringNode`](IHeapNode.md#tostringnode)

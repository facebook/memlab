---
id: "core_src"
title: "Package: @memlab/core"
sidebar_label: "core/src"
sidebar_position: 0
custom_edit_url: null
---

## Interfaces

- [IHeapEdge](../interfaces/core_src.IHeapEdge.md)
- [IHeapEdges](../interfaces/core_src.IHeapEdges.md)
- [IHeapLocation](../interfaces/core_src.IHeapLocation.md)
- [IHeapNode](../interfaces/core_src.IHeapNode.md)
- [IHeapNodes](../interfaces/core_src.IHeapNodes.md)
- [IHeapSnapshot](../interfaces/core_src.IHeapSnapshot.md)
- [IHeapStringNode](../interfaces/core_src.IHeapStringNode.md)
- [ILeakFilter](../interfaces/core_src.ILeakFilter.md)
- [IScenario](../interfaces/core_src.IScenario.md)

## Type Aliases

### <a id="checkpageloadcallback" name="checkpageloadcallback"></a> **CheckPageLoadCallback**: (`page`: `Page`) => `Promise`<`boolean`\>

Callback function to provide if the page is loaded.

 * **Parameters**:
    * `page`: `Page` | puppeteer's [Page](https://pptr.dev/api/puppeteer.page/) object.
 * **Returns**: `Promise`<`boolean`\> | a boolean value, if it returns `true`, memlab will consider
the navigation completes, if it returns `false`, memlab will keep calling
this callback until it returns `true`. This is an async callback, you can
also `await` and returns `true` until some async logic is resolved.

 * **Source**:
    * core/src/lib/Types.ts:752

___

### <a id="cookies" name="cookies"></a> **Cookies**: { `domain?`: `string` ; `name`: `string` ; `value`: `string`  }[]

 * **Source**:
    * core/src/lib/Types.ts:104

___

### <a id="edgeiterationcallback" name="edgeiterationcallback"></a> **EdgeIterationCallback**: (`edge`: [`IHeapEdge`](../interfaces/core_src.IHeapEdge.md)) => `Optional`<{ `stop`: `boolean`  }\>

 * **Parameters**:
    * `edge`: [`IHeapEdge`](../interfaces/core_src.IHeapEdge.md)
 * **Returns**: `Optional`<{ `stop`: `boolean`  }\>

 * **Source**:
    * core/src/lib/Types.ts:1234

___

### <a id="initleakfiltercallback" name="initleakfiltercallback"></a> **InitLeakFilterCallback**: (`snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md), `leakedNodeIds`: `HeapNodeIdSet`) => `void`

Lifecycle function callback that is invoked initially once before calling any
leak filter function.

 * **Parameters**:
    * `snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md)
    * `leakedNodeIds`: `HeapNodeIdSet` | the set of leaked object (node) ids.
 * **Returns**: `void`

 * **Source**:
    * core/src/lib/Types.ts:328

___

### <a id="interactionscallback" name="interactionscallback"></a> **InteractionsCallback**: (`page`: `Page`, `args?`: `OperationArgs`) => `Promise`<`void`\>

The callback defines browser interactions which are
used by memlab to interact with the web app under test.

 * **Parameters**:
    * `page`: `Page`
    * `args?`: `OperationArgs`
 * **Returns**: `Promise`<`void`\>

 * **Source**:
    * core/src/lib/Types.ts:363

___

### <a id="leakfiltercallback" name="leakfiltercallback"></a> **LeakFilterCallback**: (`node`: [`IHeapNode`](../interfaces/core_src.IHeapNode.md), `snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md), `leakedNodeIds`: `HeapNodeIdSet`) => `boolean`

Callback that can be used to define a logic to filter the
leaked objects. The callback is only called for every node
allocated but not released from the target interaction
in the heap snapshot.

 * **Parameters**:
    * `node`: [`IHeapNode`](../interfaces/core_src.IHeapNode.md) | the node that is kept alive in the memory in the heap snapshot
    * `snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md) | the snapshot of target interaction
    * `leakedNodeIds`: `HeapNodeIdSet` | the set of leaked node ids
 * **Returns**: `boolean` | the value indicating whether the given node in the snapshot
should be considered as leaked.
* **Examples**:
```javascript
// any node in the heap snapshot that is greater than 1MB
function leakFilter(node, _snapshot, _leakedNodeIds) {
 return node.retainedSize > 1000000;
};
```

 * **Source**:
    * core/src/lib/Types.ts:353

___

### <a id="predicator" name="predicator"></a> **Predicator**<`T`\>: (`node`: `T`) => `boolean`

#### Type parameters

| Name |
| :------ |
| `T` |

 * **Parameters**:
    * `node`: `T`
 * **Returns**: `boolean`

 * **Source**:
    * core/src/lib/Types.ts:45

___

### <a id="runmetainfo" name="runmetainfo"></a> **RunMetaInfo**: `Object`

| Name | Type |
| :------ | :------ |
| `app` | `string` |
| `browserInfo` | `IBrowserInfo` |
| `interaction` | `string` |
| `type` | `string` |

 * **Source**:
    * core/src/lib/Types.ts:809

## Functions

### <a id="dumpnodeheapsnapshot"></a>**dumpNodeHeapSnapshot**()

 * **Returns**: `string`
 * **Source**:
    * core/src/lib/NodeHeap.ts:76

___

### <a id="getnodeinnocentheap"></a>**getNodeInnocentHeap**()

Take a heap snapshot of the current program state
and parse it as [IHeapSnapshot](../interfaces/core_src.IHeapSnapshot.md). Notice that
this API does not calculate some heap analysis meta data
for heap analysis. But this also means faster heap parsing.

 * **Returns**: `Promise`<[`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md)\> | heap representation without heap analysis meta data.

If you need to get the heap snapshot with heap analysis meta data
use [dumpNodeHeapSnapshot](core_src.md#dumpnodeheapsnapshot) and [getHeapFromFile](heap_analysis_src.md#getheapfromfile),
for example:
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getHeapFromFile(heapFile);
})();
```

 * **Source**:
    * core/src/lib/NodeHeap.ts:107

___

### <a id="tagobject"></a>**tagObject**<`T`\>(`o`, `tag`)

Tags a string marker to an object instance, which can later be checked by
[hasObjectWithTag](../interfaces/core_src.IHeapSnapshot.md#hasobjectwithtag). This API does not modify the object instance in
any way (e.g., no additional or hidden properties added to the tagged
object).

#### Type parameters

| Name | Type |
| :------ | :------ |
| `T` | extends `object` |

 * **Parameters**:
    * `o`: `T` | specify the object instance you want to tag, you cannot tag a [primitive](https://developer.mozilla.org/en-US/docs/Glossary/Primitive).
    * `tag`: `string` | marker name to tag on the object instance
 * **Returns**: `T` | returns the tagged object instance (same reference as
the input argument `o`)
* **Examples**:
```typescript
import type {IHeapSnapshot, AnyValue} from '@memlab/core';
import {config, getNodeInnocentHeap, tagObject} from '@memlab/core';

test('memory test', async () => {
  config.muteConsole = true;
  const o1: AnyValue = {};
  let o2: AnyValue = {};

  // tag o1 with marker: "memlab-mark-1", does not modify o1 in any way
  tagObject(o1, 'memlab-mark-1');
  // tag o2 with marker: "memlab-mark-2", does not modify o2 in any way
  tagObject(o2, 'memlab-mark-2');

  o2 = null;

  const heap: IHeapSnapshot = await getNodeInnocentHeap();

  // expect object with marker "memlab-mark-1" exists
  expect(heap.hasObjectWithTag('memlab-mark-1')).toBe(true);

  // expect object with marker "memlab-mark-2" can be GCed
  expect(heap.hasObjectWithTag('memlab-mark-2')).toBe(false);

}, 30000);
```

 * **Source**:
    * core/src/lib/NodeHeap.ts:68

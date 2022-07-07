---
id: "core_src"
title: "Package: @memlab/core"
sidebar_label: "core/src"
sidebar_position: 0
custom_edit_url: null
---

## Interfaces

- [IHeapEdge](../interfaces/core_src.IHeapEdge.md)
- [IHeapEdgeBasic](../interfaces/core_src.IHeapEdgeBasic.md)
- [IHeapEdges](../interfaces/core_src.IHeapEdges.md)
- [IHeapLocation](../interfaces/core_src.IHeapLocation.md)
- [IHeapNode](../interfaces/core_src.IHeapNode.md)
- [IHeapNodeBasic](../interfaces/core_src.IHeapNodeBasic.md)
- [IHeapNodes](../interfaces/core_src.IHeapNodes.md)
- [IHeapSnapshot](../interfaces/core_src.IHeapSnapshot.md)
- [IHeapStringNode](../interfaces/core_src.IHeapStringNode.md)
- [ILeakFilter](../interfaces/core_src.ILeakFilter.md)
- [IScenario](../interfaces/core_src.IScenario.md)

## Type Aliases

### <a id="checkpageloadcallback" name="checkpageloadcallback"></a> **CheckPageLoadCallback**: (`page`: `Page`) => `Promise`<`boolean`\>

#### Type declaration

### <a id="__type"></a>(`page`)

Callback function to provide if the page is loaded.

 * **Parameters**:
    * `page`: `Page` | puppeteer's [Page](https://pptr.dev/api/puppeteer.page/) object.
 * **Returns**: `Promise`<`boolean`\>

 * **Source**:
    * core/src/lib/Types.ts:446

___

### <a id="cookies" name="cookies"></a> **Cookies**: { `name`: `string` ; `value`: `string`  }[]

 * **Source**:
    * core/src/lib/Types.ts:104

___

### <a id="edgeiterationcallback" name="edgeiterationcallback"></a> **EdgeIterationCallback**: (`edge`: [`IHeapEdge`](../interfaces/core_src.IHeapEdge.md)) => `Optional`<{ `stop`: `boolean`  }\>

#### Type declaration

### <a id="__type"></a>(`edge`)

 * **Parameters**:
    * `edge`: [`IHeapEdge`](../interfaces/core_src.IHeapEdge.md)
 * **Returns**: `Optional`<{ `stop`: `boolean`  }\>

 * **Source**:
    * core/src/lib/Types.ts:556

___

### <a id="initleakfiltercallback" name="initleakfiltercallback"></a> **InitLeakFilterCallback**: (`snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md), `leakedNodeIds`: `HeapNodeIdSet`) => `void`

#### Type declaration

### <a id="__type"></a>(`snapshot`, `leakedNodeIds`)

Lifecycle function callback that is invoked initially once before calling any
leak filter function.

 * **Parameters**:
    * `snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md)
    * `leakedNodeIds`: `HeapNodeIdSet` | the set of leaked object (node) ids.
 * **Returns**: `void`

 * **Source**:
    * core/src/lib/Types.ts:210

___

### <a id="interactionscallback" name="interactionscallback"></a> **InteractionsCallback**: (`page`: `Page`, `args?`: `OperationArgs`) => `Promise`<`void`\>

#### Type declaration

### <a id="__type"></a>(`page`, `args?`)

This callback is used to define interactions about how `memlab` should interact with your app.

 * **Parameters**:
    * `page`: `Page`
    * `args?`: `OperationArgs`
 * **Returns**: `Promise`<`void`\>

 * **Source**:
    * core/src/lib/Types.ts:244

___

### <a id="leakfiltercallback" name="leakfiltercallback"></a> **LeakFilterCallback**: (`node`: [`IHeapNode`](../interfaces/core_src.IHeapNode.md), `snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md), `leakedNodeIds`: `HeapNodeIdSet`) => `boolean`

#### Type declaration

### <a id="__type"></a>(`node`, `snapshot`, `leakedNodeIds`)

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
    * core/src/lib/Types.ts:235

___

### <a id="predicator" name="predicator"></a> **Predicator**<`T`\>: (`node`: `T`) => `boolean`

#### Type parameters

| Name |
| :------ |
| `T` |

#### Type declaration

### <a id="__type"></a>(`node`)

 * **Parameters**:
    * `node`: `T`
 * **Returns**: `boolean`

 * **Source**:
    * core/src/lib/Types.ts:45

___

### <a id="runmetainfo" name="runmetainfo"></a> **RunMetaInfo**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `app` | `string` |
| `browserInfo` | `IBrowserInfo` |
| `interaction` | `string` |
| `type` | `string` |

 * **Source**:
    * core/src/lib/Types.ts:503

## Functions

### <a id="dumpnodeheapsnapshot"></a>**dumpNodeHeapSnapshot**()

 * **Returns**: `string`
 * **Source**:
    * core/src/lib/NodeHeap.ts:37

___

### <a id="getcurrentnodeheap"></a>**getCurrentNodeHeap**()

 * **Returns**: `Promise`<[`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md)\>
 * **Source**:
    * core/src/lib/NodeHeap.ts:46

___

### <a id="tagobject"></a>**tagObject**(`o`, `tag`)

 * **Parameters**:
    * `o`: `AnyObject`
    * `tag`: `string`
 * **Returns**: `AnyObject`
 * **Source**:
    * core/src/lib/NodeHeap.ts:29

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

### <a id="anyvalue" name="anyvalue"></a> **AnyValue**: `any`

 * **Source**:
    * core/src/lib/Types.ts:16

___

### <a id="cookies" name="cookies"></a> **Cookies**: { `name`: `string` ; `value`: `string`  }[]

 * **Source**:
    * core/src/lib/Types.ts:103

___

### <a id="edgeiterationcallback" name="edgeiterationcallback"></a> **EdgeIterationCallback**: (`edge`: [`IHeapEdge`](../interfaces/core_src.IHeapEdge.md)) => `Optional`<{ `stop`: `boolean`  }\>

#### Type declaration

### <a id="__type"></a>(`edge`)

 * **Parameters**:
    * `edge`: [`IHeapEdge`](../interfaces/core_src.IHeapEdge.md)
 * **Returns**: `Optional`<{ `stop`: `boolean`  }\>

 * **Source**:
    * core/src/lib/Types.ts:417

___

### <a id="initleakfiltercallback" name="initleakfiltercallback"></a> **InitLeakFilterCallback**: (`snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md), `leakedNodeIds`: `HeapNodeIdSet`) => `void`

#### Type declaration

### <a id="__type"></a>(`snapshot`, `leakedNodeIds`)

 * **Parameters**:
    * `snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md)
    * `leakedNodeIds`: `HeapNodeIdSet`
 * **Returns**: `void`

 * **Source**:
    * core/src/lib/Types.ts:180

___

### <a id="interactionscallback" name="interactionscallback"></a> **InteractionsCallback**: (`page`: `Page`, `args?`: `OperationArgs`) => `Promise`<`void`\>

#### Type declaration

### <a id="__type"></a>(`page`, `args?`)

 * **Parameters**:
    * `page`: `Page`
    * `args?`: `OperationArgs`
 * **Returns**: `Promise`<`void`\>

 * **Source**:
    * core/src/lib/Types.ts:191

___

### <a id="leakfiltercallback" name="leakfiltercallback"></a> **LeakFilterCallback**: (`node`: [`IHeapNode`](../interfaces/core_src.IHeapNode.md), `snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md), `leakedNodeIds`: `HeapNodeIdSet`) => `boolean`

#### Type declaration

### <a id="__type"></a>(`node`, `snapshot`, `leakedNodeIds`)

 * **Parameters**:
    * `node`: [`IHeapNode`](../interfaces/core_src.IHeapNode.md)
    * `snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md)
    * `leakedNodeIds`: `HeapNodeIdSet`
 * **Returns**: `boolean`

 * **Source**:
    * core/src/lib/Types.ts:185

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
    * core/src/lib/Types.ts:44

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
    * core/src/lib/Types.ts:364

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

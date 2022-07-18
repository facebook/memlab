---
id: "core_src.IHeapStringNode"
title: "Interface: IHeapStringNode"
sidebar_label: "IHeapStringNode"
custom_edit_url: null
---

## Hierarchy

- [`IHeapNode`](core_src.IHeapNode.md)

  ↳ **`IHeapStringNode`**

## Properties

### <a id="attributes" name="attributes"></a> **attributes**: `number`

 * **Source**:
    * core/src/lib/Types.ts:968

___

### <a id="detachstate" name="detachstate"></a> **detachState**: `number`

 * **Source**:
    * core/src/lib/Types.ts:966

___

### <a id="dominatornode" name="dominatornode"></a> **dominatorNode**: ``null`` \| [`IHeapNode`](core_src.IHeapNode.md)

 * **Source**:
    * core/src/lib/Types.ts:977

___

### <a id="edge\_count" name="edge\_count"></a> **edge\_count**: `number`

 * **Source**:
    * core/src/lib/Types.ts:970

___

### <a id="highlight" name="highlight"></a> `Optional` **highlight**: `boolean`

 * **Source**:
    * core/src/lib/Types.ts:979

___

### <a id="id" name="id"></a> **id**: `number`

 * **Source**:
    * core/src/lib/Types.ts:956

___

### <a id="isstring" name="isstring"></a> **isString**: `boolean`

 * **Source**:
    * core/src/lib/Types.ts:980

___

### <a id="is\_detached" name="is\_detached"></a> **is\_detached**: `boolean`

 * **Source**:
    * core/src/lib/Types.ts:965

___

### <a id="location" name="location"></a> **location**: ``null`` \| [`IHeapLocation`](core_src.IHeapLocation.md)

 * **Source**:
    * core/src/lib/Types.ts:978

___

### <a id="name" name="name"></a> **name**: `string`

 * **Source**:
    * core/src/lib/Types.ts:955

___

### <a id="nodeindex" name="nodeindex"></a> **nodeIndex**: `number`

 * **Source**:
    * core/src/lib/Types.ts:975

___

### <a id="pathedge" name="pathedge"></a> **pathEdge**: ``null`` \| [`IHeapEdge`](core_src.IHeapEdge.md)

 * **Source**:
    * core/src/lib/Types.ts:974

___

### <a id="references" name="references"></a> **references**: [`IHeapEdge`](core_src.IHeapEdge.md)[]

 * **Source**:
    * core/src/lib/Types.ts:972

___

### <a id="referrers" name="referrers"></a> **referrers**: [`IHeapEdge`](core_src.IHeapEdge.md)[]

 * **Source**:
    * core/src/lib/Types.ts:973

___

### <a id="retainedsize" name="retainedsize"></a> **retainedSize**: `number`

 * **Source**:
    * core/src/lib/Types.ts:976

___

### <a id="self\_size" name="self\_size"></a> **self\_size**: `number`

 * **Source**:
    * core/src/lib/Types.ts:969

___

### <a id="snapshot" name="snapshot"></a> **snapshot**: [`IHeapSnapshot`](core_src.IHeapSnapshot.md)

 * **Source**:
    * core/src/lib/Types.ts:964

___

### <a id="stringvalue" name="stringvalue"></a> **stringValue**: `string`

 * **Source**:
    * core/src/lib/Types.ts:1011

___

### <a id="trace\_node\_id" name="trace\_node\_id"></a> **trace\_node\_id**: `number`

 * **Source**:
    * core/src/lib/Types.ts:971

___

### <a id="type" name="type"></a> **type**: `string`

 * **Source**:
    * core/src/lib/Types.ts:954

## Methods

### <a id="findanyreferrer"></a>**findAnyReferrer**(`predicate`)

 * **Parameters**:
    * `predicate`: [`Predicator`](../modules/core_src.md#predicator)<[`IHeapEdge`](core_src.IHeapEdge.md)\>
 * **Returns**: `Nullable`<[`IHeapEdge`](core_src.IHeapEdge.md)\>
 * **Source**:
    * core/src/lib/Types.ts:985

___

### <a id="findreference"></a>**findReference**(`predicate`)

 * **Parameters**:
    * `predicate`: [`Predicator`](../modules/core_src.md#predicator)<[`IHeapEdge`](core_src.IHeapEdge.md)\>
 * **Returns**: `Nullable`<[`IHeapEdge`](core_src.IHeapEdge.md)\>
 * **Source**:
    * core/src/lib/Types.ts:984

___

### <a id="findreferrers"></a>**findReferrers**(`predicate`)

 * **Parameters**:
    * `predicate`: [`Predicator`](../modules/core_src.md#predicator)<[`IHeapEdge`](core_src.IHeapEdge.md)\>
 * **Returns**: [`IHeapEdge`](core_src.IHeapEdge.md)[]
 * **Source**:
    * core/src/lib/Types.ts:986

___

### <a id="foreachreference"></a>**forEachReference**(`callback`)

 * **Parameters**:
    * `callback`: [`EdgeIterationCallback`](../modules/core_src.md#edgeiterationcallback)
 * **Returns**: `void`
 * **Source**:
    * core/src/lib/Types.ts:982

___

### <a id="foreachreferrer"></a>**forEachReferrer**(`callback`)

 * **Parameters**:
    * `callback`: [`EdgeIterationCallback`](../modules/core_src.md#edgeiterationcallback)
 * **Returns**: `void`
 * **Source**:
    * core/src/lib/Types.ts:983

___

### <a id="getanyreferrer"></a>**getAnyReferrer**(`edgeName`, `edgeType?`)

 * **Parameters**:
    * `edgeName`: `string` \| `number`
    * `edgeType?`: `string`
 * **Returns**: `Nullable`<[`IHeapEdge`](core_src.IHeapEdge.md)\>
 * **Source**:
    * core/src/lib/Types.ts:995

___

### <a id="getanyreferrernode"></a>**getAnyReferrerNode**(`edgeName`, `edgeType?`)

 * **Parameters**:
    * `edgeName`: `string` \| `number`
    * `edgeType?`: `string`
 * **Returns**: `Nullable`<[`IHeapNode`](core_src.IHeapNode.md)\>
 * **Source**:
    * core/src/lib/Types.ts:999

___

### <a id="getreference"></a>**getReference**(`edgeName`, `edgeType?`)

 * **Parameters**:
    * `edgeName`: `string` \| `number`
    * `edgeType?`: `string`
 * **Returns**: `Nullable`<[`IHeapEdge`](core_src.IHeapEdge.md)\>
 * **Source**:
    * core/src/lib/Types.ts:987

___

### <a id="getreferencenode"></a>**getReferenceNode**(`edgeName`, `edgeType?`)

 * **Parameters**:
    * `edgeName`: `string` \| `number`
    * `edgeType?`: `string`
 * **Returns**: `Nullable`<[`IHeapNode`](core_src.IHeapNode.md)\>
 * **Source**:
    * core/src/lib/Types.ts:991

___

### <a id="getreferrernodes"></a>**getReferrerNodes**(`edgeName`, `edgeType?`)

 * **Parameters**:
    * `edgeName`: `string` \| `number`
    * `edgeType?`: `string`
 * **Returns**: [`IHeapNode`](core_src.IHeapNode.md)[]
 * **Source**:
    * core/src/lib/Types.ts:1004

___

### <a id="getreferrers"></a>**getReferrers**(`edgeName`, `edgeType?`)

 * **Parameters**:
    * `edgeName`: `string` \| `number`
    * `edgeType?`: `string`
 * **Returns**: [`IHeapEdge`](core_src.IHeapEdge.md)[]
 * **Source**:
    * core/src/lib/Types.ts:1003

___

### <a id="markasdetached"></a>**markAsDetached**()

 * **Returns**: `void`
 * **Source**:
    * core/src/lib/Types.ts:967

___

### <a id="tostringnode"></a>**toStringNode**()

 * **Returns**: `Nullable`<[`IHeapStringNode`](core_src.IHeapStringNode.md)\>
 * **Source**:
    * core/src/lib/Types.ts:981

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
    * core/src/lib/Types.ts:426

___

### <a id="detachstate" name="detachstate"></a> **detachState**: `number`

 * **Source**:
    * core/src/lib/Types.ts:424

___

### <a id="dominatornode" name="dominatornode"></a> **dominatorNode**: ``null`` \| [`IHeapNode`](core_src.IHeapNode.md)

 * **Source**:
    * core/src/lib/Types.ts:435

___

### <a id="edge\_count" name="edge\_count"></a> **edge\_count**: `number`

 * **Source**:
    * core/src/lib/Types.ts:428

___

### <a id="highlight" name="highlight"></a> `Optional` **highlight**: `boolean`

 * **Source**:
    * core/src/lib/Types.ts:437

___

### <a id="id" name="id"></a> **id**: `number`

 * **Source**:
    * core/src/lib/Types.ts:414

___

### <a id="isstring" name="isstring"></a> **isString**: `boolean`

 * **Source**:
    * core/src/lib/Types.ts:438

___

### <a id="is\_detached" name="is\_detached"></a> **is\_detached**: `boolean`

 * **Source**:
    * core/src/lib/Types.ts:423

___

### <a id="location" name="location"></a> **location**: ``null`` \| [`IHeapLocation`](core_src.IHeapLocation.md)

 * **Source**:
    * core/src/lib/Types.ts:436

___

### <a id="name" name="name"></a> **name**: `string`

 * **Source**:
    * core/src/lib/Types.ts:413

___

### <a id="nodeindex" name="nodeindex"></a> **nodeIndex**: `number`

 * **Source**:
    * core/src/lib/Types.ts:433

___

### <a id="pathedge" name="pathedge"></a> **pathEdge**: ``null`` \| [`IHeapEdge`](core_src.IHeapEdge.md)

 * **Source**:
    * core/src/lib/Types.ts:432

___

### <a id="references" name="references"></a> **references**: [`IHeapEdge`](core_src.IHeapEdge.md)[]

 * **Source**:
    * core/src/lib/Types.ts:430

___

### <a id="referrers" name="referrers"></a> **referrers**: [`IHeapEdge`](core_src.IHeapEdge.md)[]

 * **Source**:
    * core/src/lib/Types.ts:431

___

### <a id="retainedsize" name="retainedsize"></a> **retainedSize**: `number`

 * **Source**:
    * core/src/lib/Types.ts:434

___

### <a id="self\_size" name="self\_size"></a> **self\_size**: `number`

 * **Source**:
    * core/src/lib/Types.ts:427

___

### <a id="snapshot" name="snapshot"></a> **snapshot**: [`IHeapSnapshot`](core_src.IHeapSnapshot.md)

 * **Source**:
    * core/src/lib/Types.ts:422

___

### <a id="stringvalue" name="stringvalue"></a> **stringValue**: `string`

 * **Source**:
    * core/src/lib/Types.ts:469

___

### <a id="trace\_node\_id" name="trace\_node\_id"></a> **trace\_node\_id**: `number`

 * **Source**:
    * core/src/lib/Types.ts:429

___

### <a id="type" name="type"></a> **type**: `string`

 * **Source**:
    * core/src/lib/Types.ts:412

## Methods

### <a id="findanyreferrer"></a>**findAnyReferrer**(`predicate`)

 * **Parameters**:
    * `predicate`: [`Predicator`](../modules/core_src.md#predicator)<[`IHeapEdge`](core_src.IHeapEdge.md)\>
 * **Returns**: `Nullable`<[`IHeapEdge`](core_src.IHeapEdge.md)\>
 * **Source**:
    * core/src/lib/Types.ts:443

___

### <a id="findreference"></a>**findReference**(`predicate`)

 * **Parameters**:
    * `predicate`: [`Predicator`](../modules/core_src.md#predicator)<[`IHeapEdge`](core_src.IHeapEdge.md)\>
 * **Returns**: `Nullable`<[`IHeapEdge`](core_src.IHeapEdge.md)\>
 * **Source**:
    * core/src/lib/Types.ts:442

___

### <a id="findreferrers"></a>**findReferrers**(`predicate`)

 * **Parameters**:
    * `predicate`: [`Predicator`](../modules/core_src.md#predicator)<[`IHeapEdge`](core_src.IHeapEdge.md)\>
 * **Returns**: [`IHeapEdge`](core_src.IHeapEdge.md)[]
 * **Source**:
    * core/src/lib/Types.ts:444

___

### <a id="foreachreference"></a>**forEachReference**(`callback`)

 * **Parameters**:
    * `callback`: [`EdgeIterationCallback`](../modules/core_src.md#edgeiterationcallback)
 * **Returns**: `void`
 * **Source**:
    * core/src/lib/Types.ts:440

___

### <a id="foreachreferrer"></a>**forEachReferrer**(`callback`)

 * **Parameters**:
    * `callback`: [`EdgeIterationCallback`](../modules/core_src.md#edgeiterationcallback)
 * **Returns**: `void`
 * **Source**:
    * core/src/lib/Types.ts:441

___

### <a id="getanyreferrer"></a>**getAnyReferrer**(`edgeName`, `edgeType?`)

 * **Parameters**:
    * `edgeName`: `string` \| `number`
    * `edgeType?`: `string`
 * **Returns**: `Nullable`<[`IHeapEdge`](core_src.IHeapEdge.md)\>
 * **Source**:
    * core/src/lib/Types.ts:453

___

### <a id="getanyreferrernode"></a>**getAnyReferrerNode**(`edgeName`, `edgeType?`)

 * **Parameters**:
    * `edgeName`: `string` \| `number`
    * `edgeType?`: `string`
 * **Returns**: `Nullable`<[`IHeapNode`](core_src.IHeapNode.md)\>
 * **Source**:
    * core/src/lib/Types.ts:457

___

### <a id="getreference"></a>**getReference**(`edgeName`, `edgeType?`)

 * **Parameters**:
    * `edgeName`: `string` \| `number`
    * `edgeType?`: `string`
 * **Returns**: `Nullable`<[`IHeapEdge`](core_src.IHeapEdge.md)\>
 * **Source**:
    * core/src/lib/Types.ts:445

___

### <a id="getreferencenode"></a>**getReferenceNode**(`edgeName`, `edgeType?`)

 * **Parameters**:
    * `edgeName`: `string` \| `number`
    * `edgeType?`: `string`
 * **Returns**: `Nullable`<[`IHeapNode`](core_src.IHeapNode.md)\>
 * **Source**:
    * core/src/lib/Types.ts:449

___

### <a id="getreferrernodes"></a>**getReferrerNodes**(`edgeName`, `edgeType?`)

 * **Parameters**:
    * `edgeName`: `string` \| `number`
    * `edgeType?`: `string`
 * **Returns**: [`IHeapNode`](core_src.IHeapNode.md)[]
 * **Source**:
    * core/src/lib/Types.ts:462

___

### <a id="getreferrers"></a>**getReferrers**(`edgeName`, `edgeType?`)

 * **Parameters**:
    * `edgeName`: `string` \| `number`
    * `edgeType?`: `string`
 * **Returns**: [`IHeapEdge`](core_src.IHeapEdge.md)[]
 * **Source**:
    * core/src/lib/Types.ts:461

___

### <a id="markasdetached"></a>**markAsDetached**()

 * **Returns**: `void`
 * **Source**:
    * core/src/lib/Types.ts:425

___

### <a id="tostringnode"></a>**toStringNode**()

 * **Returns**: `Nullable`<[`IHeapStringNode`](core_src.IHeapStringNode.md)\>
 * **Source**:
    * core/src/lib/Types.ts:439

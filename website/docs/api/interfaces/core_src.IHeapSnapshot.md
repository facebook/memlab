---
id: "core_src.IHeapSnapshot"
title: "Interface: IHeapSnapshot"
sidebar_label: "IHeapSnapshot"
custom_edit_url: null
---

## Properties

### <a id="edges" name="edges"></a> **edges**: [`IHeapEdges`](core_src.IHeapEdges.md)

 * **Source**:
    * core/src/lib/Types.ts:374

___

### <a id="nodes" name="nodes"></a> **nodes**: [`IHeapNodes`](core_src.IHeapNodes.md)

 * **Source**:
    * core/src/lib/Types.ts:373

___

### <a id="snapshot" name="snapshot"></a> **snapshot**: `RawHeapSnapshot`

 * **Source**:
    * core/src/lib/Types.ts:372

## Methods

### <a id="clearshortestpathinfo"></a>**clearShortestPathInfo**()

 * **Returns**: `void`
 * **Source**:
    * core/src/lib/Types.ts:376

___

### <a id="getanyobjectwithclassname"></a>**getAnyObjectWithClassName**(`className`)

 * **Parameters**:
    * `className`: `string`
 * **Returns**: `Nullable`<[`IHeapNode`](core_src.IHeapNode.md)\>
 * **Source**:
    * core/src/lib/Types.ts:379

___

### <a id="getnodebyid"></a>**getNodeById**(`id`)

 * **Parameters**:
    * `id`: `number`
 * **Returns**: `Nullable`<[`IHeapNode`](core_src.IHeapNode.md)\>
 * **Source**:
    * core/src/lib/Types.ts:375

___

### <a id="hasobjectwithclassname"></a>**hasObjectWithClassName**(`className`)

 * **Parameters**:
    * `className`: `string`
 * **Returns**: `boolean`
 * **Source**:
    * core/src/lib/Types.ts:378

___

### <a id="hasobjectwithpropertyname"></a>**hasObjectWithPropertyName**(`nameOrIndex`)

 * **Parameters**:
    * `nameOrIndex`: `string` \| `number`
 * **Returns**: `boolean`
 * **Source**:
    * core/src/lib/Types.ts:380

___

### <a id="hasobjectwithtag"></a>**hasObjectWithTag**(`tag`)

 * **Parameters**:
    * `tag`: `string`
 * **Returns**: `boolean`
 * **Source**:
    * core/src/lib/Types.ts:381

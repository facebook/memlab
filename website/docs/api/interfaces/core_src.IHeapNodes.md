---
id: "core_src.IHeapNodes"
title: "Interface: IHeapNodes"
sidebar_label: "IHeapNodes"
custom_edit_url: null
---

## Properties

### <a id="length" name="length"></a> **length**: `number`

 * **Source**:
    * core/src/lib/Types.ts:612

## Methods

### <a id="foreach"></a>**forEach**(`callback`)

 * **Parameters**:
    * `callback`: (`node`: [`IHeapNode`](core_src.IHeapNode.md), `index`: `number`) => `boolean` \| `void`
 * **Returns**: `void`
 * **Source**:
    * core/src/lib/Types.ts:614

___

### <a id="foreachtraceable"></a>**forEachTraceable**(`callback`)

 * **Parameters**:
    * `callback`: (`node`: [`IHeapNode`](core_src.IHeapNode.md), `index`: `number`) => `boolean` \| `void`
 * **Returns**: `void`
 * **Source**:
    * core/src/lib/Types.ts:615

___

### <a id="get"></a>**get**(`index`)

 * **Parameters**:
    * `index`: `number`
 * **Returns**: [`IHeapNode`](core_src.IHeapNode.md)
 * **Source**:
    * core/src/lib/Types.ts:613

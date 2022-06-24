---
id: "heap_analysis_src.DetachedDOMElementAnalysis"
title: "Class: DetachedDOMElementAnalysis"
sidebar_label: "DetachedDOMElementAnalysis"
custom_edit_url: null
---

[heap-analysis/src](../modules/heap_analysis_src.md).DetachedDOMElementAnalysis

## Hierarchy

- [`BaseAnalysis`](heap_analysis_src.BaseAnalysis.md)

  ↳ **`DetachedDOMElementAnalysis`**

## Constructors

### constructor

• **new DetachedDOMElementAnalysis**()

#### Inherited from

[BaseAnalysis](heap_analysis_src.BaseAnalysis.md).[constructor](heap_analysis_src.BaseAnalysis.md#constructor)

## Methods

### analyzeSnapshotFromFile

▸ **analyzeSnapshotFromFile**(`file`): `Promise`<`any`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `file` | `string` |

#### Returns

`Promise`<`any`\>

#### Inherited from

[BaseAnalysis](heap_analysis_src.BaseAnalysis.md).[analyzeSnapshotFromFile](heap_analysis_src.BaseAnalysis.md#analyzesnapshotfromfile)

#### Defined in

heap-analysis/src/BaseAnalysis.ts:52

___

### analyzeSnapshotsInDirectory

▸ **analyzeSnapshotsInDirectory**(`directory`): `Promise`<`any`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `directory` | `string` |

#### Returns

`Promise`<`any`\>

#### Inherited from

[BaseAnalysis](heap_analysis_src.BaseAnalysis.md).[analyzeSnapshotsInDirectory](heap_analysis_src.BaseAnalysis.md#analyzesnapshotsindirectory)

#### Defined in

heap-analysis/src/BaseAnalysis.ts:62

___

### getCommandName

▸ **getCommandName**(): `string`

#### Returns

`string`

#### Overrides

[BaseAnalysis](heap_analysis_src.BaseAnalysis.md).[getCommandName](heap_analysis_src.BaseAnalysis.md#getcommandname)

#### Defined in

heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts:20

___

### getDescription

▸ **getDescription**(): `string`

#### Returns

`string`

#### Overrides

[BaseAnalysis](heap_analysis_src.BaseAnalysis.md).[getDescription](heap_analysis_src.BaseAnalysis.md#getdescription)

#### Defined in

heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts:24

___

### getDetachedElements

▸ **getDetachedElements**(): `IHeapNode`[]

#### Returns

`IHeapNode`[]

#### Defined in

heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts:34

___

### getOptions

▸ **getOptions**(): `default`[]

#### Returns

`default`[]

#### Overrides

[BaseAnalysis](heap_analysis_src.BaseAnalysis.md).[getOptions](heap_analysis_src.BaseAnalysis.md#getoptions)

#### Defined in

heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts:28

___

### process

▸ **process**(`options`): `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options` | `HeapAnalysisOptions` |

#### Returns

`Promise`<`void`\>

#### Overrides

BaseAnalysis.process

#### Defined in

heap-analysis/src/plugins/DetachedDOMElementAnalysis.ts:38

___

### run

▸ **run**(`options?`): `Promise`<`any`\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `options` | `HeapAnalysisOptions` | `pluginUtils.defaultAnalysisArgs` |

#### Returns

`Promise`<`any`\>

#### Inherited from

[BaseAnalysis](heap_analysis_src.BaseAnalysis.md).[run](heap_analysis_src.BaseAnalysis.md#run)

#### Defined in

heap-analysis/src/BaseAnalysis.ts:45

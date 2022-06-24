---
id: "heap_analysis_src.GlobalVariableAnalysis"
title: "Class: GlobalVariableAnalysis"
sidebar_label: "GlobalVariableAnalysis"
custom_edit_url: null
---

[heap-analysis/src](../modules/heap_analysis_src.md).GlobalVariableAnalysis

## Hierarchy

- [`BaseAnalysis`](heap_analysis_src.BaseAnalysis.md)

  ↳ **`GlobalVariableAnalysis`**

## Constructors

### constructor

• **new GlobalVariableAnalysis**()

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

heap-analysis/src/plugins/GlobalVariableAnalysis/GlobalVariableAnalysis.ts:21

___

### getDescription

▸ **getDescription**(): `string`

#### Returns

`string`

#### Overrides

[BaseAnalysis](heap_analysis_src.BaseAnalysis.md).[getDescription](heap_analysis_src.BaseAnalysis.md#getdescription)

#### Defined in

heap-analysis/src/plugins/GlobalVariableAnalysis/GlobalVariableAnalysis.ts:25

___

### getOptions

▸ **getOptions**(): `default`[]

#### Returns

`default`[]

#### Overrides

[BaseAnalysis](heap_analysis_src.BaseAnalysis.md).[getOptions](heap_analysis_src.BaseAnalysis.md#getoptions)

#### Defined in

heap-analysis/src/plugins/GlobalVariableAnalysis/GlobalVariableAnalysis.ts:29

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

heap-analysis/src/plugins/GlobalVariableAnalysis/GlobalVariableAnalysis.ts:33

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

---
id: "heap_analysis_src.ShapeUnboundGrowthAnalysis"
title: "Class: ShapeUnboundGrowthAnalysis"
sidebar_label: "ShapeUnboundGrowthAnalysis"
custom_edit_url: null
---

[heap-analysis/src](../modules/heap_analysis_src.md).ShapeUnboundGrowthAnalysis

## Hierarchy

- [`BaseAnalysis`](heap_analysis_src.BaseAnalysis.md)

  ↳ **`ShapeUnboundGrowthAnalysis`**

## Constructors

### constructor

• **new ShapeUnboundGrowthAnalysis**()

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

heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:40

___

### getDescription

▸ **getDescription**(): `string`

#### Returns

`string`

#### Overrides

[BaseAnalysis](heap_analysis_src.BaseAnalysis.md).[getDescription](heap_analysis_src.BaseAnalysis.md#getdescription)

#### Defined in

heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:44

___

### getOptions

▸ **getOptions**(): `default`[]

#### Returns

`default`[]

#### Overrides

[BaseAnalysis](heap_analysis_src.BaseAnalysis.md).[getOptions](heap_analysis_src.BaseAnalysis.md#getoptions)

#### Defined in

heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:48

___

### getShapesInfo

▸ **getShapesInfo**(`snapshot`): `ShapesInfo`

#### Parameters

| Name | Type |
| :------ | :------ |
| `snapshot` | `IHeapSnapshot` |

#### Returns

`ShapesInfo`

#### Defined in

heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:81

___

### getSummary

▸ **getSummary**(`ShapesInfoList`): `ShapeSummary`[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `ShapesInfoList` | `ShapesInfo`[] |

#### Returns

`ShapeSummary`[]

#### Defined in

heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:133

___

### process

▸ **process**(`options`): `Promise`<`ShapeSummary`[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options` | `HeapAnalysisOptions` |

#### Returns

`Promise`<`ShapeSummary`[]\>

#### Overrides

BaseAnalysis.process

#### Defined in

heap-analysis/src/plugins/ShapeUnboundGrowthAnalysis.ts:54

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

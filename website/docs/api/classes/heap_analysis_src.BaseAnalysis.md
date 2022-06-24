---
id: "heap_analysis_src.BaseAnalysis"
title: "Class: BaseAnalysis"
sidebar_label: "BaseAnalysis"
custom_edit_url: null
---

[heap-analysis/src](../modules/heap_analysis_src.md).BaseAnalysis

## Hierarchy

- `Analysis`

  ↳ **`BaseAnalysis`**

  ↳↳ [`DetachedDOMElementAnalysis`](heap_analysis_src.DetachedDOMElementAnalysis.md)

  ↳↳ [`GlobalVariableAnalysis`](heap_analysis_src.GlobalVariableAnalysis.md)

  ↳↳ [`CollectionsHoldingStaleAnalysis`](heap_analysis_src.CollectionsHoldingStaleAnalysis.md)

  ↳↳ [`ObjectShallowAnalysis`](heap_analysis_src.ObjectShallowAnalysis.md)

  ↳↳ [`ObjectSizeAnalysis`](heap_analysis_src.ObjectSizeAnalysis.md)

  ↳↳ [`ShapeUnboundGrowthAnalysis`](heap_analysis_src.ShapeUnboundGrowthAnalysis.md)

  ↳↳ [`ObjectFanoutAnalysis`](heap_analysis_src.ObjectFanoutAnalysis.md)

  ↳↳ [`ObjectShapeAnalysis`](heap_analysis_src.ObjectShapeAnalysis.md)

  ↳↳ [`ObjectUnboundGrowthAnalysis`](heap_analysis_src.ObjectUnboundGrowthAnalysis.md)

  ↳↳ [`StringAnalysis`](heap_analysis_src.StringAnalysis.md)

## Constructors

### constructor

• **new BaseAnalysis**()

#### Inherited from

Analysis.constructor

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

Analysis.analyzeSnapshotFromFile

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

Analysis.analyzeSnapshotsInDirectory

#### Defined in

heap-analysis/src/BaseAnalysis.ts:62

___

### getCommandName

▸ **getCommandName**(): `string`

#### Returns

`string`

#### Defined in

heap-analysis/src/BaseAnalysis.ts:78

___

### getDescription

▸ **getDescription**(): `string`

#### Returns

`string`

#### Defined in

heap-analysis/src/BaseAnalysis.ts:85

___

### getOptions

▸ **getOptions**(): `default`[]

#### Returns

`default`[]

#### Defined in

heap-analysis/src/BaseAnalysis.ts:104

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

Analysis.run

#### Defined in

heap-analysis/src/BaseAnalysis.ts:45

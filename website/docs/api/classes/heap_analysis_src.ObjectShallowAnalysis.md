---
id: "heap_analysis_src.ObjectShallowAnalysis"
title: "Class: ObjectShallowAnalysis"
sidebar_label: "ObjectShallowAnalysis"
custom_edit_url: null
---

[heap-analysis/src](../modules/heap_analysis_src.md).ObjectShallowAnalysis

## Hierarchy

- [`BaseAnalysis`](heap_analysis_src.BaseAnalysis.md)

  ↳ **`ObjectShallowAnalysis`**

## Constructors

### constructor

• **new ObjectShallowAnalysis**()

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

get CLI command name for this memory analysis;
use it with `memlab analyze <ANALYSIS_NAME>` in CLI

#### Returns

`string`

command name

#### Overrides

[BaseAnalysis](heap_analysis_src.BaseAnalysis.md).[getCommandName](heap_analysis_src.BaseAnalysis.md#getcommandname)

#### Defined in

heap-analysis/src/plugins/ObjectShallowAnalysis.ts:65

___

### getDescription

▸ **getDescription**(): `string`

get a textual description of the memory analysis

#### Returns

`string`

textual description

#### Overrides

[BaseAnalysis](heap_analysis_src.BaseAnalysis.md).[getDescription](heap_analysis_src.BaseAnalysis.md#getdescription)

#### Defined in

heap-analysis/src/plugins/ObjectShallowAnalysis.ts:73

___

### getTopDuplicatedObjectInCount

▸ **getTopDuplicatedObjectInCount**(): `ObjectRecord`[]

get the top duplicated object in terms of duplicated object count

#### Returns

`ObjectRecord`[]

an array of the top-duplicated objects' information

#### Defined in

heap-analysis/src/plugins/ObjectShallowAnalysis.ts:96

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

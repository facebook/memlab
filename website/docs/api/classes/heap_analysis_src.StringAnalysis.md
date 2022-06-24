---
id: "heap_analysis_src.StringAnalysis"
title: "Class: StringAnalysis"
sidebar_label: "StringAnalysis"
custom_edit_url: null
---

[heap-analysis/src](../modules/heap_analysis_src.md).StringAnalysis

This analysis finds duplicated string instance in JavaScript heap
and rank them based on the duplicated string size and count.

## Hierarchy

- [`BaseAnalysis`](heap_analysis_src.BaseAnalysis.md)

  ↳ **`StringAnalysis`**

## Constructors

### constructor

• **new StringAnalysis**()

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

heap-analysis/src/plugins/StringAnalysis.ts:124

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

heap-analysis/src/plugins/StringAnalysis.ts:132

___

### getTopDuplicatedStringsInCount

▸ **getTopDuplicatedStringsInCount**(): `StringRecord`[]

get the top duplicated string in terms of duplicated string count

#### Returns

`StringRecord`[]

an array of the top-duplicated strings' information

#### Defined in

heap-analysis/src/plugins/StringAnalysis.ts:73

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

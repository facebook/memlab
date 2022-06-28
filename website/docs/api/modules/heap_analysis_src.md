---
id: "heap_analysis_src"
title: "Module: heap-analysis/src"
sidebar_label: "heap-analysis/src"
sidebar_position: 0
custom_edit_url: null
---

## Classes

- [BaseAnalysis](../classes/heap_analysis_src.BaseAnalysis.md)
- [CollectionsHoldingStaleAnalysis](../classes/heap_analysis_src.CollectionsHoldingStaleAnalysis.md)
- [DetachedDOMElementAnalysis](../classes/heap_analysis_src.DetachedDOMElementAnalysis.md)
- [GlobalVariableAnalysis](../classes/heap_analysis_src.GlobalVariableAnalysis.md)
- [ObjectFanoutAnalysis](../classes/heap_analysis_src.ObjectFanoutAnalysis.md)
- [ObjectShallowAnalysis](../classes/heap_analysis_src.ObjectShallowAnalysis.md)
- [ObjectShapeAnalysis](../classes/heap_analysis_src.ObjectShapeAnalysis.md)
- [ObjectSizeAnalysis](../classes/heap_analysis_src.ObjectSizeAnalysis.md)
- [ObjectUnboundGrowthAnalysis](../classes/heap_analysis_src.ObjectUnboundGrowthAnalysis.md)
- [ShapeUnboundGrowthAnalysis](../classes/heap_analysis_src.ShapeUnboundGrowthAnalysis.md)
- [StringAnalysis](../classes/heap_analysis_src.StringAnalysis.md)

## Variables

### <a id="pluginutils" name="pluginutils"></a> **PluginUtils**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `aggregateDominatorMetrics` | (`ids`: `Set`<`number`\>, `snapshot`: `IHeapSnapshot`, `checkNodeCb`: (`node`: `IHeapNode`) => `boolean`, `nodeMetricsCb`: (`node`: `IHeapNode`) => `number`) => `number` |
| `defaultAnalysisArgs` | { `args`: { `_`: `never`[] = [] }  } |
| `defaultAnalysisArgs.args` | { `_`: `never`[] = [] } |
| `defaultAnalysisArgs.args._` | `never`[] |
| `filterOutLargestObjects` | (`snapshot`: `IHeapSnapshot`, `objectFilter`: (`node`: `IHeapNode`) => `boolean`, `listSize`: `number`) => `IHeapNode`[] |
| `getObjectOutgoingEdgeCount` | (`node`: `IHeapNode`) => `number` |
| `getSnapshotDirForAnalysis` | (`options`: `HeapAnalysisOptions`) => `Nullable`<`string`\> |
| `getSnapshotFileForAnalysis` | (`options`: `HeapAnalysisOptions`) => `string` |
| `isNodeWorthInspecting` | (`node`: `IHeapNode`) => `boolean` |
| `loadHeapSnapshot` | (`options`: `HeapAnalysisOptions`) => `Promise`<`IHeapSnapshot`\> |
| `printNodeListInTerminal` | (`nodeList`: `IHeapNode`[], `options`: `AnyOptions` & `PrintNodeOption`) => `void` |
| `printReferencesInTerminal` | (`edgeList`: `IHeapEdge`[], `options`: `AnyOptions` & `PrintNodeOption`) => `void` |
| `snapshotMapReduce` | <T1, T2\>(`mapCallback`: (`snapshot`: `IHeapSnapshot`, `i`: `number`, `file`: `string`) => `T1`, `reduceCallback`: (`results`: `T1`[]) => `T2`, `options`: `HeapAnalysisOptions`) => `Promise`<`T2`\> |

 * **Source**:
    * `heap-analysis/src/PluginUtils.ts:345`

___

### <a id="heapanalysisloader" name="heapanalysisloader"></a> **heapAnalysisLoader**: `HeapAnalysisLoader`

Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.

**`emails`** oncall+ws_labs

**`format`**

 * **Source**:
    * `heap-analysis/src/HeapAnalysisLoader.ts:63`

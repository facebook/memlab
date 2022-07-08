---
id: "core_src.ILeakFilter"
title: "Interface: ILeakFilter"
sidebar_label: "ILeakFilter"
custom_edit_url: null
---

The type for defining custom leak-filtering logic.
* **Examples**:
```typescript
const scenario = {

};

let map = Object.create(null);
const beforeLeakFilter = (snapshot: IHeapSnapshot, _leakedNodeIds: HeapNodeIdSet): void => {
  map = initializeMapUsingSnapshot(snapshot);
};

// duplicated string with size > 1KB as memory leak
const leakFilter = (node: IHeapNode): boolean => {
  if (node.type !== 'string' || node.retainedSize < 1000) {
    return false;
  }
  const str = utils.getStringNodeValue(node);
  return map[str] > 1;
};

export default {beforeLeakFilter, leakFilter};
```

## Properties

### <a id="beforeleakfilter" name="beforeleakfilter"></a> `Optional` **beforeLeakFilter**: [`InitLeakFilterCallback`](../modules/core_src.md#initleakfiltercallback)

 * **Source**:
    * core/src/lib/Types.ts:202

___

### <a id="leakfilter" name="leakfilter"></a> **leakFilter**: [`LeakFilterCallback`](../modules/core_src.md#leakfiltercallback)

 * **Source**:
    * core/src/lib/Types.ts:203

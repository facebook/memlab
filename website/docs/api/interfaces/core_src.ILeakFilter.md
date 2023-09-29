---
id: "core_src.ILeakFilter"
title: "Interface: ILeakFilter"
sidebar_label: "ILeakFilter"
custom_edit_url: null
---

The `ILeakFilter` interface allows you to define a leak detector and
customize the leak filtering logic in memlab (instead of using the
built-in leak filters).

Use the leak filter definition in command line interface to filter
leaks detected from browser interactions
```bash
memlab run --scenario <SCENARIO FILE> --leak-filter <PATH TO leak-filter.js>
```

If you have already run `memlab run` or `memlab snapshot` which saved
heap snapshot and other meta data on disk, use the following command
to filter leaks based on those saved heap snapshots (query the default
data location by `memlab get-default-work-dir`).

```bash
memlab find-leaks --leak-filter <PATH TO leak-filter.js>
```
Here is an example TypeScript file defining a leak filter.
The command line interface only accepts compiled JavaScript file.
You can also define the leak filter in JavaScript (without the
type annotations.

```typescript
import {IHeapNode, IHeapSnapshot, HeapNodeIdSet, utils} from '@memlab/core';

function initMap(snapshot: IHeapSnapshot): Record<string, number> {
  const map = Object.create(null);
  snapshot.nodes.forEach(node => {
    if (node.type !== 'string') {
      return;
    }
    const str = utils.getStringNodeValue(node);
    if (str in map) {
      ++map[str];
    } else {
      map[str] = 1;
    }
  });
  return map;
}
const beforeLeakFilter = (snapshot: IHeapSnapshot, _leakedNodeIds: HeapNodeIdSet): void => {
  map = initMap(snapshot);
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

Lifecycle function callback that is invoked initially once before
the subsequent `leakFilter` function calls. This callback could
be used to initialize some data stores or any one-off
preprocessings.

* **Parameters**:
  * snapshot: `IHeapSnapshot` | the final heap snapshot taken after
    all browser interactions are done.
    Check out [IHeapSnapshot](core_src.IHeapSnapshot.md) for more APIs that queries the heap snapshot.
  * leakedNodeIds: `Set<number>` | the set of ids of all JS heap objects
    allocated by the `action` call but not released after the `back` call
    in browser.

* **Examples**:
```typescript
module.exports = {
  beforeLeakFilter: (snapshot, leakedNodeIds) {
    // initialize some data stores
  },
  leakFilter(node, snapshot, leakedNodeIds) {
    // use the data stores
  },
};
```

 * **Source**:
    * core/src/lib/Types.ts:404

___

### <a id="leakfilter" name="leakfilter"></a> **leakFilter**: [`LeakFilterCallback`](../modules/core_src.md#leakfiltercallback)

This callback defines how you want to filter out the
leaked objects. The callback is called for every node (JS heap
object in browser) allocated by the `action` callback, but not
released after the `back` callback. Those objects could be caches
that are retained in memory on purpose, or they are memory leaks.

This optional callback allows you to define your own algorithm
to cherry pick memory leaks for specific JS program under test.

If this optional callback is not defined, memlab will use its
built-in leak filter, which considers detached DOM elements
and unmounted Fiber nodes (detached from React Fiber tree) as
memory leaks.

* **Parameters**:
  * node: `IHeapNode` | one of the heap object allocated but not released.
  * snapshot: `IHeapSnapshot` | the final heap snapshot taken after
    all browser interactions are done.
    Check out [IHeapSnapshot](core_src.IHeapSnapshot.md) for more APIs that queries the heap snapshot.
  * leakedNodeIds: `Set<number>` | the set of ids of all JS heap objects
    allocated by the `action` call but not released after the `back` call
    in browser.

* **Returns**: the boolean value indicating whether the given node in
  the snapshot should be considered as leaked.

```javascript
// save as leak-filter.js
module.exports = {
  leakFilter(node, snapshot, leakedNodeIds) {
    // any unreleased node (JS heap object) with 1MB+
    // retained size is considered a memory leak
    return node.retainedSize > 1000000;
  },
};
```

Use the leak filter definition in command line interface:
```bash
memlab find-leaks --leak-filter <PATH TO leak-filter.js>
```

```bash
memlab run --scenario <SCENARIO FILE> --leak-filter <PATH TO leak-filter.js>
```

 * **Source**:
    * core/src/lib/Types.ts:453

---
id: "core_src"
title: "Package: @memlab/core"
sidebar_label: "core/src"
sidebar_position: 0
custom_edit_url: null
---

## Interfaces

- [IBrowserInfo](../interfaces/core_src.IBrowserInfo.md)
- [IHeapEdge](../interfaces/core_src.IHeapEdge.md)
- [IHeapEdges](../interfaces/core_src.IHeapEdges.md)
- [IHeapLocation](../interfaces/core_src.IHeapLocation.md)
- [IHeapNode](../interfaces/core_src.IHeapNode.md)
- [IHeapNodes](../interfaces/core_src.IHeapNodes.md)
- [IHeapSnapshot](../interfaces/core_src.IHeapSnapshot.md)
- [IHeapStringNode](../interfaces/core_src.IHeapStringNode.md)
- [ILeakFilter](../interfaces/core_src.ILeakFilter.md)
- [IScenario](../interfaces/core_src.IScenario.md)

## Type Aliases

### <a id="checkpageloadcallback" name="checkpageloadcallback"></a> **CheckPageLoadCallback**: (`page`: [`Page`](core_src.md#page)) => `Promise`<`boolean`\>

Callback function to provide if the page is loaded.
For concrete example, check out [isPageLoaded](../interfaces/core_src.IScenario.md#ispageloaded).

 * **Parameters**:
    * `page`: [`Page`](core_src.md#page) | puppeteer's [Page](https://pptr.dev/api/puppeteer.page/) object. To import this type, check out [Page](core_src.md#page).
 * **Returns**: `Promise`<`boolean`\> | a boolean value, if it returns `true`, memlab will consider
the navigation completes, if it returns `false`, memlab will keep calling
this callback until it returns `true`. This is an async callback, you can
also `await` and returns `true` until some async logic is resolved.

 * **Source**:
    * core/src/lib/Types.ts:914

___

### <a id="cookies" name="cookies"></a> **Cookies**: { `domain?`: `string` ; `name`: `string` ; `value`: `string`  }[]

Data structure for holding cookies.
For concrete example, check out [cookies](../interfaces/core_src.IScenario.md#cookies).

 * **Source**:
    * core/src/lib/Types.ts:186

___

### <a id="edgeiterationcallback" name="edgeiterationcallback"></a> **EdgeIterationCallback**: (`edge`: [`IHeapEdge`](../interfaces/core_src.IHeapEdge.md)) => `Optional`<{ `stop`: `boolean`  }\> \| `void`

Executes a provided callback once for JavaScript references.
For concrete examples, check out [forEachReference](../interfaces/core_src.IHeapNode.md#foreachreference)
or [forEachReferrer](../interfaces/core_src.IHeapNode.md#foreachreferrer).

 * **Parameters**:
    * `edge`: [`IHeapEdge`](../interfaces/core_src.IHeapEdge.md)
 * **Returns**: `Optional`<{ `stop`: `boolean`  }\> \| `void` | this API returns void

 * **Source**:
    * core/src/lib/Types.ts:1447

___

### <a id="initleakfiltercallback" name="initleakfiltercallback"></a> **InitLeakFilterCallback**: (`snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md), `leakedNodeIds`: `HeapNodeIdSet`) => `void`

Lifecycle function callback that is invoked initially once before calling any
leak filter function.
For concrete example, check out [beforeLeakFilter](../interfaces/core_src.ILeakFilter.md#beforeleakfilter).

 * **Parameters**:
    * `snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md) | heap snapshot see [IHeapSnapshot](../interfaces/core_src.IHeapSnapshot.md)
    * `leakedNodeIds`: `HeapNodeIdSet` | the set of leaked object (node) ids.
 * **Returns**: `void`

 * **Source**:
    * core/src/lib/Types.ts:411

___

### <a id="interactionscallback" name="interactionscallback"></a> **InteractionsCallback**: (`page`: [`Page`](core_src.md#page), `args?`: `OperationArgs`) => `Promise`<`void`\>

The callback defines browser interactions which are
used by memlab to interact with the web app under test.
For concrete examples, check out [action](../interfaces/core_src.IScenario.md#action) or [back](../interfaces/core_src.IScenario.md#back).

 * **Parameters**:
    * `page`: [`Page`](core_src.md#page) | the puppeteer [`Page`](https://pptr.dev/api/puppeteer.page) object, which provides APIs to interact with the web browser. To import this type, check out [Page](core_src.md#page).
    * `args?`: `OperationArgs`
 * **Returns**: `Promise`<`void`\> | no return value

 * **Source**:
    * core/src/lib/Types.ts:454

___

### <a id="leakfiltercallback" name="leakfiltercallback"></a> **LeakFilterCallback**: (`node`: [`IHeapNode`](../interfaces/core_src.IHeapNode.md), `snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md), `leakedNodeIds`: `HeapNodeIdSet`) => `boolean`

Callback that can be used to define a logic to filter the
leaked objects. The callback is only called for every node
allocated but not released from the target interaction
in the heap snapshot.

For concrete examples, check out [leakFilter](../interfaces/core_src.ILeakFilter.md#leakfilter).

 * **Parameters**:
    * `node`: [`IHeapNode`](../interfaces/core_src.IHeapNode.md) | the node that is kept alive in the memory in the heap snapshot
    * `snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md) | the snapshot of target interaction
    * `leakedNodeIds`: `HeapNodeIdSet` | the set of leaked node ids
 * **Returns**: `boolean` | the value indicating whether the given node in the snapshot
should be considered as leaked.
* **Examples**:
```javascript
// any node in the heap snapshot that is greater than 1MB
function leakFilter(node, _snapshot, _leakedNodeIds) {
 return node.retainedSize > 1000000;
};
```

 * **Source**:
    * core/src/lib/Types.ts:438

___

### <a id="page" name="page"></a> **Page**: `PuppeteerPage`

This is the puppeteer [`Page`](https://pptr.dev/api/puppeteer.page)
class used by MemLab. The puppeteer `Page` class instance provides
APIs to interact with the web browser.

The puppeteer `Page` type can be incompatible across different versions.
Your local npm-installed puppeteer version may be different from
the puppeteer used by MemLab. This may cause some type errors, for example:

```typescript
import type {Page} from 'puppeteer';
import type {RunOptions} from '@memlab/api';

const runOptions: RunOptions = {
  scenario: {
    // initial page load url: Google Maps
    url: () => {
      return "https://www.google.com/maps/@37.386427,-122.0428214,11z";
    },
    // type error here if your local puppeeter version is different
    // from the puppeteer used by MemLab
    action: async function (page: Page) {
      await page.click('button[aria-label="Hotels"]');
    },
  },
};
```

To avoid the type error in the code example above, MemLab exports the
puppeteer `Page` type used by MemLab so that your code can import it
when necessary:

```typescript
import type {Page} from '@memlab/core' // import Page type from memlab
import type {RunOptions} from 'memlab';

const runOptions: RunOptions = {
  scenario: {
    // initial page load url: Google Maps
    url: () => {
      return "https://www.google.com/maps/@37.386427,-122.0428214,11z";
    },
    // no type error here
    action: async function (page: Page) {
      await page.click('button[aria-label="Hotels"]');
    },
  },
};
```

 * **Source**:
    * core/src/lib/Types.ts:167

___

### <a id="predicator" name="predicator"></a> **Predicator**<`T`\>: (`entity`: `T`) => `boolean`

#### Type parameters

| Name | Description |
| :------ | :------ |
| `T` | the type of the entity to be checked |

the predicate callback is used to decide if a
entity of type `T`.
For more concrete examples on where it is used,
check out [findAnyReference](../interfaces/core_src.IHeapNode.md#findanyreference), [findAnyReferrer](../interfaces/core_src.IHeapNode.md#findanyreferrer),
and [findReferrers](../interfaces/core_src.IHeapNode.md#findreferrers).

 * **Parameters**:
    * `entity`: `T` | the entity to be checked
 * **Returns**: `boolean` | whether the entity passes the predicate check

 * **Source**:
    * core/src/lib/Types.ts:180

___

### <a id="runmetainfo" name="runmetainfo"></a> **RunMetaInfo**: `Object`

This data structure holds the information about memlab run.
You can retrieve the instance of this type through [getRunMetaInfo](../classes/api_src.BrowserInteractionResultReader.md#getrunmetainfo).

| Name | Type | Description |
| :------ | :------ | :------ |
| `browserInfo` | [`IBrowserInfo`](../interfaces/core_src.IBrowserInfo.md) | input configuration for the browser and output data from the browser |
| `type` | `string` | type of the memlab run |

 * **Source**:
    * core/src/lib/Types.ts:995

## Functions

### <a id="dumpnodeheapsnapshot"></a>**dumpNodeHeapSnapshot**()

Take a heap snapshot of the current program state and save it as a
`.heapsnapshot` file under a randomly generated folder inside the system's
temp folder.

**Note**: All `.heapsnapshot` files could also be loaded by Chrome DevTools.

 * **Returns**: `string` | the absolute file path to the saved `.heapsnapshot` file.

* **Examples**:
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);
})();
```

 * **Source**:
    * core/src/lib/NodeHeap.ts:84

___

### <a id="tagobject"></a>**tagObject**<`T`\>(`o`, `tag`)

Tags a string marker to an object instance, which can later be checked by
[hasObjectWithTag](../interfaces/core_src.IHeapSnapshot.md#hasobjectwithtag). This API does not modify the object instance in
any way (e.g., no additional or hidden properties added to the tagged
object).

#### Type parameters

| Name | Type |
| :------ | :------ |
| `T` | extends `object` |

 * **Parameters**:
    * `o`: `T` | specify the object instance you want to tag, you cannot tag a [primitive](https://developer.mozilla.org/en-US/docs/Glossary/Primitive).
    * `tag`: `string` | marker name to tag on the object instance
 * **Returns**: `T` | returns the tagged object instance (same reference as
the input argument `o`)
* **Examples**:
```typescript
import type {IHeapSnapshot, AnyValue} from '@memlab/core';
import {config, takeNodeMinimalHeap, tagObject} from '@memlab/core';

test('memory test', async () => {
  config.muteConsole = true;
  const o1: AnyValue = {};
  let o2: AnyValue = {};

  // tag o1 with marker: "memlab-mark-1", does not modify o1 in any way
  tagObject(o1, 'memlab-mark-1');
  // tag o2 with marker: "memlab-mark-2", does not modify o2 in any way
  tagObject(o2, 'memlab-mark-2');

  o2 = null;

  const heap: IHeapSnapshot = await takeNodeMinimalHeap();

  // expect object with marker "memlab-mark-1" exists
  expect(heap.hasObjectWithTag('memlab-mark-1')).toBe(true);

  // expect object with marker "memlab-mark-2" can be GCed
  expect(heap.hasObjectWithTag('memlab-mark-2')).toBe(false);

}, 30000);
```

 * **Source**:
    * core/src/lib/NodeHeap.ts:59

___

### <a id="takenodeminimalheap"></a>**takeNodeMinimalHeap**()

Take a heap snapshot of the current program state
and parse it as [IHeapSnapshot](../interfaces/core_src.IHeapSnapshot.md). Notice that
this API does not calculate some heap analysis meta data
for heap analysis. But this also means faster heap parsing.

 * **Returns**: `Promise`<[`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md)\> | heap representation without heap analysis meta data.

* **Examples:**
```typescript
import type {IHeapSnapshot} from '@memlab/core';
import {takeNodeMinimalHeap} from '@memlab/core';

(async function () {
  const heap: IHeapSnapshot = await takeNodeMinimalHeap();
})();
```

If you need to get the heap snapshot with heap analysis meta data, please
use [getFullHeapFromFile](heap_analysis_src.md#getfullheapfromfile).

 * **Source**:
    * core/src/lib/NodeHeap.ts:152

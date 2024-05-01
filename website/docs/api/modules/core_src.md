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
    * core/src/lib/Types.ts:1166

___

### <a id="cookie" name="cookie"></a> **Cookie**: `Object`

A single cookie entry in a Cookies list.
The `name` and `value` field is mandatory.
It is better to also specify the `domain` field, otherwise MemLab
will try to infer `domain` automatically.
The other fields are optional.
For concrete use case, please check out [cookies](../interfaces/core_src.IScenario.md#cookies).

| Name | Type | Description |
| :------ | :------ | :------ |
| `domain?` | `string` | Add when possible: Defines the domain associated with the cookie |
| `expires?` | [`Undefinable`](core_src.md#undefinable)<`number`\> | Optional: Indicates when the cookie will expire, in Unix time (seconds) |
| `httpOnly?` | [`Undefinable`](core_src.md#undefinable)<`boolean`\> | Optional: Flag to determine if the cookie is accessible only over HTTP |
| `name` | `string` | Mandatory: Represents the name of the cookie |
| `path?` | [`Undefinable`](core_src.md#undefinable)<`string`\> | Optional: Defines the domain associated with the cookie |
| `sameSite?` | [`Undefinable`](core_src.md#undefinable)<``"Strict"`` \| ``"Lax"``\> | Optional: Determines if a cookie is transmitted with cross-site requests, offering a degree of defense against cross-site request forgery attacks. |
| `secure?` | [`Undefinable`](core_src.md#undefinable)<`boolean`\> | Optional: Flag to indicate if the cookie transmission requires a secure protocol (e.g., HTTPS) |
| `session?` | [`Undefinable`](core_src.md#undefinable)<`boolean`\> | Optional: Flag to check if the cookie is a session cookie |
| `url?` | [`Undefinable`](core_src.md#undefinable)<`string`\> | Optional: Specifies the request-URI linked with the cookie setup. This can influence the cookie's default domain and path |
| `value` | `string` | Mandatory: Represents the value assigned to the cookie |

 * **Source**:
    * core/src/lib/Types.ts:236

___

### <a id="cookies" name="cookies"></a> **Cookies**: [`Cookie`](core_src.md#cookie)[]

Data structure for holding cookies.
For concrete use case, please check out [cookies](../interfaces/core_src.IScenario.md#cookies).

 * **Source**:
    * core/src/lib/Types.ts:226

___

### <a id="edgeiterationcallback" name="edgeiterationcallback"></a> **EdgeIterationCallback**: (`edge`: [`IHeapEdge`](../interfaces/core_src.IHeapEdge.md)) => [`Optional`](core_src.md#optional)<{ `stop`: `boolean`  }\> \| `void`

Executes a provided callback once for JavaScript references.
For concrete examples, check out [forEachReference](../interfaces/core_src.IHeapNode.md#foreachreference)
or [forEachReferrer](../interfaces/core_src.IHeapNode.md#foreachreferrer).

 * **Parameters**:
    * `edge`: [`IHeapEdge`](../interfaces/core_src.IHeapEdge.md)
 * **Returns**: [`Optional`](core_src.md#optional)<{ `stop`: `boolean`  }\> \| `void` | this API returns void

 * **Source**:
    * core/src/lib/Types.ts:1779

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
    * core/src/lib/Types.ts:554

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
    * core/src/lib/Types.ts:640

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
    * core/src/lib/Types.ts:581

___

### <a id="nullable" name="nullable"></a> **Nullable**<`T`\>: `T` \| ``null``

Given any type `T`, return the union type `T` and `null`

#### Type parameters

| Name | Description |
| :------ | :------ |
| `T` | The type that will be made nullable. |

 * **Source**:
    * core/src/lib/Types.ts:32

___

### <a id="optional" name="optional"></a> **Optional**<`T`\>: `T` \| ``null`` \| `undefined`

Given any type `T`, return the union type `T`, `null`, and `undefined`.

#### Type parameters

| Name | Description |
| :------ | :------ |
| `T` | The type that will be made both nullable and undefinable. |

 * **Source**:
    * core/src/lib/Types.ts:38

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
    * core/src/lib/Types.ts:207

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
    * core/src/lib/Types.ts:220

___

### <a id="referencefiltercallback" name="referencefiltercallback"></a> **ReferenceFilterCallback**: (`edge`: [`IHeapEdge`](../interfaces/core_src.IHeapEdge.md), `snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md), `isReferenceUsedByDefault`: `boolean`) => `boolean`

Callback that can be used to define a logic to decide whether
a reference should be filtered (included) for some
calculations (e.g., retainer trace calculation)

For concrete examples, check out [leakFilter](../interfaces/core_src.ILeakFilter.md#leakfilter).

 * **Parameters**:
    * `edge`: [`IHeapEdge`](../interfaces/core_src.IHeapEdge.md) | the reference (edge) that is considered for calcualting the retainer trace
    * `snapshot`: [`IHeapSnapshot`](../interfaces/core_src.IHeapSnapshot.md) | the final snapshot taken after all browser interactions are done.
    * `isReferenceUsedByDefault`: `boolean` | MemLab has its own default logic for whether a reference should be filtered (included), if this parameter is true, it means MemLab will consider this reference for inclusion
 * **Returns**: `boolean` | the value indicating whether the given reference should be
filtered (i.e., included)

Please also be aware that some edges like self-referencing edges,
JS engine's internal edges, and hidden edges should not be considered
as part of the retainer trace. These edges could make the retainer trace
unncessarily complex and cause confusion. `isReferenceUsedByDefault` will
be `false` for these types of edges.

* **Examples**:
```javascript
// exclude react fiber references
function retainerReferenceFilter(edge, _snapshot, _isReferenceUsedByDefault) {
  if (edge.name_or_index.toString().startsWith('__reactFiber$')) {
    return false;
  }
  // exclude other references here
  // ...
  return true;
};
```

 * **Source**:
    * core/src/lib/Types.ts:624

___

### <a id="runmetainfo" name="runmetainfo"></a> **RunMetaInfo**: `Object`

This data structure holds the information about memlab run.
You can retrieve the instance of this type through [getRunMetaInfo](../classes/api_src.BrowserInteractionResultReader.md#getrunmetainfo).

| Name | Type | Description |
| :------ | :------ | :------ |
| `browserInfo` | [`IBrowserInfo`](../interfaces/core_src.IBrowserInfo.md) | input configuration for the browser and output data from the browser |
| `type` | `string` | type of the memlab run |

 * **Source**:
    * core/src/lib/Types.ts:1247

___

### <a id="undefinable" name="undefinable"></a> **Undefinable**<`T`\>: `T` \| `undefined`

Given any type `T`, return the union type `T` and `undefined`.

#### Type parameters

| Name | Description |
| :------ | :------ |
| `T` | The type that will be made undefinable. |

 * **Source**:
    * core/src/lib/Types.ts:44

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

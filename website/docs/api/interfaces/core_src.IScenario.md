---
id: "core_src.IScenario"
title: "Interface: IScenario"
sidebar_label: "IScenario"
custom_edit_url: null
---

This is the type definition for the test scenario file that you pass in to
the `memlab run --scenario` command. The test scenario instance can also be
passed to the [`run` API](docs/api/modules/api_src#run) exported by `@memlab/api`.

## Properties

### <a id="action" name="action"></a> `Optional` **action**: [`InteractionsCallback`](../modules/core_src.md#interactionscallback)

`action` is callback function to define how the interactions should take place.
`memlab` will interact with the page following what's described in the body
of this function right before taking a heap snapshot for the target page.

* **Examples**:
```typescript
async function action(page) {
  const [button] = await page.$x("//button[contains(., 'Create detached DOMs')]");
  if (button) {
    await button.click();
  }
}
```

 * **Source**:
    * core/src/lib/Types.ts:292

___

### <a id="back" name="back"></a> `Optional` **back**: [`InteractionsCallback`](../modules/core_src.md#interactionscallback)

`back` is callback function to define how memlab should back/revert the action
performed before. Think of it as undo action.

Example:
```typescript
async function back(page) {
  await page.click('a[href="/"]')
}
```

 * **Source**:
    * core/src/lib/Types.ts:304

___

### <a id="beforeleakfilter" name="beforeleakfilter"></a> `Optional` **beforeLeakFilter**: [`InitLeakFilterCallback`](../modules/core_src.md#initleakfiltercallback)

Lifecycle function callback that is invoked initially once before calling any
leak filter function.

**`param`** heap snapshot see [IHeapSnapshot](core_src.IHeapSnapshot.md)

**`param`** the set of leaked object (node) ids.

 * **Source**:
    * core/src/lib/Types.ts:321

___

### <a id="ispageloaded" name="ispageloaded"></a> `Optional` **isPageLoaded**: [`CheckPageLoadCallback`](../modules/core_src.md#checkpageloadcallback)

Callback function to provide if the page is loaded.

**`param`** puppeteer's [Page](https://pptr.dev/api/puppeteer.page/) object.

 * **Source**:
    * core/src/lib/Types.ts:313

___

### <a id="leakfilter" name="leakfilter"></a> `Optional` **leakFilter**: [`LeakFilterCallback`](../modules/core_src.md#leakfiltercallback)

Callback that can be used to define a logic to filter the
leaked objects. The callback is only called for every node
allocated but not released from the target interaction
in the heap snapshot.

**`param`** the node that is kept alive in the memory in the heap snapshot

**`param`** the snapshot of target interaction

**`param`** the set of leaked node ids

**`returns`** the value indicating whether the given node in the snapshot
should be considered as leaked.
* **Examples**:
```javascript
// any node in the heap snapshot that is greater than 1MB
function leakFilter(node, _snapshot, _leakedNodeIds) {
 return node.retainedSize > 1000000;
};
```

 * **Source**:
    * core/src/lib/Types.ts:342

## Methods

### <a id="cookies"></a>`Optional` **cookies**()

If the page you are running memlab against requires authentication or
specific cookie(s) to be set, you can pass them as
a list of <name, value> pairs.

 * **Returns**: [`Cookies`](../modules/core_src.md#cookies)
 * **Source**:
    * core/src/lib/Types.ts:264

___

### <a id="repeat"></a>`Optional` **repeat**()

Specifies how many times `memlab` should repeat the `action` and `back`.

 * **Returns**: `number`
 * **Source**:
    * core/src/lib/Types.ts:308

___

### <a id="url"></a>**url**()

String value of the initial url of the page.

* **Examples**:
```typescript
const scenario = {
  url: () => 'https://www.youtube.com',
  // ...
}
```

 * **Returns**: `string`
 * **Source**:
    * core/src/lib/Types.ts:276

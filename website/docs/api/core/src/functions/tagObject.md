# Function: tagObject()

> **tagObject**\<`T`\>(`o`, `tag`): `T`

Defined in: core/src/lib/NodeHeap.ts:59

Tags a string marker to an object instance, which can later be checked by
hasObjectWithTag. This API does not modify the object instance in
any way (e.g., no additional or hidden properties added to the tagged
object).

## Type Parameters

### T

`T` *extends* `object`

## Parameters

### o

`T`

specify the object instance you want to tag, you cannot tag a
[primitive](https://developer.mozilla.org/en-US/docs/Glossary/Primitive).

### tag

`string`

marker name to tag on the object instance

## Returns

`T`

returns the tagged object instance (same reference as
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

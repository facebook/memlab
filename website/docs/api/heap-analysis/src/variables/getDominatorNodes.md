# Variable: getDominatorNodes()

> **getDominatorNodes**: (`ids`, `snapshot`) => `Set`\<`number`\>

Defined in: heap-analysis/src/index.ts:20

This API calculate the set of
[dominator nodes](https://firefox-source-docs.mozilla.org/devtools-user/memory/dominators/index.html)
of the set of input heap objects.

## Parameters

### ids

`Set`\<`number`\>

Set of ids of heap objects (or nodes)

### snapshot

`IHeapSnapshot`

heap loaded from a heap snapshot

## Returns

`Set`\<`number`\>

the set of dominator nodes/objects
* * **Examples**:
```typescript
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile, getDominatorNodes} from '@memlab/heap-analysis';

class TestObject {}

(async function () {
  const t1 = new TestObject();
  const t2 = new TestObject();

  // dump the heap of this running JavaScript program
  const heapFile = dumpNodeHeapSnapshot();
  const heap = await getFullHeapFromFile(heapFile);

  // find the heap node for TestObject
  let nodes = [];
  heap.nodes.forEach(node => {
    if (node.name === 'TestObject' && node.type === 'object') {
      nodes.push(node);
    }
  });

  // get the dominator nodes
  const dominatorIds = getDominatorNodes(
    new Set(nodes.map(node => node.id)),
    heap,
  );
})();
```

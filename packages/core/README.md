# @memlab/core

The memlab core library. The CLI, the API, the heap analyses, and the MCP
server are all built on it. It contains:

- **A heap snapshot parser** for V8 (Chromium, Node.js, Electron) and Hermes
  `.heapsnapshot` files.
- **An object-oriented heap graph API**: walk objects (`IHeapNode`) and the
  references between them (`IHeapEdge`), with dominators and retained sizes.
- **Leak detection**: retainer traces from GC roots to leaked objects, and
  clustering of similar traces so one bug shows up as one result.
- **Memory assertions for Node.js**: a running program or unit test can take a
  heap snapshot of itself and check what is still alive.
- **Snapshot anonymization**: strip user data from a heap snapshot so it can
  be shared.
- Shared configuration, file layout, logging, and utilities.

## Install

```bash
npm install @memlab/core
```

## Write memory assertions in a unit test

Tag the objects you care about, take a heap snapshot of the current process,
and assert on what survived. `tagObject` doesn't modify the object:

```typescript
import type {AnyValue, IHeapSnapshot} from '@memlab/core';
import {config, takeNodeMinimalHeap, tagObject} from '@memlab/core';

test('memory test', async () => {
  config.muteConsole = true;
  const o1: AnyValue = {};
  let o2: AnyValue = {};

  tagObject(o1, 'memlab-mark-1');
  tagObject(o2, 'memlab-mark-2');

  o2 = null;

  const heap: IHeapSnapshot = await takeNodeMinimalHeap();

  // o1 is still referenced
  expect(heap.hasObjectWithTag('memlab-mark-1')).toBe(true);
  // o2 can be garbage collected
  expect(heap.hasObjectWithTag('memlab-mark-2')).toBe(false);
}, 30000);
```

`IHeapSnapshot` also has `hasObjectWithClassName`, `hasObjectWithPropertyName`,
`getAnyObjectWithClassName`, and `getNodeById`.

## Walk a heap snapshot

Load any `.heapsnapshot` file (here, one of the current process) and iterate
over its objects and references. Loading a file from disk lives in
[`@memlab/heap-analysis`](https://www.npmjs.com/package/@memlab/heap-analysis):

```typescript
import type {IHeapNode, IHeapSnapshot} from '@memlab/core';
import {dumpNodeHeapSnapshot} from '@memlab/core';
import {getFullHeapFromFile} from '@memlab/heap-analysis';

(async function () {
  const heapFile = dumpNodeHeapSnapshot();
  const heap: IHeapSnapshot = await getFullHeapFromFile(heapFile);

  heap.nodes.forEach((node: IHeapNode) => {
    if (node.is_detached) {
      console.log(`detached ${node.name} @${node.id}: ${node.retainedSize} bytes`);
      // node.references and node.referrers are the edges out of and into it
    }
  });
})();
```

## Anonymize a heap snapshot before sharing it

Heap snapshots contain the strings your app held in memory, which can include
user data. `anonymizeHeapSnapshotFile` writes a copy with those values
redacted and reports what it changed:

```typescript
import {anonymizeHeapSnapshotFile} from '@memlab/core';

(async function () {
  const report = await anonymizeHeapSnapshotFile(
    '/tmp/capture.heapsnapshot',
    '/tmp/shareable.heapsnapshot',
  );
  console.log(`redacted ${report.valuesRedacted} string values`);
  for (const family of report.unclassifiedLabelFamilies) {
    console.log(`still in the clear: ${family.count} x ${family.shape}`);
  }
})();
```

`auditHeapSnapshotFile` reports what would be redacted without writing a
file. The CLI equivalent is `memlab anonymize`.

## Main exports

| Export | What it does |
| --- | --- |
| `takeNodeMinimalHeap` | Snapshot the current Node.js process and return the heap graph |
| `dumpNodeHeapSnapshot` | Write a heap snapshot of the current process to a file |
| `tagObject` | Mark an object so it can be found in a later snapshot |
| `anonymizeHeapSnapshotFile`, `auditHeapSnapshotFile` | Redact, or audit, user data in a snapshot file |
| `serializeHeapSnapshot` | Write a heap graph back out as a snapshot |
| `config` | Global memlab configuration (working directory, console output, and more) |
| `IHeapSnapshot`, `IHeapNode`, `IHeapEdge`, `IScenario`, ... | Types for the heap graph and test scenarios |

The full reference is in the
[API documentation](https://meta.github.io/memlab/docs/api/core/src/).

## Online Resources

* [Official Website and Demo](https://meta.github.io/memlab)
* [Documentation](https://meta.github.io/memlab/docs/intro)
* [How memlab Works](https://meta.github.io/memlab/docs/how-memlab-works)

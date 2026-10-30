# @memlab/heap-analysis

memlab's heap analyses, and the plugin interface for writing your own. Each
analysis reads one or more JavaScript heap snapshots and reports a kind of
memory problem: duplicated strings, detached DOM, objects or collections that
keep growing, and more. Not every problem is a leak.

The same analyses run from the `memlab analyze` command and from code. The
snapshots can come from Chromium, Node.js, Electron, or Hermes.

## Install

```bash
npm install @memlab/heap-analysis
```

To run the analyses from a terminal instead, install the CLI:
`npm install -g memlab`.

## Built-in analyses

| `memlab analyze ...` | Class | What it reports |
| --- | --- | --- |
| `string` | `StringAnalysis` | Duplicated string instances |
| `detached-DOM` | `DetachedDOMElementAnalysis` | Detached DOM elements |
| `global-variable` | `GlobalVariableAnalysis` | Global variables |
| `object-size` | `ObjectSizeAnalysis` | The largest objects |
| `object-fanout` | `ObjectFanoutAnalysis` | Objects with the most outgoing references |
| `object-shallow` | `ObjectShallowAnalysis` | Duplicated objects, compared by key and value without recursing |
| `shape` | `ObjectShapeAnalysis` | The object shapes that retain the most memory |
| `collections-with-stale` | `CollectionsHoldingStaleAnalysis` | Collections holding stale objects |
| `unbound-object` | `ObjectUnboundGrowthAnalysis` | Objects that keep growing across snapshots |
| `unbound-shape` | `ShapeUnboundGrowthAnalysis` | Shapes that keep growing across snapshots |
| `unbound-collection` | (CLI only) | Collections whose entry count keeps growing |
| `unmounted-fiber-node` | (CLI only) | Unmounted React Fiber nodes |
| `react-hooks` | (CLI only) | Memory breakdown of the largest React components |
| `object` | (CLI only) | The properties of one object |

Run `memlab analyze` to see them all, and `memlab help analyze <name>`
for an analysis's options.

## Run an analysis from the CLI

On a single snapshot, for example one saved from Chrome DevTools:

```bash
memlab analyze string --snapshot /path/to/file.heapsnapshot
```

On a series of snapshots of the same app, to find growth:

```bash
memlab analyze unbound-object --snapshot-dir /path/to/snapshots/
```

Without `--snapshot` or `--snapshot-dir`, memlab uses the snapshots from the
last `memlab run`.

## Run an analysis from code

```typescript
import {StringAnalysis, ShapeUnboundGrowthAnalysis} from '@memlab/heap-analysis';

(async function () {
  // one snapshot
  const strings = new StringAnalysis();
  // the console output is saved to result.analysisOutputFile
  const result = await strings.analyzeSnapshotFromFile(snapshotFile);
  // structured, analysis-specific results
  const duplicated = strings.getTopDuplicatedStringsInCount();

  // a directory of snapshots
  const shapes = new ShapeUnboundGrowthAnalysis();
  await shapes.analyzeSnapshotsInDirectory(snapshotDirectory);
  const growing = shapes.getShapesWithUnboundGrowth();
})();
```

Both methods accept `{workDir}` to choose where output and intermediate files
go.

## Write your own analysis

Extend `BaseAnalysis`, name it, and implement `process`. `loadHeapSnapshot`
gives you the parsed heap graph
([`IHeapSnapshot`](https://meta.github.io/memlab/docs/api/core/src/interfaces/IHeapSnapshot))
with retained sizes already computed:

```typescript
import type {HeapAnalysisOptions} from '@memlab/heap-analysis';
import {BaseAnalysis, loadHeapSnapshot} from '@memlab/heap-analysis';

class LargeArrayAnalysis extends BaseAnalysis {
  public getCommandName(): string {
    return 'large-array';
  }

  public getDescription(): string {
    return 'List arrays that retain more than 1MB';
  }

  async process(options: HeapAnalysisOptions): Promise<void> {
    const heap = await loadHeapSnapshot(options);
    heap.nodes.forEach(node => {
      if (node.name === 'Array' && node.retainedSize > 1024 * 1024) {
        console.log(`@${node.id}: ${node.retainedSize} bytes`);
      }
    });
  }
}

(async function () {
  await new LargeArrayAnalysis().analyzeSnapshotFromFile(snapshotFile);
})();
```

To run it from the CLI, compile it to a plain JavaScript file whose name ends
in `Analysis.js` and export the class. Then pass the file with
`--analysis-plugin`:

```bash
memlab analyze large-array --analysis-plugin ./LargeArrayAnalysis.js \
  --snapshot /path/to/file.heapsnapshot
```

## Other exports

| Export | What it does |
| --- | --- |
| `getFullHeapFromFile` | Load and parse a `.heapsnapshot` file into a heap graph |
| `loadHeapSnapshot`, `getSnapshotFileForAnalysis`, `getSnapshotDirForAnalysis` | Find and load the snapshot(s) an analysis was asked to run on |
| `snapshotMapReduce` | Process a directory of snapshots one at a time, then combine the results |
| `takeNodeFullHeap` | Snapshot the current Node.js process and return the full heap graph |
| `getDominatorNodes` | Find the dominator nodes of a set of objects |

The full reference is in the
[API documentation](https://meta.github.io/memlab/docs/api/heap-analysis/src/).

## Online Resources

* [Official Website and Demo](https://meta.github.io/memlab)
* [Documentation](https://meta.github.io/memlab/docs/intro)
* [`memlab analyze` reference](https://meta.github.io/memlab/docs/cli/CLI-commands#memlab-analyze)

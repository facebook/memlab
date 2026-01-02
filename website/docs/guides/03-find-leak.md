---
id: 'guides-find-leaks'
---

# Find Memory Leaks Not Reported

By default, memlab reports high-confidence memory leaks (filtered out by its
built-in leak detector). In case some memory leaks exist but memlab
does not report the leaks, this tutorial shows other options to surface
suspicious heap objects.

Let's start by running the following command. Make sure to not specify any leak
filter in the scenario file. MemLab will apply its built-in leak detectors
which find detached DOM elements and unmounted React Fiber nodes.
Sometimes this may not detect all (or any) memory leaks.

```bash
memlab run --scenario ~/memlab/scenarios/unbound-object.js
```

Now let's run:
```bash
memlab find-leaks --trace-all-objects
```

This will ask memlab to treat every object allocated by the target interaction
as a memory leak. In this case, there are a bunch of objects not
released from the target interaction.

memlab clusters the retainer traces of the leaked objects and print them in
decreasing order based on the
[aggregated retained sizes](https://developer.chrome.com/docs/devtools/memory-problems/memory-101/#retained_size)
of leak clusters.

```bash
MemLab found 46 leak(s)
--Similar leaks in this run: 4--
--Retained size of leaked objects: 8.3MB--
[Window] (native) @35847 [8.3MB]
  --20 (element)--->  [InternalNode] (native) @130981728 [8.3MB]
  --8 (element)--->  [InternalNode] (native) @130980288 [8.3MB]
  --1 (element)--->  [EventListener] (native) @131009888 [8.3MB]
  --1 (element)--->  [V8EventListener] (native) @224808192 [8.3MB]
  --1 (element)--->  [eventHandler] (closure) @168079 [8.3MB]
  --context (internal)--->  [<function scope>] (object) @181905 [8.3MB]
  --bigArray (variable)--->  [Array] (object) @182925 [8.3MB]
  --elements (internal)--->  [(object elements)] (array) @182929 [8.3MB]


--Similar leaks in this run: 79--
--Retained size of leaked objects: 16.9KB--
[Window] (native) @35847 [8.3MB]
  --17 (element)--->  [InternalNode] (native) @224820352 [0 byte]
  --3 (element)--->  [InternalNode] (native) @224766112 [0 byte]
  --1 (element)--->  [InternalNode] (native) @224771072 [0 byte]
  --1 (element)--->  [InternalNode] (native) @224723840 [540 bytes]
  --1 (element)--->  [InternalNode] (native) @224723680 [540 bytes]
  --1 (element)--->  [InternalNode] (native) @224818752 [84 bytes]


--Similar leaks in this run: 62--
--Retained size of leaked objects: 12.8KB--
[Window] (native) @35847 [8.3MB]
  --4 (element)--->  [HTMLDocument] (native) @35845 [6KB]
  --part of key -> value pair in ephemeron table (internal)--->  [HTMLDocument] (object) @167199 [28 bytes]
  --__proto__ (property)--->  [HTMLDocument] (object) @173029 [144 bytes]
  --properties (internal)--->  [(object properties)] (array) @182697 [76 bytes]

...
```

One way to view the retainer traces in a slightly less verbose would be to apply
[leak-filter](../api/core/src/interfaces/ILeakFilter) or to use `--trace-object-size-above`.
The below will only show the traces whose `retainedSize` is greater than `1MB`
```bash
memlab find-leaks --trace-object-size-above 1000000
```

The result will look like:
```bash
MemLab found 1 leak(s)
--Similar leaks in this run: 4--
--Retained size of leaked objects: 8.3MB--
[Window] (native) @33651 [8.3MB]
  --20 (element)--->  [InternalNode] (native) @216691968 [8.3MB]
  --8 (element)--->  [InternalNode] (native) @216691168 [8.3MB]
  --1 (element)--->  [EventListener] (native) @216563936 [8.3MB]
  --1 (element)--->  [V8EventListener] (native) @216563776 [8.3MB]
  --1 (element)--->  [eventHandler] (closure) @160711 [8.3MB]
  --context (internal)--->  [<function scope>] (object) @176463 [8.3MB]
  --bigArray (variable)--->  [Array] (object) @176465 [8.3MB]
  --elements (internal)--->  [(object elements)] (array) @176489 [8.3MB]
```

Another options is using `--ignore-leak-cluster-size-below` which ignore memory
leak clusters with aggregated retained size smaller than a specified threshold.
To learn more about the `find-leaks` command, please run `memlab find-leaks -h`.

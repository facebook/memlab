---
sidebar_position: 2
---
# How MemLab Works

## Memory Lab
Previously the leak detection and analysis were done manually. MemLab is designed to automate and ease the process. The tool can be configured to filter uninteresting traces or known leak trace patterns.

## Page Interaction and Heap Snapshots
MemLab automatically starts a headless Chrome browser, interacts with the page, and takes heap snapshots. For example, if we want to find leaked objects in target page `Page A` . MemLab visits pages in the following order:
* Visit a different page `Page B` and take snapshot `S1`
* Visit the target page `Page A` and take snapshot `S2`
* Visit a few different pages (other than the target page) to clean up memories that are held up as cache
* Finally Come back to the `Page A` and take snapshot `S3`
## Heap Analysis
**Snapshot decoding**: MemLab decodes v8 (and hermes) heap snapshots and provides tool that allows you to query JavaScript heap object.
**Leak detection**: A superset of leaked objects from the target page can be derived as follows:

```(S2 \ S1) ∩ S3```

MemLab first gets a set of allocated objects in `Page A` by excluding `S1`’s objects from `S2`. Then it takes an intersection with objects in `S3` which are the objects that are allocated in `Page A` but remain alive after MemLab navigates away.
We also use domain-specific knowledge to further refine the list of leaked objects (e.g., detached DOM elements, error stack trace etc. MemLab also identifies React Fiber tree and detect detached Fiber nodes). We would love to hear if there are other such application-specific rules for identifying leaks.
## Leak analysis
In this stage, MemLab queries the heap for the shortest path from the garbage collector root (GC) to leaked objects. To avoid duplication, incoming leaked path searching will not go through edges and nodes in the previous paths. For each object in the heap, MemLab calculates the dominator node and retained size info, which indicates the size of the heap subgraph that can be released if an object is deallocated.

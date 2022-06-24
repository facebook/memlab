# How memlab Works
`memlab` decodes v8 (and hermes) heap snapshots and [provides API](/under-construction) that allows you to query JavaScript heap objects.

`memlab` starts a headless Chrome browser to interact (loading a page, performing an action, and going back) with the pages. Then, it takes heap snapshots. For example, if we want to find leaked objects on target page `TP`, `memlab` visits pages in the following order:
* Visit a different page - let's call it baseline page `BP` and take a heap snapshot named `SBP`
* Visit the target page `TP` and take another heap snapshot
`STP`
* Finally come back to the baseline page (`BP`), and take the last heap snapshot `SBP'`.
With these heap snapshots, `memlab` find memory leaks as explained in the next section.

## Heap Analysis
`memlab` parses the raw snapshot and applies leak detection algorithms. A superset of leaked objects from the target page can be derived as follows:

```(STP \ SPB) ∩ SPB'```

`memlab` excludes a set of allocated objects `SPB` from `SPT`. Then it intersects with `SPB'` to get the objects that are
- allocated in the snapshot of target page `STP`
- and remain alive after memlab navigates away.

We also use domain-specific heuristics to further refine the list of leaked objects (e.g., detached DOM elements, error stack trace, etc. `memlab` also identifies React Fiber tree and detects detached Fiber nodes). We would love to hear if there are other such application-specific rules for identifying leaks.

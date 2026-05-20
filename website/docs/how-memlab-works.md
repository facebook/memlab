# How memlab Works

In a nutshell, memlab starts a headless Chrome browser, interacts with the page,
takes heap snapshots, and finds memory leaks by parsing, diffing, and analyzing
those snapshots.

## 1. Browser Interaction
For example, if we want to find memory leaks triggered by interactions
on a target page (`TP`), memlab performs the following steps:
 * Visit a different page — called the baseline page (`BP`) — and take a
   heap snapshot named `SBP`.
   *(The baseline page is specified by the **`url`**
   callback in the [test scenario](./api/core/src/interfaces/IScenario).)*
 * Visit the target page `TP` or trigger the target interactions, and take
   another heap snapshot `STP`.
   *(Navigating to the target page or triggering the target interactions is
   specified by the **`action`** callback in the
   [test scenario](./api/core/src/interfaces/IScenario).)*
 * Finally, navigate to a different page or perform an in-page interaction to
   release memory that should no longer be needed from the
   target page. This is the final state (`FP`), where we take the final heap
   snapshot `SFP`.
   For example, in this step you might close the widget opened by the target
   interactions, or return to the baseline page.
   *(The final navigation or interaction is specified by the **`back`**
   callback in the [test scenario](./api/core/src/interfaces/IScenario).)*


With these heap snapshots, memlab can find memory leaks as described
in the next section.

## 2. Heap Analysis

**Snapshot decoding**: memlab decodes V8 (or Hermes) heap snapshots and
provides [APIs](./api/core/src/interfaces/IHeapSnapshot) that allow
querying the JavaScript heap.

**Leak detection**: A superset of objects leaked from the target page can
be derived as follows:

```math
(STP \ SBP) ∩ SFP
```

MemLab first gets the set of objects allocated during `TP` (target interaction)
by excluding `SBP`'s objects (objects allocated on the baseline page)
from `STP` (the target heap snapshot).

Then it intersects with objects in `FP` (objects remaining on the
final page) to get objects that:

 1. were allocated during the target interaction (`TP`)
 2. but are still alive when they should have been released.

The built-in leak detectors use domain-specific heuristics to further refine
the list of leaked objects (e.g., detached DOM elements, error stack traces, etc.).
memlab also identifies the React Fiber tree and detects unmounted Fiber nodes.

## 3. Retainer Traces for Memory Leaks

memlab generates retainer traces from GC roots to leaked objects. Some
interactions can trigger thousands of leaked objects, and showing all of their
retainer traces would be overwhelming. Instead, memlab clusters similar retainer
traces together and shows only one representative trace per cluster.

![](../static/img/heap-diff.gif)

In the animation, A represents the BP (baseline page), B represents the
TP (target page), and A' represents the FP (final page).

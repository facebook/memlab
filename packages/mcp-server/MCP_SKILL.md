# MemLab MCP Investigation Skill

This document provides a structured investigation methodology for AI coding
assistants using the MemLab MCP server to analyze JavaScript heap snapshots.
It teaches assistants how to systematically identify memory leaks, diagnose
retention patterns, and suggest fixes.

For MCP server setup and tool reference, see the
[MCP server README](./README.md). For general MemLab usage (test scenarios,
CLI, programmatic API), see the [AI Assistant Guide](../../AI.md).

## Step 0: Obtain the Snapshot

`memlab_load_snapshot` accepts three forms of `file_path`:

- A **local absolute path** (e.g. `/tmp/snapshot.heapsnapshot`).
- A **`manifold://bucket/key` URL** — fetched automatically into a temp dir.
- A **bare snapshot filename** (no slashes) — resolved against the
  `nest_server_nodejs_heap_snapshots` bucket (where Nest auto-capture and the
  Manifold links in diffs live) and fetched automatically.

So for Nest auto-captured snapshots you can pass the filename directly instead
of shelling out to `manifold get`. For other remote URLs, download first:

```bash
curl -o /tmp/snapshot.heapsnapshot <URL>
```

Then proceed to Step 1.

### Working with multiple snapshots

Pass `keep_previous: true` to `memlab_load_snapshot` to keep earlier snapshots
resident (for before/after diffing or app-to-app comparison). Each loaded
snapshot gets a **handle**; use `memlab_snapshots` to list them, switch the
active one (`action: "switch", handle: "..."`), or unload one to free memory
(`action: "unload"`). Node ids are only valid within the snapshot they came
from — switch to the right handle before reusing an id. Each resident snapshot
holds its full graph in memory, so watch the server's RSS for multi-GB heaps;
unload snapshots you're done with.

## Step 1: Load and Triage

1. Call `memlab_load_snapshot` with the file path.
2. Read the quick diagnosis output carefully — it flags the highest-severity
   issues immediately.
3. Call `memlab_quick_diagnosis` for a combined overview in one call — it
   returns snapshot summary, top objects by retained size, class histogram with
   cumulative %, and duplicated strings. This saves 3-4 round trips compared
   to calling each tool separately.
4. Call `memlab_auto_investigate` for deep analysis — it finds the top retained
   objects, traces retainer chains with severity scoring
   (CRITICAL/HIGH/MEDIUM/LOW), identifies pinch points, detects unbounded
   caches, scans for pending Promises, summarizes object shape clusters, and
   extracts source file hints from retainer paths. It also **merges multi-path
   retention** (one subtree reached via several retainers is reported once, with
   correct — never >100% — combined retained size) and runs **framework
   detectors**: OpenTelemetry metric cardinality explosion, Relay store growth,
   suspended async-function frames, undici pool buffering, and
   AsyncLocalStorage/TCP context retention.
5. If you need more detail, call `memlab_check_health` for comprehensive
   prioritized triage.
6. Note the environment (Browser vs Node.js) from the output — this determines
   which tools are relevant.

**Parallel-safe tools:** After `memlab_load_snapshot`, all analysis tools are
read-only and can be called concurrently. Batch independent calls in a single
message for parallel execution. For example, call `memlab_quick_diagnosis` and
`memlab_auto_investigate` together to cut analysis time in half.

## Step 2: Choose an Investigation Path

Based on the triage results, follow the most relevant path below. You may need
to follow multiple paths if several issues are flagged.

### Path A: String Waste (duplicated/large strings)

Triggered when: triage shows high string duplication or strings consuming >30%
of heap.

1. `memlab_duplicated_strings` — identify top duplicated strings by total
   retained size and per-entry savings. Use `include_node_ids: true` only when
   you plan to follow up with `retainer_summary` (omitting node IDs saves tokens
   per entry).
2. `memlab_intern_opportunities` — **start here for interning**: groups
   duplicated strings by the property name and parent object shape that holds
   them, showing total savings per (property × shape) combination. This replaces
   the manual workflow of duplicated_strings → retainer_summary → codebase grep.
3. `memlab_string_patterns` — group strings by prefix to find families (API
   responses, IDs, URLs)
4. `memlab_sliced_strings` — check if small substrings keep massive parent
   strings alive
5. For the top duplicated string: `memlab_retainer_summary` with
   `class_name: "string"` or use `node_ids` from the duplicated_strings output
   (with `include_node_ids: true`) to cluster retainer patterns. Use
   `compact: true` and `framework_filter: true` to reduce token usage.
6. Follow the dominant retainer chain to identify the code path creating
   duplicates

**Common fixes:**
- Duplicated short strings from JSON.parse() or API responses → string
  interning with a `Map<string, string>` pool at ingestion time
- SlicedStrings keeping large parents alive → copy the substring:
  `str.slice(start, end)` doesn't free the parent; use
  `Buffer.from(str).toString()` or concatenation to create an independent copy
- Large serialized payloads held in closures → release references after parsing

### Path B: DOM Leaks (browser snapshots only)

Triggered when: triage shows detached DOM elements.

1. `memlab_detached_dom` — find detached DOM elements still retained
2. `memlab_detached_dom` with `group_by: "retainer"` — group detached nodes by
   what's retaining them (answers "which component is leaking the most DOM?")
3. `memlab_detached_dom` with `group_by: "element"` — group by HTML tag to see
   distribution
4. `memlab_detached_dom` with `group_by: "testid"` — group by `data-testid`
   attribute (most useful for React apps)
5. Pick the top entry by retained size → `memlab_retainer_trace` with its
   node ID
6. If a closure appears in the retainer chain → `memlab_closure_inspection` on
   the closure node to see captured variables
7. `memlab_stale_collections` — find Map/Set/Array holding detached DOM
   references. Use `min_stale_count: 5` or `min_stale_retained_size: 10240` to
   filter trivially small stale collections.
8. `memlab_find_by_property` with `__reactFiber$` to find React components
   still referencing detached nodes

**Common fixes:**
- Missing `removeEventListener` in cleanup / `useEffect` return
- React refs not cleared on unmount
- Global event handlers capturing component scope
- Stale entries in a cache Map — use `WeakRef` or clear on unmount

### Path C: Object Accumulation / Unbounded Growth

Triggered when: triage shows classes with >10,000 instances or a single object
retaining >5% of heap.

1. `memlab_class_histogram` — see per-class instance counts and retained sizes
   with cumulative % column (stop reading when cumulative % hits 95%). Use
   `suppress_suggestions: true` on repeat calls to save tokens.
2. `memlab_shape_histogram` — group generic `Object` instances by property
   structure to identify distinct record types (often reveals 3-5 distinct
   shapes behind millions of "Object" instances)
3. `memlab_cache_analysis` — scan for unbounded Map/Set/Array caches with high
   entry counts and no eviction. Also detects ad-hoc TTL caches, configured
   caches, warm-on-boot caches, and globalThis registries. Use
   `detect_identical_entries: true` to flag caches with structurally identical
   entries (suggests caching once instead of per-key).
3b. `memlab_object_cost_breakdown` — when a cache uses more memory than
   expected, this tool shows the V8 overhead breakdown (object headers, heap
   numbers vs SMIs, collection storage) and compares to theoretical minimum
4. `memlab_pinch_points` — find small objects retaining disproportionately
   large subtrees (best candidates to free)
5. For the top anomalous class: `memlab_retainer_summary` with its class
   name — this samples instances and groups retainer chains by shape. Use
   `compact: true` for abbreviated paths and `framework_filter: true` to hide
   V8/Node.js internals (system / Context, PromiseReaction, module cache
   patterns). The tool uses early termination — if the first 5 samples all
   share the same pattern, it stops and reports high confidence.
6. If a single large retainer: `memlab_trace_dominators` to auto-walk the
   dominator tree from the top retainer to the actual data in one call
   (replaces 10+ sequential `get_references` calls)
7. `memlab_object_shape` on representative instances to understand
   structure — use `node_ids` parameter to batch-inspect multiple nodes in
   one call
8. For growth detection: `memlab_diff_snapshots` comparing a before and after
   snapshot

**Common fixes:**
- Unbounded cache → add LRU eviction or use `WeakMap`/`WeakSet`
- Event listener accumulation → ensure symmetric add/remove
- Module-level arrays that grow per-request (Node.js) → scope to request
  lifecycle

### Path D: Closure Leaks

Triggered when: large closures appear in retainer traces, or
`class_histogram` shows many closures.

1. `memlab_find_nodes_by_class` with class name of the closure's function
   name (if known)
2. `memlab_closure_inspection` on the closure node — shows captured variables
   and their sizes
3. Identify which captured variable is unexpectedly large
4. `memlab_retainer_trace` on the large captured variable to understand why
   it's retained

**Common fixes:**
- Closure captures entire object when only one property is needed →
  destructure before creating closure
- Timer callbacks (`setInterval`) not cleared → clear in cleanup
- Promise chains holding references to resolved data → let data flow through,
  don't capture in outer scope

### Path E: Global Variable Bloat

Triggered when: triage shows significant global variable retained size.

1. `memlab_global_variables` — list non-built-in globals by retained size
2. For top entries: `memlab_get_references` to see what they point to
3. `memlab_dominator_subtree` to understand total memory impact

**Common fixes:**
- Module caches growing without bounds → add eviction
- Debug/dev globals left in production → gate behind `__DEV__`
- Polyfill-installed globals → evaluate if still needed

### Path F: Subscription/Listener Accumulation

Triggered when: `auto_investigate` or `check_health` reports shapes with
callback/handler/listener + context properties in high counts.

1. `memlab_event_listener_leaks` — dedicated detector for EventEmitter-style
   accumulation. Scans for `_events`/`_listeners`/`eventMap` objects, flags
   arrays with >N entries, zombie listeners (context objects with no other
   referrers), and duplicate callbacks (mount/unmount leak pattern)
2. `memlab_shape_histogram` — get the full list of object shapes, sorted by
   retained size
3. For shapes matching listener patterns (e.g., `{callback, context, ctx}`):
   `memlab_retainer_summary` with `node_ids` from example nodes to trace
   retention
4. `memlab_referrer_summary` — group all referrers of a suspect object by edge
   name and source class, answering "how many things reference this, and via
   which edges?"
5. `memlab_find_by_property` with `property_name: "callback"` to find all
   objects with callback properties

**Common fixes:**
- Signal/event subscriptions not unsubscribed on unmount → add cleanup in
  `useEffect` return or `componentWillUnmount`
- Observer pattern accumulating registrations → implement symmetric
  subscribe/unsubscribe
- EventEmitter `on()` without matching `off()` → ensure symmetric add/remove
  in lifecycle methods

### Path G: Repeated Error Accumulation

Triggered when: `auto_investigate` or `check_health` reports many identical
Error instances.

1. `memlab_get_node` on the example error node to see the full error object
2. `memlab_retainer_trace` to find where the errors are being created and
   retained
3. `memlab_find_by_property` with `property_name: "message"` and
   `property_value: "/ErrorMessageHere/"` (regex) to find all instances

**Common fixes:**
- Module being evaluated repeatedly and failing → fix the module or prevent
  re-evaluation
- Retry loops that never succeed → add max retry limits and exponential backoff
- Error objects stored in arrays/maps without bounds → add eviction or limit
  collection size

### Path H: Cardinality Explosion (metrics / cache keys / per-record fields)

Triggered when: `auto_investigate` reports an OpenTelemetry metric cardinality
pattern, or a shape's property has very high distinct-value count, or memory is
dominated by many small per-key entries.

1. `memlab_auto_investigate` — its "Known Leak Patterns" section flags OTel
   metric storage (`SyncMetricStorage` / `TemporalMetricProcessor` /
   `AttributeHashMap` with large `_valueMap`).
2. `memlab_property_distribution` — **the key tool**: for a class/shape and a
   property, reports value cardinality plus the top-K most frequent values.
   Use it on the offending metric attribute, cache key, or record field to
   confirm the explosion and see the offending values.
3. `memlab_search_strings` — regex over string nodes to find the serialized
   attribute keys (e.g. `/\[\["http.route","\/x\/[0-9a-f-]+"\]\]/`).

**Common fixes:**
- High-cardinality attribute used as a metric dimension → template/bucket it
  (`/artifact/:id` instead of `/artifact/<uuid>`), or add an allowed-attributes
  view so unbounded dimensions never enter the metric.
- Cache keyed by a unique-per-request value → key by the stable part, or add an
  LRU bound.

### Path I: Single-Snapshot Growth Guess (no baseline available)

Triggered when: you only have one snapshot and want to guess what is
accumulating before a second capture is available.

1. `memlab_growth_signals` — flags Maps/Sets keyed by timestamps or sequential
   integers (time-series / append-only logs) and large ever-growing Arrays.
   This is a heuristic; confirm with a later snapshot + `memlab_diff_snapshots`.

### Path J: Sequence / trend across 3+ snapshots

Triggered when: the question is "is anything growing unboundedly across N
captures?"

1. `memlab_sequence_analysis` with an ordered `paths` list — loads each snapshot
   transiently (does NOT change the active snapshot), reports each class's count
   at every step, and labels **"↑ every step" (leak signal)** vs **"grew net
   (noisy)"** (GC/navigation). Lists classes new since baseline. Prefer this over
   chaining `diff_snapshots` pairwise.
2. Load the last snapshot and localize with `cache_analysis` /
   `event_listener_leaks` / `event_registry` / `growth_signals` (object-identity
   matching across captures isn't possible — node ids differ per snapshot).

### Path K: Browser — real leaks vs dev/extension artifacts

Triggered when: a browser snapshot shows a huge detached-DOM tree / retainer and
you must decide if it is production-relevant.

1. `memlab_dev_artifacts` — classifies large retainers as **production** vs
   **dev-only** (retained solely via `__REACT_DEVTOOLS_GLOBAL_HOOK__`,
   `__REDUX_DEVTOOLS_EXTENSION__`, `window.Debug`, …) and totals the bytes to
   exclude from headline leak numbers. `detached_dom` reports the dev-only share
   inline.
2. `memlab_event_registry` — Backbone/observer per-model registries
   (`{"change:name":[{callback,context}], …}`): top event names by listener
   count, listeners-per-host distribution, and a structural-vs-leak verdict.

## eval / for_each calling conventions

`memlab_eval` and `memlab_for_each` run in a sandbox with strict conventions —
violating them yields opaque errors:

- **Assign output to `result`** — never `return` at the top level ("Illegal
  return statement").
- **Iterate all nodes with `snapshot.nodes.forEach(node => { … })`**, not
  `for...of` (`snapshot.nodes` is not for-of iterable). `node.references` /
  `node.referrers` ARE for-of iterable.
- **`retained_size` is unreliable inside eval** — it can read back ~0 for every
  node on some loads. Counts, property/edge walks, and string values are
  trustworthy; for authoritative retained sizes use the dedicated tools
  (`largest_objects`, `class_histogram`, `pinch_points`, `object_shape`).
- Run `memlab_eval({mode:"describe_env"})` to print the in-scope globals, the
  IHeapNode/IHeapEdge API, and a runnable example before writing code.

```
const counts = {};
snapshot.nodes.forEach(node => { counts[node.type] = (counts[node.type] || 0) + 1; });
result = counts;
```

## Reliability on large browser heaps

Full-heap scan tools (`search_nodes`, `find_by_property`, `global_variables`,
and `eval`/`for_each` walks) are slow on multi-million-node browser snapshots.
They now take a `timeout_ms` budget and **return partial results instead of
hanging** the server. Prefer index-backed tools first (`diff_snapshots`,
`detached_dom`, `event_listener_leaks`, `cache_analysis`). `memlab_server_status`
returns instantly to confirm the server is responsive and to watch RSS. If the
server is genuinely wedged by a prior long/interrupted call, a fresh server
instance fully recovers it (restart and reload the snapshot).

## Step 3: Deep Dive

When you've identified a suspicious node or pattern, use these tools for
detailed investigation:

- `memlab_trace_dominators` — **start here**: auto-walk the dominator tree from
  a large retainer to the actual data in one call (replaces 10+ sequential
  `get_references` calls)
- `memlab_get_node` — full details for a specific node
- `memlab_get_references` / `memlab_get_referrers` — traverse the object graph
- `memlab_get_property` — step into a specific property by name
- `memlab_object_shape` — see all properties of an object (supports batch via
  `node_ids`)
- `memlab_retainer_trace` — shortest path from GC root (why is this alive?)
- `memlab_dominator_subtree` — what would be freed if this node were collected
- `memlab_closure_inspection` — captured variables in a closure, OR (for a
  suspended generator/async frame) the `parameters_and_registers` slots with
  source variable names resolved where the value is also context-allocated
- `memlab_property_distribution` — value cardinality + top-K values for a
  property (cardinality-explosion diagnosis)
- `memlab_retainer_trace` with `expand: true` — show every node on the path
  (don't collapse internal runs) when the library/app boundary is hidden in the
  elided middle; the trace also highlights the first source-located app frame
- `memlab_eval` / `memlab_for_each` — custom analysis when built-in tools
  don't cover the query

## Step 4: Report Findings

Summarize your findings with:
1. **Root cause** — what is leaking/accumulating and why
2. **Impact** — how much memory is wasted (retained size)
3. **Retainer chain** — the path from GC root to the leaked objects
4. **Suggested fix** — specific code changes with rationale
5. **Verification** — how to confirm the fix works (re-take snapshot,
   `diff_snapshots`)

## Token Efficiency Tips

When analyzing large snapshots, use these options to reduce token usage:

- **`memlab_quick_diagnosis`** — replaces 4 separate tool calls (summary +
  objects + histogram + strings) with one combined call, saving ~2,000 tokens
  of repeated headers
- **`memlab_retainer_summary` with `compact: true`** — abbreviates retainer
  paths using → arrows and short names, reducing path tokens by 50-70%
- **`memlab_retainer_summary` with `framework_filter: true`** — excludes
  V8/Node.js internals (system / Context, PromiseReaction, module cache chains)
  from paths, surfacing only application-level retention
- **`memlab_duplicated_strings`** — omits example node IDs by default. Pass
  `include_node_ids: true` only when you need IDs for follow-up with
  `retainer_summary`
- **`memlab_class_histogram` with `suppress_suggestions: true`** — omits
  "Suggested next steps" boilerplate on repeat calls. The cumulative % column
  lets you stop reading when you hit 95%
- **Session output controls** — pass `quiet: true` to `memlab_load_snapshot`
  (or `memlab_snapshots`) to print the `> Snapshot: …` header once per snapshot
  instead of on every result, and `suppress_suggestions: true` to drop the
  "Suggested next steps" trailers across all tools. Both add up over a long
  (40+ call) investigation
- **Parallel calls** — after `memlab_load_snapshot`, all tools are read-only.
  Batch independent calls (e.g., `quick_diagnosis` + `auto_investigate`) in a
  single message for parallel execution

## Tool Selection Quick Reference

| I want to... | Use this tool |
|---|---|
| Start analysis | `memlab_load_snapshot` → `memlab_quick_diagnosis` + `memlab_auto_investigate` (call both in parallel) |
| Get combined overview in one call | `memlab_quick_diagnosis` (summary + objects + histogram + strings) |
| Trace from retainer to data (one call) | `memlab_trace_dominators` |
| Identify distinct record types | `memlab_shape_histogram` |
| Get detailed triage | `memlab_check_health` |
| Get overview | `memlab_snapshot_summary` or `memlab_reports` with `full_analysis` |
| Find what to free for max impact | `memlab_pinch_points` |
| Detect unbounded caches | `memlab_cache_analysis` |
| Find leaking DOM | `memlab_detached_dom` |
| Find duplicated strings | `memlab_duplicated_strings` → `memlab_string_patterns` |
| Find large objects | `memlab_largest_objects` |
| See per-class breakdown | `memlab_class_histogram` |
| Understand why object is alive | `memlab_retainer_trace` |
| See retention patterns across instances | `memlab_retainer_summary` (use `compact: true`, `framework_filter: true` for token savings) |
| Inspect multiple objects at once | `memlab_object_shape` with `node_ids` array |
| Inspect closure captures | `memlab_closure_inspection` |
| Find React component refs | `memlab_find_by_property` with `__reactFiber$` |
| Compare two snapshots | `memlab_diff_snapshots` |
| Find stale Map/Set entries | `memlab_stale_collections` (use `min_stale_count: 5` to filter noise) |
| Group detached DOM by component | `memlab_detached_dom` with `group_by: "retainer"` or `"testid"` |
| Find objects by property value | `memlab_find_by_property` with `property_value` (exact string or `/regex/`) |
| Find listener accumulation | `memlab_event_listener_leaks` (now with context distribution analysis) |
| Group array elements by property | `memlab_array_group_by` with `element_property` — eliminates common `eval` boilerplate |
| Find objects by shape and see property distribution | `memlab_find_by_shape` with `follow_property` |
| Trace retention by object shape (not class name) | `memlab_retainer_summary` with `shape: ["prop1", "prop2"]` |
| Find listener-orphaned objects | `memlab_stale_collections` with `detect_modes: ["listener_orphaned"]` |
| Filter closure variables by size | `memlab_closure_inspection` with `min_retained_size` and `max_variables` |
| Group referrers by edge/class | `memlab_referrer_summary` |
| Find repeated errors | `memlab_auto_investigate` or `memlab_check_health` |
| Detect AsyncLocalStorage/TCP leaks | `memlab_auto_investigate` (auto-detects TCP context retention patterns) |
| Detect OTel metric cardinality / Relay / suspended-async | `memlab_auto_investigate` (framework detectors in "Known Leak Patterns") |
| See a property's value cardinality + top values | `memlab_property_distribution` |
| Guess what's growing from one snapshot | `memlab_growth_signals` |
| Load from Manifold / bare filename | `memlab_load_snapshot` with `manifold://…` or a bare snapshot filename |
| Keep multiple snapshots / switch between them | `memlab_load_snapshot` with `keep_previous: true`, then `memlab_snapshots` |
| Decode a numeric property by name | `memlab_get_value` with `node_id` + `property_name` |
| Expand a truncated retainer trace | `memlab_retainer_trace` with `expand: true` |
| Inspect a suspended generator/async frame | `memlab_closure_inspection` on the Generator node |
| Trim repeated header/suggestion tokens | `memlab_snapshots` (or `memlab_load_snapshot`) with `quiet: true` / `suppress_suggestions: true` |
| Trend across 3+ ordered snapshots | `memlab_sequence_analysis` with `paths: [...]` |
| Real leak vs DevTools artifact (browser) | `memlab_dev_artifacts` (also inline in `memlab_detached_dom`) |
| Per-model event registry breakdown | `memlab_event_registry` |
| Confirm server is responsive / check RSS | `memlab_server_status` |
| Learn the eval sandbox API | `memlab_eval` with `mode: "describe_env"` |
| Bound a slow full-heap scan | `search_nodes`/`find_by_property`/`global_variables` `timeout_ms` |
| Diff with friendly names / keep active snapshot | `memlab_diff_snapshots` `before`/`after`/`baseline`/`target`, `set_active:false` |
| See string interning savings | `memlab_duplicated_strings` (shows per-entry savings and total, plus app/framework actionability) |
| Detect ad-hoc object caches | `memlab_cache_analysis` with `detect_object_caches: true` (scans for {data, timestamp} shaped objects) |
| See memory fan-out at branches | `memlab_trace_dominators` with `show_siblings: true` |
| Compare shapes across nodes | `memlab_object_shape` with `node_ids` array (batch mode shows property overlap summary) |
| Check global pollution | `memlab_global_variables` |
| Custom query | `memlab_eval` (includes helpers: `groupReferrersByEdge`, `groupArrayElementsByProperty`, `isOrphaned`, `countUniqueTargets`) or `memlab_for_each` |

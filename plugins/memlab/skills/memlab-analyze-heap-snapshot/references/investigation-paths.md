# Investigation paths

Tool sequences for each symptom found during triage. Run
`memlab_load_snapshot` first; after that every tool here is read-only and
independent calls can run in parallel.

## Path A: String Waste (duplicated/large strings)

Triggered when: triage shows high string duplication or strings consuming >30%
of heap.

1. `memlab_duplicated_strings` — identify top duplicated strings by total
   retained size and per-entry savings. Use `include_node_ids: true` only when
   you plan to follow up with `retainer_summary` (omitting node IDs saves tokens
   per entry).
2. `memlab_intern_opportunities` — **start here for interning**: groups
   duplicated strings by the property name and parent object shape that holds
   them, showing total savings per (property × shape) combination, split into
   within-load / co-retained / cross-load buckets with a **Dup ×** column
   (copies ÷ unique). Pass `summary_only: true` for a compact triage view
   (headline split + one-line verdict + ranked table only) when screening many
   snapshots. This replaces the manual workflow of duplicated_strings →
   retainer_summary → codebase grep.
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

## Path B: DOM Leaks (browser snapshots only)

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

## Path C: Object Accumulation / Unbounded Growth

Triggered when: triage shows classes with >10,000 instances or a single object
retaining >5% of heap.

1. `memlab_class_histogram` — see per-class instance counts and self sizes. It
   runs with `include_retained_size: false` by default (fast single O(N) pass,
   sorted by self size) — the safe default on large heaps. Only pass
   `include_retained_size: true` if the user EXPLICITLY asks for dominator-aware
   retained sizes; that path walks the dominator tree and can be slow or time
   out on very large heaps (deep PromiseReaction/Context chains). Use
   `suppress_suggestions: true` on repeat calls to save tokens.
2. `memlab_shape_histogram` — group generic `Object` instances by property
   structure to identify distinct record types (often reveals 3-5 distinct
   shapes behind millions of "Object" instances). Retained size per shape is a
   lower/upper-bound range by default; pass `exact_retained_size:true` (slow on
   huge heaps) for the exact dominator-deduped value.
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

## Path D: Closure Leaks

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

## Path E: Global Variable Bloat

Triggered when: triage shows significant global variable retained size.

1. `memlab_global_variables` — list non-built-in globals by retained size
2. For top entries: `memlab_get_references` to see what they point to
3. `memlab_dominator_subtree` to understand total memory impact

**Common fixes:**
- Module caches growing without bounds → add eviction
- Debug/dev globals left in production → gate behind `__DEV__`
- Polyfill-installed globals → evaluate if still needed

## Path F: Subscription/Listener Accumulation

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

## Path G: Repeated Error Accumulation

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

## Path H: Cardinality Explosion (metrics / cache keys / per-record fields)

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

## Path I: Single-Snapshot Growth Guess (no baseline available)

Triggered when: you only have one snapshot and want to guess what is
accumulating before a second capture is available.

1. `memlab_growth_signals` — flags Maps/Sets keyed by timestamps or sequential
   integers (time-series / append-only logs) and large ever-growing Arrays.
   This is a heuristic; confirm with a later snapshot + `memlab_diff_snapshots`.

## Path J: Sequence / trend across 3+ snapshots

Triggered when: the question is "is anything growing unboundedly across N
captures?"

1. `memlab_sequence_analysis` with an ordered `paths` list — loads each snapshot
   transiently (does NOT change the active snapshot), reports each class's count
   at every step, and labels **"↑ every step" (leak signal)** vs **"grew net
   (noisy)"** (GC/navigation). Lists classes new since baseline. Prefer this over
   chaining `diff_snapshots` pairwise.
2. Load the last snapshot and localize with `cache_analysis` /
   `event_listener_leaks` / `event_registry` / `growth_signals`. Object ids
   match across captures only from the same isolate (one page or process, no
   reload or restart). For those, `memlab_diff_snapshots` matches objects by id
   and lists the ones allocated in between that are still alive; captures from
   different isolates can only be compared by class counts and sizes.

## Path K: Browser — real leaks vs dev/extension artifacts

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

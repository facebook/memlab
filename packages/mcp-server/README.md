# @memlab/mcp-server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that wraps [MemLab](https://facebook.github.io/memlab/)'s heap analysis APIs, giving AI coding assistants (Claude Code, Cursor, etc.) interactive tools to explore JavaScript heap snapshots, find memory leaks, and identify optimization opportunities.

It registers about 150 `memlab_*` tools, covering:

- **Single-snapshot analysis**: what the heap is made of, who retains what, detached DOM, duplicated strings, caches and collections.
- **Ladder analysis**: an ordered series of snapshots taken while an interaction repeats. These tools report per-cycle growth rates, fit the growth, and tell a leak apart from a bounded working set or in-flight backlog.
- **Verification**: separating real growth from dev-tool and measurement artifacts, checking that a fix worked, and checking that a result reproduces.

The package also ships `memlab-cli`, which runs the same tools from a shell without an MCP client.

## Prerequisites

- Node.js 18 or later.
- A large V8 heap. The server loads and analyzes large heap snapshots in memory, which can exceed Node.js's default heap limit. Run it with `--max-old-space-size=8192` or higher to avoid out-of-memory crashes. The configuration examples below include this setting.

**Snapshot-size ceiling.** The server keeps the full parsed graph resident: nodes, edges, dominator tree and indexes. A full load needs several times the snapshot's on-disk size in memory. To avoid an out-of-memory crash, which would lose all loaded state, `memlab_load_snapshot` refuses a load in three cases:

- **File size.** The file is larger than `max_file_size_mb`. The default is 900 MB or 0.25 × the old-space limit, whichever is larger. That is 2,048 MB on an 8 GB server.
- **Node/edge count.** The node or edge count in the snapshot header is above the load ceiling. The ceiling is derived from the old-space limit the process is actually running with: about 13.9M nodes and 55.7M edges at 8 GB. Raising the heap raises it with no other change. To make a one-off oversized load anyway, pass `force: true`.
- **Memory headroom.** The projected working set doesn't fit in the remaining old space. In that case the least-recently-used resident snapshot is evicted first, and the load is refused only if it still doesn't fit.

`memlab_snapshot_header` reads a file's node and edge counts without loading it. It tells you whether the file will load, and if not, roughly how large a capture of the same app would. When you load several snapshots with `keep_previous: true`, each one adds its full graph to memory. Unload the ones you're done with via `memlab_snapshots`.

**Which setting raises the heap depends on how the server is launched.**

- **`memlab-mcp` or `dist/index.js`:** set `NODE_OPTIONS`. These run the server in-process without passing a flag of their own.
- **`memlab-cli`:** set `MEMLAB_MAX_OLD_SPACE_MB` instead. `memlab-cli` spawns the server with an explicit `--max-old-space-size`, and an explicit flag overrides the same flag in `NODE_OPTIONS`.

By default `memlab-cli` uses 60% of physical RAM, rounded to the nearest GB. The value is never less than 8,192 MB and never more than 49,152 MB. Inside a memory-limited container it uses 60% of the container limit instead, and the 8,192 MB minimum doesn't apply.

## Quick Start

### Option 1: Global install

```bash
npm install -g @memlab/mcp-server
```

Then configure (`~/.claude.json` for Claude Code, or `.mcp.json` for Cursor/Windsurf):

```json
{
  "mcpServers": {
    "memlab": {
      "type": "stdio",
      "command": "memlab-mcp",
      "env": {
        "NODE_OPTIONS": "--max-old-space-size=8192"
      }
    }
  }
}
```

### Option 2: npx (no install)

Add to your Claude Code MCP config (`~/.claude.json` for Claude Code, or `.mcp.json` for Cursor/Windsurf):

```json
{
  "mcpServers": {
    "memlab": {
      "type": "stdio",
      "command": "npx",
      "args": ["@memlab/mcp-server"],
      "env": {
        "NODE_OPTIONS": "--max-old-space-size=8192"
      }
    }
  }
}
```

### Option 3: From source

```bash
git clone https://github.com/facebook/memlab.git
cd memlab
npm install
npm run build
```

To check a change, run these in `packages/mcp-server`:

- `npm run test-pkg` reads the source only, so it needs no build or install. It checks that no tool description tells the caller to use a parameter its schema lacks, that every tool is in the tools index, that the tool tables below match that index, and that the version the server reports matches `package.json`.
- `npm run test-units` unit-tests the shared helpers against the built `dist/`: size parsing (`"1MB"`, `"1MB-10MB"`), the paging contract every ranked list uses, and the report formatters (sizes, counts, clamped labels, collapsed retainer runs, tables).
- `npm run test-fixtures` drives the built server against snapshots it generates and checks invariants every report must keep: exact dead-variable answers on hand-built scope-tree snapshots, no share above 100%, partitions that add up, and complete, repeatable paging.

Then configure (`~/.claude.json` for Claude Code, or `.mcp.json` for Cursor/Windsurf):

```json
{
  "mcpServers": {
    "memlab": {
      "type": "stdio",
      "command": "node",
      "args": ["--max-old-space-size=8192", "/path/to/memlab/packages/mcp-server/dist/index.js"]
    }
  }
}
```

## Command Line (`memlab-cli`)

`memlab-cli` speaks the same stdio JSON-RPC that an MCP host does. Use it when no MCP client is attached, for example in a shell script or CI job, or when a host fails to connect to the server.

```bash
memlab-cli doctor                      # check node, server presence, and a live handshake
memlab-cli list                        # tool names and one-line descriptions
memlab-cli schema memlab_load_snapshot # a tool's input schema as JSON
memlab-cli call memlab_load_snapshot '{"file_path":"/tmp/a.heapsnapshot"}' \
                memlab_app_heap '{}'   # several calls in ONE server session
memlab-cli script steps.jsonl          # one {"tool":..,"args":{..}} per line, ONE session
```

The server is stateful and loading a large snapshot takes minutes, so `call` with several tool/argument pairs, and `script`, reuse one server process. To keep snapshots loaded across separate invocations, run one resident server and point later commands at its socket:

```bash
memlab-cli serve --socket /tmp/memlab.sock &
memlab-cli call --socket /tmp/memlab.sock memlab_load_snapshot '{"file_path":"/tmp/a.heapsnapshot"}'
memlab-cli script --socket /tmp/memlab.sock steps.jsonl
memlab-cli stop --socket /tmp/memlab.sock
```

`script` output is terse, with no "Next:" suggestions. Set `MEMLAB_CLI_VERBOSE=1` for the full text. The CLI runs `dist/index.js` next to itself unless `MEMLAB_MCP_SERVER` points at a different server entry point.

## Tool Safety and Auto-Approval

By default, Claude Code prompts you to approve each MCP tool call. **No tool ever modifies the heap snapshot it analyzes.** Most tools are read-only analysis that is safe to auto-approve. The exceptions fall into two groups.

Every tool declares MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` and a `title`), from one table in `src/tool-annotations.ts`. A client that honours them can auto-approve the 134 read-only tools and keep prompting for the ones below: the code runners are marked destructive and open-world, `memlab_prune_run` destructive, and the other writers not read-only.

### Tools that execute JavaScript

> [!CAUTION]
> These tools run JavaScript supplied by the caller, or read from files a round directory provides, **with the full privileges of the MCP server process**. They use `node:vm` to scope the globals they inject, but [`node:vm` is not a security sandbox](https://nodejs.org/api/vm.html). Code can reach the host realm, for example with `Object.constructor('return process')()`, and from there touch the filesystem, network and shell. Treat each call as equivalent to running code on your machine. Heap snapshot contents are attacker-influenceable input, so a prompt injection could steer the model into running hostile code here. **Do not auto-approve these tools**, and avoid the `mcp__memlab__*` wildcard, which would auto-approve them. To remove them altogether, start the server with `MEMLAB_DISABLE_CODE_TOOLS=1`.

| Tool | What runs |
| --- | --- |
| `memlab_eval`, `memlab_eval_across` | The `code` (and `prelude`) you pass |
| `memlab_for_each` | The `filter_code` / `map_code` / `reduce_code` strings |
| `memlab_hypothesis` | The `predicate` / `predicates` |
| `memlab_ladder_probe`, `memlab_replicate` | The probe `code` (and `prelude`) |
| `memlab_judges`, `memlab_calibrate_judges`, `memlab_switch_matrix` | Invariant probes from `invariants`, `invariants_file`, or a round's `invariants.json` |
| `memlab_ab_compare` | The probe `metrics` and `prelude` |
| `memlab_analysis_battery` | Runs `memlab_judges` when the round directory holds an `invariants.json` |
| `memlab_batch`, `memlab_start_job` | Can call any other tool, including the ones above |

### Tools with side effects outside the heap

| Tool | Side effect |
| --- | --- |
| `memlab_capture` | Connects to a running Chrome on its remote-debugging port (default 9222), and writes snapshots to `out_dir` |
| `memlab_prune_run` | Gzips a round's snapshot files in place (`mode: "compress"`), or **deletes** them (`mode: "delete"`). The default, `dry_run`, touches nothing |
| `memlab_anonymize_snapshot` | Writes a rewritten snapshot to `output_path` (nothing with `audit_only: true`) |
| `memlab_analysis_battery` | Writes per-tool reports to `out_dir` (default `<run_dir>/analysis`) |
| `memlab_finding_index` | Updates the findings file, and `export` writes to the `to` path |
| `memlab_metric`, `memlab_ladder` | Persist small JSON state files (see [State and Cache Files](#state-and-cache-files)) |

To auto-approve the read-only tools while keeping the rest on manual approval, allowlist the tools you use explicitly. Put the list in `~/.claude/settings.json` (user-level) or `.claude/settings.json` (project-level):

```json
{
  "permissions": {
    "allow": [
      "mcp__memlab__memlab_tools",
      "mcp__memlab__memlab_load_snapshot",
      "mcp__memlab__memlab_snapshot_header",
      "mcp__memlab__memlab_snapshots",
      "mcp__memlab__memlab_app_heap",
      "mcp__memlab__memlab_snapshot_summary",
      "mcp__memlab__memlab_class_histogram",
      "mcp__memlab__memlab_retainer_trace"
    ]
  }
}
```

## How It Works

- **Resident snapshots.** The server keeps loaded `IHeapSnapshot` graphs in memory across tool calls, because loading is expensive for large heaps. Several snapshots can be resident at once (`keep_previous: true`). Tools read the active one, which `memlab_snapshots` switches. Node ids are only valid within the snapshot they came from. Most ladder tools load each snapshot transiently and release it, so they don't change the active snapshot.
- **Light loads.** `light: true` skips the dominator, retained-size and shortest-path pass, which roughly halves load time. Tools that need those values return an error that names the light-safe tools, instead of reporting zeros.
- **Wall-clock guardrail.** Every tool call runs under a wall-clock budget: 90 s by default. You can override it per call with `timeout_ms`, or globally with `MEMLAB_ANALYSIS_TIMEOUT_MS`; a value of 0 or less disables it. When a heap scan runs past the budget, the tool returns a clean "analysis stopped" result instead of wedging the server. The dominator pass inside a load is synchronous, so the guardrail can't interrupt it. That is why the load ceilings exist.
- **Background jobs.** A tool that would outlast the client's tool timeout can run in the background with `memlab_start_job`, or with `async: true` on `memlab_eval` and `memlab_analysis_battery`. Collect the result with `memlab_job_status` or `memlab_battery_status`.
- **Compressed snapshots.** Snapshots may be gzipped. The loader resolves `<file>.gz` transparently, decompressing into a private per-user cache directory under the OS temp dir.

## Reading the numbers

memlab and the browser's own heap profiler read the same snapshot, but a few figures are defined or grouped differently. When two numbers disagree, check this table before treating it as a bug.

| memlab | Heap profiler | How they relate |
| --- | --- | --- |
| Self size | Shallow size | The same value: the object's own bytes. |
| Retained size of a node | Retained size | The same definition: what the dominator tree says freeing this node would free. |
| Class retained size (`memlab_class_histogram` with `include_retained_size`) | Retained size of a constructor row | Both count each byte once even when instances hold one another. memlab marks a row `~` when it only has an upper bound. Rows overlap across classes, so neither adds up down the table. |
| Class key `type::name` (e.g. `closure::onClick`, `object::Map`) | Constructor name, with `(closure)`, `(string)`, `(array)`, `(system)` groups | memlab keeps the node type in the key, so a closure named `Map` and a `Map` object are different rows. |
| Total (`memlab_snapshot_summary`) | Total size | Both are the root's retained size plus `extra_native_bytes`, the native memory that has no node. |
| Distance (`memlab_get_node`) | Distance | Hops from the root over strong edges, with page globals at 1. |
| Detachedness (`memlab_get_node`) | Detached flag | The snapshot's own three states: attached, detached, unknown. JS objects are always unknown. |
| Default lists | Everything | `memlab_largest_objects` and several scans leave out engine-internal node types (arrays, code, native, synthetic) unless you ask for them by `node_type`. |

## Getting a Heap Snapshot

Both `.heapsnapshot` files and `.heaptimeline` files (snapshots recorded with allocation tracking on) load, and either suffix may be left off a handle. `memlab_allocation_sites` reads the allocation stacks such a capture carries.

### Chrome DevTools

1. Open DevTools (F12) > Memory tab
2. Select "Heap snapshot" and click "Take snapshot"
3. Right-click the snapshot in the left panel > "Save..."
4. Save the `.heapsnapshot` file

### Live page and workers (`memlab_capture`)

Start Chrome with `--remote-debugging-port=9222`, then call `memlab_capture` with an `out_dir`. It snapshots the page and its dedicated workers, which a page snapshot never contains. Load the resulting files with `memlab_load_snapshot`, or compare them with `memlab_realm_summary`.

`memlab_capture({list_targets: true})` lists the pages Chrome offers, to choose `url_filter`. Give each capture a `label` ("baseline", "after-10-opens") and it is recorded in `<out_dir>/checkpoints.json`. Any tool that takes a snapshot path then accepts `checkpoint:<label>` (or `checkpoint:<out_dir>#<label>`, and `checkpoint:<label>/<worker title>` for a worker), so "capture, interact, capture, compare" is `memlab_diff_snapshots({before: "checkpoint:baseline", after: "checkpoint:after-10-opens"})`, with each side's capture time in the report.

### Node.js

```js
const v8 = require('v8');
const snapshot = v8.writeHeapSnapshot();
console.log(`Heap snapshot written to ${snapshot}`);
```

### Snapshot ladders

The trend tools work on an ordered list of snapshots captured while one interaction repeats. A ladder can be given in three ways:

- **`paths`:** an explicit, ordered list of snapshot files. Cycle counts are recovered from `rung_NN_cNNN.heapsnapshot` filenames. Otherwise the rungs are assumed evenly spaced, and the report says so.
- **`run_dir`:** a round directory whose `run.json` manifest lists the rungs, the cumulative cycles at each rung, and an optional settle rung captured after idle and GC. The per-cycle axis is then measured rather than assumed.
- **`ladder:<name>`:** a name registered once with `memlab_ladder`, together with its capture provenance.

## Tools Reference

Call **`memlab_tools`** first when you are not sure which tool fits. It prints this index from the running server, filters by `question` (for example "growing", "retained" or "artifact"), finds a tool's group with `tool`, and prints a tool's input schema with `tool` plus `schema: true`. From a shell, use `memlab-cli schema <tool>`.

Tools are grouped by the question they answer. Within a group, try them in the order listed. A few tools appear in more than one group. The tables below are generated from `src/tools/tools-index.ts`, the same index `memlab_tools` prints (`npm run sync-catalog`; `npm run test-pkg` fails when they drift).

Every single-snapshot tool takes an optional `snapshot`: a resident handle, or a `.heapsnapshot` path that is loaded for that call only and released afterwards. The active snapshot does not move, so two captures can be queried side by side without `memlab_snapshots({action: "switch"})` between calls.

Every byte-size filter (`min_retained_size`, `min_self_size`, `min_bytes`, …) takes bytes or a size such as `"1MB"` or `"500KiB"` (KB = 1000 bytes, KiB = 1024). `memlab_query_objects` also takes ranges: `"1MB-"`, `"10KB-1MB"`, `"-1MB"`.

Ranked lists page the same way: pass `offset` to skip rows, and every page ends with "Showing a–b of N … Next page: `offset: k`". Ties are broken by node id, so the same offset always shows the same rows. `memlab_snapshots({max_name_length: N})` clips node names in every tool for the rest of the session, and `memlab_snapshots({table_format: "csv"})` renders every table as compact CSV, about half the size of the aligned markdown on a 50-row page.

The main list and lookup tools (`memlab_query_objects`, `memlab_class_histogram`, `memlab_largest_objects`, `memlab_find_nodes_by_class`, `memlab_search_nodes`, `memlab_get_references`, `memlab_get_referrers`, `memlab_get_node`, `memlab_retainer_trace`, `memlab_diff_snapshots`, `memlab_shape_histogram`, `memlab_duplicated_strings`, `memlab_snapshot_summary`, `memlab_native_contexts`, `memlab_retained_by`, `memlab_dead_context_variables`) also return `structuredContent`: the same rows as JSON, with node ids scoped by a `snapshot` handle, raw byte counts, the filters that applied and a `pagination` object. A client can chain results without parsing the tables.

### What is this heap actually made of?

| Tool | Use it when |
| --- | --- |
| `memlab_script_census` | How much of the heap is retained JS SOURCE TEXT — and whether the same bundle is retained twice. |
| `memlab_property_names` | Which property names exist at all; the cheapest way to confirm a field is present before probing for it. |
| `memlab_async_census` | Pending async work: scheduler task queues (live vs cancelled), timer closures, unsettled Promises. |
| `memlab_pending_promises` | Unsettled Promises ranked by reaction-chain length, tracked by id across a ladder — one never-settling promise gaining `.then`s per cycle. |
| `memlab_app_heap` | START HERE on an unfamiliar app: splits the heap into application data vs bundle source vs V8 machinery. On one app this showed ~55% of the heap was JS bundle source, which reframed every number that followed. |
| `memlab_memory_partition` | "What is using the memory?" in one exclusive table: framework families (React, collections, telemetry records, module system, memo caches, Wasm), DOM/Blink sub-families, and the rest by the module or global on its shortest path. Works minified. |
| `memlab_path_tree` | WHERE the memory sits, as a tree: shortest-path subtrees with byte sums (they partition the heap, so shared caches show their real size), expanded wherever a branch is big. |
| `memlab_model_census` | What ONE loaded record costs, per model type in Backbone-style collections: fields, V8 property store, arrays held, retained per record, plus each `_index` dictionary. Works minified. |
| `memlab_timers` | Pending scheduler tasks grouped by the real callback and the payload it captures — a timer per record keeps the record alive for its whole delay. |
| `memlab_framework_buffers` | The recurring framework buffers in one call: log arrays, module timing records, lazy-loader registry, scheduler queue, registry tables, giant objects, plus app-specific buffers from a probe file. |
| `memlab_capture` | Take fresh snapshots of a live page AND its dedicated workers (a page snapshot never contains them). Skips threads blocked in Atomics.wait instead of hanging. |
| `memlab_native_contexts` | Split ONE snapshot by realm (page, iframes, extension worlds, detached windows, Node `vm` contexts): bytes each NativeContext owns alone, shared bytes, unattributed bytes, and the largest classes in any of them. |
| `memlab_realm_summary` | Page + worker snapshots side by side: app / bundle / code per realm, with shared Wasm modules and SharedArrayBuffers counted once. |
| `memlab_co_holders` | Clusters of Maps/Sets/Arrays holding the same objects, with bytes freed by cutting one holder vs all of them. |
| `memlab_realm_duplication` | Modules loaded in more than one realm (page + workers), with state bytes per realm and the duplicated total. |
| `memlab_quick_diagnosis` | One call for summary + biggest objects + class histogram + duplicated strings. |
| `memlab_snapshot_summary` | Node/edge counts, totals and the standard statistics split (V8 heap: code, strings, JS arrays, system; native: typed arrays), including native memory with no node (`extra_native_bytes`). |
| `memlab_class_histogram` | Counts and sizes per class; `name_pattern` answers "is class X present?" in one row. |
| `memlab_largest_objects` | The single biggest retainers, ranked. |
| `memlab_shape_histogram` | Groups plain objects by their property set — finds record types the class name hides behind `Object`. |
| `memlab_identify` | Name a minified structure from its property shape — listener record, LRU node, React update record, undo entry. |
| `memlab_object_cost_breakdown` | Where one class’s bytes actually go (self vs properties vs elements). |
| `memlab_what_if` | If this set were freed, how many bytes actually come back — dominator-deduped, no double counting. |
| `memlab_trace_all` | Retainer-trace an ENTIRE population and cluster the paths server-side — finds the minority path a 10-instance sample cannot. |
| `memlab_retainer_diff` | Did the population grow along the same retention path, or did a NEW owner appear? The question a count diff cannot answer. |
| `memlab_identity_diff` | Same objects, or just the same count? Matches a population across two captures by CONTENT — churn and retention need different fixes. |
| `memlab_next_measurement` | What the loaded snapshots cannot support, and which capture would fix it. Run it before writing a conclusion. |
| `memlab_app_config` | Read the feature flags the app was actually running with, out of the capture — "was the fix even enabled here?" without circular inference. |
| `memlab_gate_fingerprint` | Which experiment ARM a capture is in, when the gate is server-side-scoped and `memlab_app_config` has no flag to read — reads the arm from a population the other arm does not build. |
| `memlab_metric` | Record a measurement under a name and keep it ACROSS sessions — the only way a number measured today survives to be compared next week. |
| `memlab_unit_cost` | Retained bytes per instance, AVERAGE and MARGINAL — the number a cap, an LRU size or an eviction policy is sized against. |
| `memlab_snapshot_budget_planner` | Which rungs of a ladder fit in memory at once, and which to probe transiently — answers "can I afford the MARGINAL unit cost?" before an analysis discovers the ceiling by hitting it. |
| `memlab_island_doors` | List EVERY production-reachable reference into a detached island, not just the shortest one — a fix that closes one of several holders reclaims nothing. |
| `memlab_build_provenance` | Assert the snapshot came from a build that actually contains the change, before reading any before/after number — "the fix does not work" and "the fix was never built" otherwise look identical. |
| `memlab_console_retention` | Report what an attached DevTools console is keeping alive, and whether a given object depends on it — console-held roots are real GC roots in the capture that do not exist in production. |
| `memlab_count_population` | Count one population by class, by shape AND by closure-captured variable, and flag when the methods disagree — a method that cannot reach a population returns the same 0 as a population that is absent. |
| `memlab_drill_to_heavy_leaf` | Follow a big retained size DOWN to the object actually holding it in ONE call, instead of walking dominator_subtree hop by hop — stops at the leaf or the branch point where the weight splits. |
| `memlab_overlap_matrix` | Do these classes retain the SAME bytes? Use it before adding two per-class retained sizes together — classes on one retention chain share bytes and the sum double-counts them. |

### Is anything growing — and is it a leak?

| Tool | Use it when |
| --- | --- |
| `memlab_ladder_probe` | ONE numeric probe across an ordered ladder, with the per-cycle rate and a linear fit — the cheapest way to test a metric, since each rung loads once for all probes. |
| `memlab_rate_model` | Unbounded leak, or a working set whose size is just rate x window? Fits a line AND a saturating curve to one series and reports which the data supports, plus the implied plateau. |
| `memlab_compare_rounds` | Compare N rounds of a sweep: per-cycle rates that land on a WHOLE NUMBER (a mechanism, not a trend) and populations that grew while app_delta was negative (invisible to the aggregate ladder). |
| `memlab_field_release_impact` | If a fix nulls this property, how many bytes come back — and is it the only reference? The question every memory fix asks, in the form fixes actually take. |
| `memlab_analysis_battery` | Run a whole round's analysis in one call, write per-tool detail to disk, return only a digest — the way to read a multi-round sweep without spending a context window on it. |
| `memlab_retention_windows` | What windows could BOUND this population — timeouts, TTLs, cleanup intervals? Run it before calling any growth unbounded: a ladder shorter than the app's window cannot tell a leak from a working set. |
| `memlab_prune_run` | Reclaim the disk a round occupies by gzipping its rungs (still analysable) or deleting them. A sweep is tens of GB. |
| `memlab_battery_status` | Wait on a `memlab_analysis_battery({async: true})` run (`wait_ms`, up to 110 s) and collect its report when it finishes; `battery.done.json` in its output directory is written last. |
| `memlab_start_job` | Run ANY tool in the background and get a job id at once — for ladder tools that would outlive the client tool timeout. |
| `memlab_positive_controls` | Measure the round's declared positive controls — known accumulators — so a flat result can be trusted as clean rather than blind. |
| `memlab_judges` | Judge a round against its stated invariants at rest — PASS / LEAK / BACKLOG / UNSETTLED / UNVERIFIED per plain-words claim, every probe on every rung and the settle rung in one pass. |
| `memlab_switch_matrix` | Can each judge go red? Judge rounds (or the two phases of a `--ab` round) with named fixes switched off: a judge that stays green with its fix off is BLIND. |
| `memlab_calibrate_judges` | Prove judges against rounds KNOWN to carry the leaks they guard; records who has been seen red, so `memlab_judges` can mark every unproven PASS. |
| `memlab_cache_inventory` | Module-scope Maps/Sets/Arrays ranked by what their entries hold, with the owning module and any clear/reset API it already has — memory-pressure candidates in one call. |
| `memlab_module_source` | The served source of one module (`__d` span) read from the snapshot: is the fix served (`gate`), is it a dev-compile artifact (`compare_to` a prod capture), what does it do (`grep`). |
| `memlab_source_for_node` | Which module's code a node belongs to (closure scope chain → Haste module, exact), for going from "which object" to "which file" without code search. |
| `memlab_stale_refs` | React refs whose `.current` is detached DOM, by owner and variable, against the owner's fiber count — bounded (≤1 per instance) or accumulating. |
| `memlab_dev_subtracted_delta` | Per-class growth between two snapshots with everything reachable only through a dev root or dev edge removed — the dev build's honest "what did the app grow". |
| `memlab_job_status` | Poll a `memlab_start_job` job: per-rung notes while it runs, the full result when it is done. |
| `memlab_shape_census_diff` | Per-SHAPE growth across the ladder. Reach for this the moment a class-level tool blames `Object`: it turns "`Object` +377,959" into "`{event,timestamp}` ~0 → 53,029" in one call. |
| `memlab_census_diff` | Detached-DOM and listener census at TWO rungs, diffed per class and per callback in one call. |
| `memlab_leak_report` | The ladder verdict: per-class growth across an ordered set of snapshots. |
| `memlab_growth_cohort` | Who holds the NEWEST instances — the tail of the id range IS the growth. Reports it next to the whole population, so a static collection masking an accumulating one is visible in one call. |
| `memlab_sequence_analysis` | Per-class trend across a ladder, with artifact families flagged. |
| `memlab_collection_trend` | Entry counts of NAMED collections across a ladder, with growth per interaction cycle. |
| `memlab_population_diff` | Whether two snapshots hold the same POPULATION or just the same count — equal totals are not identity. |
| `memlab_react_update_queues` | The React eager-bailout family in one call: queue BREADTH vs chain LENGTH vs owning component. The breadth/length split is what separates a leak from "more hooks mounted". |
| `memlab_settle_check` | Backlog or leak? Compares a busy rung against one captured after idle + GC — growth that comes back was work in flight. |
| `memlab_growth_signals` | Single-snapshot signals that something is accumulating. |
| `memlab_diff_snapshots` | Per-class deltas between two snapshots. For two captures of one tab session (same V8 isolate, detected automatically) it also matches objects by id: per class, how many are new and still alive, how many were freed, and their bytes, so churn no longer reads as zero. `class_name` + `detail` ("added" or "deleted") lists those objects, paged. |
| `memlab_hypothesis` | Test MANY predicates against every rung in ONE pass each, with an `expect` per predicate for a PASS/FAIL column. Use it instead of hand-writing a `memlab_eval` per theory — a second forEach over a multi-million-node graph aborts on the cumulative node budget. |
| `memlab_verify_fix` | Did the fix work? Compares per-cycle growth RATES between a before ladder and an after ladder — from two sets of snapshot FILES, so no runtime gate is needed and an ungated or build-only fix is verified the same way. |
| `memlab_ladder` | Name a ladder once and reference it as `ladder:<name>` from every trend tool. |

### Who owns the growth / why is X retained?

| Tool | Use it when |
| --- | --- |
| `memlab_react_owners` | Name the React COMPONENT behind a population of plain `Object`s. Fibers and hooks are all `Object` in a production bundle, so every class-name heuristic — including `helpers.owner` — walks past them. |
| `memlab_population_vs_owners` | STRUCTURAL or ACCUMULATING? One record per live owner is a baseline; many records per owner is a leak. |
| `memlab_chain_walk` | Walk a repeated linked structure (`.next` update queues, `.prev` closure chains, LRU lists) and report how deep it goes — use this instead of a hand-written loop, which cannot tell a cycle from a hop cap. |
| `memlab_module_attribution` | Attribute bytes to the MODULE that owns them, by walking dominators up to the nearest module-registry export. |
| `memlab_census` | Count several named populations (detached DOM, listener records, LRU cache nodes, React fibers, timers, …) across every rung in ONE pass each, with per-cycle rates and a settle verdict. |
| `memlab_ab_compare` | Judge an A/B round in one call: the same probes on the OFF and ON arms, per-cycle rates, ON/OFF ratio and a FIX EFFECTIVE / NO EFFECT / CANNOT JUDGE verdict per metric, plus each arm's heap total with dev-only memory removed. |
| `memlab_object_urls` | Unrevoked `blob:` object URLs per rung — their Blobs are pinned OFF the V8 heap, so this leak never shows in heap size. |
| `memlab_rate_table` | Rank several rounds by the per-cycle rate of ONE population, labelled by the surface each round drove — the "which surface do I fix first" table. Carries settle-drain and isolate-age columns, because a rate is not comparable without them. |
| `memlab_external_strings` | Attribute `system / ExternalStringData` — usually the largest class in a browser heap, and the one a retainer trace cannot explain. Names the source chunks by reading their content. |
| `memlab_explain_delta` | WHERE a heap grew, attributed to the object that owns the new bytes rather than to what they are. Production-only by default; flags a backing store that grew by a one-time capacity step. |
| `memlab_dominator_chain` | From one node up to the accountable application object. |
| `memlab_dominator_attribution` | Given several candidate retainers, how much each one actually dominates — a zero refutes a hypothesis. |
| `memlab_allocation_sites` | WHO allocated these objects: live objects grouped by the JavaScript stack that allocated them (needs a capture recorded with allocation tracking, e.g. a `.heaptimeline`). |
| `memlab_retained_by` | Bytes retained ONLY through closure contexts, detached DOM, the DevTools console or event handlers: what removing every such retainer would free, with the largest classes. Filter any query or histogram the same way with `retained_by`. |
| `memlab_dead_context_variables` | Captured variables no live code can read, heap-wide: a value kept alive only because it shares a closure Context with a sibling closure that is still alive. Needs a V8 15.6+ (Chrome 156+) capture. |
| `memlab_model_duplicates` | Records that share an identity value (`identity_path`, e.g. `__x_id._serialized`): copies of a one-per-id model, where the extras are held and what they retain; per-rung counts with `run_dir`. |
| `memlab_scope_chains` | Chains of contexts of one function, each call pinning the previous call's scope through a captured closure: invisible to class counts. Flags the React Compiler dev hook-guard artifact (links only through `t0`..`tN`); per-rung lengths with `run_dir`. |
| `memlab_retainer_trace` | The shortest retainer path for one node; `mode: "tree"` shows every owner as a bounded tree (`max_depth`, `max_nodes`, `max_siblings`) ending at a root or the page global. |
| `memlab_retainer_summary` | Retainer paths across many instances, clustered by shape. |
| `memlab_referrer_summary` | Who points at this, grouped by edge. |
| `memlab_pinch_points` | Single objects whose release would free the most. |
| `memlab_dominator_subtree` | What one object holds, expanded downward. |
| `memlab_retainer_layers` | The retention structure around a node, layer by layer. |
| `memlab_trace_dominators` | Dominator path for a set of nodes at once. |

### Is it real, or a measurement artifact?

| Tool | Use it when |
| --- | --- |
| `memlab_artifact_budget` | ONE number for how much of the heap is not the application — and, with a baseline, how much of the GROWTH was the app. `app_delta` is the number that should lead a report. |
| `memlab_replicate` | Does the effect REPRODUCE across independently-driven runs? Refuses to call it real until it does — the guard against filing a one-off. |
| `memlab_blink_native_census` | Native (Blink) classes growing across a ladder, split into JS-held (app-releasable) vs browser-internal, with fixed-capacity browser buffers annotated. |
| `memlab_dev_artifacts` | Memory retained ONLY by dev/automation roots — DevTools, extensions, React Fast Refresh, the a11y cache. Run before calling anything a production leak. |
| `memlab_explain_delta` | Counts the OTHER artifact family — V8 JIT warmup — which dev_artifacts does not. Read both. |
| `memlab_check_health` | Prioritized triage that separates likely-real from likely-noise. |

### Detached DOM and event listeners

| Tool | Use it when |
| --- | --- |
| `memlab_dom_audit` | Budget the ATTACHED DOM and rank surfaces worth virtualizing. An OPTIMIZATION tool — these elements are correctly retained, there are simply too many. |
| `memlab_detached_dom` | Detached nodes, with a pinned-vs-GC-eligible split; `group_by:"dominator"` groups by what a fix would actually free. |
| `memlab_event_listener_leaks` | Listeners that outlived their target. |
| `memlab_event_registry` | What is registered on what; `group_by` emitter × context class × callback says whose listener records they are, per rung with `run_dir`. |

### Collections and caches

| Tool | Use it when |
| --- | --- |
| `memlab_collection_diff` | WHICH collections grew across a ladder, without being told their names — censuses every Map/Set/Array and keys each by a stable `<Owner>.<property>` signature. |
| `memlab_weakref_census` | Every WeakRef, split LIVE vs EMPTY, grouped by the shape of the holder. |
| `memlab_cache_analysis` | Unbounded or oversized caches in one snapshot. |
| `memlab_persistent_structures` | How many VERSIONS of a structurally-shared structure are retained (Immutable.js, Immer, RxJS) — detected by SHAPE, so it survives the minified class names a histogram cannot explain. |
| `memlab_sparse_elements` | Integer-keyed objects and arrays whose elements backing store is mostly holes — waste charged to no class, so a histogram cannot see it. |
| `memlab_id_space_audit` | Separate integer-keyed structures indexed by the SAME sparse id space — several small sparse findings that are really one re-keying fix. |
| `memlab_stale_collections` | Collections holding entries nothing else references. |
| `memlab_collection_trend` | The same collections tracked ACROSS a ladder. |
| `memlab_map_entries` | Enumerate a Map/Set correctly (SMI gaps and browser slot typing handled). |
| `memlab_weakmap_entries` | Enumerate a WeakMap. |
| `memlab_array_group_by` | Group an array’s elements by a property to see what is piling up. |
| `memlab_property_distribution` | Cardinality and top values of one property across instances. |

### Strings and duplication

| Tool | Use it when |
| --- | --- |
| `memlab_string_prefix_census` | Strings by PREFIX (`blob:`, `data:image/`, a key scheme) on every rung, from the sidecar index — seconds, not a full-graph walk per rung. |
| `memlab_intern_opportunities` | What an intern pool would actually reclaim, grouped by property x parent shape. Start here for an interning decision. |
| `memlab_duplicated_strings` | The raw per-value duplication table. |
| `memlab_string_patterns` | Group strings by prefix to find families (URLs, ids, payloads). |
| `memlab_sliced_strings` | Substrings pinning huge parents. |
| `memlab_duplicate_objects` | The same question for objects rather than strings. |
| `memlab_search_strings` | Find a string value in the heap. |
| `memlab_get_string` | Read one string node’s value. |

### Inspect or find specific objects

| Tool | Use it when |
| --- | --- |
| `memlab_query_objects` | Any combination of filters in one call: class regex, node type, property name, detached, self / retained size ranges like "1MB-". Sorted, paged and cached per snapshot. |
| `memlab_find_nodes_by_class` | By exact class name, or by `name_pattern` regex/substring. |
| `memlab_search_nodes` | By name/type/size predicates. |
| `memlab_find_by_property` | By a property name/value. |
| `memlab_find_by_shape` | By property set. |
| `memlab_module_present` | Is this class in the heap AT ALL? Pre-flight before instrumenting a module. |
| `memlab_match_object` | By a structural pattern. |
| `memlab_get_node` | One node’s details, with detachedness (attached / detached / unknown) and distance from the root. |
| `memlab_object_shape` | One object’s properties and their sizes. |
| `memlab_get_references` | Outgoing edges. |
| `memlab_get_referrers` | Incoming edges. |
| `memlab_get_property` | One property of one object. |
| `memlab_get_value` | A scalar value, where the format allows it. |
| `memlab_closure_inspection` | What a closure captured, and what that costs. |
| `memlab_global_variables` | What is hanging off the global object. |
| `memlab_aggregate` | Sum/count over a node set. |
| `memlab_for_each` | Run one tool over many nodes. |

### None of the above — ask the heap directly

| Tool | Use it when |
| --- | --- |
| `memlab_eval` | Arbitrary JS over the snapshot, with indexed helpers (`byClass`, `iterByType`, `classCounts`, `entries`, `dominates`, `pathBetween`). Use `mode:"describe_env"` for the calling convention. This is the escape hatch when no fixed-shape tool matches the question. |
| `memlab_eval_across` | The same eval program run against several snapshots at once — resident ones, or files and round rungs it loads one at a time — comparative questions without the switch-and-diff. |
| `memlab_auto_investigate` | When you do not yet have a question: runs the standard deep-dive and reports what it found. |
| `memlab_tools` | This index. Filter it with `question` or look a tool up with `tool`. |

### Sharing a capture outside its trust boundary

| Tool | Use it when |
| --- | --- |
| `memlab_anonymize_snapshot` | Rewrite a capture so it can be attached to a task or handed to a model, keeping it analyzable — and reporting the identifier-shaped text it could NOT classify. Also audits a capture someone else anonymized: one such file still carried 26,303 account handles as property names. |

### Session, batching and write-ups

| Tool | Use it when |
| --- | --- |
| `memlab_round_digest` | The verdict table for a finished round and nothing else — the audit verdict, the ladder shape, and the per-metric rate/fit/verdict rows, without the ~30 KB of prose. |
| `memlab_sweep_digest` | One row per round across a whole sweep, plus the leak-candidate classes no earlier round reported — where the sweep found something new. |
| `memlab_round_audit` | Read a round’s run.json BEFORE analysing it, so a broken bring-up is caught before its numbers travel into a write-up. |
| `memlab_load_snapshot` | Load a local path, a manifold:// URL, or a bare Nest filename. |
| `memlab_snapshots` | List / switch / unload resident snapshots; set session output controls. |
| `memlab_batch` | Several tools against ONE load — the load is the expensive part. |
| `memlab_snapshot_header` | Node/edge counts WITHOUT loading the snapshot. |
| `memlab_server_status` | Confirm the server is alive (returns instantly), and see what large snapshots cost it: peak RSS, recent loads with time and RSS before/after, evictions, and the slowest tools this session. |
| `memlab_finding_index` | Record findings as you go so the write-up is not reconstructed from memory. |
| `memlab_reports` | Render the findings. |
| `memlab_hunt_report` | Render a leak-hunt run. |
| `memlab_analyze_run` | Point at a run.json and get the WHOLE analysis protocol — trend, owner attribution, population diff, artifact classification, caveats — in one call. |
## Core Session Tools

### `memlab_load_snapshot`

Load and parse a `.heapsnapshot` (or `.heapsnapshot.gz`) file. Builds indexes, computes the dominator tree and retained sizes, and returns a quick diagnosis.

- **Snapshot resolution:** `file_path` is normally a local absolute path. Inside Meta it may also be a `manifold://bucket/key` URL or a bare server-snapshot filename, fetched with the `manifold` CLI.
- **Multiple snapshots:** pass `keep_previous: true` to keep earlier snapshots resident for diffing. Each gets a handle (`alias`, defaulting to the file name).
- **Size ceilings:** `max_file_size_mb`, `max_nodes` and `max_edges` override the defaults, and `force: true` bypasses the ceilings and the headroom guard (see [Prerequisites](#prerequisites)).
- **Light loads:** `light: true` skips the dominator / retained-size / shortest-path pass.
- **Session output controls:** `quiet` and `suppress_suggestions` trim repeated boilerplate.

```
Input:  { file_path, alias?, keep_previous?: false, light?: false,
          max_file_size_mb?, max_nodes?, max_edges?, force?: false,
          force_reload?: false, quiet?, suppress_suggestions?, repeat_notes?: false }
Output: status, file path, node/edge counts, total size, handle, quick diagnosis
```

### `memlab_snapshot_header`

Reads a snapshot's header without loading it: node and edge counts, capture time and file size. There is no dominator pass, so it can't wedge or OOM the server. It reports whether the capture fits under the current load ceiling. If it doesn't fit, it estimates the largest capture of the same app that would.

```
Input:  { file_path }
Output: file size, node/edge counts, capture date, current ceiling,
        loadable ✓ / over-ceiling ✗ verdict with a max-loadable-MB hint
```

### `memlab_snapshots`

Manages the multi-snapshot session and session-wide output controls.

```
Input:  { action?: "list"|"switch"|"unload", handle?, quiet?, suppress_suggestions?,
          terse?, repeat_notes? }
Output: resident snapshots (active one marked), or switch/unload result
```

### `memlab_batch`

Runs several tools against ONE snapshot load and returns all their outputs together, so you don't pay the multi-minute parse on every call. Steps run in order against the resident snapshot, and each step sees earlier steps' side effects. Every step's tool name and arguments are validated before step 0 runs. The whole batch shares one wall-clock budget, so size `timeout_ms` for all of it.

```
Input:  { load?: { ...memlab_load_snapshot args }, steps: [{ tool, args? }],
          stop_on_error?: false, timeout_ms? }
Output: a per-step output block for each step, headed by a run/failed step count
```

### `memlab_start_job` / `memlab_job_status`

Starts any tool in the background and returns a job id at once. Use it for ladder tools that would run past the client's tool timeout. `memlab_job_status` reports per-rung progress while the job runs and the full result once it finishes. With no `job_id`, it lists every job the server knows about.

```
Input:  memlab_start_job { tool, args }    memlab_job_status { job_id? }
```

### `memlab_eval`

The escape hatch when no fixed-shape tool matches the question. It runs JavaScript against the loaded snapshot with access to `snapshot`, `utils` and `helpers`; assign the answer to `result`. The helpers are indexed and memoized per snapshot, for example `helpers.byClass`, `helpers.hasShape`, `helpers.rootPath`, `helpers.mapEntries` and `helpers.retainedSize`. `mode: "describe_env"` prints the full helper surface and its gotchas.

- **`save_as`:** keeps a result set server-side, and `helpers.load(name)` reads it back in a later call.
- **`max_nodes`:** bounds a full-heap walk.
- **`async: true`:** runs the eval as a background job.

> [!WARNING]
> `memlab_eval` executes arbitrary code with the full privileges of the server process. See [Tools that execute JavaScript](#tools-that-execute-javascript).

```
Input:  { code, mode?, prelude?, timeout_ms?, max_nodes?, save_as?, async?, ... }
```

## State and Cache Files

The server keeps a few small files so that work survives a restart:

| File | Written by | Override |
| --- | --- | --- |
| `<snapshot>.memlab-index.json` | Sidecar index next to each analyzed snapshot, so later ladder analyses run from cache | `MEMLAB_NO_INDEX_CACHE=1` disables it |
| `~/.memlab-mcp/ladders.json` | `memlab_ladder` | — |
| `~/.memlab-mcp/findings.json` (or `findings.<workstream>.json`) | `memlab_finding_index` | `MEMLAB_FINDINGS_INDEX` (file, or a directory) |
| `~/.memlab-mcp/judge-calibration.json` | `memlab_calibrate_judges` | `MEMLAB_JUDGE_LEDGER` |
| `~/.memlab/metrics.json`, `~/.memlab/eval-store.json` | `memlab_metric`, `helpers.remember` in `memlab_eval` | `MEMLAB_STATE_DIR` |
| `~/.memlab/battery-caveats.json` | `memlab_analysis_battery`: run.json caveats already printed for a sweep (a round's parent directory), so later rounds print them as one "unchanged" line | `MEMLAB_STATE_DIR` |
| `$TMPDIR/memlab-cache-<uid>/` | Decompressed `.gz` snapshots (and Manifold fetches), mode `0700` | — |

## Environment Variables

| Variable | Effect |
| --- | --- |
| `NODE_OPTIONS` | Set `--max-old-space-size` here when running `memlab-mcp` or `dist/index.js` directly |
| `MEMLAB_MAX_OLD_SPACE_MB` | Server heap in MB when launched by `memlab-cli` (minimum 512; default scales with RAM) |
| `MEMLAB_ANALYSIS_TIMEOUT_MS` | Default per-call wall-clock budget (default 90000; `<= 0` disables it) |
| `MEMLAB_DISABLE_CODE_TOOLS` | `1` turns off every tool that runs caller-supplied JavaScript (the table under [Tools that execute JavaScript](#tools-that-execute-javascript)); `memlab_tools({enable})` cannot turn them back on. Use `memlab_query_objects`, `memlab_retained_by` and `memlab_native_contexts` for queries instead |
| `MEMLAB_TOOLSETS` | Expose only these tool groups, comma-separated: `core` (the ~20 everyday tools) and the question groups `composition`, `growth`, `retention`, `artifacts`, `dom`, `collections`, `strings`, `inspect`, `ask`, `sharing`, `session`. The session tools are always on, and `memlab_tools({enable: "growth"})` turns more groups on mid-session. Unset (or `all`) exposes every tool |
| `MEMLAB_MCP_SERVER` | Server entry point `memlab-cli` runs, instead of the bundled `dist/index.js` |
| `MEMLAB_CLI_VERBOSE` | `1` prints full tool output, with suggestions, from `memlab-cli script` |
| `MEMLAB_REPEAT_NOTES` | `1` prints standing explanatory notes on every call instead of once per session |
| `MEMLAB_PREWARM_CONCURRENCY` | Number of workers that build sidecar indexes for a ladder in parallel |
| `MEMLAB_RETAIN_RUNGS` | Most rungs `memlab_analysis_battery` keeps parsed between its steps, so the next ladder tool reuses them instead of parsing again (default 8, fewer when memory is short; `0` turns it off) |
| `MEMLAB_NO_INDEX_CACHE` | `1` disables the `.memlab-index.json` sidecar cache, for example for a cold measurement |
| `MEMLAB_DEV_ARTIFACT_GLOBALS` | Comma-separated extra dev-only globals for `memlab_dev_artifacts`, for example `myDebugHook,__MY_DEVTOOLS__` |
| `MEMLAB_DEV_ARTIFACT_NODE_PATTERN` | Regex of extra dev-only node names for `memlab_dev_artifacts` |
| `MEMLAB_FRAMEWORK_BUFFERS` | Path to a probe file of app-specific buffers for `memlab_framework_buffers` |
| `MEMLAB_FINDINGS_INDEX`, `MEMLAB_JUDGE_LEDGER`, `MEMLAB_STATE_DIR` | Relocate state files (see [State and Cache Files](#state-and-cache-files)) |

## Investigation Skill for AI Assistants

The [MCP Investigation Skill](./MCP_SKILL.md) provides a structured
methodology for AI coding assistants to systematically investigate memory
issues using the MCP tools. It covers:

- **Step-by-step triage**: load, diagnose, and prioritize findings
- **Investigation paths**: guided workflows for string waste, DOM leaks,
  object accumulation, closure leaks, global bloat, listener accumulation, and
  repeated errors, each with triggers, tool sequences, and common fixes
- **Tool selection reference**: a quick-reference table mapping investigation
  goals to the right MCP tool
- **Token efficiency tips**: how to minimize token usage with compact modes
  and parallel tool calls

## Example Workflows

### One snapshot

1. **Load the snapshot**: "Load the heap snapshot at /tmp/my-app.heapsnapshot"
2. **Find out what the heap is made of**: "Split the heap into app data, bundle source and V8 internals" (`memlab_app_heap`, `memlab_memory_partition`)
3. **Find the biggest retainers**: "What are the largest objects and classes by retained size?"
4. **Rule out artifacts**: "How much of this is retained only by DevTools or extensions?" (`memlab_dev_artifacts`)
5. **Check for common leak patterns**:
   - "Are there any detached DOM nodes?"
   - "Show me duplicated strings and what interning would save"
   - "Are any caches or collections unbounded?"
6. **Explain one object**: "Why is node 48231 retained?" (`memlab_retainer_trace`, `memlab_dominator_chain`)

### A ladder of snapshots

1. **Register the ladder**: "Register these snapshots as ladder `feed-scroll`" (`memlab_ladder`)
2. **Find what grows**: "Which classes and shapes grow every cycle?" (`memlab_leak_report`, `memlab_shape_census_diff`, `memlab_collection_diff`)
3. **Tell a leak from a working set or backlog**: "Does this growth plateau, and does the settle rung give it back?" (`memlab_rate_model`, `memlab_settle_check`, `memlab_retention_windows`)
4. **Find the owner**: "Who holds the newest instances?" (`memlab_growth_cohort`, `memlab_trace_all`, `memlab_react_owners`)
5. **Size the fix**: "How many bytes come back if this property is cleared?" (`memlab_field_release_impact`, `memlab_what_if`)
6. **Verify the fix**: "Compare the before and after ladders" (`memlab_verify_fix`, `memlab_replicate`)

## License

MIT

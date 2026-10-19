# MCP Server for AI Assistants

The [`@memlab/mcp-server`](https://www.npmjs.com/package/@memlab/mcp-server)
package is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/)
server that wraps memlab's heap analysis APIs. It gives AI coding assistants
(Claude Code, Cursor, Windsurf, and any other MCP client) interactive tools to
load JavaScript heap snapshots, find memory leaks, and identify optimization
opportunities through natural language conversation.

Instead of clicking through the Chrome DevTools memory panel, you point the
assistant at a `.heapsnapshot` file and ask questions:

> Load `/tmp/my-app.heapsnapshot`, tell me what is growing, and show me the
> retainer trace for the biggest offender.

## Setup

### Option 1: Global install

```bash
npm install -g @memlab/mcp-server
```

Then add the server to your MCP client config (`~/.claude.json` for Claude
Code, or `.mcp.json` for Cursor/Windsurf):

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

```json
{
  "mcpServers": {
    "memlab": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--max-old-space-size=8192",
        "/path/to/memlab/packages/mcp-server/dist/index.js"
      ]
    }
  }
}
```

:::caution Give Node.js enough heap

The server keeps the fully parsed graph resident: nodes, edges, dominator tree
and indexes. A full load needs several times the snapshot's on-disk size in
memory. Always start the server with `--max-old-space-size=8192` or higher; the
configurations above do this for you.

To avoid an out-of-memory crash, which would lose every loaded snapshot,
`memlab_load_snapshot` refuses a load in three cases:

- **File size:** the file is larger than `max_file_size_mb`. The default is
  900 MB or 0.25 × the old-space limit, whichever is larger: 2,048 MB on an
  8 GB server.
- **Node/edge count:** the snapshot's node or edge count is above the load
  ceiling. The ceiling is derived from the heap limit the server is actually
  running with: about 13.9M nodes and 55.7M edges at 8 GB.
- **Memory headroom:** the projected working set doesn't fit in the remaining
  heap, even after evicting the least-recently-used resident snapshot.

Raising `--max-old-space-size` raises all three limits, with no other change.
`force: true` attempts a one-off oversized load anyway.

:::

## Command line (`memlab-cli`)

The package also installs `memlab-cli`, which runs the same tools without an
MCP client. Use it in a shell script or CI job, or when your assistant fails to
connect to the server.

```bash
memlab-cli doctor                      # check node, the server, and a live handshake
memlab-cli list                        # every tool with a one-line description
memlab-cli schema memlab_load_snapshot # a tool's input schema as JSON
memlab-cli call memlab_load_snapshot '{"file_path":"/tmp/a.heapsnapshot"}' \
                memlab_app_heap '{}'   # several calls in one server session
memlab-cli script steps.jsonl          # one {"tool":..,"args":{..}} per line
```

Loading a large snapshot takes minutes, so to keep snapshots loaded across
separate invocations, run one resident server with
`memlab-cli serve --socket /tmp/memlab.sock`. Then pass `--socket` to `call`,
`script` and `stop`.

`memlab-cli` starts the server with its own `--max-old-space-size`, which
overrides `NODE_OPTIONS`. Set `MEMLAB_MAX_OLD_SPACE_MB` to change it. By
default it uses 60% of physical RAM (at least 8 GB), or 60% of the container's
memory limit.

## Getting a heap snapshot

Both `.heapsnapshot` files and `.heaptimeline` files (snapshots recorded with
allocation tracking on) load. `memlab_allocation_sites` groups live objects by
the stack that allocated them in such a capture.

### From Chrome DevTools

1. Open DevTools (F12) and go to the **Memory** tab.
2. Select **Heap snapshot** and click **Take snapshot**.
3. Right-click the snapshot in the left panel and choose **Save...**.
4. Save the `.heapsnapshot` file somewhere the MCP server can read it.

### From a live page and its workers

Start Chrome with `--remote-debugging-port=9222` and ask the assistant to run
`memlab_capture` with an output directory. It snapshots the page and its
dedicated workers, which a page snapshot never contains. Compare the page and
workers with `memlab_realm_summary`. `list_targets: true` lists the pages to
choose from. Give each capture a `label` and refer to it later as
`checkpoint:<label>` anywhere a snapshot path is accepted, for example
`memlab_diff_snapshots({before: "checkpoint:baseline", after: "checkpoint:after"})`.

### From Node.js

```js
const v8 = require('v8');
const snapshot = v8.writeHeapSnapshot();
console.log(`Heap snapshot written to ${snapshot}`);
```

### From memlab

Snapshots taken by [`memlab run`](./cli/CLI-commands.md) are saved under the
working directory printed at the end of the run (see
`memlab get-default-work-dir`), and can be loaded directly.

## A typical investigation

A memory investigation with the MCP server usually follows this shape — all of
it in conversation, with the assistant picking the tools:

1. **Load the snapshot** — "Load the heap snapshot at
   `/tmp/my-app.heapsnapshot`."
2. **Frame the heap** — "What is this heap made of?" The assistant splits the
   heap into application data, bundle source and V8 internals
   (`memlab_app_heap`). Then it looks at a class histogram and the biggest
   retainers.
3. **Find what is growing** — with a series of snapshots taken while an
   interaction repeats: "Which classes grow on every snapshot?"
4. **Leak or working set?** — "Does this growth plateau, and is it given back
   after idle and GC?" Steady growth across a short series can still be a
   bounded cache or work in flight.
5. **Rule out noise** — "Is any of this retained only by DevTools or browser
   extensions?"
6. **Explain the retention** — "Show me the retainer trace for node 48231, and
   tell me which reference to break."
7. **Confirm the fix** — capture a new set of snapshots after the fix and ask
   whether the per-cycle growth rate went down (`memlab_verify_fix`).

## What the tools can answer

The server ships about 150 tools, organized by the question they answer:

| Question | Representative tools |
| --- | --- |
| What is this heap made of? | `memlab_app_heap`, `memlab_memory_partition`, `memlab_native_contexts`, `memlab_quick_diagnosis`, `memlab_class_histogram`, `memlab_largest_objects`, `memlab_shape_histogram`, `memlab_what_if` |
| Is anything growing — and is it a leak? | `memlab_leak_report`, `memlab_shape_census_diff`, `memlab_collection_diff`, `memlab_ladder_probe`, `memlab_rate_model`, `memlab_settle_check`, `memlab_verify_fix` |
| Who owns the growth / why is X retained? | `memlab_retainer_trace`, `memlab_retainer_summary`, `memlab_trace_all`, `memlab_react_owners`, `memlab_dominator_chain`, `memlab_pinch_points`, `memlab_explain_delta`, `memlab_dead_context_variables`, `memlab_retained_by`, `memlab_allocation_sites` |
| Is it real, or a measurement artifact? | `memlab_artifact_budget`, `memlab_dev_artifacts`, `memlab_replicate`, `memlab_check_health` |
| Detached DOM and event listeners | `memlab_detached_dom`, `memlab_dom_audit`, `memlab_event_listener_leaks`, `memlab_event_registry` |
| Collections and caches | `memlab_cache_analysis`, `memlab_stale_collections`, `memlab_map_entries`, `memlab_weakref_census`, `memlab_property_distribution` |
| Strings and duplication | `memlab_intern_opportunities`, `memlab_duplicated_strings`, `memlab_string_patterns`, `memlab_sliced_strings`, `memlab_duplicate_objects` |
| Inspect or find specific objects | `memlab_query_objects`, `memlab_get_node`, `memlab_object_shape`, `memlab_get_references`, `memlab_get_referrers`, `memlab_find_nodes_by_class`, `memlab_find_by_shape`, `memlab_closure_inspection` |
| None of the above | `memlab_eval`, `memlab_eval_across`, `memlab_auto_investigate` |
| Sharing a capture | `memlab_anonymize_snapshot` |
| Session, batching and write-ups | `memlab_load_snapshot`, `memlab_snapshots`, `memlab_batch`, `memlab_finding_index`, `memlab_analyze_run` |

Every byte-size filter takes bytes or a size such as `"1MB"` or `"500KiB"`
(KB = 1000 bytes, KiB = 1024).

Ranked lists page the same way: `offset` skips rows, and every page ends with
"Showing a–b of N … Next page: `offset: k`". Ties are broken by node id, so a
given offset always shows the same rows. `memlab_snapshots` with
`max_name_length` clips node names in every tool for the rest of the session,
and `table_format: "csv"` renders tables as compact CSV.
The main list and lookup tools also return `structuredContent`: the same rows
as JSON, with node ids scoped by a `snapshot` handle, raw byte counts, the
filters that applied and a `pagination` object.

To keep the tool list short, start the server with
`MEMLAB_TOOLSETS=core` (or `core,growth,retention`, …): only those groups are
exposed, and `memlab_tools({enable: "<group>"})` turns more on mid-session.

Ask the assistant to call **`memlab_tools`** to print the full index, grouped
the same way, with a one-line "use it when" for every tool. It is the fastest
way to discover a tool you didn't know to ask for. `memlab_tools` with a `tool`
and `schema: true` prints that tool's parameters.

### Captured variables no live code can read

All closures created in one scope share one V8 Context. A large value read
only by a callback that has already run stays alive for as long as any
sibling closure does. Snapshots from V8 15.6 (Chrome 156) and later include
the source scope tree of every script. `memlab_dead_context_variables` checks
each Context slot against the closures and suspended async functions still on
the heap. It reports the variables nothing live can read, ranked by the bytes
they retain. Each row gives the Context and value ids, ready for
`memlab_retainer_trace`. For the most accurate results capture with Chrome 157
or later, which leaves out script-level `let`/`const`. Older snapshots have no
scope tree, and the tool says so.

## Working with more than one snapshot

Every single-snapshot tool takes an optional `snapshot`: a resident handle, or
a `.heapsnapshot` path that is loaded for that call only. The active snapshot
does not move, so you can ask about two captures side by side without
switching between calls.

Leak detection needs a trend, not a single capture. Pass `keep_previous: true`
when loading so earlier snapshots stay resident: each one gets a *handle*, and
`memlab_snapshots` lists them, switches the active one, or unloads the ones you
are done with. V8 keeps an object's id for its whole lifetime, so ids match
across captures of the same isolate (one tab session, no reload) and nowhere
else. `memlab_diff_snapshots` detects that case and matches objects by id,
listing the objects allocated between two captures that are still alive; for
captures of different isolates, switch to the right handle before reusing an
id.

Every resident snapshot holds its full graph in memory. Watch the server's
footprint with `memlab_server_status` and unload snapshots you no longer need.

:::tip Peek before you load

`memlab_snapshot_header` reads a snapshot's header — node/edge counts, capture
time, file size, native memory with no node (`extra_native_bytes`) — *without*
parsing it, and tells you whether it fits under the
current load ceiling. Use it to pick a loadable capture in one step instead of
attempting an oversized load.

:::

### Snapshot ladders

The growth tools work on a *ladder*: an ordered series of snapshots captured
while one interaction repeats. Most of them load each rung transiently and
release it, so a long ladder doesn't have to fit in memory at once. You can
give a ladder in three ways:

- **`paths`:** an ordered list of snapshot files. Cycle counts are read from
  `rung_NN_cNNN.heapsnapshot` filenames; otherwise rungs are assumed evenly
  spaced, and the report says so.
- **`run_dir`:** a directory whose `run.json` lists the rungs, the cycles
  driven at each rung, and an optional *settle* rung captured after idle and
  GC. The settle rung is what tells a leak apart from work still in flight.
- **`ladder:<name>`:** a name registered once with `memlab_ladder`.

Ladder tools can run longer than an assistant's tool timeout. Start them with
`memlab_start_job` and collect the result with `memlab_job_status`. Every call
also runs under a wall-clock budget (90 s by default; override it with
`timeout_ms` or `MEMLAB_ANALYSIS_TIMEOUT_MS`), so a runaway scan returns a clean
"analysis stopped" result instead of wedging the server.

## Tool permissions and safety

No tool ever modifies the heap snapshot it analyzes, and most tools are
read-only analysis. Two groups are exceptions. Start the server with
`MEMLAB_DISABLE_CODE_TOOLS=1` to turn off the tools that run JavaScript
altogether. Every tool declares MCP
annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint` and a `title`), so a client that honours them can auto-approve
the read-only tools and keep asking for these.

:::danger Do not auto-approve tools that execute JavaScript

These tools run JavaScript passed in by the assistant, or read from a round
directory's files, with the full privileges of the MCP server process:

- `memlab_eval` and `memlab_eval_across`
- `memlab_for_each`
- `memlab_hypothesis`
- `memlab_ladder_probe` and `memlab_replicate`
- `memlab_judges`, `memlab_calibrate_judges` and `memlab_switch_matrix`
- `memlab_ab_compare`
- `memlab_analysis_battery`, when the round holds an `invariants.json`

`memlab_batch` and `memlab_start_job` can call any of them.

They use `node:vm` to scope the globals they inject, but
[`node:vm` is not a security sandbox](https://nodejs.org/api/vm.html). Code
can reach the host realm and from there the filesystem, network and shell.
Heap snapshot contents are attacker-influenceable input, so a prompt injection
could steer the model into running hostile code. Keep these tools on manual
approval, and avoid a `mcp__memlab__*` wildcard allowlist, which would
auto-approve them too.

:::

A second group has side effects outside the heap. `memlab_capture` connects to
a running Chrome and writes snapshots. `memlab_prune_run` compresses or deletes
a round's snapshot files; its default mode is a dry run. `memlab_anonymize_snapshot`
and `memlab_analysis_battery` write files. `memlab_finding_index`, `memlab_metric`
and `memlab_ladder` keep small state files under your home directory.

To stop your assistant prompting on every call while keeping these on manual
approval, allowlist the read-only tools you use explicitly. For Claude Code,
put the list in `~/.claude/settings.json` (user-level) or `.claude/settings.json`
(project-level):

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

## Further reading

- [MCP server README](https://github.com/facebook/memlab/blob/main/packages/mcp-server/README.md)
  — the full tool reference (every tool, grouped by the question it answers),
  plus the `memlab-cli` commands, the state files the server writes, and all
  `MEMLAB_*` environment variables.
- [MCP investigation skill](https://github.com/facebook/memlab/blob/main/packages/mcp-server/MCP_SKILL.md)
  — a structured methodology for assistants: step-by-step triage, guided
  investigation paths for string waste, DOM leaks, object accumulation, closure
  leaks and listener accumulation, plus token-efficiency tips.
- [AI assistant guide](https://github.com/facebook/memlab/blob/main/AI.md) —
  guidance for AI assistants using memlab more broadly, including writing test
  scenarios and reading retainer traces.

# @memlab/mcp-server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that wraps [MemLab](https://facebook.github.io/memlab/)'s heap analysis APIs, giving AI coding assistants (Claude Code, Cursor, etc.) interactive tools to explore JavaScript heap snapshots, find memory leaks, and identify optimization opportunities.

## Prerequisites

The MCP server loads and analyzes large heap snapshots in memory, which can exceed Node.js's default heap limit. You need to configure `--max-old-space-size=8192` (or higher) to avoid out-of-memory crashes. The configuration examples below include this setting.

**Snapshot-size ceiling.** The server holds the full parsed graph (nodes, edges, dominator tree, indexes) resident, so its own RSS is roughly **3–5× the on-disk snapshot size**. With the recommended `--max-old-space-size=8192`, snapshots up to ~850 MB on disk have been analyzed reliably; `memlab_load_snapshot` refuses files above `max_file_size_mb` (default 900) to avoid OOM crashes that would lose all state. For larger heaps, raise both `--max-old-space-size` and `max_file_size_mb`. When loading multiple snapshots with `keep_previous: true`, each resident snapshot adds its full graph to RSS — unload ones you're done with via `memlab_snapshots`.

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

## Auto-Approving Tool Permissions

By default, Claude Code prompts you to approve each MCP tool call. To auto-approve all MemLab tools, add this to your `~/.claude/settings.json` (user-level) or `.claude/settings.json` (project-level):

```json
{
  "permissions": {
    "allow": [
      "mcp__memlab__*"
    ]
  }
}
```

The naming convention is `mcp__<server-name>__*` where `memlab` matches the key you used in your MCP server config. The `*` wildcard auto-approves all tools from that server.

You can also allowlist individual tools for granular control, add this to your `~/.claude/settings.json` (user-level) or `.claude/settings.json` (project-level):

```json
{
  "permissions": {
    "allow": [
      "mcp__memlab__memlab_load_snapshot",
      "mcp__memlab__memlab_snapshot_summary"
    ]
  }
}
```

## How It Works

The server holds a loaded `IHeapSnapshot` in memory across tool calls (loading is expensive for large heaps). Only one snapshot can be loaded at a time. All tools are read-only — they analyze the heap but never modify it.

## Getting a Heap Snapshot

### Chrome DevTools

1. Open DevTools (F12) > Memory tab
2. Select "Heap snapshot" and click "Take snapshot"
3. Right-click the snapshot in the left panel > "Save..."
4. Save the `.heapsnapshot` file

### Node.js

```js
const v8 = require('v8');
const snapshot = v8.writeHeapSnapshot();
console.log(`Heap snapshot written to ${snapshot}`);
```

## Tools Reference

### `memlab_load_snapshot`

Load and parse a `.heapsnapshot` file. Builds indexes, computes the dominator tree, and calculates retained sizes. `file_path` may be a local absolute path, a `manifold://bucket/key` URL, or a bare snapshot filename (resolved against the `nest_server_nodejs_heap_snapshots` bucket and fetched via `manifold get`). Pass `keep_previous: true` to keep earlier snapshots resident for diffing/comparison (each gets a handle; manage with `memlab_snapshots`). `quiet` / `suppress_suggestions` set session-wide output controls to trim repeated boilerplate.

```
Input:  { file_path: "snap.heapsnapshot" | "/abs/path" | "manifold://bucket/key",
          alias?: "before", keep_previous?: false, quiet?: false,
          suppress_suggestions?: false, max_file_size_mb?: 900 }
Output: { status, file_path, node_count, edge_count, total_size, handle }
```

### `memlab_snapshot_header`

Peek a `.heapsnapshot`'s header (node/edge counts, capture time, file size) **without** loading it — no dominator pass, so it can never wedge or OOM the server the way a full `memlab_load_snapshot` can. Reports whether the capture fits under the current auto-scaled load ceiling, this app's node/edge density, and — when it doesn't fit — the estimated largest same-app capture that *would* fit, so you can pick a loadable snapshot in one step instead of attempting an oversized load and retrying. `file_path` accepts the same three forms as `memlab_load_snapshot`; a Manifold fetch is reused (cached) by a subsequent load.

```
Input:  { file_path: "snap.heapsnapshot" | "/abs/path" | "manifold://bucket/key" }
Output: file size, node/edge counts, capture date, current ceiling, and a
        loadable ✓ / over-ceiling ✗ verdict with a density-based max-loadable-MB hint
```

### `memlab_snapshots`

Manage the multi-snapshot session and session output controls.

```
Input:  { action?: "list"|"switch"|"unload", handle?: "before",
          quiet?: bool, suppress_suggestions?: bool }
Output: resident snapshots (active one marked), or switch/unload result
```

### `memlab_property_distribution`

For a class/shape and a property, report value cardinality plus the top-K most frequent values. The key tool for diagnosing cardinality explosions (OTel metric attributes, cache keys, per-record fields).

```
Input:  { property: "http.route", class_name?: "Object", shape?: ["a","b"],
          top_k?: 15, min_count?: 1 }
Output: { scanned, distinct_values, top_values: [{ value, count, pct }] }
```

### `memlab_growth_signals`

Single-snapshot heuristic that flags likely unbounded growth: Maps/Sets keyed by timestamps or sequential integers, and large ever-growing Arrays. Confirm with a later snapshot + `memlab_diff_snapshots`.

```
Input:  { limit?: 15, min_entries?: 200, min_retained_size?: 262144 }
Output: candidates with kind, entry count, retained size, sample keys
```

### `memlab_sequence_analysis`

Trend analysis across an ordered sequence of 3+ snapshots. Loads each transiently (does not change the active snapshot), reports each class's count at every step, and labels "↑ every step" (leak signal) vs "grew net (noisy)". Lists classes new since baseline.

```
Input:  { paths: ["a","b","c"], limit?: 25, min_growth_count?: 50,
          monotonic_only?: false, max_file_size_mb?: 900 }
Output: per-step heap totals + growing classes with per-step counts and verdict
```

### `memlab_dev_artifacts`

Browser snapshots: classify large retainers as production vs. dev-only (retained solely via `__REACT_DEVTOOLS_GLOBAL_HOOK__`, `__REDUX_DEVTOOLS_EXTENSION__`, `window.Debug`, …) and total the bytes to exclude from leak headlines. `memlab_detached_dom` also reports the dev-only share inline.

```
Input:  { limit?: 25, min_retained_size?: 524288, only_dev?: false }
Output: dev-only byte total + per-object classification (production | dev-only via <global>)
```

### `memlab_event_registry`

Detector for per-model event registries (Backbone/observer): objects mapping event names to arrays of `{callback, context}`. Reports top event names by listener count, listeners-per-host distribution, and a structural-vs-leak verdict.

```
Input:  { min_events?: 2, limit?: 20, timeout_ms?: 45000 }
Output: registry stats + top events + verdict (structural O(hosts) vs re-subscription leak)
```

### `memlab_server_status`

Cheap liveness/health check — returns instantly with process RSS, uptime, and resident snapshots. Use to confirm the server is responsive (vs. stuck behind a heavy scan) and to watch RSS against the snapshot-size ceiling.

```
Input:  {}
Output: status, uptime, RSS, resident snapshots
```

### `memlab_snapshot_summary`

Overview stats: total nodes/edges, total size, breakdown by node type with dominator-aware aggregate retained sizes.

### `memlab_largest_objects`

Top N objects by retained size, filtering out internal/meta nodes.

```
Input:  { limit?: 20 }
```

### `memlab_get_node`

Look up a single node by numeric ID with full details (size, type, detachment status, dominator, location, string value).

```
Input:  { node_id: 12345 }
```

### `memlab_find_nodes_by_class`

Find all objects with a given constructor/class name, sorted by retained size.

```
Input:  { class_name: "FiberNode", limit?: 20 }
```

### `memlab_get_references`

Outgoing edges from a node (what it points to), sorted by target retained size.

```
Input:  { node_id: 12345, limit?: 30 }
```

### `memlab_get_referrers`

Incoming edges to a node (what points to it), sorted by source retained size.

```
Input:  { node_id: 12345, limit?: 30 }
```

### `memlab_retainer_trace`

Shortest path from a GC root to a node. Shows why the object is retained in memory.

```
Input:  { node_id: 12345 }
```

### `memlab_detached_dom`

Find detached DOM elements still retained in memory (common memory leak source). Supports count-only and ids-only modes for large result sets.

```
Input:  { output_mode?: "full"|"count"|"ids", limit?: 20 }
```

### `memlab_duplicated_strings`

Find duplicated string instances ranked by total retained size.

```
Input:  { limit?: 15 }
```

### `memlab_stale_collections`

Find Map/Set/Array collections holding detached DOM or unmounted Fiber nodes.

```
Input:  { limit?: 15 }
```

### `memlab_global_variables`

Non-built-in global variables on the Window object, sorted by retained size.

```
Input:  { limit?: 20 }
```

### `memlab_search_nodes`

General-purpose search combining filters: name pattern (regex), node type, size thresholds, detachment status.

```
Input:  { name_pattern?: "Regex", type?: "object", min_retained_size?: 1000000, limit?: 20 }
```

### `memlab_get_property`

Look up a specific property of a node by name and return the target node with full details.

```
Input:  { node_id: 12345, property_name: "stateNode" }
```

### `memlab_object_shape`

Show all named properties of an object with target types and sizes.

```
Input:  { node_id: 12345, include_internal?: false, limit?: 50 }
```

### `memlab_class_histogram`

Instance count and total retained size per constructor name, sorted by aggregate retained size (dominator-aware). The Chrome DevTools "Summary" view equivalent.

```
Input:  { limit?: 30, min_count?: 1, node_type?: "object" }
```

### `memlab_dominator_subtree`

Show objects dominated by a given node — what would be freed if it were garbage collected.

```
Input:  { node_id: 12345, limit?: 20 }
```

### `memlab_closure_inspection`

Inspect a closure's captured variables, source location, and scope context. Critical for diagnosing closure-based memory leaks.

```
Input:  { node_id: 12345 }
```

### `memlab_find_by_property`

Find all objects that have a specific property name. Useful for React internals (`__reactFiber$`), custom markers, or framework-specific patterns.

```
Input:  { property_name: "__reactFiber$", limit?: 20 }
```

### `memlab_aggregate`

Aggregate heap nodes by type, name, or name prefix. Returns grouped statistics with dominator-aware retained sizes (no double-counting).

```
Input:  { group_by: "type"|"name"|"name_prefix", name_pattern?: "...", limit?: 30 }
```

### `memlab_reports`

Run curated memory analysis reports. Use `"list"` to see available reports, pick one by name, or use `"full_analysis"` to run all reports for comprehensive triage.

```
Input:  { report: "list"|"full_analysis"|"detached_dom"|"duplicated_strings"|..., limit?: 10 }
```

### `memlab_eval`

Execute arbitrary JavaScript against the loaded heap snapshot in a sandboxed VM. Has access to `snapshot`, `utils`, and `helpers` but no filesystem/network access.

```
Input:  { code: "...", timeout_ms?: 30000 }
```

### `memlab_for_each`

Structured map/filter/reduce over all heap nodes with code predicates.

```
Input:  { filter_code: "node.type === 'closure'", map_code?: "...", reduce_code?: "...", limit?: 100 }
```

## Investigation Skill for AI Assistants

The [MCP Investigation Skill](./MCP_SKILL.md) provides a structured
methodology for AI coding assistants to systematically investigate memory
issues using the MCP tools. It covers:

- **Step-by-step triage** — load, diagnose, and prioritize findings
- **Investigation paths** — guided workflows for string waste, DOM leaks,
  object accumulation, closure leaks, global bloat, listener accumulation, and
  repeated errors, each with triggers, tool sequences, and common fixes
- **Tool selection reference** — a quick-reference table mapping investigation
  goals to the right MCP tool
- **Token efficiency tips** — how to minimize token usage with compact modes
  and parallel tool calls

## Example Workflow

A typical memory investigation:

1. **Load the snapshot**: "Load the heap snapshot at /tmp/my-app.heapsnapshot"
2. **Get an overview**: "Show me a summary of the heap"
3. **Find the biggest objects**: "What are the largest objects by retained size?"
4. **Investigate a specific object**: "Show me the retainer trace for node 48231"
5. **Check for common leak patterns**:
   - "Are there any detached DOM nodes?"
   - "Show me duplicated strings"
   - "Are any collections holding stale objects?"
6. **Drill into references**: "What does node 48231 reference?"

## License

MIT

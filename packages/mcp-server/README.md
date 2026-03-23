# @memlab/mcp-server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that wraps [MemLab](https://facebook.github.io/memlab/)'s heap analysis APIs, giving AI coding assistants (Claude Code, Cursor, etc.) interactive tools to explore JavaScript heap snapshots, find memory leaks, and identify optimization opportunities.

## Quick Start

### Option 1: npx (no install)

Add to your Claude Code MCP config (`~/.claude.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "memlab": {
      "type": "stdio",
      "command": "npx",
      "args": ["@memlab/mcp-server"]
    }
  }
}
```

### Option 2: Global install

```bash
npm install -g @memlab/mcp-server
```

Then configure:

```json
{
  "mcpServers": {
    "memlab": {
      "type": "stdio",
      "command": "memlab-mcp"
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

Then configure:

```json
{
  "mcpServers": {
    "memlab": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/memlab/packages/mcp/dist/index.js"]
    }
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

Load and parse a `.heapsnapshot` file. Builds indexes, computes the dominator tree, and calculates retained sizes.

```
Input:  { file_path: "/path/to/snapshot.heapsnapshot" }
Output: { status, file_path, node_count, edge_count, total_size }
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

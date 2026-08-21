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

The server keeps the fully parsed graph (nodes, edges, dominator tree, indexes)
resident, so its own memory footprint is roughly **3–5x the on-disk snapshot
size**. Always start it with `--max-old-space-size=8192` (or higher) — the
configurations above do this for you. With that setting, snapshots up to around
850 MB on disk have been analyzed reliably. `memlab_load_snapshot` refuses
files above `max_file_size_mb` (900 by default) rather than risking an
out-of-memory crash that would lose the session; raise both values together for
larger heaps.

:::

## Getting a heap snapshot

### From Chrome DevTools

1. Open DevTools (F12) and go to the **Memory** tab.
2. Select **Heap snapshot** and click **Take snapshot**.
3. Right-click the snapshot in the left panel and choose **Save...**.
4. Save the `.heapsnapshot` file somewhere the MCP server can read it.

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
2. **Frame the heap** — "What is this heap made of?" The assistant runs a
   summary, a class histogram, and the biggest retainers.
3. **Find what is growing** — with two or more snapshots taken at different
   points in time, "Which classes grow on every snapshot?"
4. **Rule out noise** — "Is any of this retained only by DevTools or browser
   extensions?"
5. **Explain the retention** — "Show me the retainer trace for node 48231, and
   tell me which reference to break."
6. **Confirm the fix** — capture a new set of snapshots after the fix and ask
   whether the per-cycle growth rate went down.

## What the tools can answer

The server ships 80+ tools. They are organized by the question they answer:

| Question | Representative tools |
| --- | --- |
| What is this heap made of? | `memlab_quick_diagnosis`, `memlab_snapshot_summary`, `memlab_class_histogram`, `memlab_largest_objects`, `memlab_shape_histogram` |
| Is anything growing — and is it a leak? | `memlab_leak_report`, `memlab_sequence_analysis`, `memlab_collection_trend`, `memlab_growth_signals`, `memlab_diff_snapshots`, `memlab_verify_fix` |
| Who owns the growth / why is X retained? | `memlab_retainer_trace`, `memlab_retainer_summary`, `memlab_dominator_chain`, `memlab_dominator_subtree`, `memlab_pinch_points`, `memlab_explain_delta` |
| Is it real, or a measurement artifact? | `memlab_dev_artifacts`, `memlab_check_health` |
| Detached DOM and event listeners | `memlab_detached_dom`, `memlab_event_listener_leaks`, `memlab_event_registry` |
| Collections and caches | `memlab_stale_collections`, `memlab_map_entries`, `memlab_weakmap_entries`, `memlab_cache_analysis` |
| Strings and duplication | `memlab_duplicated_strings`, `memlab_string_patterns`, `memlab_sliced_strings`, `memlab_duplicate_objects` |
| Inspect or find specific objects | `memlab_get_node`, `memlab_object_shape`, `memlab_get_references`, `memlab_get_referrers`, `memlab_find_nodes_by_class`, `memlab_find_by_property`, `memlab_search_nodes` |
| None of the above | `memlab_eval`, `memlab_for_each` |

Ask the assistant to call **`memlab_tools`** to print the full index, grouped
the same way, with a one-line "use it when" for every tool. It is the fastest
way to discover a tool you did not know to ask for.

## Working with more than one snapshot

Leak detection needs a trend, not a single capture. Pass `keep_previous: true`
when loading so earlier snapshots stay resident: each one gets a *handle*, and
`memlab_snapshots` lists them, switches the active one, or unloads the ones you
are done with. Node ids are only valid inside the snapshot they came from, so
switch to the right handle before reusing an id.

Every resident snapshot holds its full graph in memory. Watch the server's
footprint with `memlab_server_status` and unload snapshots you no longer need.

:::tip Peek before you load

`memlab_snapshot_header` reads a snapshot's header — node/edge counts, capture
time, file size — *without* parsing it, and tells you whether it fits under the
current load ceiling. Use it to pick a loadable capture in one step instead of
attempting an oversized load.

:::

## Tool permissions and safety

Every tool is read-only heap analysis except two: `memlab_eval` and
`memlab_for_each`.

:::danger Do not auto-approve `memlab_eval` or `memlab_for_each`

Both execute arbitrary JavaScript with the full privileges of the MCP server
process. They use `node:vm` to scope the globals they inject, but
[`node:vm` is not a security sandbox](https://nodejs.org/api/vm.html) — code
can reach the host realm and from there the filesystem, network, and shell.
Heap snapshot contents are attacker-influenceable input, so a prompt injection
could steer the model into running hostile code. Keep these two tools on manual
approval, and avoid a `mcp__memlab__*` wildcard allowlist, which would
auto-approve them too.

:::

To stop your assistant prompting on every call while keeping those two on
manual approval, allowlist the read-only tools explicitly. For Claude Code,
in `~/.claude/settings.json` (user-level) or `.claude/settings.json`
(project-level):

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

## Further reading

- [MCP server README](https://github.com/facebook/memlab/blob/main/packages/mcp-server/README.md)
  — the full tool reference, with the input and output shape of each tool.
- [MCP investigation skill](https://github.com/facebook/memlab/blob/main/packages/mcp-server/MCP_SKILL.md)
  — a structured methodology for assistants: step-by-step triage, guided
  investigation paths for string waste, DOM leaks, object accumulation, closure
  leaks and listener accumulation, plus token-efficiency tips.
- [AI assistant guide](https://github.com/facebook/memlab/blob/main/AI.md) —
  guidance for AI assistants using memlab more broadly, including writing test
  scenarios and reading retainer traces.

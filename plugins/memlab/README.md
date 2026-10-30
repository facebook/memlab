# memlab plugin for AI coding agents

This plugin gives an AI coding agent everything it needs to find and fix
JavaScript memory leaks with [memlab](https://meta.github.io/memlab):

- The [memlab MCP server](../../packages/mcp-server/README.md), with more than
  150 tools for loading and querying heap snapshots.
- Four [Agent Skills](https://agentskills.io) that teach the agent when and how
  to use memlab.

| Skill | The agent uses it to... |
|---|---|
| [`memlab-analyze-heap-snapshot`](skills/memlab-analyze-heap-snapshot/SKILL.md) | Investigate a `.heapsnapshot` file: what fills the heap, what grows, and why an object is still retained |
| [`memlab-find-web-leaks`](skills/memlab-find-web-leaks/SKILL.md) | Write a memlab scenario for a web UI interaction, run it, and fix the leaks it reports |
| [`memlab-capture-heap-snapshots`](skills/memlab-capture-heap-snapshots/SKILL.md) | Take heap snapshots from Chrome, Puppeteer, Playwright, Node.js, Electron or Hermes, including a series that shows growth |
| [`memlab-memory-tests`](skills/memlab-memory-tests/SKILL.md) | Add memory leak regression tests to Node.js unit tests and CI |

## Install in Claude Code

```bash
claude plugin marketplace add meta/memlab
claude plugin install memlab@memlab
```

Or from inside a session:

```
/plugin marketplace add meta/memlab
/plugin install memlab@memlab
```

Then ask, for example, "Load /tmp/app.heapsnapshot and tell me what is
leaking" or "Check whether opening and closing the settings dialog leaks
memory". Skills from the plugin also run as commands, such as
`/memlab:memlab-find-web-leaks`.

## Use the skills with other agents

The skills follow the [Agent Skills](https://agentskills.io/specification)
format, so any agent that supports it can load them. Copy the directories
under [`skills/`](skills/) into your agent's skills directory.

To give that agent the memlab MCP server too, add it to the agent's MCP
configuration as described in the
[MCP server README](../../packages/mcp-server/README.md). Without it, the
skills fall back to `memlab-cli`, which runs the same tools from a shell.

## Requirements and safety

- Node.js 18 or later and `npx`. The MCP server is fetched from npm
  (`@memlab/mcp-server`) the first time it starts.
- Memory: the server keeps a whole parsed snapshot in memory, so the plugin
  starts it with `NODE_OPTIONS=--max-old-space-size=8192`. Large snapshots
  need that much free RAM.
- Tools such as `memlab_eval` run JavaScript that the agent writes, with the
  server's full privileges. Keep them on manual approval and don't allowlist
  `mcp__*memlab*` with a wildcard. See
  [Tools that execute JavaScript](../../packages/mcp-server/README.md#tools-that-execute-javascript).

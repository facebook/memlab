# Using memlab without an MCP client

`memlab-cli` ships in the `@memlab/mcp-server` npm package. It starts the
same server the MCP client would and calls its tools over stdio, so every
`memlab_*` tool works the same way from a shell.

Run it with npx, or install the package globally
(`npm install -g @memlab/mcp-server`) and call `memlab-cli` directly. The
examples below use a shell function so they work in bash and zsh:

```bash
memlab_cli() { npx -y -p @memlab/mcp-server memlab-cli "$@"; }

memlab_cli doctor                        # node version, server path, live handshake
memlab_cli list                          # every tool with a one-line description
memlab_cli schema memlab_retainer_trace  # one tool's input schema as JSON
```

## One session per command

`call` takes `<tool> '<json-args>'` pairs and runs them in order in one server
session. Later calls see the snapshot loaded by an earlier one:

```bash
memlab_cli call \
  memlab_load_snapshot '{"file_path":"/abs/path/app.heapsnapshot","quiet":true}' \
  memlab_app_heap '{}' \
  memlab_retainer_trace '{"node_id":48231}'
```

`script` reads the same calls from a file, one JSON object per line. Lines
starting with `#` are comments:

```jsonl
{"tool":"memlab_load_snapshot","args":{"file_path":"/abs/path/app.heapsnapshot"}}
{"tool":"memlab_quick_diagnosis","args":{}}
{"tool":"memlab_detached_dom","args":{"group_by":"retainer"}}
```

```bash
memlab_cli script steps.jsonl
```

## Keep snapshots loaded between commands

Loading a large snapshot can take minutes. To load it once and run many
separate commands against it, keep one server running on a socket:

```bash
memlab_cli serve --socket /tmp/memlab.sock &
# The socket appears once the server is up; calls before that fail.
until [ -S /tmp/memlab.sock ]; do sleep 1; done
memlab_cli call --socket /tmp/memlab.sock memlab_load_snapshot '{"file_path":"/abs/path/app.heapsnapshot"}'
memlab_cli call --socket /tmp/memlab.sock memlab_quick_diagnosis '{}'
memlab_cli stop --socket /tmp/memlab.sock
```

## Memory

`memlab-cli` starts the server with its own `--max-old-space-size`, which
overrides `NODE_OPTIONS`. By default it uses 60% of physical RAM (at least
8 GB), or 60% of the container's memory limit. Set `MEMLAB_MAX_OLD_SPACE_MB`
to change it.

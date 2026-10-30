# AGENTS.md

Instructions for AI coding agents working on the memlab source code.

To *use* memlab rather than change it (write a leak test scenario, analyze a
heap snapshot, set up the MCP server), read [AI.md](./AI.md) and the
[MCP Investigation Skill](./packages/mcp-server/MCP_SKILL.md) instead.

## Repository layout

memlab is an npm workspaces monorepo. Each package under `packages/` is
published to npm separately:

| Directory | npm package | What it contains |
|---|---|---|
| `packages/core` | `@memlab/core` | Heap snapshot parser, the `IHeapSnapshot`/`IHeapNode`/`IHeapEdge` API, leak trace clustering, config |
| `packages/e2e` | `@memlab/e2e` | Browser automation with Puppeteer: runs test scenarios and takes heap snapshots |
| `packages/heap-analysis` | `@memlab/heap-analysis` | Built-in analyses behind `memlab analyze <plugin>` |
| `packages/api` | `@memlab/api` | Programmatic API: `run`, `takeSnapshots`, `findLeaks`, `analyze` |
| `packages/cli` | `@memlab/cli` | The `memlab` command line commands |
| `packages/memlab` | `memlab` | Umbrella package that installs the `memlab` CLI |
| `packages/lens` | `@memlab/lens` | In-browser overlay that highlights detached DOM and unmounted React components (webpack bundle) |
| `packages/mcp-server` | `@memlab/mcp-server` | MCP server for AI assistants, plus the `memlab-cli` command |

Each package depends only on packages earlier in this order: `core`, `lens`,
`e2e`, `heap-analysis`, `api`, `cli`, `memlab`. `mcp-server` depends only on
`core` and `heap-analysis`. Don't add an import that goes the other way.

`website/` is the Docusaurus site published at <https://meta.github.io/memlab>.
`docs/` is a symlink to `website/docs/`.

## Build, test, run

Use Node.js 18 or later (`@memlab/mcp-server` requires it).

```bash
npm install
npm run build              # compiles every package to packages/*/dist
npm test                   # runs each package's tests
npm run memlab -- help     # run the CLI built from this checkout
```

- **Build before you test.** Jest runs the compiled tests in
  `packages/*/dist/**/__tests__/`, not the TypeScript sources, so a test run
  without a fresh build tests old code.
- To work on one package: `npm run build-pkg -w packages/core`, then
  `npm run test-pkg -w packages/core`.
- `npm run dev` runs `tsc -b -w` for incremental rebuilds.
- Website: `cd website && yarn install && yarn start` serves it locally;
  `yarn build` is what the GitHub Pages deploy runs.

## Conventions

- TypeScript in `strict` mode. Put tests next to the code in `src/**/__tests__/*.test.ts`.
- Every source file starts with the MIT license header; copy it from an
  existing file in the same package.
- Public APIs are documented with TSDoc comments. The pages under
  `website/docs/api/` are generated from those comments; change the comment,
  not the generated markdown.
- `website/docs/cli/CLI-commands.md` is generated from the CLI command
  definitions in `packages/cli/src/commands/`; change the command, not the
  markdown.
- If you change a public API or CLI option, update `README.md`, `AI.md` and the
  affected package README in the same change.

### MCP server (`packages/mcp-server`)

- Register every tool in `src/tools/tools-index.ts`. The tool tables in
  `packages/mcp-server/README.md` are generated from it: run
  `npm run sync-catalog` in the package after adding or renaming a tool.
- `npm run test-pkg` in the package checks that every tool is in the index,
  that no tool description asks for a parameter its schema lacks, that the
  README tables are current, and that `src/server-version.ts` matches
  `package.json`.
- A tool that runs caller-supplied JavaScript goes in `RUNS_CODE` in
  `src/tool-annotations.ts`, which sets its MCP annotations and hides it under
  `MEMLAB_DISABLE_CODE_TOOLS=1`. Also list it in the README under
  "Tools that execute JavaScript".
- [`.mcp.json`](./.mcp.json) runs the server from this checkout
  (`packages/mcp-server/bin/memlab-mcp.js`), so build first.

## Pull requests

See [CONTRIBUTING.md](./CONTRIBUTING.md). Make sure the build and tests pass,
and update the documentation when you change behavior.

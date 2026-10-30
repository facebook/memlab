# @memlab/cli

The memlab command-line interface: every `memlab` command, its options, and
the dispatcher that runs them. It provides the `memlab` binary.

Most people install the CLI through the
[`memlab`](https://www.npmjs.com/package/memlab) package, which bundles it with
the rest of memlab:

```bash
npm install -g memlab
```

Installing `@memlab/cli` directly gives you the same `memlab` command.

## Find memory leaks in a web page

Write a [test scenario](https://meta.github.io/memlab/docs/api/core/src/interfaces/IScenario):
the page to load, the interaction you suspect leaks memory, and how to undo
it. `page` is a Puppeteer [`Page`](https://pptr.dev/api/puppeteer.page):

```javascript
// test-google-maps.js
function url() {
  return 'https://www.google.com/maps/@37.386427,-122.0428214,11z';
}

async function action(page) {
  await page.click('text/Hotels');
}

async function back(page) {
  await page.click('[aria-label="Close"]');
}

module.exports = {action, back, url};
```

Then run it:

```bash
memlab run --scenario test-google-maps.js
```

memlab opens the page in Chromium, takes a heap snapshot after each step, and
prints one representative retainer trace per cluster of leaked objects. A
retainer trace is the chain of references from a GC root that keeps the
leaked object alive.

## Commands

**Find leaks**

| Command | What it does |
| --- | --- |
| `memlab run --scenario <file>` | Run a scenario in the browser and find memory leaks |
| `memlab find-leaks` | Find leaks in heap snapshots you already have (`--baseline`, `--target`, `--final`, or `--snapshot-dir`) |
| `memlab diff-leaks` | Find leaks that are new in a test run compared to a control run |
| `memlab trace --node-id <id>` | Print the retainer trace of one heap object |

**Analyze a heap**

| Command | What it does |
| --- | --- |
| `memlab analyze <analysis>` | Run a heap analysis, for example `string`, `detached-DOM`, or `unbound-object` |
| `memlab heap --snapshot <file>` | Explore one heap snapshot interactively |
| `memlab view-heap --snapshot <file>` | View one heap snapshot in an interactive terminal UI |
| `memlab anonymize --snapshot <file> --output <file>` | Remove user data from a heap snapshot so it can be shared |

**Browser runs**

| Command | What it does |
| --- | --- |
| `memlab snapshot --scenario <file>` | Run a scenario and take heap snapshots, without finding leaks |
| `memlab warmup` / `memlab warmup-and-snapshot` | Warm up the app's server before taking snapshots |
| `memlab measure --scenario <file>` | Run a scenario many times to tell real heap growth from run-to-run noise |

**Other**

| Command | What it does |
| --- | --- |
| `memlab help [command]` | List all commands, or print help for one |
| `memlab version` | Show the versions of all installed memlab packages |
| `memlab get-default-work-dir` | Print the directory where results are saved by default |
| `memlab reset` | Reset and re-create memlab's working directories |

Common options:

- `--work-dir <dir>`: save the run's snapshots, screenshots, and results here.
- `--headful`: show the browser window (headless by default).
- `--device <name>`: emulate a device, for example a phone.
- `--chromium-binary <path>`: use a specific Chromium build.
- `--silent`, `--verbose`: change how much is printed.

Every command and option is listed in the
[CLI reference](https://meta.github.io/memlab/docs/cli/CLI-commands).

## Use the CLI from code

`run()` parses `process.argv` and dispatches to the matching command, the same
way the `memlab` binary does:

```javascript
const {run} = require('@memlab/cli');

run();
```

To drive memlab from a program, the
[`@memlab/api`](https://www.npmjs.com/package/@memlab/api) package is usually
a better fit: it takes options as objects and returns results instead of
printing them.

## Add your own heap analysis

`memlab analyze` loads analyses written as plugins. See
[`@memlab/heap-analysis`](https://www.npmjs.com/package/@memlab/heap-analysis)
for how to write one, then pass it with `--analysis-plugin`.

## Online Resources

* [Official Website and Demo](https://meta.github.io/memlab)
* [Documentation](https://meta.github.io/memlab/docs/intro)
* [CLI reference](https://meta.github.io/memlab/docs/cli/CLI-commands)

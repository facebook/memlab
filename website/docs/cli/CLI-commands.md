# Command Line Interface

## COMMON Commands


### memlab run

Find memory leaks in web apps

```bash
memlab run --scenario <TEST_SCENARIO_FILE>
```

#### examples

```bash
memlab run --scenario /tmp/test-scenario.js
memlab run --scenario /tmp/test-scenario.js --work-dir /tmp/test-1/
```

**Options**:
 * **`--work-dir`**: set the working directory of the current run
 * **`--headful`**: start the browser in headful mode, but default it is headless
 * **`--full`**: take heap snapshot for every step in E2E interaction
 * **`--skip-screenshot`**: skip taking screenshots
 * **`--skip-gc`**: skip doing garbage collection in browser
 * **`--skip-scroll`**: skip scrolling target page in browser
 * **`--skip-extra-ops`**: skip doing extra interactions (e.g., scrolling and waiting) on target and final page
 * **`--local-puppeteer`**: enable remote browser instance debugging via local puppeteer
 * **`--scenario`**: set file path loading test scenario
 * **`--device`**: set the device type to emulate
 * **`--disable-xvfb`**: disable Xvfb (X virtual framebuffer) for simulating headful browser rendering
 * **`--leak-filter`**: specify a definition JS file for leak filter
 * **`--trace-object-size-above`**: objects with retained size (bytes) bigger than the threshold will be considered as leaks
 * **`--ignore-leak-cluster-size-below`**: ignore memory leaks with aggregated retained size smaller than the threshold
 * **`--trace-all-objects`**: dump retainer trace for all allocated objects (ignore the leak filter)
 * **`--save-trace-as-unclassified-cluster`**: dump each retainer trace as an unclassified trace cluster
 * **`--ml-clustering`**: use machine learning algorithms for clustering leak traces (by default, traces are clustered by heuristics)
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

### memlab find-leaks

Find memory leaks in heap snapshots

```bash
memlab find-leaks 
```

**Options**:
 * **`--baseline`**: set file path of the baseline heap snapshot
 * **`--target`**: set file path of the target heap snapshot
 * **`--final`**: set file path of the final heap snapshot
 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--leak-filter`**: specify a definition JS file for leak filter
 * **`--trace-object-size-above`**: objects with retained size (bytes) bigger than the threshold will be considered as leaks
 * **`--ignore-leak-cluster-size-below`**: ignore memory leaks with aggregated retained size smaller than the threshold
 * **`--trace-all-objects`**: dump retainer trace for all allocated objects (ignore the leak filter)
 * **`--save-trace-as-unclassified-cluster`**: dump each retainer trace as an unclassified trace cluster
 * **`--ml-clustering`**: use machine learning algorithms for clustering leak traces (by default, traces are clustered by heuristics)
 * **`--work-dir`**: set the working directory of the current run
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

### memlab trace

Report retainer trace of a specific node, use with --nodeId

```bash
memlab trace --node-id=<HEAP_OBJECT_ID>
```

#### examples

```bash
memlab trace --node-id=@3123123
memlab trace --node-id=128127
```

**Options**:
 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis
 * **`--engine`**: set the JavaScript engine (default to V8)
 * **`--node-id`**: set heap node ID
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

### memlab analyze

Run heap analysis plugins

```bash
memlab analyze <PLUGIN_NAME> [PLUGIN_OPTIONS]
```

**Options**:
 * **`--work-dir`**: set the working directory of the current run
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

#### memlab analyze collections-with-stale

Analyze collections holding stale objects

```bash
memlab analyze collections-with-stale 
```

**Options**:
 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

#### memlab analyze detached-DOM

Get detached DOM elements

```bash
memlab analyze detached-DOM 
```

**Options**:
 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

#### memlab analyze global-variable

Get global variables in heap

```bash
memlab analyze global-variable 
```

**Options**:
 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

#### memlab analyze object-fanout

Get objects with the most out-going references in heap

```bash
memlab analyze object-fanout 
```

**Options**:
 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

#### memlab analyze object-shallow

Get objects by key and value, without recursing into sub-objects

```bash
memlab analyze object-shallow 
```

**Options**:
 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

#### memlab analyze shape

List the shapes that retained most memory

```bash
memlab analyze shape 
```

**Options**:
 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

#### memlab analyze object-size

Get the largest objects in heap

```bash
memlab analyze object-size 
```

**Options**:
 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

#### memlab analyze unbound-object

Check unbound object growth

```bash
memlab analyze unbound-object 
```

**Options**:
 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

#### memlab analyze unbound-shape

Get shapes with unbound growth

```bash
memlab analyze unbound-shape 
```

**Options**:
 * **`--snapshot-dir`**: set directory path containing all heap snapshots under analysis
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

#### memlab analyze string

Analyze string in heap

```bash
memlab analyze string 
```

**Options**:
 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

#### memlab analyze unmounted-fiber-node

Get unmounted React Fiber nodes

```bash
memlab analyze unmounted-fiber-node 
```

**Options**:
 * **`--snapshot`**: set file path of the heap snapshot under analysis
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output


## MISC Commands


### memlab version

Show the versions of all memlab packages installed

```bash
memlab version 
```

**Options**:
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

### memlab list

List all test scenarios

```bash
memlab list 
```

**Options**:
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

### memlab reset

Reset and initialize all directories

```bash
memlab reset 
```

**Options**:
 * **`--work-dir`**: set the working directory of the current run
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

### memlab measure

Run test scenario in measure mode

```bash
memlab measure --scenario <TEST_SCENARIO_FILE>
```

#### examples

```bash
memlab measure --scenario /tmp/test-scenario.js
memlab measure --scenario /tmp/test-scenario.js --work-dir /tmp/test-1/
```

**Options**:
 * **`--headful`**: start the browser in headful mode, but default it is headless
 * **`--run-num`**: set number of runs
 * **`--app`**: set name for onboarded web application
 * **`--interaction`**: set name for onboarded interaction
 * **`--full`**: take heap snapshot for every step in E2E interaction
 * **`--skip-snapshot`**: skip taking heap snapshots
 * **`--skip-screenshot`**: skip taking screenshots
 * **`--skip-gc`**: skip doing garbage collection in browser
 * **`--skip-scroll`**: skip scrolling target page in browser
 * **`--skip-extra-ops`**: skip doing extra interactions (e.g., scrolling and waiting) on target and final page
 * **`--run-mode`**: set running mode
 * **`--local-puppeteer`**: enable remote browser instance debugging via local puppeteer
 * **`--scenario`**: set file path loading test scenario
 * **`--device`**: set the device type to emulate
 * **`--disable-xvfb`**: disable Xvfb (X virtual framebuffer) for simulating headful browser rendering
 * **`--work-dir`**: set the working directory of the current run
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

### memlab warmup

Warm up the target app

```bash
memlab warmup --scenario <TEST_SCENARIO_FILE>
```

#### examples

```bash
memlab warmup --scenario /tmp/test-scenario.js
```

**Options**:
 * **`--headful`**: start the browser in headful mode, but default it is headless
 * **`--app`**: set name for onboarded web application
 * **`--interaction`**: set name for onboarded interaction
 * **`--run-mode`**: set running mode
 * **`--local-puppeteer`**: enable remote browser instance debugging via local puppeteer
 * **`--scenario`**: set file path loading test scenario
 * **`--device`**: set the device type to emulate
 * **`--disable-xvfb`**: disable Xvfb (X virtual framebuffer) for simulating headful browser rendering
 * **`--skip-warmup`**: skip warming up web server
 * **`--work-dir`**: set the working directory of the current run
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

### memlab help

List all MemLab CLI commands or print helper text for a specific command

```bash
memlab help <COMMAND> [SUB-COMMANDS]
```

**Options**:
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

### memlab get-default-work-dir

Query the default working directory

```bash
memlab get-default-work-dir 
```

**Options**:
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

### memlab snapshot

Interact with web app and take heap snapshots

```bash
memlab snapshot --scenario <TEST_SCENARIO_FILE>
```

#### examples

```bash
memlab snapshot --scenario /tmp/test-scenario.js
memlab snapshot --scenario /tmp/test-scenario.js --work-dir /tmp/test-1/
```

**Options**:
 * **`--headful`**: start the browser in headful mode, but default it is headless
 * **`--app`**: set name for onboarded web application
 * **`--interaction`**: set name for onboarded interaction
 * **`--full`**: take heap snapshot for every step in E2E interaction
 * **`--skip-snapshot`**: skip taking heap snapshots
 * **`--skip-screenshot`**: skip taking screenshots
 * **`--skip-gc`**: skip doing garbage collection in browser
 * **`--skip-scroll`**: skip scrolling target page in browser
 * **`--skip-extra-ops`**: skip doing extra interactions (e.g., scrolling and waiting) on target and final page
 * **`--run-mode`**: set running mode
 * **`--local-puppeteer`**: enable remote browser instance debugging via local puppeteer
 * **`--scenario`**: set file path loading test scenario
 * **`--device`**: set the device type to emulate
 * **`--disable-xvfb`**: disable Xvfb (X virtual framebuffer) for simulating headful browser rendering
 * **`--work-dir`**: set the working directory of the current run
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output

### memlab warmup-and-snapshot

Warm up server and take heap snapshots

```bash
memlab warmup-and-snapshot 
```

**Options**:
 * **`--work-dir`**: set the working directory of the current run
 * **`--headful`**: start the browser in headful mode, but default it is headless
 * **`--app`**: set name for onboarded web application
 * **`--interaction`**: set name for onboarded interaction
 * **`--run-mode`**: set running mode
 * **`--local-puppeteer`**: enable remote browser instance debugging via local puppeteer
 * **`--scenario`**: set file path loading test scenario
 * **`--device`**: set the device type to emulate
 * **`--disable-xvfb`**: disable Xvfb (X virtual framebuffer) for simulating headful browser rendering
 * **`--skip-warmup`**: skip warming up web server
 * **`--full`**: take heap snapshot for every step in E2E interaction
 * **`--skip-snapshot`**: skip taking heap snapshots
 * **`--skip-screenshot`**: skip taking screenshots
 * **`--skip-gc`**: skip doing garbage collection in browser
 * **`--skip-scroll`**: skip scrolling target page in browser
 * **`--skip-extra-ops`**: skip doing extra interactions (e.g., scrolling and waiting) on target and final page
 * **`--help`**, **`-h`**: print helper text
 * **`--verbose`**, **`-v`**: show more details
 * **`--sc`**: set to continuous test mode
 * **`--debug`**: enable manual debugging
 * **`--silent`**, **`-s`**: mute all terminal output


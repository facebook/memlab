# Type Alias: RunOptions

> **RunOptions** = `object`

Defined in: api/src/API.ts:47

Options for configuring browser interaction run, all fields are optional

## Properties

### chromiumBinary?

> `optional` **chromiumBinary**: `string`

Defined in: api/src/API.ts:102

if not specified, memlab will use the Chromium binary installed
by Puppeteer. Use this option to specify a different binary if
Puppeteer does not install the Chromium binary correctly (e.g., in a
environtment Docker) or when you may want to use a different version of
Chromium binary.

***

### consoleMode?

> `optional` **consoleMode**: [`ConsoleMode`](../enumerations/ConsoleMode.md)

Defined in: api/src/API.ts:94

specifying the terminal output mode, default is `default`.
For more details. please check out [ConsoleMode](../enumerations/ConsoleMode.md)

***

### cookiesFile?

> `optional` **cookiesFile**: `string`

Defined in: api/src/API.ts:54

the absolute path of cookies file

***

### evalInBrowserAfterInitLoad?

> `optional` **evalInBrowserAfterInitLoad**: `AnyFunction`

Defined in: api/src/API.ts:62

function to be evaluated in browser context after
the web page initial load.
Note that this function is defined in node.js context but it will be
evaluated in browser context so the function should not use any closure
variables outside of the browser context.

***

### scenario?

> `optional` **scenario**: `IScenario`

Defined in: api/src/API.ts:52

test scenario specifying how to interact with browser
(for more details view IScenario)

***

### skipWarmup?

> `optional` **skipWarmup**: `boolean`

Defined in: api/src/API.ts:89

skip the initial page loading warmup for the web application being tested

***

### snapshotForEachStep?

> `optional` **snapshotForEachStep**: `boolean`

Defined in: api/src/API.ts:68

if true, take heap snapshot for each interaction step,
by default this is false, which means memlab will decide
which steps it will take heap snapshots

***

### webWorker?

> `optional` **webWorker**: `Optional`\<`string`\>

Defined in: api/src/API.ts:85

if this field is provided, it specifies the web worker as the target
for heap analysis. For example `{webWorker: null}` means analyzing
the heap of the first web worker found. `{webWorker: 'workerTitle'}`
means analyzing the heap of the web worker with name: `'workerTitle'`.

***

### workDir?

> `optional` **workDir**: `string`

Defined in: api/src/API.ts:78

specify the working directory where you want memlab to dump
heap snapshots and other meta data of the test run. If no
working directory is provided, memlab will generate a random
temp directory under the operating system's default directory
for temporary files.
Note: It's the caller's responsibility to make sure the
specified working directory exists.

# Function: findLeaksBySnapshotFilePaths()

> **findLeaksBySnapshotFilePaths**(`baselineSnapshot`, `targetSnapshot`, `finalSnapshot`, `options`): `Promise`\<`ISerializedInfo`[]\>

Defined in: api/src/API.ts:284

This API finds memory leaks by analyzing specified heap snapshots.
This is equivalent to `memlab find-leaks` with
the `--baseline`, `--target`, and `--final` flags in CLI.

## Parameters

### baselineSnapshot

`string`

the file path of the baseline heap snapshot

### targetSnapshot

`string`

the file path of the target heap snapshot

### finalSnapshot

`string`

the file path of the final heap snapshot

### options

optionally, you can specify a mode for heap analysis

#### consoleMode?

[`ConsoleMode`](../enumerations/ConsoleMode.md)

specify the terminal output
mode (see [ConsoleMode](../enumerations/ConsoleMode.md))

#### workDir?

`string`

specify a working directory (other than
the default one)

## Returns

`Promise`\<`ISerializedInfo`[]\>

leak traces detected and clustered from the browser interaction

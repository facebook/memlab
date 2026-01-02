# Type Alias: RunResult

> **RunResult** = `object`

Defined in: api/src/API.ts:108

A data structure holding the result of the [run](../functions/run.md) API call.

## Properties

### leaks

> **leaks**: `ISerializedInfo`[]

Defined in: api/src/API.ts:112

leak traces detected and clustered from the browser interaction

***

### runResult

> **runResult**: [`BrowserInteractionResultReader`](../classes/BrowserInteractionResultReader.md)

Defined in: api/src/API.ts:116

a utility for reading browser interaction results from disk

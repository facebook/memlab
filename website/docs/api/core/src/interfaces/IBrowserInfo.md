# Interface: IBrowserInfo

Defined in: core/src/lib/Types.ts:1231

This data structure contains the input configuration for the browser and
output data from the browser. You can retrieve the instance of this type
through [RunMetaInfo](../type-aliases/RunMetaInfo.md).

## Properties

### \_browserVersion

> **\_browserVersion**: `string`

Defined in: core/src/lib/Types.ts:1235

browser version

***

### \_consoleMessages

> **\_consoleMessages**: `string`[]

Defined in: core/src/lib/Types.ts:1243

all web console output

***

### \_puppeteerConfig

> **\_puppeteerConfig**: `LaunchOptions`

Defined in: core/src/lib/Types.ts:1239

configuration for puppeteer

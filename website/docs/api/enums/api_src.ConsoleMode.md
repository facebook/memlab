---
id: "api_src.ConsoleMode"
title: "Enumeration: ConsoleMode"
sidebar_label: "ConsoleMode"
custom_edit_url: null
---

enum of all console mode options

## Enumeration Members

### <a id="continuous\_test" name="continuous\_test"></a> **CONTINUOUS\_TEST**

continuous test mode, no terminal output overwrite or animation,
equivalent to using `--sc`

 * **Source**:
    * api/src/state/ConsoleModeManager.ts:26

___

### <a id="default" name="default"></a> **DEFAULT**

the default mode, there could be terminal output overwrite and animation,

 * **Source**:
    * api/src/state/ConsoleModeManager.ts:30

___

### <a id="silent" name="silent"></a> **SILENT**

mute all terminal output, equivalent to using `--silent`

 * **Source**:
    * api/src/state/ConsoleModeManager.ts:21

___

### <a id="verbose" name="verbose"></a> **VERBOSE**

verbose mode, there could be terminal output overwrite and animation

 * **Source**:
    * api/src/state/ConsoleModeManager.ts:34

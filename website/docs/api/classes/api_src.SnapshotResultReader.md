---
id: "api_src.SnapshotResultReader"
title: "Class: SnapshotResultReader"
sidebar_label: "SnapshotResultReader"
custom_edit_url: null
---

A utility entity to read all MemLab files generated from
baseline, target and final heap snapshots.

The most useful feature of this class is when you have
three separate snapshots (baseline, target, and final)
that are not taken from MemLab, but you still would
like to use the `findLeaks` to detect memory leaks:

```javascript
const {SnapshotResultReader, findLeaks} = require('@memlab/api');

// baseline, target, and final are file paths of heap snapshot files
const reader = SnapshotResultReader.fromSnapshots(baseline, target, final);
const leaks = await findLeaks(reader);
```

## Hierarchy

- `default`

  ↳ **`SnapshotResultReader`**

## Methods

### <a id="getinteractionsteps"></a>**getInteractionSteps**()

browser interaction step sequence

 * **Returns**: `E2EStepInfo`[] | an array of browser interaction step information

* **Examples**:
```javascript
const {SnapshotResultReader} = require('@memlab/api');

// baseline, target, and final are file paths of heap snapshot files
const reader = SnapshotResultReader.fromSnapshots(baseline, target, final);
const paths = reader.getInteractionSteps();
```

 * **Source**:
    * api/src/result-reader/SnapshotResultReader.ts:159

___

### <a id="getrootdirectory"></a>**getRootDirectory**()

get the directory where the data and generated files of
the memlab run were stored

 * **Returns**: `string` | absolute path of the directory
* **Examples**:
```javascript
const {takeSnapshots} = require('@memlab/api');

(async function () {
  const scenario = { url: () => 'https://www.npmjs.com'};
  const result = await takeSnapshots({scenario});

  // get the directory that stores all the files
  // generated from the takeSnapshots call
  const dataDir = result.getRootDirectory();
})();
```

 * **Source**:
    * api/src/result-reader/BaseResultReader.ts:72

___

### <a id="getsnapshotfiles"></a>**getSnapshotFiles**()

get all snapshot files related to this SnapshotResultReader

 * **Returns**: `string`[] | an array of snapshot file's absolute path

* **Examples**:
```javascript
const {SnapshotResultReader} = require('@memlab/api');

// baseline, target, and final are file paths of heap snapshot files
const reader = SnapshotResultReader.fromSnapshots(baseline, target, final);
const paths = reader.getSnapshotFiles();
```

 * **Source**:
    * api/src/result-reader/SnapshotResultReader.ts:132

___

### <a id="fromsnapshots"></a>`Static` **fromSnapshots**(`baselineSnapshot`, `targetSnapshot`, `finalSnapshot`)

Build a result reader from baseline, target, and final heap snapshot files.
The three snapshot files do not have to be in the same directory.

 * **Parameters**:
    * `baselineSnapshot`: `string` | file path of the baseline heap snapshot
    * `targetSnapshot`: `string` | file path of the target heap snapshot
    * `finalSnapshot`: `string` | file path of the final heap snapshot
 * **Returns**: [`SnapshotResultReader`](api_src.SnapshotResultReader.md) | the ResultReader instance

* **Examples**:
```javascript
const {SnapshotResultReader, findLeaks} = require('@memlab/api');

// baseline, target, and final are file paths of heap snapshot files
const reader = SnapshotResultReader.fromSnapshots(baseline, target, final);
const leaks = await findLeaks(reader);
```

 * **Source**:
    * api/src/result-reader/SnapshotResultReader.ts:99

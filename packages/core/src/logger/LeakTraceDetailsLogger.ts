/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {
  IHeapSnapshot,
  ISerializedInfo,
  LeakTracePathItem,
  Nullable,
} from '../lib/Types';

import serializer from '../lib/Serializer';
import utils from '../lib/Utils';
import fs from 'fs';
import path from 'path';

class LeakTraceDetailsLogger {
  _wrapPathJSONInLoader(jsonContent: string): string {
    return `window.gcPath = ${jsonContent};`;
  }

  setTraceFileEmpty(filepath: string): void {
    const content = this._wrapPathJSONInLoader('');
    fs.writeFile(filepath, content, 'UTF-8', () => {
      // noop
    });
  }

  logTrace(
    leakedIdSet: Set<number>,
    snapshot: IHeapSnapshot,
    nodeIdsInSnapshots: Array<Set<number>>,
    trace: LeakTracePathItem,
    filepath: string,
  ): Nullable<ISerializedInfo> {
    const options = {leakedIdSet, nodeIdsInSnapshots};
    const gcTrace = serializer.JSONifyPath(trace, snapshot, options);
    const traceJSON = JSON.stringify(gcTrace, null, 2);
    const content = this._wrapPathJSONInLoader(traceJSON);
    fs.writeFile(filepath, content, 'UTF-8', () => {
      // noop
    });
    return gcTrace;
  }

  logTraces(
    leakedIdSet: Set<number>,
    snapshot: IHeapSnapshot,
    nodeIdsInSnapshots: Array<Set<number>>,
    traces: LeakTracePathItem[],
    outDir: string,
  ): Array<ISerializedInfo> {
    const ret = [];
    for (const trace of traces) {
      const nodeId = utils.getLastNodeId(trace);
      const file = path.join(outDir, `@${nodeId}.json`);
      const jsonTrace = this.logTrace(
        leakedIdSet,
        snapshot,
        nodeIdsInSnapshots,
        trace,
        file,
      );
      if (jsonTrace != null) {
        ret.push(jsonTrace);
      }
    }
    return ret;
  }
}

export default new LeakTraceDetailsLogger();

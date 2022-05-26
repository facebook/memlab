/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import config from '../lib/Config';
import serializer from '../lib/Serializer';
import utils from '../lib/Utils';
import fs from 'fs';
import path from 'path';
import {IHeapSnapshot, LeakTracePathItem} from '../lib/Types';

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
  ): void {
    const options = {leakedIdSet, nodeIdsInSnapshots};
    const gcTrace = serializer.JSONifyPath(trace, snapshot, options);
    const traceJSON = JSON.stringify(gcTrace, null, 2);
    const content = this._wrapPathJSONInLoader(traceJSON);
    fs.writeFile(filepath, content, 'UTF-8', () => {
      // noop
    });
  }

  logTraces(
    leakedIdSet: Set<number>,
    snapshot: IHeapSnapshot,
    nodeIdsInSnapshots: Array<Set<number>>,
    traces: LeakTracePathItem[],
    outDir: string,
  ): void {
    if (!config.isContinuousTest) {
      return;
    }
    for (const trace of traces) {
      const nodeId = utils.getLastNodeId(trace);
      const file = path.join(outDir, `@${nodeId}.json`);
      this.logTrace(leakedIdSet, snapshot, nodeIdsInSnapshots, trace, file);
    }
  }
}

export default new LeakTraceDetailsLogger();

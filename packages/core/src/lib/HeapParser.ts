/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @lightSyntaxTransform
 * @format
 */

'use strict';

import type {
  IHeapNode,
  IHeapSnapshot,
  HeapSnapshotInfo,
  RawHeapSnapshot,
} from './Types';

import config from './Config';
import info from './Console';
import stringLoader from './StringLoader';
import HeapSnapshot from './heap-data/HeapSnapshot';

// ----------- utility and parsing functions -----------

function getSnapshotMetaData(content: string) {
  function getSignatureIndex(signature: string): number {
    const idx = content.indexOf(signature);
    if (idx < 0) {
      throw 'heap parsing: meta data parsing error';
    }
    return idx;
  }
  const startSignature = '"snapshot":';
  const startIdx = getSignatureIndex(startSignature) + startSignature.length;
  const endSignature = '"nodes":';
  const endIdx = getSignatureIndex(endSignature);
  const metaContent = content.slice(startIdx, endIdx).trim().slice(0, -1);
  return JSON.parse(metaContent);
}

const nums = Object.create(null);
for (let i = 0; i < 10; i++) {
  nums[`${i}`] = i;
}

async function loadSnapshotMetaDataFromFile(
  file: string,
): Promise<HeapSnapshotInfo> {
  const content = await stringLoader.readFile(file, {
    startSignature: '"snapshot":',
    endSignature: '"nodes":',
    inclusive: true,
  });
  return getSnapshotMetaData(content);
}

async function getNodeIdsFromFile(
  file: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _options = {},
): Promise<Set<number>> {
  const snapshotInfo = await loadSnapshotMetaDataFromFile(file);
  const nodes = await stringLoader.readFileAndExtractTypedArray(file, 'nodes');
  const ids: Set<number> = new Set();
  const nodeFields = snapshotInfo.meta.node_fields;
  const nodeFieldCount = nodeFields.length;
  const idOffset = nodeFields.indexOf('id');
  let valueIndex = 0;
  while (valueIndex < nodes.length) {
    ids.add(nodes[valueIndex + idOffset]);
    valueIndex += nodeFieldCount;
  }
  return ids;
}

async function parseFile(file: string): Promise<RawHeapSnapshot> {
  const [nodes, edges, locations, content] = await Promise.all([
    stringLoader.readFileAndExtractTypedArray(file, 'nodes'),
    stringLoader.readFileAndExtractTypedArray(file, 'edges'),
    stringLoader.readFileAndExtractTypedArray(file, 'locations'),
    stringLoader.readFileAndExcludeTypedArray(file, [
      'nodes',
      'edges',
      'locations',
    ]),
  ]);

  const snapshot = JSON.parse(content);
  snapshot.nodes = nodes;
  snapshot.edges = edges;
  snapshot.locations = locations;
  return snapshot;
}

// auto detect and set JS snapshot's engine type
function identifyAndSetEngine(snapshot: IHeapSnapshot): void {
  if (config.specifiedEngine) {
    if (config.verbose) {
      info.lowLevel(
        `JS snapshot engine is manually set to be ${config.jsEngine}`,
      );
    }
    return; // skip if engine type is manually set
  }

  info.overwrite('identifying snapshot engine...');
  let engine = 'V8';
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.type === 'object' && node.name.startsWith('Object(')) {
      engine = 'hermes';
      return false;
    }
  });

  if (config.verbose) {
    info.lowLevel(`detect and set JS snapshot engine: ${engine}`);
  }
  config.jsEngine = engine;
}

async function parse(file: string, options = {}): Promise<IHeapSnapshot> {
  const snapshot = await parseFile(file);
  const ret = new HeapSnapshot(snapshot, options);
  identifyAndSetEngine(ret);
  return ret;
}

export default {
  getNodeIdsFromFile,
  parse,
};

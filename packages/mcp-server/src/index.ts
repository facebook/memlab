#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';

import {registerLoadSnapshot} from './tools/load-snapshot.js';
import {registerSnapshotSummary} from './tools/snapshot-summary.js';
import {registerLargestObjects} from './tools/largest-objects.js';
import {registerGetNode} from './tools/get-node.js';
import {registerFindNodesByClass} from './tools/find-nodes-by-class.js';
import {registerGetReferences} from './tools/get-references.js';
import {registerGetReferrers} from './tools/get-referrers.js';
import {registerRetainerTrace} from './tools/retainer-trace.js';
import {registerDetachedDom} from './tools/detached-dom.js';
import {registerDuplicatedStrings} from './tools/duplicated-strings.js';
import {registerStaleCollections} from './tools/stale-collections.js';
import {registerGlobalVariables} from './tools/global-variables.js';
import {registerSearchNodes} from './tools/search-nodes.js';
import {registerGetProperty} from './tools/get-property.js';
import {registerObjectShape} from './tools/object-shape.js';
import {registerClassHistogram} from './tools/class-histogram.js';
import {registerDominatorSubtree} from './tools/dominator-subtree.js';
import {registerClosureInspection} from './tools/closure-inspection.js';
import {registerFindByProperty} from './tools/find-by-property.js';
import {registerAggregateNodes} from './tools/aggregate-nodes.js';
import {registerEval} from './tools/eval.js';
import {registerForEach} from './tools/for-each.js';
import {registerReports} from './tools/reports.js';

const server = new McpServer({
  name: 'memlab',
  version: '1.1.0',
});

registerLoadSnapshot(server);
registerSnapshotSummary(server);
registerLargestObjects(server);
registerGetNode(server);
registerFindNodesByClass(server);
registerGetReferences(server);
registerGetReferrers(server);
registerRetainerTrace(server);
registerDetachedDom(server);
registerDuplicatedStrings(server);
registerStaleCollections(server);
registerGlobalVariables(server);
registerSearchNodes(server);
registerGetProperty(server);
registerObjectShape(server);
registerClassHistogram(server);
registerDominatorSubtree(server);
registerClosureInspection(server);
registerFindByProperty(server);
registerAggregateNodes(server);
registerReports(server);
registerEval(server);
registerForEach(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

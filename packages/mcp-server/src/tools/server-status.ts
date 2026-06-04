/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {listSnapshots, getCurrentHandle} from '../heap-state.js';
import {formatBytes, formatNumber, errorResult, textResult} from '../utils.js';

export function registerServerStatus(server: McpServer): void {
  server.tool(
    'memlab_server_status',
    'Cheap liveness/health check: returns instantly with the server process RSS, uptime, and the resident snapshots. Use it to confirm the server is responsive (vs. stuck behind a heavy scan) and to watch RSS against the snapshot-size ceiling. Scan tools are time-budgeted (timeout_ms) so a heavy scan returns cleanly instead of wedging the server; if a call ever seems hung, this check should still answer immediately.',
    {},
    async () => {
      try {
        const mem = process.memoryUsage();
        const uptimeS = Math.round(process.uptime());
        const all = listSnapshots();
        const cur = getCurrentHandle();
        const lines = [
          '## memlab server status',
          '',
          `- Status: ready`,
          `- Uptime: ${uptimeS}s`,
          `- Process RSS: ${formatBytes(mem.rss)} (heapUsed ${formatBytes(mem.heapUsed)} / heapTotal ${formatBytes(mem.heapTotal)})`,
          `- Resident snapshots: ${all.length}`,
        ];
        for (const m of all) {
          lines.push(
            `  ${m.handle === cur ? '→' : ' '} ${m.handle} — ${m.fileName}, ${formatBytes(m.totalSize)}, ${formatNumber(m.nodeCount)} nodes`,
          );
        }
        if (all.length === 0) {
          lines.push('  (none loaded — use memlab_load_snapshot)');
        }
        lines.push(
          '',
          '_Tip: full-heap scan tools (search_nodes, find_by_property, global_variables) accept timeout_ms and return partial results rather than hanging. If RSS approaches your --max-old-space-size, unload snapshots with memlab_snapshots(action:"unload")._',
          '_Recovery: if a prior long/interrupted call left the server unresponsive (even trivial calls hang), starting a FRESH server instance fully recovers it — restart the MCP server and reload the snapshot._',
        );
        return textResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

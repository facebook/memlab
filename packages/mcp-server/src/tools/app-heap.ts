/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode} from '@memlab/core';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {getSnapshot, getSnapshotMetadata} from '../heap-state.js';
import {
  formatBytes,
  formatNumber,
  markdownTable,
  errorResult,
  toolResult,
} from '../utils.js';
import {classifyArtifact} from '../artifact-classes.js';
import {
  collectDevRoots,
  computeReachableWithoutDevRoots,
} from './dev-artifacts.js';

/**
 * How much of this heap is actually the APPLICATION?
 *
 * A dev-build heap is mostly not the app. Measured on one WhatsApp Web capture:
 * `system / ExternalStringData` — the bundle's own source text — was 56% of a
 * 311 MB heap, single strings in it retained 84.9 / 22.5 / 17.8 / 10.2 MB, and
 * code-related memory came to roughly two thirds of the total. So "drive to
 * 600 MB" is mostly an instruction to load more bundle, the number is not
 * comparable to production, and a threshold expressed against it is measuring
 * the wrong thing.
 *
 * The split below is deliberately coarse and named, not a single magic number:
 * a reader has to be able to see WHICH bucket dominates, because that is what
 * decides whether the capture is usable at all.
 */
const CODE_TYPES: ReadonlySet<string> = new Set(['code']);

// Bundle source text and the V8 structures that hold it. These exist because
// the app was *loaded*, not because it did anything.
const BUNDLE_NAME_RE =
  /ExternalStringData|InstructionStream|BytecodeArray|SharedFunctionInfo|ScopeInfo|UncompiledData|FeedbackVector|FeedbackMetadata|FeedbackCell|ClosureFeedbackCellArray|\(constant pool\)|ConstantPool/;

export function registerAppHeap(server: McpServer): void {
  server.tool(
    'memlab_app_heap',
    'Report APP-ATTRIBUTABLE heap: total self size minus bundle/code memory, minus dev-build artifacts, minus measurement-harness content — the part of the heap that is actually the application. ' +
      'On a dev build the raw number is mostly not the app: a measured WhatsApp Web capture had bundle source text (`system / ExternalStringData`) at 56% of a 311 MB heap and code-related memory at roughly two thirds of the total. A leak-hunt threshold expressed against the raw total therefore mostly measures how much bundle has loaded, and is not comparable to production at all. ' +
      'Use this as the number to drive a hunt against and to quote in a report; use memlab_leak_report for whether anything is actually growing.',
    {
      show_breakdown: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Show the per-bucket table (default true). The breakdown is the point — which bucket dominates decides whether the capture is usable.',
        ),
    },
    async ({show_breakdown}) => {
      try {
        const snapshot = getSnapshot();
        const meta = getSnapshotMetadata();

        const devRoots = collectDevRoots(snapshot);
        const reached =
          devRoots.byId.size > 0
            ? computeReachableWithoutDevRoots(snapshot, devRoots)
            : null;

        let total = 0;
        let code = 0;
        let bundle = 0;
        let devOnly = 0;
        let artifact = 0;
        let app = 0;
        let appNodes = 0;

        const isDevOnly = (node: IHeapNode): boolean =>
          reached != null && reached[node.nodeIndex] === 0;

        snapshot.nodes.forEach(node => {
          if (node.id <= 3) return;
          const size = node.self_size;
          total += size;
          // Precedence matters: a node is counted once, in the most specific
          // bucket that explains why it is NOT app memory.
          if (isDevOnly(node)) {
            devOnly += size;
            return;
          }
          if (CODE_TYPES.has(node.type)) {
            code += size;
            return;
          }
          if (BUNDLE_NAME_RE.test(node.name)) {
            bundle += size;
            return;
          }
          if (classifyArtifact(node.name) != null) {
            artifact += size;
            return;
          }
          app += size;
          appNodes++;
        });

        const pct = (n: number): string =>
          total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '—';

        const lines: string[] = [
          '## App-attributable heap',
          '',
          `**${formatBytes(app)} of ${formatBytes(total)} (${pct(app)}) is application memory** across ${formatNumber(appNodes)} nodes` +
            (meta ? ` in \`${meta.fileName}\`` : '') +
            '.',
          '',
        ];

        if (show_breakdown) {
          lines.push(
            markdownTable(
              ['Bucket', 'Self size', '% of heap', 'What it is'],
              [
                [
                  'App',
                  formatBytes(app),
                  pct(app),
                  'The number to drive and report',
                ],
                [
                  'Bundle / source text',
                  formatBytes(bundle),
                  pct(bundle),
                  'Loaded, not allocated by use; absent at this scale in prod',
                ],
                [
                  'Code / bytecode',
                  formatBytes(code),
                  pct(code),
                  'JIT + compiled code; grows by exercising new paths',
                ],
                [
                  'Dev/automation-retained',
                  formatBytes(devOnly),
                  pct(devOnly),
                  'Held only via inspector/dev roots; GC-eligible in prod',
                ],
                [
                  'Known artifacts',
                  formatBytes(artifact),
                  pct(artifact),
                  'CDP/a11y/warmup families',
                ],
              ],
              new Set([1, 2]),
            ),
            '',
          );
        }

        const nonApp = total - app;
        if (total > 0 && nonApp / total > 0.5) {
          lines.push(
            `> ⚠️ **${pct(nonApp)} of this heap is not the application.** A threshold expressed against the raw total is mostly measuring how much bundle and code has loaded. Drive against the app-attributable figure above, and do not compare the raw total to production.`,
          );
        }
        lines.push(
          '',
          '_Buckets are mutually exclusive and sum to the total; each node lands in the most specific bucket that explains why it is not app memory. Self size, not retained: retained sizes overlap and would not sum._',
        );
        return toolResult(lines.join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

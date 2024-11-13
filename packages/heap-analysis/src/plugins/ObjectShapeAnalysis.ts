/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {AnalyzeSnapshotResult, HeapAnalysisOptions} from '../PluginUtils';
import type {
  BaseOption,
  IHeapEdge,
  IHeapNode,
  IHeapSnapshot,
  IMemoryAnalystHeapNodeReferrenceStat,
  HeapNodeIdSet,
} from '@memlab/core';

import chalk from 'chalk';
import {analysis, config, utils, info, serializer} from '@memlab/core';
import BaseAnalysis from '../BaseAnalysis';
import pluginUtils from '../PluginUtils';
import SnapshotFileOption from '../options/HeapAnalysisSnapshotFileOption';

class ObjectShapeAnalysis extends BaseAnalysis {
  getCommandName(): string {
    return 'shape';
  }

  /** @internal */
  getDescription(): string {
    return 'List the shapes that retained most memory';
  }

  /** @internal */
  getOptions(): BaseOption[] {
    return [new SnapshotFileOption()];
  }

  /** @internal */
  public async analyzeSnapshotsInDirectory(
    directory: string,
  ): Promise<AnalyzeSnapshotResult> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const d = directory;
    throw utils.haltOrThrow(
      `${this.constructor.name} does not support analyzeSnapshotsInDirectory`,
    );
  }

  /** @internal */
  async process(options: HeapAnalysisOptions): Promise<void> {
    const snapshotPath = pluginUtils.getSnapshotFileForAnalysis(options);
    await this.breakDownMemoryByShapes({file: snapshotPath});
  }

  /** @internal */
  async breakDownMemoryByShapes(options: {file?: string} = {}) {
    const opt = {buildNodeIdIndex: true, verbose: true};
    const file =
      options.file ||
      utils.getSnapshotFilePathWithTabType(/.*/) ||
      '<EMPTY_FILE_PATH>';
    const snapshot = await utils.getSnapshotFromFile(file, opt);
    analysis.preparePathFinder(snapshot);
    const heapInfo = analysis.getOverallHeapInfo(snapshot, {force: true});
    if (heapInfo) {
      analysis.printHeapInfo(heapInfo);
    }
    this.breakDownSnapshotByShapes(snapshot);
  }

  /** @internal */
  private breakDownSnapshotByShapes(snapshot: IHeapSnapshot): void {
    info.overwrite('Breaking down memory by shapes...');
    const breakdown: Record<string, HeapNodeIdSet> = Object.create(null);
    const population: Record<string, {examples: IHeapNode[]; n: number}> =
      Object.create(null);

    // group objects based on their shapes
    snapshot.nodes.forEach((node: IHeapNode) => {
      if (
        (node.type !== 'object' && !utils.isStringNode(node)) ||
        config.nodeIgnoreSetInShape.has(node.name)
      ) {
        return;
      }
      const key = serializer.summarizeNodeShape(node);
      breakdown[key] = breakdown[key] || new Set();
      breakdown[key].add(node.id);
      if (population[key] === void 0) {
        population[key] = {examples: [], n: 0};
      }
      ++population[key].n;
      // retain the top 5 examples
      const examples = population[key].examples;
      examples.push(node);
      examples.sort((n1, n2) => n2.retainedSize - n1.retainedSize);
      if (examples.length > 5) {
        examples.pop();
      }
    });

    // calculate and sort based on retained sizes
    const ret: Array<{key: string; retainedSize: number}> = [];
    for (const key in breakdown) {
      const size = utils.aggregateDominatorMetrics(
        breakdown[key],
        snapshot,
        () => true,
        utils.getRetainedSize,
      );
      ret.push({key, retainedSize: size});
    }
    ret.sort((o1, o2) => o2.retainedSize - o1.retainedSize);

    info.topLevel('Object shapes with top retained sizes:');
    info.lowLevel(' (Use `memlab trace --node-id=@ID` to get trace)\n');
    const topList = ret.slice(0, 40);
    // print settings
    const opt = {color: true, compact: true};
    const dot = chalk.grey('· ');
    const colon = chalk.grey(': ');
    // print the shapes with the biggest retained size
    for (const o of topList) {
      const referrerInfo = this.breakDownByReferrers(
        breakdown[o.key],
        snapshot,
      );
      const {examples, n} = population[o.key];
      const shapeStr = serializer.summarizeNodeShape(examples[0], opt);
      const bytes = utils.getReadableBytes(o.retainedSize);
      const examplesStr = examples
        .map(e => `@${e.id} [${utils.getReadableBytes(e.retainedSize)}]`)
        .join(' | ');
      const meta = chalk.grey(` (N: ${n}, Examples: ${examplesStr})`);
      info.topLevel(`${dot}${shapeStr}${colon}${bytes}${meta}`);
      info.lowLevel(referrerInfo + '\n');
    }
  }

  /** @internal */
  private breakDownByReferrers(
    ids: Set<IHeapNode['id']>,
    snapshot: IHeapSnapshot,
  ): string {
    const edgeNames: Record<string, IMemoryAnalystHeapNodeReferrenceStat> =
      Object.create(null);
    for (const id of ids) {
      const node = snapshot.getNodeById(id);
      for (const edge of node?.referrers || []) {
        const source = edge.fromNode;
        if (
          !utils.isMeaningfulEdge(edge) ||
          this.isTrivialEdgeForBreakDown(edge)
        ) {
          continue;
        }
        const sourceName = serializer.summarizeNodeName(source, {
          color: false,
        });
        const edgeName = serializer.summarizeEdgeName(edge, {
          color: false,
          abstract: true,
        });
        const edgeKey = `[${sourceName}] --${edgeName}--> `;
        edgeNames[edgeKey] = edgeNames[edgeKey] || {
          numberOfEdgesToNode: 0,
          source,
          edge,
        };
        ++edgeNames[edgeKey].numberOfEdgesToNode;
      }
    }
    const referrerInfo = Object.entries(edgeNames)
      .sort((i1, i2) => i2[1].numberOfEdgesToNode - i1[1].numberOfEdgesToNode)
      .slice(0, 4)
      .map(i => {
        const meta = i[1];
        const source = serializer.summarizeNodeName(meta.source, {
          color: true,
        });
        const edgeName = serializer.summarizeEdgeName(meta.edge, {
          color: true,
          abstract: true,
        });
        const edgeSummary = `${source} --${edgeName}-->`;
        return `  · ${edgeSummary}: ${meta.numberOfEdgesToNode}`;
      })
      .join('\n');
    return referrerInfo;
  }

  /** @internal */
  private isTrivialEdgeForBreakDown(edge: IHeapEdge) {
    const source = edge.fromNode;
    return (
      source.type === 'array' ||
      source.name === '(object elements)' ||
      source.name === 'system' ||
      edge.name_or_index === '__proto__' ||
      edge.name_or_index === 'prototype'
    );
  }
}

export default ObjectShapeAnalysis;

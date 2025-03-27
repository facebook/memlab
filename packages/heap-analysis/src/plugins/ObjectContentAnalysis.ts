/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapEdge, IHeapNode, IHeapSnapshot} from '@memlab/core';
import type {AnalyzeSnapshotResult, HeapAnalysisOptions} from '../PluginUtils';

import chalk from 'chalk';
import {BaseOption, config, utils, info, OutputFormat} from '@memlab/core';
import NodeIdOption from '../options/HeapAnalysisNodeIdOption';
import SnapshotFileOption from '../options/HeapAnalysisSnapshotFileOption';
import BaseAnalysis from '../BaseAnalysis';
import pluginUtils from '../PluginUtils';
import OutputOption from '../options/HeapAnalysisOutputOption';

export default class ObjectContentAnalysis extends BaseAnalysis {
  getCommandName(): string {
    return 'object';
  }

  /** @internal */
  getDescription(): string {
    return 'Get properties inside an object';
  }

  /** @internal */
  getOptions(): BaseOption[] {
    return [new SnapshotFileOption(), new NodeIdOption(), new OutputOption()];
  }

  /** @internal */
  async process(options: HeapAnalysisOptions): Promise<void> {
    const nodeId = config.focusFiberNodeId;
    if (nodeId < 0) {
      utils.haltOrThrow('Specify an object by --node-id');
      return;
    }
    const snapshot = await pluginUtils.loadHeapSnapshot(options);
    const node = snapshot.getNodeById(nodeId);
    if (!node) {
      utils.haltOrThrow(`Object @${nodeId} is not found.`);
      return;
    }

    if (config.outputFormat === OutputFormat.Json) {
      pluginUtils.printNodeInTerminal(node);
    } else {
      this.print(node, snapshot);
    }
  }

  private print(node: IHeapNode, snapshot: IHeapSnapshot) {
    const id = chalk.grey(`@${node.id}`);
    info.topLevel(`Heap node (${node.type}) ${id}`);
    const name = chalk.grey(`${node.name}`);
    info.topLevel(` name: ${name}`);
    const numReferences = chalk.grey(`${node.edge_count}`);
    info.topLevel(` # of references: ${numReferences}`);
    const numReferrers = chalk.grey(`${node.referrers.length}`);
    info.topLevel(` # of referrers: ${numReferrers}`);
    const selfSize = chalk.grey(`${node.self_size}`);
    info.topLevel(` shallow size: ${selfSize}`);
    const retainedSize = chalk.grey(`${node.retainedSize}`);
    info.topLevel(` retained size: ${retainedSize}`);
    const dominatorNode = node.dominatorNode;
    if (dominatorNode) {
      const dominatorNodeId = chalk.grey(`@${dominatorNode.id}`);
      info.topLevel(` dominator node: ${dominatorNodeId}`);
    }

    // print object references
    info.topLevel('\n' + chalk.bold('REFERENCES:'));
    let list = this.getObjectProperties(snapshot, node);
    pluginUtils.printReferencesInTerminal(list);

    info.topLevel('\n' + chalk.bold('REFERRERS:'));
    // print object referrers
    list = this.getObjectReferrerEdges(snapshot, node);
    pluginUtils.printReferrersInTerminal(list);
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
  private getObjectProperties(
    snapshot: IHeapSnapshot,
    node: IHeapNode,
  ): IHeapEdge[] {
    const ret: IHeapEdge[] = [];
    const refs = node.references;
    for (const edge of refs) {
      ret.push(edge);
    }
    return ret;
  }

  /** @internal */
  private getObjectReferrerEdges(
    snapshot: IHeapSnapshot,
    node: IHeapNode,
  ): IHeapEdge[] {
    const ret: IHeapEdge[] = [];
    const refs = node.referrers;
    for (const edge of refs) {
      ret.push(edge);
    }
    return ret;
  }
}

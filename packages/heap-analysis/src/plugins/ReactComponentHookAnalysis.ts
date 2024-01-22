/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

/**
 * A heap analysis calculating the memory breakdown of React
 * components and their React hooks.
 *
 * The idea of this heap analysis comes from the tech talk by Giulio Zausa in
 * React Berlin Day 2023. For more context and overview about how the analysis
 * works, please check out the talk here:
 * https://portal.gitnation.org/contents/how-much-ram-is-your-usememo-using-lets-profile-it
 */

import type {AnalyzeSnapshotResult, HeapAnalysisOptions} from '../PluginUtils';
import type {
  BaseOption,
  IHeapNode,
  IHeapSnapshot,
  IOveralHeapInfo,
  Nullable,
  Optional,
} from '@memlab/core';

import chalk from 'chalk';
import {analysis, utils, info} from '@memlab/core';
import BaseAnalysis from '../BaseAnalysis';
import pluginUtils from '../PluginUtils';
import SnapshotFileOption from '../options/HeapAnalysisSnapshotFileOption';

type HookStat = {
  type: string;
  size: number;
};

type ReactComponentStat = {
  fiberNodeIds: number[];
  totalRetainedSize: number;
  totalShallowSize: number;
  memoizedStateIds: number[];
  totalMemoizedStateRetainedSize: number;
  hooks: HookStat[];
  memoizedPropsIds: number[];
  totalMemoizedPropsRetainedSize: number;
  children: number;
  sibling: number;
};

const SIZE_TO_PRINT = 10;

const FIBER_NODE_PROPERTIES = new Set([
  'alternate',
  'child',
  'memoizedProps',
  'memoizedState',
  'return',
  'sibling',
  'type',
]);

function getProperty(
  node: IHeapNode,
  prop: string | number,
): Optional<IHeapNode> {
  return node.references.find(ref => ref.name_or_index === prop)?.toNode;
}

class ReactComponentHookAnalysis extends BaseAnalysis {
  private isHeapSnapshotMinified = false;
  private fiberNodeName: Nullable<string> = null;

  getCommandName(): string {
    return 'react-hooks';
  }

  /** @internal */
  getDescription(): string {
    return (
      'Show a memory breakdown of the most memory-consuming React components ' +
      'and their React hooks. This works best with unminified heap snapshots ' +
      'taken from React apps running in Dev mode. But also supports minified ' +
      'heap snapshots taken from React apps in production mode.'
    );
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
    await this.breakDownMemoryByReactComponents({file: snapshotPath});
  }

  /** @internal */
  async breakDownMemoryByReactComponents(options: {file?: string} = {}) {
    const opt = {buildNodeIdIndex: true, verbose: true};
    const file =
      options.file ||
      utils.getSnapshotFilePathWithTabType(/.*/) ||
      '<EMPTY_FILE_PATH>';
    const snapshot = await utils.getSnapshotFromFile(file, opt);
    analysis.preparePathFinder(snapshot);
    this.probeHeapAndFiberInfo(snapshot);
    const heapInfo = analysis.getOverallHeapInfo(snapshot, {force: true});
    if (heapInfo && !this.isHeapSnapshotMinified) {
      this.printHeapInfo(heapInfo);
      info.topLevel('\n');
    }
    const componentStatsMap = this.breakDownSnapshotByReactComponents(snapshot);
    this.printReactComponentStats(componentStatsMap);
  }

  /** @internal */
  private walkHookChain(
    memoizedStateNode: Optional<IHeapNode>,
    types: string[],
    i: number,
  ): HookStat[] {
    if (memoizedStateNode == null) {
      return [];
    }
    const nextNode = getProperty(memoizedStateNode, 'next');
    return [
      {
        type: types[i] ?? 'unknown hook - React Dev mode only',
        size: memoizedStateNode.retainedSize - (nextNode?.retainedSize ?? 0),
      },
      ...this.walkHookChain(nextNode, types, i + 1),
    ];
    return [];
  }

  /**
   * This methods get readable React component name corresponds to
   * a specific FiberNode object.
   * @internal
   **/
  private getComponentNameFromFiberNode(
    node: IHeapNode,
    fiberNodeObjectName: string,
  ): Optional<string> {
    if (node.name !== fiberNodeObjectName) {
      return null;
    }
    const componentName = null;

    // get fiberNode.type
    const typeNode = getProperty(node, 'type');
    if (typeNode == null) {
      return null;
    }

    // if fiberNode.type itself is a string
    if (typeNode.isString) {
      return typeNode.toStringNode()?.stringValue;
    }

    // try to get component name from fiberNode.type.__debugModuleSource
    const debugModuleName = getProperty(typeNode, '__debugModuleSource');
    if (debugModuleName?.isString) {
      return debugModuleName.toStringNode()?.stringValue;
    }

    // try to get component name from fiberNode.type.displayName
    const displayNameNode = getProperty(typeNode, 'displayName');
    if (displayNameNode != null) {
      let componentName = displayNameNode.toStringNode()?.stringValue;
      // if the heap snapshot is minified replace
      // "a [from parentComponent.react]" with
      // "<minified component> from [from parentComponent.react]"
      if (this.isHeapSnapshotMinified && componentName?.includes('[')) {
        componentName = componentName?.replace(
          /^[^[]*/,
          '<minified component> ',
        );
      }
      return componentName;
    } else if (componentName === 'Object') {
      const typeofNodeId = getProperty(typeNode, '$$typeof')?.id;
      return `Component (@${typeofNodeId})`;
    }

    return null;
  }

  /**
   * Detects Fiber nodes in the heap snaphot and returns the string name
   * representation for the FiberNode objects.
   * For unminified heap snapshot, this method returns 'FiberNode'.
   * For minified heap snapshot, this method returns the FiberNode object's
   * minified name.
   * @internal
   **/
  private probeHeapAndFiberInfo(snapshot: IHeapSnapshot): void {
    let foundFiberNodeWithUnminifiedName = false;
    const likelyFiberNodes: Map<string, number> = new Map();
    snapshot.nodes.forEach((node: IHeapNode) => {
      if (node.name === 'FiberNode' && node.isString === false) {
        foundFiberNodeWithUnminifiedName = true;
      } else if (this.hasFiberNodeAttributes(node)) {
        likelyFiberNodes.set(
          node.name,
          (likelyFiberNodes.get(node.name) ?? 0) + 1,
        );
      }
    });
    if (foundFiberNodeWithUnminifiedName) {
      this.fiberNodeName = 'FiberNode';
      return;
    }
    const entries = Array.from(likelyFiberNodes.entries()).sort(
      (e1, e2) => e2[1] - e1[1],
    );
    if (entries.length === 0) {
      this.fiberNodeName = null;
      return;
    }
    this.isHeapSnapshotMinified = true;
    this.fiberNodeName = entries[0][0];
  }

  /** @internal */
  private hasFiberNodeAttributes(node: IHeapNode): boolean {
    for (const prop of FIBER_NODE_PROPERTIES) {
      if (!node.findAnyReference(ref => ref.name_or_index === prop)) {
        return false;
      }
    }
    return true;
  }

  /** @internal */
  private breakDownSnapshotByReactComponents(
    snapshot: IHeapSnapshot,
  ): Map<string, ReactComponentStat> {
    info.overwrite('Breaking down memory by React components...');

    const componentMemMap = new Map<string, ReactComponentStat>();
    const fiberNodeName = this.fiberNodeName;

    if (fiberNodeName == null) {
      throw utils.haltOrThrow('No FiberNode detected in the heap snapshot.');
    }

    snapshot.nodes.forEach((node: IHeapNode) => {
      const componentName = this.getComponentNameFromFiberNode(
        node,
        fiberNodeName,
      );
      if (componentName == null) {
        return;
      }

      const record = componentMemMap.get(componentName) ?? {
        fiberNodeIds: [],
        totalRetainedSize: 0,
        totalShallowSize: 0,
        memoizedStateIds: [],
        totalMemoizedStateRetainedSize: 0,
        hooks: [],
        memoizedPropsIds: [],
        totalMemoizedPropsRetainedSize: 0,
        children: 0,
        sibling: 0,
      };
      componentMemMap.set(componentName, record);

      record.fiberNodeIds.push(node.id);
      record.totalShallowSize += node.self_size;

      const debugHookTypesNode = getProperty(node, '_debugHookTypes');
      const types: string[] = [];
      if (debugHookTypesNode) {
        for (let index = 0; index < 1000; ++index) {
          const element = getProperty(debugHookTypesNode, index);
          if (element == null) {
            break;
          }
          types.push(element.name);
        }
      }

      const memoizedStateNode = getProperty(node, 'memoizedState');
      if (memoizedStateNode != null) {
        record.memoizedStateIds.push(memoizedStateNode.id);
        record.hooks = this.walkHookChain(memoizedStateNode, types, 0);
      }

      const memoizedPropsNode = getProperty(node, 'memoizedProps');
      if (memoizedPropsNode != null) {
        record.memoizedPropsIds.push(memoizedPropsNode.id);
      }

      const childrenNode = getProperty(node, 'child');
      if (childrenNode != null) {
        record.children += childrenNode.retainedSize;
      }

      const siblingNode = getProperty(node, 'sibling');
      if (siblingNode != null) {
        record.sibling += siblingNode.retainedSize;
      }
    });

    // aggregate and calculate the retained sizes
    for (const [, record] of componentMemMap) {
      record.totalRetainedSize = utils.aggregateDominatorMetrics(
        new Set(record.fiberNodeIds),
        snapshot,
        () => true,
        utils.getRetainedSize,
      );

      record.totalMemoizedStateRetainedSize = utils.aggregateDominatorMetrics(
        new Set(record.memoizedStateIds),
        snapshot,
        () => true,
        utils.getRetainedSize,
      );

      record.totalMemoizedPropsRetainedSize = utils.aggregateDominatorMetrics(
        new Set(record.memoizedPropsIds),
        snapshot,
        () => true,
        utils.getRetainedSize,
      );
    }

    return componentMemMap;
  }

  /** @internal */
  private printHeapInfo(heapInfo: IOveralHeapInfo): void {
    const key = chalk.white.bind(chalk);
    const sep = chalk.grey.bind(chalk);
    const size = (n: number) => chalk.yellow(utils.getReadableBytes(n));

    info.topLevel('\nHeap Overall Statistics:');
    info.topLevel(
      `  ${key('Fiber node total retained size')}${sep(':')} ${size(
        heapInfo.fiberNodeSize,
      )}`,
    );
    info.topLevel(
      `  ${key('Rendered Fiber node retained size')}${sep(':')} ${size(
        heapInfo.regularFiberNodeSize,
      )}`,
    );
    info.topLevel(
      `  ${key('Alternate Fiber node retained size')}${sep(':')} ${size(
        heapInfo.alternateFiberNodeSize,
      )}`,
    );
    info.topLevel(
      `  ${key('Detached Fiber node retained size')}${sep(':')} ${size(
        heapInfo.detachedFiberNodeSize,
      )}`,
    );
  }

  /** @internal */
  private printReactComponentStats(
    componentStatsMap: Map<string, ReactComponentStat>,
  ): void {
    const key = chalk.white.bind(chalk);
    const sep = chalk.grey.bind(chalk);
    const num = chalk.blue.bind(chalk);
    const size = (n: number) => chalk.yellow(utils.getReadableBytes(n));

    const entries = Array.from(componentStatsMap.entries()).sort(
      (entry1, entry2) => {
        return entry2[1].totalRetainedSize - entry1[1].totalRetainedSize;
      },
    );

    info.topLevel(
      `Found ${entries.length} React component types. Top ${SIZE_TO_PRINT} results:\n`,
    );

    let numPrinted = 0;
    for (const [name, stat] of entries) {
      if (numPrinted++ >= SIZE_TO_PRINT) {
        break;
      }
      let indent = ' ';
      info.topLevel(`${indent}${name}${sep(':')}`);
      indent += '  ';

      info.topLevel(
        `${indent}${key('Instances')}${sep(':')} ${num(
          stat.fiberNodeIds.length,
        )}`,
      );
      info.topLevel(
        `${indent}${key('Total retained size')}${sep(':')} ${size(
          stat.totalRetainedSize,
        )}`,
      );
      info.topLevel(
        `${indent}${key('Total shallow size')}${sep(':')} ${size(
          stat.totalShallowSize,
        )}`,
      );
      info.topLevel(
        `${indent}${key('Children retained size')}${sep(':')} ${size(
          stat.children,
        )}`,
      );
      info.topLevel(
        `${indent}${key('Sibling retained size')}${sep(':')} ${size(
          stat.sibling,
        )}`,
      );
      info.topLevel(
        `${indent}${key('Total memoizedProps retained size')}${sep(':')} ${size(
          stat.totalMemoizedPropsRetainedSize,
        )}`,
      );
      info.topLevel(
        `${indent}${key('Total memoizedState retained size')}${sep(':')} ${size(
          stat.totalMemoizedStateRetainedSize,
        )}`,
      );

      const totalHookSize = stat.hooks.reduce((acc, cur) => acc + cur.size, 0);
      info.topLevel(
        `${indent}${key('React hooks')}${sep(
          ':',
        )} (total size per component: ${size(totalHookSize)})`,
      );

      const hookStats = stat.hooks;
      for (let i = 0; i < hookStats.length; ++i) {
        const hookStat = hookStats[i];
        info.topLevel(
          `${indent} [${num(i)}]${sep(':')} ${size(hookStat.size)} (${sep(
            hookStat.type,
          )})`,
        );
      }
      info.topLevel('');
    }
  }
}

export default ReactComponentHookAnalysis;

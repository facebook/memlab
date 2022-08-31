/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */
import type {Nullable, IHeapEdge, IHeapNode} from '@memlab/core';

import chalk from 'chalk';
import {utils} from '@memlab/core';

const lessUsefulEdgeTypeForDebugging = new Set([
  'internal',
  'hidden',
  'shortcut',
  'weak',
]);
function isUsefulEdgeForDebugging(edge: IHeapEdge): boolean {
  return !lessUsefulEdgeTypeForDebugging.has(edge.type);
}

const lessUsefulObjectTypeForDebugging = new Set([
  'native',
  'hidden',
  'array',
  'code',
  'synthetic',
]);
function isUsefulObjectForDebugging(object: IHeapNode): boolean {
  return !lessUsefulObjectTypeForDebugging.has(object.type);
}

export class ComponentDataItem {
  stringContent?: string;
  tag?: string;
  referrerEdge?: IHeapEdge;
  heapObject?: IHeapNode;
  referenceEdge?: IHeapEdge;
  type?: string;

  static getTextForDisplay(data: ComponentDataItem): string {
    const content = ComponentDataItem.getTextContent(data);
    if (data.referrerEdge && isUsefulEdgeForDebugging(data.referrerEdge)) {
      return content;
    }
    if (data.referenceEdge && isUsefulEdgeForDebugging(data.referenceEdge)) {
      return content;
    }
    if (data.heapObject && isUsefulObjectForDebugging(data.heapObject)) {
      return content;
    }
    if (!data.referenceEdge && !data.heapObject && !data.referrerEdge) {
      return content;
    }
    return chalk.grey(content);
  }

  private static getTextContent(data: ComponentDataItem): string {
    let ret = '';
    if (data.tag) {
      ret += `[${data.tag}] `;
    }
    if (data.stringContent) {
      ret += data.stringContent;
    }
    const arrowPrefix = chalk.grey('--');
    const arrowSuffix = chalk.grey('---') + '>';
    if (data.referrerEdge) {
      const edgeType = chalk.grey(`(${data.referrerEdge.type})`);
      const edgeName = data.referrerEdge.name_or_index;
      ret += `${arrowPrefix}${edgeName}${edgeType}${arrowSuffix} `;
    }
    if (data.heapObject) {
      const objectType = chalk.grey(`(${data.heapObject.type})`);
      const objectId = chalk.grey(` @${data.heapObject.id}`);
      const size = utils.getReadableBytes(data.heapObject.retainedSize);
      const sizeInfo =
        chalk.grey(' [') + chalk.bold(chalk.blue(size)) + chalk.grey(']');
      ret +=
        chalk.green('[') +
        (isUsefulObjectForDebugging(data.heapObject)
          ? chalk.green(data.heapObject.name)
          : chalk.bold(chalk.grey(data.heapObject.name))) +
        chalk.green(']') +
        objectType +
        objectId +
        sizeInfo;
    }
    if (data.referenceEdge) {
      const edgeType = chalk.grey(`(${data.referenceEdge.type})`);
      const edgeName = data.referenceEdge.name_or_index;
      ret += ` ${arrowPrefix}${edgeName}${edgeType}${arrowSuffix} `;
    }
    return ret === '' ? chalk.grey('<undefinied>') : ret;
  }
}

export class ComponentData {
  selectedIdx = -1;
  items: ComponentDataItem[] = [];
}

export function throwIfNodesEmpty(nodes: ComponentDataItem[]): boolean {
  if (nodes.length === 0) {
    throw utils.haltOrThrow('no heap node specified');
  }
  for (let i = 0; i < nodes.length; ++i) {
    if (!nodes[i].heapObject) {
      throw utils.haltOrThrow('heap node missing in ComponentDataItem[]');
    }
  }
  return true;
}

export function getHeapObjectAt(
  nodes: ComponentDataItem[],
  index: number,
): IHeapNode {
  throwIfNodesEmpty(nodes);
  if (index < 0 || index >= nodes.length) {
    throw utils.haltOrThrow('index is outside of nodes range');
  }
  return nodes[index].heapObject as IHeapNode;
}

export type DebounceCallback = () => void;
export type DebounceFunction = (callback: DebounceCallback) => void;

export function debounce(timeInMs: number): DebounceFunction {
  let id: Nullable<NodeJS.Timeout> = null;

  return (callback: DebounceCallback) => {
    if (id) {
      clearTimeout(id);
    }
    id = setTimeout(() => {
      callback();
      id = null;
    }, timeInMs);
  };
}

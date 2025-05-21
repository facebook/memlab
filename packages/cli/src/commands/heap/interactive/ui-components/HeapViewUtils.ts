/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
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
const reactEdgeNames = new Set([
  'alternate',
  'firstEffect',
  'lastEffect',
  'concurrentQueues',
  'child',
  'return',
  'sibling',
]);
function isUsefulEdgeForDebugging(edge: IHeapEdge): boolean {
  if (lessUsefulEdgeTypeForDebugging.has(edge.type)) {
    return false;
  }
  const edgeStr = `${edge.name_or_index}`;
  if (reactEdgeNames.has(edgeStr)) {
    if (utils.isFiberNode(edge.fromNode) || utils.isFiberNode(edge.toNode)) {
      return false;
    }
  }
  if (edgeStr.startsWith('__reactProps$')) {
    return false;
  }
  return true;
}

const lessUsefulObjectTypeForDebugging = new Set([
  'native',
  'hidden',
  'array',
  'code',
  'synthetic',
]);
function isUsefulObjectForDebugging(object: IHeapNode): boolean {
  if (lessUsefulObjectTypeForDebugging.has(object.type)) {
    return false;
  }
  return !utils.isFiberNode(object);
}

export class ComponentDataItem {
  stringContent?: string;
  tag?: string;
  referrerEdge?: IHeapEdge;
  heapObject?: IHeapNode;
  referenceEdge?: IHeapEdge;
  type?: string;
  details?: Map<string, string>;

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

  private static getHeapObjectTextContent(node: IHeapNode): string {
    const objectType = chalk.grey(`(${node.type})`);
    const objectId = chalk.grey(` @${node.id}`);
    const size = utils.getReadableBytes(node.retainedSize);
    const sizeInfo =
      chalk.grey(' [') + chalk.bold(chalk.blue(size)) + chalk.grey(']');
    const objectTitle = node.isString ? '<string>' : node.name;
    return (
      chalk.green('[') +
      (isUsefulObjectForDebugging(node)
        ? chalk.green(objectTitle)
        : chalk.bold(chalk.grey(objectTitle))) +
      chalk.green(']') +
      objectType +
      objectId +
      sizeInfo
    );
  }

  private static getHeapEdgeTextContent(edge: IHeapEdge): string {
    const arrowPrefix = chalk.grey('--');
    const arrowSuffix = chalk.grey('---') + '>';
    const edgeType = chalk.grey(`(${edge.type})`);
    const edgeName = edge.name_or_index;
    return `${arrowPrefix}${edgeName}${edgeType}${arrowSuffix} `;
  }

  private static getTextContent(data: ComponentDataItem): string {
    let ret = '';
    if (data.tag) {
      ret += `[${data.tag}] `;
    }
    if (data.stringContent) {
      ret += data.stringContent;
    }
    if (data.referrerEdge) {
      ret += this.getHeapEdgeTextContent(data.referrerEdge);
    }
    if (data.heapObject) {
      ret += this.getHeapObjectTextContent(data.heapObject);
    }
    if (data.referenceEdge) {
      ret += this.getHeapEdgeTextContent(data.referenceEdge);
    }
    return ret === '' ? chalk.grey('<undefined>') : ret;
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

// eslint-disable-next-line no-control-regex
const colorBegin = /^\u001b\[(\d+)m/;
// eslint-disable-next-line no-control-regex
const colorEnd = /^\u001b\](\d+)m/;

function stripColorCodeIfAny(input: string): {
  str: string;
  code: number;
  isBegin: boolean;
} {
  const matchBegin = input.match(colorBegin);
  const matchEnd = input.match(colorEnd);
  const match = matchBegin || matchEnd;
  if (!match) {
    return {str: input, code: -1, isBegin: false};
  }
  const isBegin = !!matchBegin;
  const code = parseInt(match[1], 10);
  const str = input.substring(match[0].length);
  return {str, code, isBegin};
}

function toColorControlChar(code: number, isBegin: boolean): string {
  const colorSpecialChar = '\u001b';
  return colorSpecialChar + (isBegin ? '[' : ']') + code + 'm';
}
export function substringWithColor(input: string, begin: number): string {
  const codeQueue = [];
  let curIndex = 0;
  let curStr = input;
  while (curIndex < begin) {
    // enqueue all control characters
    let strip;
    do {
      strip = stripColorCodeIfAny(curStr);
      curStr = strip.str;
      if (strip.code >= 0) {
        // pop if control begin meets control ends
        const last = codeQueue[codeQueue.length - 1];
        if (
          !last ||
          last.code !== strip.code ||
          strip.isBegin === true ||
          last.isBegin === false
        ) {
          codeQueue.push({code: strip.code, isBegin: strip.isBegin});
        } else {
          codeQueue.pop();
        }
      }
    } while (strip.code >= 0);
    // strip one actual content character
    curStr = curStr.substring(1);
    ++curIndex;
  }
  // prepend control characters
  while (codeQueue.length > 0) {
    const last = codeQueue.pop();
    if (last) {
      curStr = toColorControlChar(last?.code, last?.isBegin) + curStr;
    }
  }
  return curStr;
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

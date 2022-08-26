/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */
import type {IHeapSnapshot, IHeapNode, IHeapEdge, Nullable} from '@memlab/core';
import type ListComponent from './ListComponent';

import chalk from 'chalk';
import {utils} from '@memlab/core';

type SelectHeapObjectOption = {
  noChangeInReferenceBox?: boolean;
  noChangeInReferrerBox?: boolean;
  noChangeInRetainerTraceBox?: boolean;
  noChangeInObjectPropertyBox?: boolean;
};

class ComponentDataItem {
  stringContent?: string;
  tag?: string;
  referrerEdge?: IHeapEdge;
  heapObject?: IHeapNode;
  referenceEdge?: IHeapEdge;

  static getTextForDisplay(data: ComponentDataItem): string {
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
        chalk.green(`[${data.heapObject.name}]`) +
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

/**
 * HeapViewController managers all the data associated with each
 * UI components in CLI and coordinates the events/interaction
 * among all UI components.
 */
export default class HeapViewController {
  private currentHeapObject: IHeapNode;
  private selectedHeapObject: IHeapNode;
  private componentIdToDataMap: Map<number, ComponentData>;
  private componentIdToComponentMap: Map<number, ListComponent>;
  private heap: IHeapSnapshot;

  private parentBox: ListComponent;
  private referrerBox: ListComponent;
  private objectBox: ListComponent;
  private referenceBox: ListComponent;
  private objectPropertyBox: ListComponent;
  private retainerTracePropertyBox: ListComponent;

  constructor(heap: IHeapSnapshot, node: IHeapNode) {
    this.heap = heap;
    this.currentHeapObject = node;
    this.componentIdToDataMap = new Map();
    this.componentIdToComponentMap = new Map();
  }

  getContent(componentId: number): string[] {
    const ret: string[] = [];
    const data = this.componentIdToDataMap.get(componentId);
    if (data) {
      for (const item of data.items) {
        ret.push(ComponentDataItem.getTextForDisplay(item));
      }
    }
    return ret;
  }

  setParentBox(component: ListComponent) {
    this.componentIdToComponentMap.set(component.id, component);
    this.parentBox = component;
    this.componentIdToDataMap.set(component.id, new ComponentData());
  }

  setReferrerBox(component: ListComponent) {
    this.componentIdToComponentMap.set(component.id, component);
    this.referrerBox = component;
    this.componentIdToDataMap.set(component.id, new ComponentData());
  }
  getReferrerBoxData(node: IHeapNode = this.selectedHeapObject): ComponentData {
    let more = 0;
    const data = new ComponentData();
    node.forEachReferrer(ref => {
      if (data.items.length >= 100) {
        ++more;
      } else {
        const tag =
          ref.fromNode.id === node.pathEdge?.fromNode?.id ? {tag: '<-'} : {};
        data.items.push({heapObject: ref.fromNode, referenceEdge: ref, ...tag});
      }
      return {stop: false};
    });
    if (more > 0) {
      data.items.push({stringContent: ` ${more} more items...`});
    }
    data.selectedIdx = data.items.length > 0 ? 0 : -1;
    return data;
  }

  setObjectBox(component: ListComponent) {
    this.componentIdToComponentMap.set(component.id, component);
    this.objectBox = component;
    this.componentIdToDataMap.set(component.id, new ComponentData());
  }
  getObjectBoxData(): ComponentData {
    const data = new ComponentData();
    this.currentHeapObject.forEachReferrer(edge => {
      for (const ref of edge.fromNode.references) {
        const tag =
          ref.toNode.id === this.currentHeapObject.id ? {tag: '*'} : {};
        data.items.push({referrerEdge: ref, heapObject: ref.toNode, ...tag});
      }
      return {stop: true};
    });
    data.selectedIdx = data.items.length > 0 ? 0 : -1;
    return data;
  }

  setReferenceBox(component: ListComponent) {
    this.componentIdToComponentMap.set(component.id, component);
    this.referenceBox = component;
    this.componentIdToDataMap.set(component.id, new ComponentData());
  }
  getReferenceBoxData(): ComponentData {
    const data = new ComponentData();
    let more = 0;
    this.selectedHeapObject.forEachReference(ref => {
      if (data.items.length >= 100) {
        ++more;
      } else {
        data.items.push({referrerEdge: ref, heapObject: ref.toNode});
      }
      return {stop: false};
    });
    if (more > 0) {
      data.items.push({stringContent: ` ${more} more items...`});
    }
    data.selectedIdx = data.items.length > 0 ? 0 : -1;
    return data;
  }

  setObjectPropertyBox(component: ListComponent) {
    this.componentIdToComponentMap.set(component.id, component);
    this.objectPropertyBox = component;
    this.componentIdToDataMap.set(component.id, new ComponentData());
  }

  getObjectPropertyData(): ComponentData {
    const data = new ComponentData();
    const node = this.selectedHeapObject;

    data.items.push({
      stringContent: this.getKeyValuePairString('id', `@${node.id}`),
    });
    data.items.push({
      stringContent: this.getKeyValuePairString('name', node.name),
    });
    data.items.push({
      stringContent: this.getKeyValuePairString('type', node.type),
    });
    data.items.push({
      stringContent: this.getKeyValuePairString(
        'self size',
        utils.getReadableBytes(node.self_size),
      ),
    });
    data.items.push({
      stringContent: this.getKeyValuePairString(
        'retained size',
        utils.getReadableBytes(node.retainedSize),
      ),
    });
    data.items.push({
      stringContent: this.getKeyValuePairString(
        '# of references',
        utils.getReadableBytes(node.edge_count),
      ),
    });
    data.items.push({
      stringContent: this.getKeyValuePairString(
        '# of referrers',
        utils.getReadableBytes(node.referrers.length),
      ),
    });
    if (node.dominatorNode) {
      data.items.push({
        stringContent: 'dominator node' + chalk.grey(': '),
        heapObject: node.dominatorNode,
      });
    }
    data.selectedIdx = data.items.length > 0 ? 0 : -1;
    return data;
  }

  private getKeyValuePairString(key: string, value: string): string {
    return key + chalk.grey(': ') + chalk.green(value);
  }

  setRetainerTraceBox(component: ListComponent) {
    this.componentIdToComponentMap.set(component.id, component);
    this.retainerTracePropertyBox = component;
    this.componentIdToDataMap.set(component.id, new ComponentData());
  }

  getRetainerTraceData(): ComponentData {
    const data = new ComponentData();
    const node = this.selectedHeapObject;
    let curNode: Nullable<IHeapNode> = node;
    while (curNode && !utils.isRootNode(curNode)) {
      if (!curNode.pathEdge) {
        curNode = null;
        break;
      }
      data.items.unshift({referrerEdge: curNode.pathEdge, heapObject: curNode});
      curNode = curNode.pathEdge?.fromNode;
    }
    if (curNode) {
      data.items.unshift({heapObject: curNode});
    }
    data.selectedIdx = data.items.length > 0 ? 0 : -1;
    return data;
  }

  public setCurrentHeapObjectFromComponent(
    componentId: number,
    itemIndex: number,
  ): void {
    const data = this.componentIdToDataMap.get(componentId);
    if (!data) {
      return;
    }
    const item = data.items[itemIndex];
    if (!item) {
      return;
    }
    const heapObject = item.heapObject;
    if (!heapObject) {
      return;
    }
    this.setCurrentHeapObject(heapObject);
  }

  public setCurrentHeapObject(node: IHeapNode): void {
    this.currentHeapObject = node;
    // set parent box's data and content
    let data;
    this.componentIdToDataMap.set(
      this.parentBox.id,
      (data = this.getReferrerBoxData(this.currentHeapObject)),
    );
    this.parentBox.setContent(this.getContent(this.parentBox.id));
    this.parentBox.selectIndex(data.selectedIdx);

    // set object box's data and content
    this.componentIdToDataMap.set(this.objectBox.id, this.getObjectBoxData());
    this.objectBox.setContent(this.getContent(this.objectBox.id));
    // select the current heap object in the object box
    const objectBoxData = this.componentIdToDataMap.get(this.objectBox.id);
    if (objectBoxData) {
      const index = objectBoxData.items.findIndex(item => {
        return item.heapObject?.id === this.currentHeapObject.id;
      });
      this.objectBox.selectIndex(index);
      objectBoxData.selectedIdx = index;
    }

    this.setSelectedHeapObject(node);
    this.focusOnComponent(this.objectBox.id);
  }

  focusOnComponent(componentId: number): void {
    for (const component of this.componentIdToComponentMap.values()) {
      if (component.id === componentId) {
        component.focus();
      } else {
        component.loseFocus();
      }
    }
  }

  public setSelectedHeapObjectFromComponent(
    componentId: number,
    itemIndex: number,
  ): void {
    const data = this.componentIdToDataMap.get(componentId);
    if (!data) {
      return;
    }
    data.selectedIdx = itemIndex;
    const item = data.items[itemIndex];
    if (!item) {
      return;
    }
    const heapObject = item.heapObject;
    if (!heapObject) {
      return;
    }
    // if selecting in a specific box, do not update content in that box
    const noChangeInReferenceBox = componentId === this.referenceBox.id;
    const noChangeInReferrerBox = componentId === this.referrerBox.id;
    const noChangeInRetainerTraceBox =
      componentId === this.retainerTracePropertyBox.id;
    const noChangeInObjectPropertyBox =
      componentId === this.objectPropertyBox.id;
    this.setSelectedHeapObject(heapObject, {
      noChangeInReferenceBox,
      noChangeInReferrerBox,
      noChangeInRetainerTraceBox,
      noChangeInObjectPropertyBox,
    });
  }

  public setSelectedHeapObject(
    node: IHeapNode,
    options: SelectHeapObjectOption = {},
  ): void {
    this.selectedHeapObject = node;

    // set referrer box's data and content
    if (!options.noChangeInReferrerBox) {
      const data = this.getReferrerBoxData();
      this.componentIdToDataMap.set(this.referrerBox.id, data);
      this.referrerBox.setContent(this.getContent(this.referrerBox.id));
      this.referrerBox.selectIndex(data.selectedIdx);
    }
    // set reference box's data and content
    if (!options.noChangeInReferenceBox) {
      const data = this.getReferenceBoxData();
      this.componentIdToDataMap.set(this.referenceBox.id, data);
      this.referenceBox.setContent(this.getContent(this.referenceBox.id));
      this.referenceBox.selectIndex(data.selectedIdx);
    }
    // set object property box's data and content
    if (!options.noChangeInObjectPropertyBox) {
      const data = this.getObjectPropertyData();
      this.componentIdToDataMap.set(this.objectPropertyBox.id, data);
      this.objectPropertyBox.setContent(
        this.getContent(this.objectPropertyBox.id),
      );
      this.objectPropertyBox.selectIndex(data.selectedIdx);
    }
    // set retainer trace box's data and content
    if (!options.noChangeInRetainerTraceBox) {
      const data = this.getRetainerTraceData();
      this.componentIdToDataMap.set(this.retainerTracePropertyBox.id, data);
      this.retainerTracePropertyBox.setContent(
        this.getContent(this.retainerTracePropertyBox.id),
      );
      this.retainerTracePropertyBox.selectIndex(data.selectedIdx);
    }
  }
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */
import type {IHeapSnapshot, IHeapNode, Nullable} from '@memlab/core';
import type ListComponent from './ListComponent';

import chalk from 'chalk';
import {utils} from '@memlab/core';
import {
  ComponentDataItem,
  ComponentData,
  getHeapObjectAt,
} from './HeapViewUtils';

type SelectHeapObjectOption = {
  noChangeInReferenceBox?: boolean;
  noChangeInReferrerBox?: boolean;
  noChangeInRetainerTraceBox?: boolean;
  noChangeInObjectPropertyBox?: boolean;
};

/**
 * HeapViewController managers all the data associated with each
 * UI components in CLI and coordinates the events/interaction
 * among all UI components.
 */
export default class HeapViewController {
  private currentHeapObject: IHeapNode;
  private selectedHeapObject: IHeapNode;
  private currentHeapObjectsInfo: ComponentDataItem[];
  private componentIdToDataMap: Map<number, ComponentData>;
  private componentIdToComponentMap: Map<number, ListComponent>;
  private heap: IHeapSnapshot;

  private parentBox: ListComponent;
  private referrerBox: ListComponent;
  private objectBox: ListComponent;
  private referenceBox: ListComponent;
  private objectPropertyBox: ListComponent;
  private retainerTracePropertyBox: ListComponent;

  constructor(heap: IHeapSnapshot, nodes: ComponentDataItem[]) {
    this.heap = heap;
    this.currentHeapObject = getHeapObjectAt(nodes, 0);
    this.currentHeapObjectsInfo = nodes;
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
    const data = new ComponentData();
    node.forEachReferrer(ref => {
      const tag =
        ref.fromNode.id === node.pathEdge?.fromNode?.id ? {tag: '<-'} : {};
      data.items.push({heapObject: ref.fromNode, referenceEdge: ref, ...tag});
      return {stop: false};
    });
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
    const index = this.currentHeapObjectsInfo.findIndex(
      item => item.heapObject?.id === this.currentHeapObject.id,
    );
    if (index >= 0) {
      data.selectedIdx = index;
    } else {
      data.selectedIdx = 0;
      this.currentHeapObjectsInfo.unshift({
        tag: 'Chosen',
        heapObject: this.currentHeapObject,
      });
    }
    data.items = this.currentHeapObjectsInfo;
    return data;
  }

  setReferenceBox(component: ListComponent) {
    this.componentIdToComponentMap.set(component.id, component);
    this.referenceBox = component;
    this.componentIdToDataMap.set(component.id, new ComponentData());
  }
  getReferenceBoxData(): ComponentData {
    const data = new ComponentData();
    this.selectedHeapObject.forEachReference(ref => {
      data.items.push({referrerEdge: ref, heapObject: ref.toNode});
      return {stop: false};
    });
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
        node.edge_count,
      ),
    });
    data.items.push({
      stringContent: this.getKeyValuePairString(
        '# of referrers',
        node.referrers.length,
      ),
    });
    if (node.dominatorNode) {
      data.items.push({
        stringContent: 'dominator node' + chalk.grey(': '),
        heapObject: node.dominatorNode,
      });
    }
    // inject additional node information
    if (node.isString) {
      const stringNode = node.toStringNode();
      if (stringNode) {
        const value = this.getReadableString(stringNode.stringValue);
        data.items.push({
          stringContent: this.getKeyValuePairString('string value', value),
        });
      }
    }
    if (node.type === 'number') {
      data.items.push({
        stringContent: this.getKeyValuePairString(
          'numeric value',
          utils.getNumberNodeValue(node) ?? '<error>',
        ),
      });
    }
    if (node.type === 'closure') {
      const contextNode = node.getReferenceNode('context', 'internal');
      if (contextNode) {
        contextNode.forEachReference(edge => {
          data.items.push({
            tag: chalk.grey('Scope Variable'),
            referrerEdge: edge,
            heapObject: edge.toNode,
          });
        });
      }
    }
    data.selectedIdx = data.items.length > 0 ? 0 : -1;
    return data;
  }

  private getReadableString(value: string): string {
    return value.length > 300
      ? value.substring(0, 300) + chalk.grey('...')
      : value;
  }

  private getKeyValuePairString(key: string, value: string | number): string {
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
    options: {skipFocus?: boolean} = {},
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
    this.setCurrentHeapObject(heapObject, options);
  }

  public setCurrentHeapObject(
    node: IHeapNode,
    options: {skipFocus?: boolean} = {},
  ): void {
    this.currentHeapObject = node;
    // set parent box's data and content
    const parentBoxData = this.getReferrerBoxData(this.currentHeapObject);
    this.componentIdToDataMap.set(this.parentBox.id, parentBoxData);
    this.parentBox.setContent(this.getContent(this.parentBox.id));
    this.parentBox.selectIndex(parentBoxData.selectedIdx);

    // set object box's data and content
    const objectBoxData = this.getObjectBoxData();
    this.componentIdToDataMap.set(this.objectBox.id, objectBoxData);
    this.objectBox.setContent(this.getContent(this.objectBox.id));
    this.objectBox.selectIndex(objectBoxData.selectedIdx);

    this.setSelectedHeapObject(node);
    if (!options.skipFocus) {
      this.focusOnComponent(this.objectBox.id);
    }
  }

  focusOnComponent(componentId: number): void {
    for (const component of this.componentIdToComponentMap.values()) {
      if (component.id === componentId) {
        component.focus();
        const data = this.componentIdToDataMap.get(componentId);
        const selectIndex = (data && data.selectedIdx) ?? -1;
        this.setSelectedHeapObjectFromComponent(componentId, selectIndex);
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
      this.referrerBox.setLabel(`Referrers of @${node.id}`);
    }
    // set reference box's data and content
    if (!options.noChangeInReferenceBox) {
      const data = this.getReferenceBoxData();
      this.componentIdToDataMap.set(this.referenceBox.id, data);
      this.referenceBox.setContent(this.getContent(this.referenceBox.id));
      this.referenceBox.selectIndex(data.selectedIdx);
      this.referenceBox.setLabel(`References of @${node.id}`);
    }
    // set object property box's data and content
    if (!options.noChangeInObjectPropertyBox) {
      const data = this.getObjectPropertyData();
      this.componentIdToDataMap.set(this.objectPropertyBox.id, data);
      this.objectPropertyBox.setContent(
        this.getContent(this.objectPropertyBox.id),
      );
      this.objectPropertyBox.selectIndex(data.selectedIdx);
      this.objectPropertyBox.setLabel(`Detail of @${node.id}`);
    }
    // set retainer trace box's data and content
    if (!options.noChangeInRetainerTraceBox) {
      const data = this.getRetainerTraceData();
      this.componentIdToDataMap.set(this.retainerTracePropertyBox.id, data);
      this.retainerTracePropertyBox.setContent(
        this.getContent(this.retainerTracePropertyBox.id),
      );
      this.retainerTracePropertyBox.selectIndex(data.selectedIdx);
      this.retainerTracePropertyBox.setLabel(`Retainer Trace of @${node.id}`);
    }
  }
}

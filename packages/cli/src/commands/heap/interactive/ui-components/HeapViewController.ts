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
import {utils, analysis} from '@memlab/core';
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
  componentDataItem?: ComponentDataItem;
};

export type ObjectCategory = Map<string, ComponentDataItem[]>;

/**
 * HeapViewController managers all the data associated with each
 * UI components in CLI and coordinates the events/interaction
 * among all UI components.
 */
export default class HeapViewController {
  private currentHeapObject: IHeapNode;
  private selectedHeapObject: IHeapNode;
  private currentHeapObjectsInfo: ComponentDataItem[];
  private currentClusteredObjectsInfo: ComponentDataItem[];
  private componentIdToDataMap: Map<number, ComponentData>;
  private componentIdToComponentMap: Map<number, ListComponent>;
  private heap: IHeapSnapshot;

  private clusteredBox: ListComponent;
  private referrerBox: ListComponent;
  private objectBox: ListComponent;
  private referenceBox: ListComponent;
  private objectPropertyBox: ListComponent;
  private retainerTracePropertyBox: ListComponent;

  constructor(heap: IHeapSnapshot, objectCategory: ObjectCategory) {
    this.heap = heap;
    this.currentHeapObjectsInfo =
      this.getFlattenHeapObjectsInfo(objectCategory);
    this.currentClusteredObjectsInfo =
      this.getFlattenClusteredObjectsInfo(objectCategory);
    this.currentHeapObject = getHeapObjectAt(this.currentHeapObjectsInfo, 0);
    this.componentIdToDataMap = new Map();
    this.componentIdToComponentMap = new Map();
  }

  private getFlattenHeapObjectsInfo(
    objectCategory: ObjectCategory,
  ): ComponentDataItem[] {
    let ret: ComponentDataItem[] = [];
    for (const category of objectCategory.keys()) {
      const nodes = objectCategory.get(category) as ComponentDataItem[];
      ret = [...ret, ...nodes];
    }
    return ret;
  }

  private getFlattenClusteredObjectsInfo(
    objectCategory: ObjectCategory,
  ): ComponentDataItem[] {
    let ret: ComponentDataItem[] = [];
    for (const category of objectCategory.keys()) {
      let nodes = objectCategory.get(category) as ComponentDataItem[];
      if (this.shouldClusterCategory(category)) {
        nodes = this.clusterComponentDataItems(nodes);
      }
      ret = [...ret, ...nodes];
    }
    return ret;
  }

  private shouldClusterCategory(category: string): boolean {
    return category === 'detached';
  }

  private clusterComponentDataItems(
    nodes: ComponentDataItem[],
  ): ComponentDataItem[] {
    const ret: ComponentDataItem[] = [];
    const nodeIds = new Set<number>(
      nodes
        .filter(node => node.heapObject)
        .map(node => node.heapObject?.id ?? -1),
    );
    const clusters = analysis.clusterHeapObjects(nodeIds, this.heap);
    clusters.forEach(cluster => {
      const id = cluster.id ?? -1;
      let node: Nullable<IHeapNode> = null;
      node = this.heap.getNodeById(id) as IHeapNode;
      const details = new Map<string, string>();
      if (cluster.count) {
        details.set('# of clusters', `${cluster.count}`);
      }
      if (cluster.retainedSize) {
        details.set(
          'aggregated retained size',
          `${utils.getReadableBytes(cluster.retainedSize)}`,
        );
      }
      ret.push({tag: 'Cluster', heapObject: node, details});
    });
    return ret;
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

  setClusteredBox(component: ListComponent) {
    this.componentIdToComponentMap.set(component.id, component);
    this.clusteredBox = component;
    this.componentIdToDataMap.set(component.id, new ComponentData());
  }
  getClusteredBoxData(): ComponentData {
    const data = new ComponentData();
    data.selectedIdx = 0;
    data.items = this.currentClusteredObjectsInfo;
    return data;
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
    data.items.sort(
      (i1, i2) =>
        (i2.heapObject?.retainedSize ?? 0) - (i1.heapObject?.retainedSize ?? 0),
    );
    data.selectedIdx = data.items.length > 0 ? 0 : -1;
    return data;
  }

  setObjectPropertyBox(component: ListComponent) {
    this.componentIdToComponentMap.set(component.id, component);
    this.objectPropertyBox = component;
    this.componentIdToDataMap.set(component.id, new ComponentData());
  }

  getObjectPropertyData(
    options: {details?: Map<string, string>} = {},
  ): ComponentData {
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
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    options.details?.forEach((value, key) =>
      data.items.push({
        stringContent: self.getKeyValuePairString(key, value),
      }),
    );
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
    const clusteredBoxData = this.getClusteredBoxData();
    this.componentIdToDataMap.set(this.clusteredBox.id, clusteredBoxData);
    this.clusteredBox.setContent(this.getContent(this.clusteredBox.id));
    this.clusteredBox.selectIndex(clusteredBoxData.selectedIdx);

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
      componentDataItem: item,
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
      const propertyOption = options?.componentDataItem?.details
        ? {details: options.componentDataItem.details}
        : {};
      const data = this.getObjectPropertyData(propertyOption);
      this.componentIdToDataMap.set(this.objectPropertyBox.id, data);
      this.objectPropertyBox.setContent(
        this.getContent(this.objectPropertyBox.id),
      );
      this.objectPropertyBox.selectIndex(data.selectedIdx);
      this.objectPropertyBox.setLabel(`Object: @${node.id}`);
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

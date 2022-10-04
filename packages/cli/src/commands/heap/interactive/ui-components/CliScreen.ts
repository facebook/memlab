/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */
import type {Widgets} from 'blessed';
import type {ListCallbacks, ListItemSelectInfo} from './ListComponent';
import type {IHeapSnapshot, Optional} from '@memlab/core';
import {ComponentDataItem, getHeapObjectAt, debounce} from './HeapViewUtils';

import blessed from 'blessed';
import ListComponent from './ListComponent';
import HeapViewController from './HeapViewController';

function positionToNumber(info: string | number): number {
  return parseInt(`${info}`);
}

type ComponentSizeInfo = {
  width: number;
  height: number;
  top: number;
  left: number;
};

/*
 * The CliScreen component managers the screen layout
 * all the UI components in CLI.
 *
 * Screen Layout:
 * ┌─Referrers ────────┐┌─Clustered Objects ┐┌─References ───────┐
 * │                   ││                   ││                   │
 * │                   ││                   ││                   │
 * │                   ││                   ││                   │
 * │                   ││                   ││                   │
 * │                   ││                   │└───────────────────┘
 * │                   ││                   │┌─Retainer Trace ───┐
 * │                   ││                   ││                   │
 * │                   ││                   ││                   │
 * └───────────────────┘│                   ││                   │
 * ┌─Objects ──────────┐│                   ││                   │
 * │                   ││                   ││                   │
 * │                   │└───────────────────┘│                   │
 * │                   │┌─Object Detail ────┐│                   │
 * │                   ││                   ││                   │
 * │                   ││                   ││                   │
 * │                   ││                   ││                   │
 * │                   ││                   ││                   │
 * │                   ││                   ││                   │
 * └───────────────────┘└───────────────────┘└───────────────────┘
 */
export default class CliScreen {
  private screen: Widgets.Screen;
  private objectBox: ListComponent;
  private clusteredObjectBox: ListComponent;
  private referrerBox: ListComponent;
  private referenceBox: ListComponent;
  private objectPropertyBox: ListComponent;
  private retainerTraceBox: ListComponent;

  private currentFocuseKey = 1;
  private keyToComponent: Map<string, ListComponent>;
  private heapController: HeapViewController;

  constructor(
    title: string,
    heap: IHeapSnapshot,
    objectCategory: Map<string, ComponentDataItem[]>,
  ) {
    this.heapController = new HeapViewController(heap, objectCategory);
    this.screen = this.initScreen(title);
    const callbacks = this.initCallbacks(this.heapController, this.screen);
    this.keyToComponent = new Map<string, ListComponent>();
    this.referrerBox = this.initReferrerBox(callbacks);
    this.heapController.setReferrerBox(this.referrerBox);
    this.objectBox = this.initObjectBox(callbacks);
    this.heapController.setObjectBox(this.objectBox);
    this.clusteredObjectBox = this.initClusteredObjectBox(callbacks);
    this.heapController.setClusteredBox(this.clusteredObjectBox);
    this.referenceBox = this.initReferenceBox(callbacks);
    this.heapController.setReferenceBox(this.referenceBox);
    this.objectPropertyBox = this.initObjectPropertyBox(callbacks);
    this.heapController.setObjectPropertyBox(this.objectPropertyBox);
    this.retainerTraceBox = this.initRetainerTraceBox(callbacks);
    this.heapController.setRetainerTraceBox(this.retainerTraceBox);
    this.registerEvents();
    this.setFirstObjectAsCurrrent(objectCategory);
  }

  private setFirstObjectAsCurrrent(
    objectCategory: Map<string, ComponentDataItem[]>,
  ) {
    const keys = Array.from(objectCategory.keys());
    if (keys.length === 0) {
      return;
    }
    let nodes: Optional<ComponentDataItem[]>;
    for (const key of keys) {
      nodes = objectCategory.get(key);
      if (nodes && nodes.length > 0) {
        break;
      }
    }
    if (nodes && nodes.length > 0) {
      this.heapController.setCurrentHeapObject(getHeapObjectAt(nodes, 0));
    }
  }

  private initScreen(title: string): Widgets.Screen {
    return blessed.screen({
      smartCSR: true,
      title: title,
    });
  }

  private initCallbacks(
    controller: HeapViewController,
    screen: Widgets.Screen,
  ): ListCallbacks {
    const selectDebounce = debounce(150);
    const selectCallback = (
      componentId: number,
      index: number,
      content: string[],
      selectInfo: ListItemSelectInfo,
    ) => {
      if (selectInfo.keyName === 'enter') {
        selectDebounce(() => {
          controller.setCurrentHeapObjectFromComponent(componentId, index);
          screen.render();
        });
      } else if (selectInfo.keyName === 'up' || selectInfo.keyName === 'down') {
        selectDebounce(() => {
          controller.setSelectedHeapObjectFromComponent(componentId, index);
          screen.render();
        });
      }
    };
    return {
      selectCallback,
      render: () => screen.render(),
    };
  }

  public start(): void {
    this.screen.render();
  }

  private registerEvents(): void {
    this.registerKeys();
    this.registerScreenResize();
  }

  private registerScreenResize(): void {
    const screen = this.screen;
    screen.on('resize', () => {
      // all boxes/lists needs to resize
      this.updateComponentSize(
        this.clusteredObjectBox,
        this.getClusteredObjectBoxSize(),
      );
      this.updateComponentSize(this.referrerBox, this.getReferrerBoxSize());
      this.updateComponentSize(this.objectBox, this.getObjectBoxSize());
      this.updateComponentSize(
        this.objectPropertyBox,
        this.getObjectPropertyBoxSize(),
      );
      this.updateComponentSize(this.referenceBox, this.getReferenceBoxSize());
      this.updateComponentSize(
        this.retainerTraceBox,
        this.getRetainerTraceBoxSize(),
      );
    });
  }

  private updateComponentSize(
    component: ListComponent,
    size: ComponentSizeInfo,
  ): void {
    component.element.width = size.width;
    component.element.height = size.height;
    component.element.top = size.top;
    component.element.left = size.left;
  }

  private registerKeys(): void {
    const screen = this.screen;
    // Quit on Escape, q, or Control-C.
    screen.key(['escape', 'q', 'C-c'], () => process.exit(0));
    const keyToComponent = this.keyToComponent;
    const heapController = this.heapController;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const callback = (char: string, key: Widgets.Events.IKeyEventArg) => {
      if (keyToComponent.has(char)) {
        // focus on the selected element
        const component = keyToComponent.get(char);
        if (component) {
          heapController.focusOnComponent(component.id);
          screen.render();
        }
      }
    };
    screen.on('keypress', callback);
  }

  private addComponentToFocusKeyMap(component: ListComponent): string {
    const key = `${this.currentFocuseKey++}`;
    this.keyToComponent.set(key, component);
    return key;
  }

  private getNextFocusKey(): string {
    return `${this.currentFocuseKey}`;
  }

  private initClusteredObjectBox(callbacks: ListCallbacks): ListComponent {
    const box = new ListComponent([], callbacks, {
      ...this.getClusteredObjectBoxSize(),
    });
    box.setFocusKey(this.getNextFocusKey());
    box.setLabel('Clustered Objects');
    this.screen.append(box.element);
    this.addComponentToFocusKeyMap(box);
    return box;
  }

  private getClusteredObjectBoxSize(): ComponentSizeInfo {
    return {
      width: Math.floor(positionToNumber(this.screen.width) / 3),
      height: Math.floor((2 * positionToNumber(this.screen.height)) / 3),
      top: 0,
      left: Math.floor(positionToNumber(this.screen.width) / 3),
    };
  }

  private initReferrerBox(callbacks: ListCallbacks): ListComponent {
    const box = new ListComponent([], callbacks, {
      ...this.getReferrerBoxSize(),
    });
    box.setFocusKey(this.getNextFocusKey());
    box.setLabel('Referrers');
    this.screen.append(box.element);
    this.addComponentToFocusKeyMap(box);
    return box;
  }

  private getReferrerBoxSize(): ComponentSizeInfo {
    return {
      width: Math.floor(positionToNumber(this.screen.width) / 3),
      height: Math.floor(positionToNumber(this.screen.height) / 2),
      top: 0,
      left: 0,
    };
  }

  private initObjectBox(callbacks: ListCallbacks): ListComponent {
    const box = new ListComponent([], callbacks, {
      ...this.getObjectBoxSize(),
    });
    box.setFocusKey(this.getNextFocusKey());
    box.setLabel('Objects');
    this.screen.append(box.element);
    this.addComponentToFocusKeyMap(box);
    return box;
  }

  private getObjectBoxSize(): ComponentSizeInfo {
    return {
      width: Math.floor(positionToNumber(this.screen.width) / 3),
      height:
        positionToNumber(this.screen.height) -
        Math.floor(positionToNumber(this.screen.height) / 2),
      top: Math.floor(positionToNumber(this.screen.height) / 2),
      left: 0,
    };
  }

  private initObjectPropertyBox(callbacks: ListCallbacks): ListComponent {
    const box = new ListComponent([], callbacks, {
      ...this.getObjectPropertyBoxSize(),
    });
    box.setFocusKey(this.getNextFocusKey());
    box.setLabel('Objects Detail');
    this.screen.append(box.element);
    this.addComponentToFocusKeyMap(box);
    return box;
  }

  private getObjectPropertyBoxSize(): ComponentSizeInfo {
    return {
      width: Math.floor(positionToNumber(this.screen.width) / 3),
      height:
        positionToNumber(this.screen.height) -
        Math.floor((2 * positionToNumber(this.screen.height)) / 3),
      top: Math.floor((2 * positionToNumber(this.screen.height)) / 3),
      left: Math.floor(positionToNumber(this.screen.width) / 3),
    };
  }

  private initReferenceBox(callbacks: ListCallbacks): ListComponent {
    const box = new ListComponent([], callbacks, {
      ...this.getReferenceBoxSize(),
    });
    box.setFocusKey(this.getNextFocusKey());
    box.setLabel('References');
    this.screen.append(box.element);
    this.addComponentToFocusKeyMap(box);
    return box;
  }

  private getReferenceBoxSize(): ComponentSizeInfo {
    return {
      width:
        positionToNumber(this.screen.width) -
        Math.floor((2 * positionToNumber(this.screen.width)) / 3),
      height: Math.floor(positionToNumber(this.screen.height) / 3),
      top: 0,
      left: Math.floor((2 * positionToNumber(this.screen.width)) / 3),
    };
  }

  private initRetainerTraceBox(callbacks: ListCallbacks): ListComponent {
    const box = new ListComponent([], callbacks, {
      ...this.getRetainerTraceBoxSize(),
    });
    box.setFocusKey(this.getNextFocusKey());
    box.setLabel('Retainer Trace');
    this.screen.append(box.element);
    this.addComponentToFocusKeyMap(box);
    return box;
  }

  private getRetainerTraceBoxSize(): ComponentSizeInfo {
    return {
      width:
        positionToNumber(this.screen.width) -
        Math.floor((2 * positionToNumber(this.screen.width)) / 3),
      height:
        positionToNumber(this.screen.height) -
        Math.floor(positionToNumber(this.screen.height) / 3),
      top: Math.floor(positionToNumber(this.screen.height) / 3),
      left: Math.floor((2 * positionToNumber(this.screen.width)) / 3),
    };
  }
}

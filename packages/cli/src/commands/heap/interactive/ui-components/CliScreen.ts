/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */
import type {Widgets} from 'blessed';
import type {ListCallbacks, ListItemSelectInfo} from './ListComponent';
import type {IHeapSnapshot, IHeapNode} from '@memlab/core';

import chalk from 'chalk';
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
 * ┌─Referrers of [*] ─┐┌─Objects ──────────┐┌─References ───────┐
 * │                   ││                   ││                   │
 * │                   ││                   ││                   │
 * │                   ││                   ││                   │
 * │                   ││                   ││                   │
 * │                   ││                   │└───────────────────┘
 * │                   ││                   │┌─Retainer Trace ───┐
 * │                   ││                   ││                   │
 * │                   ││                   ││                   │
 * └───────────────────┘│                   ││                   │
 * ┌─Referrers ────────┐│                   ││                   │
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
  private parentObjectBox: ListComponent;
  private referrerBox: ListComponent;
  private referenceBox: ListComponent;
  private objectPropertyBox: ListComponent;
  private retainerTraceBox: ListComponent;

  private currentFocuseKey = 1;
  private keyToComponent: Map<string, ListComponent>;
  private heapController: HeapViewController;

  constructor(title: string, heap: IHeapSnapshot, node: IHeapNode) {
    this.heapController = new HeapViewController(heap, node);
    this.screen = blessed.screen({
      smartCSR: true,
      title: title,
    });
    const screen = this.screen;
    const controller = this.heapController;
    const callbacks = {
      selectCallback: (
        componentId: number,
        index: number,
        content: string[],
        selectInfo: ListItemSelectInfo,
      ) => {
        if (selectInfo.keyName === 'enter') {
          controller.setCurrentHeapObjectFromComponent(componentId, index);
        } else if (
          selectInfo.keyName === 'up' ||
          selectInfo.keyName === 'down'
        ) {
          controller.setSelectedHeapObjectFromComponent(componentId, index);
        }
        screen.render();
      },
    };
    this.keyToComponent = new Map<string, ListComponent>();
    this.parentObjectBox = this.initParentObjectBox(callbacks);
    this.heapController.setParentBox(this.parentObjectBox);
    this.referrerBox = this.initReferrerBox(callbacks);
    this.heapController.setReferrerBox(this.referrerBox);
    this.objectBox = this.initObjectBox(callbacks);
    this.heapController.setObjectBox(this.objectBox);
    this.referenceBox = this.initReferenceBox(callbacks);
    this.heapController.setReferenceBox(this.referenceBox);
    this.objectPropertyBox = this.initObjectPropertyBox(callbacks);
    this.heapController.setObjectPropertyBox(this.objectPropertyBox);
    this.retainerTraceBox = this.initRetainerTraceBox(callbacks);
    this.heapController.setRetainerTraceBox(this.retainerTraceBox);
    this.registerEvents();
    this.heapController.setCurrentHeapObject(node);
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
        this.parentObjectBox,
        this.getParentObjectBoxSize(),
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

  private getLabel(text: string, key: string): string {
    return `${text}` + chalk.grey(` (press ${chalk.inverse(key)} to focus)`);
  }

  private initParentObjectBox(callbacks: ListCallbacks): ListComponent {
    const box = new ListComponent([], callbacks, {
      ...this.getParentObjectBoxSize(),
      label: this.getLabel('Referrers of [*]', this.getNextFocusKey()),
    });
    this.screen.append(box.element);
    this.addComponentToFocusKeyMap(box);
    return box;
  }

  private getParentObjectBoxSize(): ComponentSizeInfo {
    return {
      width: Math.floor(positionToNumber(this.screen.width) / 3),
      height: Math.floor(positionToNumber(this.screen.height) / 2),
      top: 0,
      left: 0,
    };
  }

  private initReferrerBox(callbacks: ListCallbacks): ListComponent {
    const box = new ListComponent([], callbacks, {
      ...this.getReferrerBoxSize(),
      label: this.getLabel('Referrers', this.getNextFocusKey()),
    });
    this.screen.append(box.element);
    this.addComponentToFocusKeyMap(box);
    return box;
  }

  private getReferrerBoxSize(): ComponentSizeInfo {
    return {
      width: Math.floor(positionToNumber(this.screen.width) / 3),
      height:
        positionToNumber(this.screen.height) -
        Math.floor(positionToNumber(this.screen.height) / 2),
      top: Math.floor(positionToNumber(this.screen.height) / 2),
      left: 0,
    };
  }

  private initObjectBox(callbacks: ListCallbacks): ListComponent {
    const box = new ListComponent([], callbacks, {
      ...this.getObjectBoxSize(),
      label: this.getLabel('Objects', this.getNextFocusKey()),
    });
    this.screen.append(box.element);
    this.addComponentToFocusKeyMap(box);
    return box;
  }

  private getObjectBoxSize(): ComponentSizeInfo {
    return {
      width: Math.floor(positionToNumber(this.screen.width) / 3),
      height: Math.floor((2 * positionToNumber(this.screen.height)) / 3),
      top: 0,
      left: Math.floor(positionToNumber(this.screen.width) / 3),
    };
  }

  private initObjectPropertyBox(callbacks: ListCallbacks): ListComponent {
    const box = new ListComponent([], callbacks, {
      ...this.getObjectPropertyBoxSize(),
      label: this.getLabel('Object Detail', this.getNextFocusKey()),
    });
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
      label: this.getLabel('References', this.getNextFocusKey()),
    });
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
      label: this.getLabel('Retainer Trace', this.getNextFocusKey()),
    });
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

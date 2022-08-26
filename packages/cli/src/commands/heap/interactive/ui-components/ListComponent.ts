/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */
import type {Widgets} from 'blessed';

import blessed from 'blessed';
import chalk from 'chalk';
import stringWidth from 'string-width';

export type ListComponentOption = {
  width: number;
  height: number;
  left: number;
  top: number;
  label: string;
};

export type ListItemSelectInfo = {
  keyName: string;
};

export type ListCallbacks = {
  selectCallback?: (
    componentId: number,
    index: number,
    content: string[],
    selectInfo: ListItemSelectInfo,
  ) => void;
  updateContent?: (oldContent: string[], newContent: string[]) => void;
  getFocus?: () => void;
};

/**
 * A ListComponent is an UI list component in CLI.
 * It managers all the UI events related to the
 * list component (e.g., scroll up, down, left, right, and other key strokes)
 */
export default class ListComponent {
  public element: Widgets.ListElement;
  public id: number;
  private listIndex = 0;
  private content: string[] = [];
  private callbacks: ListCallbacks;
  private horizonScrollPositionMap: Map<number, number>;

  private static nextComponentId = 0;
  private static nextId(): number {
    return ListComponent.nextComponentId++;
  }

  constructor(
    content: string[],
    callbacks: ListCallbacks,
    options: ListComponentOption,
  ) {
    this.id = ListComponent.nextId();
    this.horizonScrollPositionMap = new Map();
    this.callbacks = callbacks;
    // init list element
    this.element = blessed.list({
      ...options,
      tags: true,
      scrollable: true,
      keys: true,
      border: {
        fg: 'grey',
        type: 'line',
      } as unknown as Widgets.Border,
      style: {
        item: {
          fg: 'white',
          bg: 'default',
        },
        selected: {
          bg: 'grey',
          bold: true,
        },
      },
    });
    this.setContent(content);
    this.registerKeys();
  }

  protected registerKeys() {
    this.element.on(
      'keypress',
      (char: string, key: Widgets.Events.IKeyEventArg) => {
        const content = this.content;

        // move selection down
        if (key.name === 'down' && this.listIndex < content.length - 1) {
          this.element.select(++this.listIndex);
          this.selectUpdate(this.listIndex, content, {
            keyName: key.name,
          });

          // move selection up
        } else if (key.name === 'up' && this.listIndex > 0) {
          this.element.select(--this.listIndex);
          this.selectUpdate(this.listIndex, content, {
            keyName: key.name,
          });

          // hit enter to select the current heap object
        } else if (key.name === 'enter') {
          this.selectUpdate(this.listIndex, content, {
            keyName: key.name,
          });

          // scroll left
        } else if (key.name === 'left') {
          this.scrollLeft();

          // scroll right
        } else if (key.name === 'right') {
          this.scrollRight();
        }
      },
    );
  }

  private scrollLeft() {
    const selectedContent = this.content[this.listIndex];
    if (!selectedContent) {
      return;
    }
    let offset = 0;
    if (this.horizonScrollPositionMap.has(this.listIndex)) {
      offset = this.horizonScrollPositionMap.get(this.listIndex) ?? 0;
    }
    if (offset === 0) {
      return;
    }
    this.horizonScrollPositionMap.set(this.listIndex, --offset);
    let newContent = selectedContent.substring(offset) as unknown;
    if (offset > 0) {
      newContent = chalk.grey('...') + newContent;
    }
    this.element.spliceItem(
      this.listIndex,
      1,
      newContent as Widgets.BlessedElement,
    );
    this.element.select(this.listIndex);
  }

  private scrollRight() {
    const selectedContent = this.content[this.listIndex];
    if (!selectedContent || stringWidth(selectedContent) <= 5) {
      return;
    }
    let offset = 0;
    if (this.horizonScrollPositionMap.has(this.listIndex)) {
      offset = this.horizonScrollPositionMap.get(this.listIndex) ?? 0;
    }
    this.horizonScrollPositionMap.set(this.listIndex, ++offset);
    let newContent = selectedContent.substring(offset) as unknown;
    if (offset > 0) {
      newContent = chalk.grey('...') + newContent;
    }
    this.element.spliceItem(
      this.listIndex,
      1,
      newContent as Widgets.BlessedElement,
    );
    this.element.select(this.listIndex);
  }

  public focus(): void {
    this.element.focus();
    this.element.style.border.fg = 'white';
    this.getFocus();
  }

  public loseFocus(): void {
    this.element.style.border.fg = 'grey';
  }

  public selectIndex(index: number): void {
    this.listIndex = index;
    this.element.select(index);
  }

  public setContent(content: string[]): void {
    const oldContent = this.content;
    this.element.clearItems();
    // push list items into the list
    for (const l of content) {
      this.element.pushItem(l as unknown as Widgets.BlessedElement);
    }
    this.content = content;
    this.horizonScrollPositionMap.clear();
    this.updateContent(oldContent, this.content);
  }

  // function to be overridden
  public updateContent(oldContent: string[], newContent: string[]): void {
    if (this.callbacks.updateContent) {
      this.callbacks.updateContent(oldContent, newContent);
    }
  }

  // function to be overridden
  public getFocus(): void {
    if (this.callbacks.getFocus) {
      this.callbacks.getFocus();
    }
  }

  public selectUpdate(
    index: number,
    content: string[],
    selectInfo: ListItemSelectInfo,
  ): void {
    if (this.callbacks.selectCallback) {
      this.callbacks.selectCallback(this.id, index, content, selectInfo);
    }
  }
}

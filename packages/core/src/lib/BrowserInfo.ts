/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {ConsoleMessage, Dialog, LaunchOptions, Page} from 'puppeteer';
import type {IBrowserInfo} from './Types';
type Options = {color?: boolean};

import config from './Config';
import info from './Console';
import constant from './Constant';
import chalk from 'chalk';
import fs from 'fs';

class BrowserInfo {
  _browserVersion: string;
  _puppeteerConfig: LaunchOptions;
  _consoleMessages: string[];

  constructor() {
    this._browserVersion = constant.unset;
    this._puppeteerConfig = {};
    this._consoleMessages = [];
  }

  clear() {
    this._consoleMessages = [];
  }

  setBrowserVersion(version: string): void {
    this._browserVersion = version;
  }

  setPuppeteerConfig(puppeteerConfig: LaunchOptions): void {
    this._puppeteerConfig = puppeteerConfig;
  }

  load(browserInfo: IBrowserInfo): void {
    this._browserVersion = browserInfo._browserVersion;
    this._puppeteerConfig = browserInfo._puppeteerConfig;
    this._consoleMessages = browserInfo._consoleMessages;
  }

  formatConsoleMessage(
    message: ConsoleMessage,
    options: Options = {},
  ): string[] {
    if (!message) {
      return [];
    }
    const type = `${message.type()}`;
    if (
      type === 'startGroup' ||
      type === 'endGroup' ||
      type === 'groupStart' ||
      type === 'groupEnd'
    ) {
      return [];
    }
    const text = message.text();
    return text.split('\n').map(line => {
      let consoleInfo = `[console.${type}]`;
      consoleInfo = options.color ? chalk.blue(consoleInfo) : consoleInfo;
      return `${consoleInfo}: ${line}`;
    });
  }

  formatDialogMessage(dialog: Dialog, options: Options = {}): string {
    if (!dialog || !dialog.message()) {
      return '';
    }
    let typeInfo = `[dialog ${dialog.type()}]`;
    typeInfo = options.color ? chalk.blue(typeInfo) : typeInfo;
    return `${typeInfo}: ${dialog.message()}`;
  }

  addMarker(marker: string): void {
    this._consoleMessages.push(marker);
  }

  summarizeConsoleMessage(): string {
    return this._consoleMessages.join('\n');
  }

  dump(): void {
    const file = config.browserInfoSummary;
    const consoleSummary = this.summarizeConsoleMessage();
    const summary = `Web Console Output:\n${consoleSummary}`;
    fs.writeFileSync(file, summary, 'utf-8');
  }

  monitorWebConsole(page: Page): void {
    page.on('console', message => {
      let msgList = this.formatConsoleMessage(message);
      this._consoleMessages = this._consoleMessages.concat(msgList);
      if (config.verbose || config.dumpWebConsole) {
        msgList = this.formatConsoleMessage(message, {color: true});
        if (msgList.length > 0) {
          info.highLevel(msgList.join('\n'));
        }
      }
      message.args().forEach(handle => handle.dispose());
    });
    const handleError = (err: Error) => {
      this._consoleMessages.push(err.toString());
      info.error(err.message);
    };
    page.on('pageerror', handleError);
    page.on('error', handleError);

    page.on('dialog', async (dialog: Dialog) => {
      let msg = this.formatDialogMessage(dialog);
      this._consoleMessages.push(msg);
      if (config.verbose || config.dumpWebConsole) {
        msg = this.formatDialogMessage(dialog, {color: true});
        info.highLevel(msg);
      }
      // dialog will be auto accepted or dismissed in setupPage
    });
  }
}

export default new BrowserInfo();

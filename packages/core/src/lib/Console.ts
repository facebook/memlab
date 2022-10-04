/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

'use strict';

import chalk, {Chalk} from 'chalk';
import fs from 'fs';
import readline from 'readline';
import stringWidth from 'string-width';
import type {MemLabConfig} from './Config';
import {AnyValue, Nullable, Optional} from './Types';

type Message = {
  lines: number[];
  options?: ConsoleOptions;
};

type ConsoleOptions = {
  isOverwrite?: boolean;
};

type Section = {
  name: string;
  msgs: Message[];
};

type Sections = {
  dict: {
    [sectionName: string]: Section;
  };
  arr: Section[];
};

const stdout = process.stdout;
const TABLE_MAX_WIDTH = 50;
const prevLine = '\x1b[F';
const eraseLine = '\x1b[K';
const barComplete = chalk.green('\u2588');
const barIncomplete = chalk.grey('\u2591');

function formatTableArg(arg: AnyValue): void {
  if (!Array.isArray(arg)) {
    return arg;
  }
  arg.forEach(obj => {
    if (typeof obj !== 'object') {
      return;
    }
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (typeof value !== 'string') {
        continue;
      }
      if (value.length <= TABLE_MAX_WIDTH) {
        continue;
      }
      obj[key] = value.substring(0, TABLE_MAX_WIDTH) + '...';
    }
  });
}

interface MemlabConsoleStyles {
  top: (msg: string) => string;
  high: Chalk;
  mid: Chalk;
  low: Chalk;
  success: Chalk;
  error: Chalk;
  warning: Chalk;
}

class MemLabConsole {
  private config: MemLabConfig = {} as MemLabConfig;
  private sections: Sections;
  private log: string[] = [];
  private styles: MemlabConsoleStyles = {
    top: (msg: string): string => msg,
    high: chalk.dim.bind(chalk),
    mid: chalk.yellow.bind(chalk),
    low: chalk.grey.bind(chalk),
    success: chalk.green.bind(chalk),
    error: chalk.red.bind(chalk),
    warning: chalk.yellow.bind(chalk),
  };

  private static singleton: MemLabConsole;

  protected constructor() {
    this.sections = {
      dict: Object.create(null),
      arr: [{name: 'header', msgs: []}],
    };
    this.init();
  }

  public static getInstance(): MemLabConsole {
    if (MemLabConsole.singleton) {
      return MemLabConsole.singleton;
    }

    const inst = new MemLabConsole();
    MemLabConsole.singleton = inst;

    // clean up output
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    process.on('exit', (_code: number) => {
      inst.flushLog();
      inst.clearPrevOverwriteMsg();
    });
    return inst;
  }

  private style(msg: string, name: keyof MemlabConsoleStyles): string {
    if (Object.prototype.hasOwnProperty.call(this.styles, name)) {
      return this.styles[name](msg);
    }
    return this.styles.low(msg);
  }

  private init(): void {
    this.beginSection('main-section-DO-NOT-USE');
  }

  private getLastSection(): Optional<Section> {
    const list = this.sections.arr;
    return list[list.length - 1];
  }

  private getLastMsg(): Nullable<Message> {
    const lastSection = this.getLastSection();
    if (!lastSection || !lastSection.msgs) {
      return null;
    }
    const msgs = lastSection.msgs;
    return msgs.length === 0 ? null : msgs[msgs.length - 1];
  }

  private logMsg(msg: string): void {
    // remove control characters
    const rawMsg = msg
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/\[\d{1,3}m/g, '');
    this.log.push(rawMsg);
    if (this.log.length > 20) {
      this.flushLog();
    }
  }

  private flushLog(): void {
    const str = this.log.join('\n');
    if (str.length > 0) {
      const file = this.config.consoleLogFile;
      fs.appendFile(file, str + '\n', 'UTF-8', () => {
        // NOOP
      });
    }
    this.log = [];
  }

  private pushMsg(msg: string, options: ConsoleOptions = {}): void {
    const len = this.sections.arr.length;
    if (this.config.isContinuousTest || len === 0) {
      return;
    }
    // calculate each line's visible width
    const lines = msg.split('\n').map(line => stringWidth(line));
    const section = this.getLastSection();
    section?.msgs.push({lines, options});
    this.logMsg(msg);
  }

  private clearPrevMsgInLastSection(): void {
    const lastSection = this.getLastSection();
    this.clearPrevMsgInSection(lastSection);
  }

  private clearPrevMsgInSection(section: Optional<Section>): void {
    if (this.config.isContinuousTest) {
      return;
    }
    if (!section || section.msgs.length === 0) {
      return;
    }
    stdout.write(eraseLine);
    const msg = section.msgs.pop();

    if (!msg) {
      return;
    }

    const lines = msg.lines;
    while (lines.length > 0) {
      const line = lines.pop() ?? 0;
      const width = stdout.columns;
      let n = line === 0 ? 1 : Math.ceil(line / width);
      while (n-- > 0) {
        stdout.write(prevLine + eraseLine);
      }
    }
  }

  private clearPrevSection(): void {
    if (this.config.isContinuousTest) {
      return;
    }
    const lastSection = this.getLastSection();

    if (!lastSection) {
      return;
    }

    while (lastSection?.msgs?.length > 0) {
      this.clearPrevMsgInSection(lastSection);
    }
    this.sections.arr.pop();
    delete this.sections.dict[lastSection.name];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private shouldBeConcise(_msgType: string): boolean {
    if (!this.config || !this.config.runningMode) {
      return false;
    }
    return this.config.runningMode.shouldUseConciseConsole();
  }

  private clearPrevOverwriteMsg(): void {
    if (this.config.isContinuousTest) {
      return;
    }
    const lastMsg = this.getLastMsg();
    if (!lastMsg || !lastMsg.options?.isOverwrite) {
      return;
    }
    this.clearPrevMsgInLastSection();
  }

  private printStr(msg: string, options: ConsoleOptions = {}): void {
    if (this.config.isTest || this.config.muteConsole) {
      return;
    }
    console.log(msg);
    this.pushMsg(msg, options);
  }

  public beginSection(name: string): void {
    if (this.config.isContinuousTest) {
      return;
    }
    this.clearPrevOverwriteMsg();
    if (this.sections.dict[name]) {
      this.endSection(name);
    }
    const section = {name, msgs: []};
    this.sections.dict[name] = section;
    this.sections.arr.push(section);
  }

  public endSection(name: string): void {
    if (this.config.isContinuousTest || this.sections.arr.length === 0) {
      return;
    }
    if (!this.sections.dict[name]) {
      return;
    }
    let section;
    do {
      section = this.getLastSection();
      this.clearPrevSection();
    } while (section?.name !== name);
  }

  public setConfig(config: MemLabConfig): void {
    this.config = config;
  }

  public table(...args: AnyValue[]): void {
    if (
      this.shouldBeConcise('table') ||
      this.config.isTest ||
      this.config.muteConsole
    ) {
      return;
    }
    this.clearPrevOverwriteMsg();
    // make sure the values are not too big
    formatTableArg(args[0]);
    if (args[0].length === 0) {
      return;
    }
    console.table(...args);
  }

  public trace(): void {
    if (this.config.isTest || this.config.muteConsole) {
      return;
    }
    console.trace();
  }

  public topLevel(msg: string): void {
    if (this.shouldBeConcise('topLevel')) {
      return this.overwrite(msg);
    }
    this.clearPrevOverwriteMsg();
    this.printStr(this.style(msg, 'top'));
  }

  public highLevel(msg: string): void {
    if (this.shouldBeConcise('highLevel')) {
      return this.overwrite(msg);
    }
    this.clearPrevOverwriteMsg();
    this.printStr(this.style(msg, 'high'));
  }

  public midLevel(msg: string): void {
    if (this.shouldBeConcise('midLevel')) {
      return this.overwrite(msg);
    }
    this.clearPrevOverwriteMsg();
    this.printStr(this.style(msg, 'mid'));
  }

  public lowLevel(msg: string): void {
    if (this.shouldBeConcise('lowLevel')) {
      return this.overwrite(msg);
    }
    this.clearPrevOverwriteMsg();
    this.printStr(this.style(msg, 'low'));
  }

  public success(msg: string): void {
    if (this.shouldBeConcise('success')) {
      return this.overwrite(msg);
    }
    this.clearPrevOverwriteMsg();
    this.printStr(this.style(msg, 'success'));
  }

  // top level error, only used before halting the execution
  public criticalError(msg: string): void {
    this.clearPrevOverwriteMsg();
    this.logMsg(msg);
    console.error(msg);
  }

  public error(msg: string): void {
    this.clearPrevOverwriteMsg();
    this.printStr(this.style(msg, 'error'));
  }

  public warning(msg: string): void {
    this.clearPrevOverwriteMsg();
    this.printStr(this.style(msg, 'warning'));
  }

  public nextLine(): void {
    if (this.shouldBeConcise('nextLine')) {
      return this.overwrite('');
    }
    this.clearPrevOverwriteMsg();
    this.printStr('');
  }

  public overwrite(
    msg: string,
    options: {level?: keyof MemlabConsoleStyles} = {},
  ): void {
    if (this.config.isTest || this.config.muteConsole) {
      return;
    }
    if (this.config.isContinuousTest) {
      return console.log(msg);
    }
    this.clearPrevOverwriteMsg();
    const str = this.style(msg, options.level || 'low');
    this.printStr(str, {isOverwrite: true});
  }

  public waitForConsole(query: string): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    this.pushMsg(query);
    return new Promise(resolve =>
      rl.question(query, ans => {
        rl.close();
        resolve(ans);
      }),
    );
  }

  public progress(
    cur: number,
    total: number,
    options: {message?: string} = {},
  ): void {
    let width = Math.floor(stdout.columns * 0.8);
    width = Math.min(width, 80);
    const messageMaxWidth = Math.floor(width * 0.3);
    let message = options.message || '';
    const messageWidth = Math.min(message.length, messageMaxWidth);
    message = message.substring(0, messageWidth);

    // calculate progress bar
    const barWidth = width - messageWidth - 1;
    const barBodyWidth = barWidth - 2;
    const changeIndex = Math.floor((cur / total) * barBodyWidth);
    let bar = '';
    for (let i = 0; i < barBodyWidth; ++i) {
      bar += i < changeIndex ? barComplete : barIncomplete;
    }
    const percent = Math.floor((cur / total) * 100);
    const progress = `${message}: |${bar}| ${percent}/100`;
    this.overwrite(progress, {level: 'top'});
  }

  public flush(): void {
    this.clearPrevOverwriteMsg();
  }
}

export default MemLabConsole.getInstance();

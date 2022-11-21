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
import path from 'path';
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
const LOG_BUFFER_LENGTH = 100;
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

type ExitOptions = {
  exit?: boolean;
  cleanup?: boolean;
};

type ExitHandler = (options: ExitOptions, exitCode: number | string) => void;

function registerExitCleanup(
  inst: MemLabConsole,
  exitHandler: ExitHandler,
): void {
  const p = process;

  // normal exit
  p.on('exit', exitHandler.bind(null, {cleanup: true}));

  // ctrl + c event
  p.on('SIGINT', exitHandler.bind(null, {exit: true}));

  // kill pid
  p.on('SIGUSR1', exitHandler.bind(null, {exit: true}));
  p.on('SIGUSR2', exitHandler.bind(null, {exit: true}));
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
  private logFileSet: Set<string> = new Set();
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

    const exitHandler: ExitHandler = (
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _options: ExitOptions,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _exitCode: number | string,
    ) => {
      inst.flushLog({sync: true});
      inst.clearPrevOverwriteMsg();
    };
    registerExitCleanup(inst, exitHandler);

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
    const lines = msg.split('\n').map(line =>
      line
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
        .replace(/\[\d{1,3}m/g, ''),
    );
    this.log.push(...lines);
    if (this.log.length > LOG_BUFFER_LENGTH) {
      this.flushLog({sync: true});
    }
  }

  private flushLog(options: {sync?: boolean} = {}): void {
    const str = this.log.join('\n');
    this.log = [];

    if (str.length === 0) {
      return;
    }

    // synchronous logging
    if (options.sync) {
      for (const logFile of this.logFileSet) {
        try {
          fs.appendFileSync(logFile, str + '\n', 'UTF-8');
        } catch {
          // fail silently
        }
      }
    } else {
      // async logging
      const emptyCallback = () => {
        // no op
      };
      for (const logFile of this.logFileSet) {
        try {
          fs.appendFile(logFile, str + '\n', 'UTF-8', emptyCallback);
        } catch {
          // fail silently
        }
      }
    }
  }

  private pushMsg(msg: string, options: ConsoleOptions = {}): void {
    if (this.sections.arr.length === 0) {
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
    if (!this.config.muteConsole) {
      stdout.write(eraseLine);
    }
    const msg = section.msgs.pop();

    if (!msg) {
      return;
    }

    const lines = msg.lines;
    while (lines.length > 0) {
      const line = lines.pop() ?? 0;
      const width = stdout.columns;
      let n = line === 0 ? 1 : Math.ceil(line / width);
      if (!this.config.muteConsole && !this.config.isTest) {
        while (n-- > 0) {
          stdout.write(prevLine + eraseLine);
        }
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
    this.pushMsg(msg, options);
    if (this.config.isTest) {
      return;
    }
    if (this.config.isContinuousTest || !this.config.muteConsole) {
      console.log(msg);
    }
  }

  public registerLogFile(logFile: string): void {
    this.flushLog({sync: true});
    this.logFileSet.add(path.resolve(logFile));
  }

  public unregisterLogFile(logFile: string): void {
    this.flushLog({sync: true});
    this.logFileSet.delete(path.resolve(logFile));
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
    const str = this.style(msg, options.level || 'low');
    if (this.config.isContinuousTest) {
      this.printStr(msg, {isOverwrite: false});
      return;
    }
    if (this.config.isTest || this.config.muteConsole) {
      this.printStr(str, {isOverwrite: true});
      return;
    }
    this.clearPrevOverwriteMsg();
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

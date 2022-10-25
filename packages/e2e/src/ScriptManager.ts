/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {AnyFunction, Nullable} from '@memlab/core';
import type {RewriteScriptOption} from './instrumentation/ScriptRewriteManager';

import fs from 'fs';
import path from 'path';
import {config, fileManager} from '@memlab/core';
import ScriptRewriteManager from './instrumentation/ScriptRewriteManager';

type ScriptInfo = {
  codePath: string;
  url: string;
  fileId: number;
};

export default class ScriptManager {
  private fileId = 0;
  private metaFileWriteTimeout: Nullable<NodeJS.Timeout> = null;
  private scriptRewriteManager: ScriptRewriteManager;
  private urlToScriptMap: Map<string, ScriptInfo>;
  private scriptInfos: ScriptInfo[];

  constructor() {
    this.init();
  }

  private init(): void {
    this.urlToScriptMap = new Map();
    this.scriptInfos = [];
    this.scriptRewriteManager = new ScriptRewriteManager();
  }

  public loadFromFiles(): boolean {
    this.init();
    const webSourceMetaFile = fileManager.getWebSourceMetaFile();
    const webSourceDir = fileManager.getWebSourceDir();
    if (!fs.existsSync(webSourceMetaFile) || !fs.existsSync(webSourceDir)) {
      return false;
    }
    try {
      const metaContent = fs.readFileSync(webSourceMetaFile, 'UTF-8');
      this.scriptInfos = JSON.parse(metaContent);
      for (const scriptInfo of this.scriptInfos) {
        this.urlToScriptMap.set(scriptInfo.url, scriptInfo);
      }
    } catch {
      return false;
    }
    return true;
  }

  public loadCodeForUrl(url: string): Nullable<string> {
    if (!this.urlToScriptMap.has(url)) {
      return null;
    }
    const scriptInfo = this.urlToScriptMap.get(url) as ScriptInfo;
    let code: Nullable<string> = null;
    try {
      code = fs.readFileSync(scriptInfo.codePath, 'UTF-8');
    } catch {
      // do nothing
    }
    return code;
  }

  public async rewriteScript(
    code: string,
    options: RewriteScriptOption = {},
  ): Promise<string> {
    if (!config.instrumentJS) {
      return code;
    }
    const newCode = await this.scriptRewriteManager.rewriteScript(
      code,
      options,
    );
    return newCode;
  }

  public async logScript(url: string, code: string): Promise<void> {
    if (this.urlToScriptMap.has(url)) {
      return;
    }
    const metaFile = fileManager.getWebSourceMetaFile();
    const file = path.join(
      fileManager.getWebSourceDir(),
      `${++this.fileId}.js`,
    );
    const scriptInfo: ScriptInfo = {
      url,
      fileId: this.fileId,
      codePath: file,
    };
    this.urlToScriptMap.set(url, scriptInfo);
    this.scriptInfos.push(scriptInfo);
    fs.writeFile(file, code, 'UTF-8', () => {
      // write file asynchroniously
    });
    // only write the latest version of the meta file state
    this.debounce(() => {
      fs.writeFileSync(
        metaFile,
        JSON.stringify(this.scriptInfos, undefined, 2),
        'UTF-8',
      );
    }, 1000);
  }

  private debounce(callback: AnyFunction, timeout: number): void {
    if (this.metaFileWriteTimeout) {
      clearTimeout(this.metaFileWriteTimeout);
      this.metaFileWriteTimeout = null;
    }
    this.metaFileWriteTimeout = setTimeout(() => {
      callback();
      this.metaFileWriteTimeout = null;
    }, timeout);
  }
}

/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {AnyFunction, Nullable} from '@memlab/core';
import type {RewriteScriptOption} from './instrumentation/ScriptRewriteManager';
import type {ClosureScope} from './code-analysis/Script';

import fs from 'fs';
import path from 'path';
import {config, fileManager} from '@memlab/core';
import Script from './code-analysis/Script';
import ScriptRewriteManager from './instrumentation/ScriptRewriteManager';

type ScriptInfo = {
  codePath: string;
  url: string;
  fileId: number;
  code?: string;
  resourceType: string;
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
    if (scriptInfo.code) {
      return scriptInfo.code;
    }
    try {
      scriptInfo.code = fs.readFileSync(scriptInfo.codePath, 'UTF-8');
    } catch {
      // do nothing
    }
    return scriptInfo.code ?? null;
  }

  public getClosureScopeTreeForUrl(url: string): Nullable<ClosureScope> {
    const code = this.loadCodeForUrl(url);
    if (code == null) {
      return null;
    }
    try {
      const script = new Script(code);
      return script.getClosureScopeTree();
    } catch {
      // do nothing
    }
    return null;
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

  public resourceTypeToSuffix(resourceType: string): string {
    switch (resourceType) {
      case 'Script':
        return '.js';
      case 'Stylesheet':
        return '.css';
      case 'Document':
        return '.html';
      default:
        return '.unknown';
    }
  }

  public async logScript(
    url: string,
    code: string,
    resourceType: string,
  ): Promise<void> {
    if (this.urlToScriptMap.has(url)) {
      return;
    }
    const metaFile = fileManager.getWebSourceMetaFile();
    const file = path.join(
      fileManager.getWebSourceDir(),
      `${++this.fileId}${this.resourceTypeToSuffix(resourceType)}`,
    );
    const scriptInfo: ScriptInfo = {
      url,
      fileId: this.fileId,
      codePath: file,
      resourceType,
    };
    this.urlToScriptMap.set(url, scriptInfo);
    this.scriptInfos.push(scriptInfo);
    fs.writeFile(file, code, 'UTF-8', () => {
      // async write, do nothing here
    });
    // only write the latest version of the meta file state
    this.debounce(() => {
      fs.writeFileSync(
        metaFile,
        JSON.stringify(this.scriptInfos, void 0, 2),
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

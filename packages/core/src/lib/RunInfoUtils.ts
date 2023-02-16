/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */
import type {Nullable, Optional, RunMetaInfo} from './Types';

import fs from 'fs';
import browserInfo from './BrowserInfo';
import config from './Config';
import constant from './Constant';
import fileManager from './FileManager';
import utils from './Utils';
import {setInternalValue} from './InternalValueSetter';

export class RunMetaInfoManager {
  getRunMetaFilePath(options?: {workDir?: Optional<string>}): string {
    if (options?.workDir != null) {
      return fileManager.getRunMetaFile({workDir: options.workDir});
    }
    if (config.useExternalSnapshot) {
      return config.externalRunMetaFile;
    }
    if (config.runMetaFile != null) {
      return config.runMetaFile;
    }
    return fileManager.getRunMetaFile();
  }

  saveRunMetaInfo(
    runMetaInfo: RunMetaInfo,
    options?: {workDir?: Optional<string>; extraRunInfo?: Map<string, string>},
  ): string {
    const runMetaFile = this.getRunMetaFilePath(options);
    const serializable = {
      ...runMetaInfo,
      extraInfo: {
        ...utils.mapToObject(config.extraRunInfoMap),
        ...utils.mapToObject(options?.extraRunInfo ?? new Map()),
      },
    };
    fs.writeFileSync(
      runMetaFile,
      JSON.stringify(serializable, null, 2),
      'UTF-8',
    );
    return runMetaFile;
  }

  private loadRunMetaInfoFromFile(file: string): RunMetaInfo {
    const content = fs.readFileSync(file, 'UTF-8');
    const runMetaInfo = JSON.parse(content) as RunMetaInfo;
    if (runMetaInfo && runMetaInfo.extraInfo) {
      config.extraRunInfoMap = utils.objectToMap(runMetaInfo.extraInfo);
    }
    return runMetaInfo;
  }

  loadRunMetaInfo(options?: {
    metaFile?: Optional<string>;
    workDir?: Optional<string>;
  }): RunMetaInfo {
    const file = options?.metaFile || this.getRunMetaFilePath(options);
    try {
      return this.loadRunMetaInfoFromFile(file);
    } catch (_) {
      throw utils.haltOrThrow(
        'Run info missing. Please make sure `memlab run` is complete.',
      );
    }
  }

  loadRunMetaInfoSilentFail(options?: {
    metaFile?: Optional<string>;
    workDir?: Optional<string>;
  }): Nullable<RunMetaInfo> {
    const file = options?.metaFile || this.getRunMetaFilePath(options);
    try {
      return this.loadRunMetaInfoFromFile(file);
    } catch (_) {
      return null;
    }
  }

  loadRunMetaExternalTemplate(): RunMetaInfo {
    const runMetaTemplateFile = fileManager.getRunMetaExternalTemplateFile();
    return JSON.parse(
      fs.readFileSync(runMetaTemplateFile, 'UTF-8'),
    ) as RunMetaInfo;
  }

  setConfigFromRunMeta(
    options: {workDir?: Optional<string>; silentFail?: boolean} = {},
  ): void {
    const meta = options?.silentFail
      ? this.loadRunMetaInfoSilentFail(options)
      : this.loadRunMetaInfo(options);
    if (meta == null) {
      return;
    }
    if (meta?.app == null || meta?.interaction == null) {
      if (options?.silentFail) {
        return;
      }
      throw utils.haltOrThrow('No app or interaction infomation');
    }
    config.targetApp = meta.app;
    config.targetTab = meta.interaction;
    browserInfo.load(meta.browserInfo);
  }
}

const runInfoUtils = {runMetaInfoManager: new RunMetaInfoManager()};

setInternalValue(runInfoUtils, __filename, constant.internalDir);
/** @internal */
export default runInfoUtils;

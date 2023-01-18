/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {MemLabConfig} from './Config';
import type {AnyValue, FileOption, Nullable} from './Types';

import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import info from './Console';
import constant from './Constant';
import utils from './Utils';

function joinAndProcessDir(options: FileOption, ...args: AnyValue[]): string {
  const filepath = path.join(...args);
  if (!fs.existsSync(filepath)) {
    try {
      fs.mkdirpSync(filepath);
    } catch (ex) {
      const err = utils.getError(ex);
      if (!err.message.includes('already exists')) {
        utils.haltOrThrow(err);
      }
    }
  }
  return filepath;
}

/** @internal */
export class FileManager {
  private memlabConfigCache: Nullable<MemLabConfig> = null;

  public getDefaultWorkDir(): string {
    return path.join(this.getTmpDir(), 'memlab');
  }

  public generateTmpHeapDir(): string {
    const dirPath = path.join(
      this.getTmpDir(),
      'memlab-' + utils.getUniqueID(),
    );
    if (!fs.existsSync(dirPath)) {
      fs.mkdirpSync(dirPath);
    }
    return dirPath;
  }

  private static transientInstanceIdx = 0;
  public static defaultFileOption: FileOption = {};

  public getWorkDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    // workDir options supercedes all the other options
    if (options.workDir) {
      return path.resolve(options.workDir);
    }

    // transient options supercedes the other CLI options
    if (options.transient) {
      const idx = ++FileManager.transientInstanceIdx;
      const instanceId = `${process.pid}-${Date.now()}-${idx}`;
      const workDir = path.join(this.getTmpDir(), `memlab-${instanceId}`);
      return path.resolve(workDir);
    }

    // workDir from the CLI options
    const workDir =
      FileManager.defaultFileOption.workDir ||
      // in case there is a transcient working directory generated
      this.memlabConfigCache?.workDir ||
      this.getDefaultWorkDir();
    return path.resolve(workDir);
  }

  public getChromeBinaryZipFile(): string {
    return path.join(this.getDefaultWorkDir(), 'chrome.tar.gz');
  }

  public getChromeBinaryTimeStampFile(): string {
    return path.join(this.getChromeBinaryDir(), 'memlab-success');
  }

  public getChromeBinaryDir(): string {
    return path.join(this.getDefaultWorkDir(), 'chrome');
  }

  public getDataBaseDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getWorkDir(options), 'data');
  }

  public getCodeDataDir(): string {
    return path.join(this.getCoreProjectBaseDir(), 'static');
  }

  public getClusterSampleDataDir(): string {
    return path.join(this.getCodeDataDir(), 'cluster');
  }

  public getUserDataDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getDataBaseDir(options), 'profile');
  }

  public clearUserDataDir(
    options: FileOption = FileManager.defaultFileOption,
  ): void {
    const userDataDir = this.getUserDataDir(options);
    this.rmDir(userDataDir);
  }

  public getCurDataDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getDataBaseDir(options), 'cur');
  }

  public getWebSourceDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getCurDataDir(options), 'code');
  }

  public getWebSourceMetaFile(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getWebSourceDir(options), 'files.json');
  }

  public getDebugDataDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getDataBaseDir(options), 'debug');
  }

  public getDebugSourceFile(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getDebugDataDir(options), 'file.js');
  }

  public getPersistDataDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getDataBaseDir(options), 'persist');
  }

  public getLoggerOutDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getDataBaseDir(options), 'logger');
  }

  // all heap analysis results generated
  public getHeapAnalysisLogDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getLoggerOutDir(options), 'heap-analysis');
  }

  // memlab save-heap result log file
  public getHeapSaveLogJSONFile(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getHeapAnalysisLogDir(options), 'save-heap.json');
  }

  // all trace clusters generated from the current run
  public getTraceClustersDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getLoggerOutDir(options), 'trace-clusters');
  }

  // stores JSON file (with heap object and reference details for visualization)
  // of all trace clusters (each cluster has a representative trace)
  public getTraceJSONDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getLoggerOutDir(options), 'trace-jsons');
  }

  public getUnclassifiedTraceClusterDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getLoggerOutDir(options), 'unclassified-clusters');
  }

  public getUniqueTraceClusterDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getLoggerOutDir(options), 'unique-trace-clusters');
  }

  public getNewUniqueTraceClusterDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getUniqueTraceClusterDir(options), 'add');
  }

  public getStaleUniqueTraceClusterDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getUniqueTraceClusterDir(options), 'delete');
  }

  public getAllClusterSummaryFile(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(
      this.getUniqueTraceClusterDir(options),
      'unique-clusters-summary.txt',
    );
  }

  public getExistingUniqueTraceClusterDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getUniqueTraceClusterDir(options), 'existing');
  }

  public getAllFilesInDir(dir: string): string[] {
    const files = fs.readdirSync(dir);
    return files.map((file: string) => path.join(dir, file));
  }

  public getDataOutDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getDataBaseDir(options), 'out');
  }

  public getCoreProjectBaseDir(): string {
    return path.join(__dirname, '..', '..');
  }

  public getMonoRepoDir(): string {
    return path.join(this.getCoreProjectBaseDir(), '..', '..');
  }

  public getDocDir(): string {
    return path.join(this.getMonoRepoDir(), 'website', 'docs');
  }

  public getReportOutDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getPersistDataDir(options), 'reports');
  }

  public getPreviewReportDir(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getPersistDataDir(options), 'report-preview');
  }

  public getLeakSummaryFile(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getDataOutDir(options), 'leaks.txt');
  }

  public getRunMetaFile(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getCurDataDir(options), 'run-meta.json');
  }

  public getSnapshotSequenceMetaFile(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    return path.join(this.getCurDataDir(options), 'snap-seq.json');
  }

  public getInputDataDir(): string {
    return path.join(this.getDefaultWorkDir(), 'input');
  }

  public getAllFilesInSubDirs(dir: string): string[] {
    let ret: string[] = [];
    if (!fs.existsSync(dir)) {
      return ret;
    }
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const p = path.join(dir, file);
      if (fs.lstatSync(p).isDirectory()) {
        ret = ret.concat(this.getAllFilesInSubDirs(p));
      } else {
        ret.push(p);
      }
    }
    return ret;
  }

  // system default tmp dir
  public getTmpDir(): string {
    return os.tmpdir();
  }

  public rmDir(dir: string): void {
    if (fs.existsSync(dir)) {
      fs.removeSync(dir);
    }
  }

  public getExperimentsDir(): string {
    return path.join(this.getTmpDir(), 'memlab-experiments');
  }

  public initExperimentDir(experimentId: string): {
    controlWorkDir: string;
    testWorkDir: string;
  } {
    const expsDir = joinAndProcessDir({}, this.getExperimentsDir());
    const expDir = joinAndProcessDir({}, expsDir, `exp-${experimentId}`);
    const controlWorkDir = joinAndProcessDir({}, expDir, 'control');
    const testWorkDir = joinAndProcessDir({}, expDir, 'test');
    return {controlWorkDir, testWorkDir};
  }

  // create a unique log file created for heap analysis output
  public initNewHeapAnalysisLogFile(
    options: FileOption = FileManager.defaultFileOption,
  ): string {
    const dir = this.getHeapAnalysisLogDir(options);
    const file = path.join(dir, `analysis-${utils.getUniqueID()}-out.log`);
    if (!fs.existsSync(file)) {
      fs.createFileSync(file);
    }
    return file;
  }

  public getAndInitTSCompileIntermediateDir(): string {
    const dir = path.join(this.getTmpDir(), 'memlab-code');
    this.rmDir(dir);
    fs.mkdirpSync(dir);
    return dir;
  }

  public clearDataDirs(
    options: FileOption = FileManager.defaultFileOption,
  ): void {
    const curDataDir = this.getCurDataDir(options);
    if (!fs.existsSync(curDataDir)) {
      return;
    }
    this.emptyDirIfExists(this.getWebSourceDir(options));
    this.emptyDirIfExists(this.getDebugDataDir(options));
    const dataSuffix = ['.heapsnapshot', '.json', '.png'];
    const files = fs.readdirSync(curDataDir);
    for (const file of files) {
      inner: for (const suffix of dataSuffix) {
        if (file.endsWith(suffix)) {
          const filepath = path.join(curDataDir, file);
          fs.unlinkSync(filepath);
          break inner;
        }
      }
    }
  }

  public removeSnapshotFiles(
    options: FileOption = FileManager.defaultFileOption,
  ) {
    const curDataDir = this.getCurDataDir(options);
    if (!fs.existsSync(curDataDir)) {
      return;
    }
    const dataSuffix = ['.heapsnapshot'];
    const files = fs.readdirSync(curDataDir);
    for (const file of files) {
      inner: for (const suffix of dataSuffix) {
        if (file.endsWith(suffix)) {
          const filepath = path.join(curDataDir, file);
          fs.unlinkSync(filepath);
          break inner;
        }
      }
    }
  }

  public emptyDirIfExists(dir: string): void {
    if (this.isDirectory(dir)) {
      fs.emptyDirSync(dir);
    }
  }

  public emptyTraceLogDataDir(
    options: FileOption = FileManager.defaultFileOption,
  ): void {
    // all leak trace clusters
    this.emptyDirIfExists(this.getTraceClustersDir(options));
    // all JSON files for trace visualization
    this.emptyDirIfExists(this.getTraceJSONDir(options));
    // all unclassified clusters
    this.emptyDirIfExists(this.getUnclassifiedTraceClusterDir(options));
    // all unique cluster info
    this.emptyDirIfExists(this.getUniqueTraceClusterDir(options));
    // all heap analysis results
    this.emptyDirIfExists(this.getHeapAnalysisLogDir(options));
  }

  public resetBrowserDir(): void {
    try {
      const browserDir = this.getChromeBinaryDir();
      const browserBinary = this.getChromeBinaryZipFile();
      if (fs.existsSync(browserBinary)) {
        fs.unlinkSync(browserBinary);
      }
      this.rmDir(browserDir);
      joinAndProcessDir({}, browserDir);
    } catch (e) {
      info.error(utils.getError(e).message);
    }
  }

  public isDirectory(file: string): boolean {
    const stats = fs.statSync(file);
    return stats.isDirectory();
  }

  public iterateAllFiles(
    dir: string,
    callback: (filepath: string) => AnyValue,
  ): void {
    if (!this.isDirectory(dir)) {
      callback(dir);
      return;
    }
    const files = fs.readdirSync(dir);
    files.forEach((file: string) => {
      const filepath = path.join(dir, file);
      this.iterateAllFiles(filepath, callback);
    });
  }

  public rmWorkDir(options: FileOption = FileManager.defaultFileOption): void {
    try {
      this.rmDir(this.getWorkDir(options));
    } catch (e) {
      info.error(utils.getError(e).message);
    }
  }

  public isWithinInternalDirectory(filePath: string): boolean {
    const sep = path.sep;
    const internalDir = constant.internalDir;
    return filePath.includes(`${sep}${internalDir}${sep}`);
  }

  public initDirs(
    config: MemLabConfig,
    options: FileOption = FileManager.defaultFileOption,
  ): void {
    // cache the last processed memlab config instance
    // the instance should be a singleton
    this.memlabConfigCache = config;
    config.monoRepoDir = constant.monoRepoDir;

    // make sure getWorkDir is called first before
    // any other get file or get dir calls
    const workDir = this.getWorkDir(options);
    // if errorWhenAbsent is set to true, make it
    // an error when the working directory does not exist
    if (options.errorWhenAbsent && !fs.existsSync(workDir)) {
      throw utils.haltOrThrow(`work dir does not exist: ${workDir}`);
    }
    // remember the current working directory
    // especially if this is a transcient working directory
    config.workDir = joinAndProcessDir(options, workDir);
    options = {...options, workDir};

    config.dataBaseDir = joinAndProcessDir(
      options,
      this.getDataBaseDir(options),
    );
    config.browserDir = joinAndProcessDir(options, this.getChromeBinaryDir());

    config.userDataDir = joinAndProcessDir(
      options,
      this.getUserDataDir(options),
    );

    const outDir = joinAndProcessDir(options, this.getDataOutDir(options));
    config.curDataDir = joinAndProcessDir(options, this.getCurDataDir(options));
    config.webSourceDir = joinAndProcessDir(
      options,
      this.getWebSourceDir(options),
    );
    config.debugDataDir = joinAndProcessDir(
      options,
      this.getDebugDataDir(options),
    );
    config.dataBuilderDataDir = joinAndProcessDir(
      options,
      config.dataBaseDir,
      'dataBuilder',
    );
    config.persistentDataDir = joinAndProcessDir(
      options,
      this.getPersistDataDir(options),
    );

    // register the default log file
    config.consoleLogFile = path.join(config.curDataDir, 'console-log.txt');
    info.registerLogFile(config.consoleLogFile);

    config.runMetaFile = this.getRunMetaFile(options);
    config.snapshotSequenceFile = this.getSnapshotSequenceMetaFile(options);
    config.browserInfoSummary = path.join(
      config.curDataDir,
      'browser-info.txt',
    );
    config.exploreResultFile = this.getLeakSummaryFile(options);
    config.singleReportSummary = path.join(outDir, 'report.txt');
    config.unboundObjectCSV = path.join(outDir, 'unbound-object.csv');
    config.inputDataDir = joinAndProcessDir(options, this.getInputDataDir());

    config.reportOutDir = joinAndProcessDir(
      options,
      this.getReportOutDir(options),
    );
    config.previewReportDir = joinAndProcessDir(
      options,
      this.getPreviewReportDir(options),
    );
    config.viewJsonFile = path.join(config.reportOutDir, 'js', 'gc-path.js');
    config.cookieSettingFile = path.join(
      config.persistentDataDir,
      'cookie-setting.json',
    );
    config.traceClusterFile = path.join(
      config.persistentDataDir,
      'trace-cluster.json',
    );

    const loggerOutDir = joinAndProcessDir(
      options,
      this.getLoggerOutDir(options),
    );
    // trace cluster meta info
    config.traceClusterOutDir = joinAndProcessDir(
      options,
      this.getTraceClustersDir(options),
    );
    // detailed trace json files for visualization
    config.traceJsonOutDir = joinAndProcessDir(
      options,
      this.getTraceJSONDir(options),
    );
    // heap analysis results
    config.heapAnalysisLogDir = joinAndProcessDir(
      options,
      this.getHeapAnalysisLogDir(options),
    );
    config.metricsOutDir = joinAndProcessDir(options, loggerOutDir, 'metrics');
    config.reportScreenshotFile = path.join(outDir, 'report.png');

    const codeDataDir = this.getCodeDataDir();
    config.externalRunMetaFile = path.join(codeDataDir, 'run-meta.json');
    config.externalSnapshotVisitOrderFile = path.join(
      codeDataDir,
      'visit-order.json',
    );

    joinAndProcessDir(options, this.getUniqueTraceClusterDir(options));
    config.newUniqueClusterDir = joinAndProcessDir(
      options,
      this.getNewUniqueTraceClusterDir(options),
    );
    config.staleUniqueClusterDir = joinAndProcessDir(
      options,
      this.getStaleUniqueTraceClusterDir(options),
    );
    config.currentUniqueClusterDir = joinAndProcessDir(
      options,
      this.getExistingUniqueTraceClusterDir(options),
    );
    config.unclassifiedClusterDir = joinAndProcessDir(
      options,
      this.getUnclassifiedTraceClusterDir(options),
    );
    config.allClusterSummaryFile = this.getAllClusterSummaryFile(options);
  }
}

export default new FileManager();

/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */
import browserInfo from '../lib/BrowserInfo';
import config from '../lib/Config';
import info from '../lib/Console';
import serializer from '../lib/Serializer';
import utils from '../lib/Utils';
import NormalizedTrace from '../trace-cluster/TraceBucket';
import fs from 'fs';
import path from 'path';
import {promisify} from 'util';
import {
  E2EStepInfo,
  TraceCluster,
  TraceClusterDiff,
  TraceClusterMetaInfo,
} from '../lib/Types';
const readdir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);

class LeakClusterLogger {
  _fileIdx: number;
  constructor() {
    this._fileIdx = 0;
  }

  async _loadClustersData(dir: string): Promise<TraceClusterMetaInfo[]> {
    const files = await readdir(dir);
    return Promise.all(
      files.map(async (file: string) => {
        const p = path.join(dir, file);
        const content = await readFile(p, 'UTF-8');
        return JSON.parse(content);
      }),
    );
  }

  async loadClusters(dir: string): Promise<TraceCluster[]> {
    const data: TraceClusterMetaInfo[] = await this._loadClustersData(dir);
    return data.map((info: TraceClusterMetaInfo) => {
      const meta = JSON.parse(info.meta_data);
      const traceRecord = meta.trace_record;
      return {
        id: info.cluster_id,
        path: NormalizedTrace.traceToPath(traceRecord),
        clusterMetaInfo: info,
      };
    });
  }

  async dumpReadableCluster(options: {metaFile?: string} = {}): Promise<void> {
    const metaFile = options.metaFile;
    if (!metaFile || !fs.existsSync(metaFile)) {
      throw utils.haltOrThrow(`File doesn't exist: ${metaFile}`);
    }
    const meta: TraceClusterMetaInfo = await this.loadClusterMeta(metaFile);
    info.topLevel(`\nApp: ${meta.app}, Interaction: ${meta.interaction}`);
    info.lowLevel(`Created on: ${new Date(meta.creation_time * 1000)}`);
    info.topLevel(`\nTest interactions: ${meta.interaction_summary}`);
    info.topLevel(`\nLeak trace:`);
    info.topLevel(meta.leak_trace_summary);
  }

  async loadClusterMeta(file: string): Promise<TraceClusterMetaInfo> {
    const content = await readFile(file, 'UTF-8');
    return JSON.parse(content);
  }

  logUnclassifiedClusters(clusters: TraceCluster[]): void {
    const tabsOrder = utils.loadTabsOrder();
    const interactSummary = serializer.summarizeTabsOrder(tabsOrder);
    const interactionVector: string[] = tabsOrder.map(tab => tab.name);
    for (const cluster of clusters) {
      this._logSingleUnClassifiedCluster(
        tabsOrder,
        cluster,
        interactSummary,
        interactionVector,
      );
    }
  }

  logClusters(
    clusters: TraceCluster[],
    options: {clusterDiff?: TraceClusterDiff} = {},
  ): void {
    this._saveClusterSummary(clusters);

    if (config.useExternalSnapshot) {
      return;
    }
    const tabsOrder = utils.loadTabsOrder();
    const interactSummary = serializer.summarizeTabsOrder(tabsOrder);
    const interactionVector: string[] = tabsOrder.map(tab => tab.name);
    for (const cluster of clusters) {
      this._logCluster(tabsOrder, cluster, interactSummary, interactionVector);
    }

    // manage unique clusters
    if (!options.clusterDiff) {
      return;
    }
    this.logClusterDiff(options.clusterDiff);
  }

  logAllClusters(clusters: TraceCluster[][]): void {
    const file = config.allClusterSummaryFile;
    let content = '';
    for (let i = 0; i < clusters.length; ++i) {
      content += `--------- cluster ${i + 1} ---------\n\n`;
      for (let j = 0; j < clusters[i].length; ++j) {
        const cluster = clusters[i][j];
        content += `cluster: ${cluster.id}\n\n`;
        let traceSummary: string;
        if (cluster.clusterMetaInfo) {
          traceSummary = cluster.clusterMetaInfo.leak_trace_summary;
        } else {
          const trace = new NormalizedTrace(cluster.path, cluster.snapshot);
          traceSummary = trace.getTraceSummary();
        }
        content += traceSummary + '\n\n';
      }
    }
    fs.writeFileSync(file, content, 'UTF-8');
  }

  logClusterDiff(clusterDiff: TraceClusterDiff): void {
    const staleClusters = clusterDiff.staleClusters || [];
    for (const cluster of staleClusters) {
      this._logStaleCluster(cluster);
    }
    const clustersToAdd = clusterDiff.clustersToAdd || [];
    for (const cluster of clustersToAdd) {
      this._logClusterToAdd(cluster);
    }
    this.logAllClusters(clusterDiff.allClusters);
  }

  _logStaleCluster(cluster: TraceCluster): void {
    const info = {
      cluster_id: cluster.id,
    };
    const file = path.join(
      config.staleUniqueClusterDir,
      `cluster-${cluster.id}.json`,
    );
    fs.writeFileSync(file, JSON.stringify(info, null, 2), 'UTF-8');
  }

  _logClusterToAdd(cluster: TraceCluster) {
    const tabsOrder = utils.loadTabsOrder();
    const interactSummary = serializer.summarizeTabsOrder(tabsOrder);
    const interactionVector = tabsOrder.map(tab => tab.name);
    const nodeId = utils.getLastNodeId(cluster.path);
    const filepath = path.join(config.newUniqueClusterDir, `@${nodeId}.json`);
    this._logCluster(tabsOrder, cluster, interactSummary, interactionVector, {
      filepath,
    });
  }

  _saveClusterSummary(clusters: TraceCluster[]) {
    // log cluster summary to a readable file
    fs.appendFileSync(
      config.exploreResultFile,
      `\n------${clusters.length} clusters------\n`,
      'UTF-8',
    );
    const opt = {color: !config.isContinuousTest};
    for (const cluster of clusters) {
      const size = utils.getReadableBytes(cluster.retainedSize);
      const stat =
        `\n--Similar leaks in this run: ${cluster.count}--` +
        `\n--Retained size of leaked objects: ${size}--\n`;
      const {path, snapshot} = cluster;
      if (snapshot) {
        // print trace in terminal
        let trace = serializer.summarizePath(path, new Set(), snapshot, opt);
        info.topLevel(stat + trace);
        // dump plain text train in files
        trace = serializer.summarizePath(path, new Set(), snapshot);
        fs.appendFileSync(config.exploreResultFile, stat + trace, 'UTF-8');
      }
    }
  }

  _logCluster(
    tabsOrder: E2EStepInfo[],
    cluster: TraceCluster,
    interactSummary: string,
    interactionVector: string[],
    options: {filepath?: string} = {},
  ) {
    const file = options.filepath || this._getTraceFilePath(cluster);
    const trace = new NormalizedTrace(cluster.path, cluster.snapshot);
    const info: TraceClusterMetaInfo = {
      cluster_id: cluster.id || 0,
      creation_time: Date.now(),
      app: config.targetApp,
      interaction: config.targetTab,
      num_duplicates: cluster.count,
      retained_size: cluster.retainedSize,
      interaction_summary: interactSummary,
      leak_trace_summary: trace.getTraceSummary(),
      interaction_vector: interactionVector,
      meta_data: JSON.stringify({
        browser_info: browserInfo,
        visit_plan: tabsOrder,
        trace_record: NormalizedTrace.pathToTrace(cluster.path),
      }),
    };
    fs.writeFileSync(file, JSON.stringify(info, null, 2), 'UTF-8');
  }

  _getTraceFilePath(cluster: TraceCluster): string {
    const filename = `@${utils.getLastNodeId(cluster.path)}.json`;
    return path.join(config.traceClusterOutDir, filename);
  }

  _logSingleUnClassifiedCluster(
    tabsOrder: E2EStepInfo[],
    cluster: TraceCluster,
    interactSummary: string,
    interactionVector: string[],
    options: {filepath?: string} = {},
  ) {
    const file =
      options.filepath || this._getUnclassifiedTraceFilePath(cluster);
    const trace = new NormalizedTrace(cluster.path, cluster.snapshot);
    const info: TraceClusterMetaInfo = {
      cluster_id: cluster.id ?? 0,
      creation_time: Date.now(),
      app: config.targetApp,
      interaction: config.targetTab,
      num_duplicates: cluster.count,
      retained_size: cluster.retainedSize,
      interaction_summary: interactSummary,
      leak_trace_summary: trace.getTraceSummary(),
      interaction_vector: interactionVector,
      meta_data: JSON.stringify({
        browser_info: browserInfo,
        visit_plan: tabsOrder,
        trace_record: NormalizedTrace.pathToTrace(cluster.path),
      }),
    };
    fs.writeFileSync(file, JSON.stringify(info, null, 2), 'UTF-8');
  }

  _getUnclassifiedTraceFilePath(cluster: TraceCluster): string {
    const filename = `@${utils.getLastNodeId(cluster.path)}.json`;
    return path.join(config.unclassifiedClusterDir, filename);
  }
}

export default new LeakClusterLogger();

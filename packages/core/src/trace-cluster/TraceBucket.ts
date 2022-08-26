/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {
  IHeapNode,
  IHeapSnapshot,
  LeakTrace,
  LeakTracePathItem,
  TraceDiff,
  Optional,
  TraceCluster,
  TraceClusterDiff,
  IClusterStrategy,
} from '../lib/Types';
import type {NormalizedTraceElement} from './TraceElement';

import fs from 'fs';
import config from '../lib/Config';
import info from '../lib/Console';
import serializer from '../lib/Serializer';
import utils from '../lib/Utils';
import {EdgeRecord, NodeRecord} from './TraceElement';
import TraceSimilarityStrategy from './strategies/TraceSimilarityStrategy';
import TraceAsClusterStrategy from './strategies/TraceAsClusterStrategy';
import MLTraceSimilarityStrategy from './strategies/MLTraceSimilarityStrategy';

type AggregateNodeCb = (
  ids: Set<number>,
  snapshot: IHeapSnapshot,
  checkCb: (node: IHeapNode) => boolean,
  calculateCb: (node: IHeapNode) => number,
) => number;

// sync up with html/intern/js/webspeed/memlab/lib/LeakCluster.js

export default class NormalizedTrace {
  private trace: NormalizedTraceElement[];
  private traceSummary: string;
  constructor(
    p: LeakTracePathItem | null = null,
    snapshot: IHeapSnapshot | null = null,
  ) {
    if (!p) {
      this.trace = [];
      this.traceSummary = '';
    } else {
      this.trace = NormalizedTrace.pathToTrace(p, {
        untilFirstDetachedDOMElem: true,
      });
      this.traceSummary = snapshot
        ? serializer.summarizePath(p, new Set(), snapshot)
        : '';
    }
  }

  // convert path to leak trace
  static pathToTrace(
    p: LeakTracePathItem,
    options: {
      untilFirstDetachedDOMElem?: boolean;
    } = {},
  ): NormalizedTraceElement[] {
    const skipRest = !!options.untilFirstDetachedDOMElem;
    const shouldSkip = (node: IHeapNode) => {
      // only consider the trace from GC root to the first detached element
      // NOTE: do not use utils.isDetachedDOMNode, which relies on
      //       the fact that p.node is a HeapNode
      return (
        skipRest &&
        node.name.startsWith('Detached ') &&
        node.name !== 'Detached InternalNode'
      );
    };
    const trace = [];
    let curItem: Optional<LeakTracePathItem> = p;
    while (curItem) {
      if (curItem.node) {
        trace.push(new NodeRecord(curItem.node));
        if (shouldSkip(curItem.node)) {
          break;
        }
      }
      if (curItem.edge) {
        trace.push(new EdgeRecord(curItem.edge));
      }
      curItem = curItem.next;
    }
    return trace;
  }

  // convert leak trace to path
  static traceToPath(trace: Optional<LeakTrace>): LeakTracePathItem {
    if (!trace) {
      return {};
    }
    let p: LeakTracePathItem = {};
    for (let i = trace.length - 1; i >= 0; --i) {
      const item = trace[i];
      if (item.kind === 'edge') {
        p.edge = item as EdgeRecord;
      }
      if (item.kind === 'node') {
        p.node = item as NodeRecord;
        p = {next: p};
      }
    }
    return p.next || {};
  }

  getTraceSummary(): string {
    return this.traceSummary;
  }

  static addLeakedNodeToCluster(
    cluster: TraceCluster,
    path: LeakTracePathItem,
  ): void {
    const leakedNode = utils.getLeakedNode(path);
    if (!cluster.leakedNodeIds) {
      cluster.leakedNodeIds = new Set();
    }
    if (leakedNode) {
      cluster.leakedNodeIds.add(leakedNode.id);
    }
  }

  static calculateClusterRetainedSize(
    cluster: TraceCluster,
    snapshot: IHeapSnapshot,
    aggregateDominatorMetrics: AggregateNodeCb,
  ): number {
    if (!cluster.leakedNodeIds) {
      return 0;
    }
    return (cluster.retainedSize = aggregateDominatorMetrics(
      cluster.leakedNodeIds,
      snapshot,
      () => true,
      (node: IHeapNode) => node.retainedSize,
    ));
  }

  static samplePaths(paths: LeakTracePathItem[]): LeakTracePathItem[] {
    const maxCount = 5000;
    const sampleRatio = Math.min(1, maxCount / paths.length);
    if (sampleRatio < 1) {
      info.warning('Sampling trace due to a large number of traces:');
      info.lowLevel(` Number of Traces: ${paths.length}`);
      info.lowLevel(
        ` Sampling Ratio:   ${utils.getReadablePercent(sampleRatio)}`,
      );
    }
    const ret = [];
    for (const p of paths) {
      if (Math.random() < sampleRatio) {
        ret.push(p);
      }
    }
    return ret;
  }

  private static diffTraces(
    newTraces: LeakTrace[],
    existingTraces: LeakTrace[], // existing representative traces
    option: {strategy?: IClusterStrategy} = {},
  ): TraceDiff {
    const strategy =
      option.strategy ??
      config.clusterStrategy ??
      new TraceSimilarityStrategy();
    return strategy.diffTraces(newTraces, existingTraces);
  }

  static diffClusters(
    newClusters: TraceCluster[],
    existingClusters: TraceCluster[],
  ): TraceClusterDiff {
    info.overwrite('Diffing clusters');

    // build trace to cluster map
    const traceToClusterMap = new Map();
    const newTraces: LeakTrace[] = [];
    const convertOption = {untilFirstDetachedDOMElem: true};
    for (const cluster of newClusters) {
      const trace = NormalizedTrace.pathToTrace(cluster.path, convertOption);
      newTraces.push(trace);
      traceToClusterMap.set(trace, cluster);
    }
    const existingTraces: LeakTrace[] = [];
    for (const cluster of existingClusters) {
      const trace = NormalizedTrace.pathToTrace(cluster.path, convertOption);
      existingTraces.push(trace);
      traceToClusterMap.set(trace, cluster);
    }

    // differing representative traces in existing clusters vs new traces
    // and calculate which representative traces are stale
    // and which new traces should form new clusters
    const traceDiff = NormalizedTrace.diffTraces(newTraces, existingTraces);
    const {staleClusters, clustersToAdd, allClusters} = traceDiff;

    // map trace to cluster
    const traceToCluster = (trace: LeakTrace) => {
      if (!traceToClusterMap.has(trace)) {
        throw utils.haltOrThrow('trace to cluster mapping failed');
      }
      return traceToClusterMap.get(trace);
    };

    return {
      staleClusters: staleClusters.map(traceToCluster),
      clustersToAdd: clustersToAdd.map(traceToCluster),
      allClusters: allClusters.map(cluster => cluster.map(traceToCluster)),
    };
  }

  static clusterLeakTraces(leakTraces: LeakTrace[]): Record<string, string> {
    const {allClusters} = NormalizedTrace.diffTraces(leakTraces, [], {
      strategy: config.isMLClustering
        ? new MLTraceSimilarityStrategy()
        : undefined,
    });

    return NormalizedTrace.clusteredLeakTracesToRecord(allClusters);
  }

  static clusteredLeakTracesToRecord(
    allClusters: LeakTrace[][],
  ): Record<string, string> {
    const lastNodeFromTrace = (trace: LeakTrace) => trace[trace.length - 1];

    const labaledLeakTraces = allClusters.reduce<Record<string, string>>(
      (acc, bucket) => {
        const lastNodeFromFirstTrace = lastNodeFromTrace(bucket[0]);
        bucket.map(lastNodeFromTrace).forEach(lastNodeInTrace => {
          if (lastNodeInTrace.id == null || lastNodeFromFirstTrace.id == null) {
            throw new Error('node id not found in last node of the leak trace');
          }
          acc[lastNodeInTrace.id] = String(lastNodeFromFirstTrace.id);
        });
        return acc;
      },
      {},
    );
    return labaledLeakTraces;
  }

  static filterClusters(clusters: TraceCluster[]): TraceCluster[] {
    if (config.clusterRetainedSizeThreshold <= 0) {
      return clusters;
    }
    return clusters.filter(
      cluster =>
        (cluster.retainedSize ?? Infinity) >
        config.clusterRetainedSizeThreshold,
    );
  }

  static clusterPaths(
    paths: LeakTracePathItem[],
    snapshot: IHeapSnapshot,
    aggregateDominatorMetrics: AggregateNodeCb,
    option: {strategy?: IClusterStrategy} = {},
  ): TraceCluster[] {
    info.overwrite('Clustering leak traces');
    if (paths.length === 0) {
      info.midLevel('No leaks found');
      return [];
    }
    // sample paths if there are too many
    paths = this.samplePaths(paths);

    // build trace to path map
    const traceToPathMap = new Map();
    const traces = [];
    for (const p of paths) {
      const trace = NormalizedTrace.pathToTrace(p, {
        untilFirstDetachedDOMElem: true,
      });
      traceToPathMap.set(trace, p);
      traces.push(trace);
    }
    // cluster traces
    const {allClusters} = NormalizedTrace.diffTraces(traces, [], option);
    // construct TraceCluster from clustering result
    let clusters: TraceCluster[] = allClusters.map((traces: LeakTrace[]) => {
      const cluster = {
        path: traceToPathMap.get(traces[0]),
        count: traces.length,
        snapshot,
        retainedSize: 0,
      };
      traces.forEach((trace: LeakTrace) => {
        NormalizedTrace.addLeakedNodeToCluster(
          cluster,
          traceToPathMap.get(trace),
        );
      });
      this.calculateClusterRetainedSize(
        cluster,
        snapshot,
        aggregateDominatorMetrics,
      );
      return cluster;
    });
    clusters = NormalizedTrace.filterClusters(clusters);
    clusters.sort((c1, c2) => (c2.retainedSize ?? 0) - (c1.retainedSize ?? 0));

    info.midLevel(`MemLab found ${clusters.length} leak(s)`);
    return clusters;
  }

  static generateUnClassifiedClusters(
    paths: LeakTracePathItem[],
    snapshot: IHeapSnapshot,
    aggregateDominatorMetrics: AggregateNodeCb,
  ): TraceCluster[] {
    return this.clusterPaths(paths, snapshot, aggregateDominatorMetrics, {
      strategy: new TraceAsClusterStrategy(),
    });
  }

  static loadCluster(): NormalizedTrace[] {
    let ret = [] as NormalizedTrace[];
    const file = config.traceClusterFile;
    if (!fs.existsSync(file)) {
      return ret;
    }
    try {
      const content = fs.readFileSync(file, 'UTF-8');
      ret = JSON.parse(content);
    } catch (ex) {
      throw utils.haltOrThrow(utils.getError(ex));
    }
    return ret;
  }

  static saveCluster(clusters: NormalizedTrace[]): void {
    const file = config.traceClusterFile;
    const content = JSON.stringify(clusters, null, 2);
    fs.writeFileSync(file, content, 'UTF-8');
  }
}

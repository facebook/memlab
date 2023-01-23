/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
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
  ControlTreatmentClusterResult,
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
import {lastNodeFromTrace} from './ClusterUtils';

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

  static getPathLastNode(
    p: LeakTracePathItem,
    options: {
      untilFirstDetachedDOMElem?: boolean;
    } = {},
  ): Optional<IHeapNode> {
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
    let curItem: Optional<LeakTracePathItem> = p;
    while (curItem.next) {
      if (curItem.node) {
        if (shouldSkip(curItem.node)) {
          break;
        }
      }
      curItem = curItem.next;
    }
    return curItem?.node;
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

  static getSamplePathMaxLength(paths: LeakTracePathItem[]): number {
    const lengthArr = paths.map(p => utils.getLeakTracePathLength(p));
    return Math.max(30, utils.getNumberAtPercentile(lengthArr, 80));
  }

  static samplePaths(paths: LeakTracePathItem[]): LeakTracePathItem[] {
    const maxCount = 5000;
    if (paths.length <= maxCount) {
      return [...paths];
    }
    const sampleRatio = Math.min(1, maxCount / paths.length);
    if (sampleRatio < 1) {
      info.warning('Sampling trace due to a large number of traces:');
      info.lowLevel(` Number of Traces: ${paths.length}`);
      info.lowLevel(
        ` Sampling Ratio: ${utils.getReadablePercent(sampleRatio)}`,
      );
    }
    const ret = [];
    const samplePathMaxLength = NormalizedTrace.getSamplePathMaxLength(paths);
    if (config.verbose) {
      info.lowLevel(` Sample Trace's Max Length: ${samplePathMaxLength}`);
    }
    for (const p of paths) {
      if (utils.getLeakTracePathLength(p) > samplePathMaxLength) {
        continue;
      }
      if (Math.random() < sampleRatio) {
        ret.push(p);
      } else {
        // force sample objects with non-trvial self size
        const lastNode = NormalizedTrace.getPathLastNode(p);
        if (lastNode && lastNode.self_size >= 100000) {
          ret.push(p);
        }
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
      const representativeTrace = traces[0];
      const cluster: TraceCluster = {
        path: traceToPathMap.get(representativeTrace),
        count: traces.length,
        snapshot,
        retainedSize: 0,
      };
      // add representative object id if there is one
      const lastNode = representativeTrace[representativeTrace.length - 1];
      if ('id' in lastNode) {
        cluster.id = lastNode.id;
      }
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
    return clusters;
  }

  private static buildTraceToPathMap(
    paths: LeakTracePathItem[],
  ): Map<NormalizedTraceElement[], LeakTracePathItem> {
    const traceToPathMap = new Map();
    for (const p of paths) {
      const trace = NormalizedTrace.pathToTrace(p, {
        untilFirstDetachedDOMElem: true,
      });
      traceToPathMap.set(trace, p);
    }
    return traceToPathMap;
  }

  private static pushLeakPathToCluster(
    traceToPathMap: Map<NormalizedTraceElement[], LeakTracePathItem>,
    trace: NormalizedTraceElement[],
    cluster: TraceCluster,
  ): void {
    // if this is a control path, update control cluster
    const curPath = traceToPathMap.get(trace) as LeakTracePathItem;
    if ((cluster.count as number) === 0) {
      cluster.path = curPath;
      // add representative object id if there is one
      const lastNode = trace[trace.length - 1];
      if ('id' in lastNode) {
        cluster.id = lastNode.id;
      }
    }
    cluster.count = (cluster.count as number) + 1;
    NormalizedTrace.addLeakedNodeToCluster(cluster, curPath);
  }

  private static initEmptyCluster(snapshot: IHeapSnapshot): TraceCluster {
    return {
      path: {} as LeakTracePathItem,
      count: 0,
      snapshot,
      retainedSize: 0,
      leakedNodeIds: new Set<number>(),
    };
  }

  static clusterControlTreatmentPaths(
    controlPaths: LeakTracePathItem[],
    controlSnapshot: IHeapSnapshot,
    treatmentPaths: LeakTracePathItem[],
    treatmentSnapshot: IHeapSnapshot,
    aggregateDominatorMetrics: AggregateNodeCb,
    option: {strategy?: IClusterStrategy} = {},
  ): ControlTreatmentClusterResult {
    const result: ControlTreatmentClusterResult = {
      controlOnlyClusters: [],
      treatmentOnlyClusters: [],
      hybridClusters: [],
    };
    info.overwrite('Clustering leak traces');
    if (controlPaths.length === 0 && treatmentPaths.length === 0) {
      info.midLevel('No leaks found');
      return result;
    }
    // sample paths if there are too many
    controlPaths = this.samplePaths(controlPaths);
    treatmentPaths = this.samplePaths(treatmentPaths);

    // build control trace to control path map
    const controlTraceToPathMap =
      NormalizedTrace.buildTraceToPathMap(controlPaths);
    const controlTraces = Array.from(controlTraceToPathMap.keys());
    // build treatment trace to treatment path map
    const treatmentTraceToPathMap =
      NormalizedTrace.buildTraceToPathMap(treatmentPaths);
    const treatmentTraces = Array.from(treatmentTraceToPathMap.keys());

    // cluster traces from both the control group and the treatment group
    const {allClusters} = NormalizedTrace.diffTraces(
      [...controlTraces, ...treatmentTraces],
      [],
      option,
    );

    // construct TraceCluster from clustering result
    allClusters.forEach((traces: LeakTrace[]) => {
      const controlCluster = NormalizedTrace.initEmptyCluster(controlSnapshot);
      const treatmentCluster =
        NormalizedTrace.initEmptyCluster(treatmentSnapshot);
      for (const trace of traces) {
        const normalizedTrace = trace as NormalizedTraceElement[];
        if (controlTraceToPathMap.has(normalizedTrace)) {
          NormalizedTrace.pushLeakPathToCluster(
            controlTraceToPathMap,
            normalizedTrace,
            controlCluster,
          );
        } else {
          NormalizedTrace.pushLeakPathToCluster(
            treatmentTraceToPathMap,
            normalizedTrace,
            treatmentCluster,
          );
        }
      }
      const controlClusterSize = controlCluster.count ?? 0;
      const treatmentClusterSize = treatmentCluster.count ?? 0;
      // calculate aggregated cluster size for control cluster
      if (controlClusterSize > 0) {
        this.calculateClusterRetainedSize(
          controlCluster,
          controlSnapshot,
          aggregateDominatorMetrics,
        );
      }
      // calculate aggregated cluster size for treatment cluster
      if (treatmentClusterSize > 0) {
        this.calculateClusterRetainedSize(
          treatmentCluster,
          treatmentSnapshot,
          aggregateDominatorMetrics,
        );
      }
      if (controlClusterSize === 0) {
        result.treatmentOnlyClusters.push(treatmentCluster);
      } else if (treatmentClusterSize === 0) {
        result.controlOnlyClusters.push(controlCluster);
      } else {
        result.hybridClusters.push({
          control: controlCluster,
          treatment: treatmentCluster,
        });
      }
    });
    result.treatmentOnlyClusters.sort(
      (c1, c2) => (c2.retainedSize ?? 0) - (c1.retainedSize ?? 0),
    );
    result.controlOnlyClusters.sort(
      (c1, c2) => (c2.retainedSize ?? 0) - (c1.retainedSize ?? 0),
    );
    result.hybridClusters.sort(
      (g1, g2) =>
        (g2.control.retainedSize ?? 0) +
        (g2.treatment.retainedSize ?? 0) -
        (g1.control.retainedSize ?? 0) -
        (g1.treatment.retainedSize ?? 0),
    );
    return result;
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

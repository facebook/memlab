/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */

'use strict';
import type {
  EdgeIterationCallback,
  IHeapEdge,
  IHeapLocation,
  IHeapNode,
  IHeapSnapshot,
  LeakTracePathItem,
  MemLabTraceElementTypeWithID,
  Nullable,
  TraceCluster,
  TraceClusterDiff,
} from '../lib/Types';

import config from '../lib/Config';
import info from '../lib/Console';
import serializer from '../lib/Serializer';
import utils from '../lib/Utils';
import ClusterUtils from './ClusterUtils';
import fs from 'fs';

type AggregateNodeCb = (
  ids: Set<number>,
  snapshot: IHeapSnapshot,
  checkCb: (node: IHeapNode) => boolean,
  calculateCb: (node: IHeapNode) => number,
) => number;

// sync up with html/intern/js/webspeed/memlab/lib/LeakCluster.js
export class NodeRecord implements IHeapNode {
  kind: string;
  name: string;
  type: string;
  id: number;
  is_detached: boolean;
  detachState: number;
  attributes: number;
  self_size: number;
  edge_count: number;
  trace_node_id: number;
  nodeIndex: number;
  retainedSize: number;
  highlight?: boolean;

  markAsDetached(): void {
    throw new Error('NodeRecord.markAsDetached not callable.');
  }
  set snapshot(s: IHeapSnapshot) {
    throw new Error('NodeRecord.snapshot cannot be assigned.');
  }
  get snapshot(): IHeapSnapshot {
    throw new Error('NodeRecord.snapshot cannot be read.');
  }
  set references(r: IHeapEdge[]) {
    throw new Error('NodeRecord.references cannot be assigned');
  }
  get references(): IHeapEdge[] {
    throw new Error('NodeRecord.references cannot be read');
  }
  forEachReference(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _callback: EdgeIterationCallback,
  ): void {
    throw new Error('NodeRecord.forEachReference is not implemented');
  }
  set referrers(r: IHeapEdge[]) {
    throw new Error('NodeRecord.referrers cannot be assigned');
  }
  get referrers(): IHeapEdge[] {
    throw new Error('NodeRecord.referrers cannot be read');
  }
  forEachReferrer(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _callback: EdgeIterationCallback,
  ): void {
    throw new Error('NodeRecord.forEachReferrer is not implemented');
  }
  findReference(): Nullable<IHeapEdge> {
    throw new Error('NodeRecord.findReference is not implemented');
  }
  findReferrer(): Nullable<IHeapEdge> {
    throw new Error('NodeRecord.findReferrer is not implemented');
  }
  set pathEdge(r: IHeapEdge) {
    throw new Error('NodeRecord.pathEdge cannot be assigned');
  }
  get pathEdge(): IHeapEdge {
    throw new Error('NodeRecord.pathEdge cannot be read');
  }
  set dominatorNode(r: IHeapNode) {
    throw new Error('NodeRecord.pathEdge cannot be assigned');
  }
  get dominatorNode(): IHeapNode {
    throw new Error('NodeRecord.pathEdge cannot be read');
  }
  set location(r: IHeapLocation) {
    throw new Error('NodeRecord.location cannot be assigned');
  }
  get location(): IHeapLocation {
    throw new Error('NodeRecord.location cannot be read');
  }

  constructor(node: IHeapNode) {
    this.kind = 'node';
    this.name = this.extraceNodeName(node);
    this.type = node.type;
    this.id = node.id;
    this.is_detached = node.is_detached;
    this.detachState = node.detachState;
    this.attributes = node.attributes;
    this.self_size = node.self_size;
    this.edge_count = node.edge_count;
    this.trace_node_id = node.trace_node_id;
    this.nodeIndex = node.nodeIndex;
    this.retainedSize = node.retainedSize;
    this.highlight = node.highlight;
  }

  private extraceNodeName(node: IHeapNode): string {
    // deserialized node may not have snapshot info
    if (!node.snapshot || !utils.isFiberNode(node)) {
      return node.name;
    }
    return utils.extractFiberNodeInfo(node);
  }
}

export class EdgeRecord implements IHeapEdge {
  kind: string;
  name_or_index: string | number;
  type: string;
  edgeIndex: number;
  is_index: boolean;
  to_node: number;

  constructor(edge: IHeapEdge) {
    this.kind = 'edge';
    this.name_or_index = edge.name_or_index;
    this.type = edge.type;
    this.edgeIndex = edge.edgeIndex;
    this.is_index = edge.is_index;
    this.to_node = edge.to_node;
  }

  set snapshot(s: IHeapSnapshot) {
    throw new Error('EdgeRecord.snapshot cannot be assigned.');
  }
  get snapshot(): IHeapSnapshot {
    throw new Error('EdgeRecord.snapshot cannot be read.');
  }
  set toNode(s: IHeapNode) {
    throw new Error('EdgeRecord.toNode cannot be assigned.');
  }
  get toNode(): IHeapNode {
    throw new Error('EdgeRecord.toNode cannot be read.');
  }
  set fromNode(s: IHeapNode) {
    throw new Error('EdgeRecord.fromNode cannot be assigned.');
  }
  get fromNode(): IHeapNode {
    throw new Error('EdgeRecord.fromNode cannot be read.');
  }
}

export type NormalizedTraceElement = NodeRecord | EdgeRecord;

export default class NormalizedTrace {
  trace: NormalizedTraceElement[];
  traceSummary: string;
  constructor(
    p: LeakTracePathItem | null = null,
    snapshot: IHeapSnapshot | null = null,
  ) {
    if (!p) {
      this.trace = [];
      this.traceSummary = '';
    } else {
      this.trace = this.normalizeTrace(p);
      this.traceSummary = snapshot
        ? serializer.summarizePath(p, new Set(), snapshot)
        : '';
    }
  }

  getSerializablePath(): NormalizedTraceElement[] {
    return this.trace;
  }

  static getCompleteSerializablePath(
    p: LeakTracePathItem,
  ): NormalizedTraceElement[] {
    const trace = [];
    if (!p) {
      return [];
    }
    let curItem: LeakTracePathItem | undefined = p;
    while (curItem) {
      if (curItem.node) {
        trace.push(new NodeRecord(curItem.node));
      }
      if (curItem.edge) {
        trace.push(new EdgeRecord(curItem.edge));
      }
      curItem = curItem.next;
    }
    return trace;
  }

  // reverse process of getCompleteSerializablePath
  static convertToPath(
    trace: NormalizedTraceElement[] | null,
  ): LeakTracePathItem {
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

  static aggregateRetainedSize(
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

  static diffClusters(
    newClusters: TraceCluster[],
    existingClusters: TraceCluster[],
  ): TraceClusterDiff {
    info.overwrite('Diffing clusters');

    // duplicated cluster to remove
    const staleClusters: TraceCluster[] = [];
    // new cluster to save
    const clustersToAdd: TraceCluster[] = [];
    // all clusters, with duplicated cluters in the same sub-array
    const clusters: TraceCluster[][] = [];

    // consolidating existing clusters
    if (existingClusters.length > 0) {
      clusters.push([existingClusters[0]]);
      outer: for (let i = 1; i < existingClusters.length; ++i) {
        const clusterToCheck = existingClusters[i];
        const path = clusterToCheck.path;
        for (let j = 0; j < clusters.length; ++j) {
          const cluster = clusters[j][0];
          const repPath = cluster.path;
          if (NormalizedTrace.isSimilarPaths(repPath, path)) {
            staleClusters.push(clusterToCheck);
            clusters[j].push(clusterToCheck);
            continue outer;
          }
        }
        clusters.push([clusterToCheck]);
      }
    }

    // checking new clusters
    outer: for (let i = 0; i < newClusters.length; ++i) {
      const clusterToCheck = newClusters[i];
      const path = clusterToCheck.path;
      for (let j = 0; j < clusters.length; ++j) {
        const cluster = clusters[j][0];
        const repPath = cluster.path;
        if (NormalizedTrace.isSimilarPaths(repPath, path)) {
          clusters[j].push(clusterToCheck);
          continue outer;
        }
      }
      clustersToAdd.push(clusterToCheck);
    }

    return {staleClusters, clustersToAdd, allClusters: clusters};
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

  static clusterLeakTraces(
    leakTraces: MemLabTraceElementTypeWithID[][],
  ): Record<string, string> {
    const buckets = [[leakTraces[0]]];
    outer: for (let i = 1; i < leakTraces.length; i++) {
      for (const bucket of buckets) {
        const trace = bucket[0];
        if (ClusterUtils.isSimilarTrace(trace, leakTraces[i])) {
          bucket.push(leakTraces[i]);
          continue outer;
        }
      }
      buckets.push([leakTraces[i]]);
    }

    const lastNodeFromTrace = (trace: MemLabTraceElementTypeWithID[]) =>
      trace[trace.length - 1];

    const labaledLeakTraces = buckets.reduce<Record<string, string>>(
      (acc, bucket) => {
        const lastNodeFromFirstTheTrace = lastNodeFromTrace(bucket[0]);
        bucket.map(lastNodeFromTrace).forEach(lastNodeInTheTrace => {
          acc[lastNodeInTheTrace.id] = String(lastNodeFromFirstTheTrace.id);
        });
        return acc;
      },
      {},
    );
    return labaledLeakTraces;
  }

  static clusterPaths(
    paths: LeakTracePathItem[],
    snapshot: IHeapSnapshot,
    aggregateDominatorMetrics: AggregateNodeCb,
  ): TraceCluster[] {
    info.overwrite('Clustering leak traces');
    const clusters: TraceCluster[] = [];
    if (paths.length === 0) {
      info.midLevel('No leaks found');
      return clusters;
    }

    // cluster the current instances
    const newCluster: TraceCluster = {
      path: paths[0],
      count: 1,
      snapshot,
    };
    this.aggregateRetainedSize(newCluster, paths[0]);
    clusters.push(newCluster);

    paths = this.samplePaths(paths);

    outer: for (let i = 1; i < paths.length; ++i) {
      info.overwrite(`clustering ${i}-th trace...`);
      const path = paths[i];
      for (const cluster of clusters) {
        cluster.count = cluster.count ?? 0;
        const repPath = cluster.path;
        if (NormalizedTrace.isSimilarPaths(repPath, path)) {
          cluster.count++;
          this.aggregateRetainedSize(cluster, path);
          continue outer;
        }
      }
      const newCluster = {path, count: 1, snapshot};
      this.aggregateRetainedSize(newCluster, path);
      clusters.push(newCluster);
    }

    for (const cluster of clusters) {
      this.calculateClusterRetainedSize(
        cluster,
        snapshot,
        aggregateDominatorMetrics,
      );
    }

    clusters.sort((c1, c2) => (c2.retainedSize ?? 0) - (c1.retainedSize ?? 0));

    // add to the persisttent storage if there is a new trace cluster
    const status = this.updateCluster(paths, snapshot);
    let msg = `MemLab found ${clusters.length} leak(s)`;
    if (config.verbose) {
      msg += `, ${status.newCluster} of which are new.`;
    }
    info.midLevel(msg);
    return clusters;
  }

  static generateUnClassifiedClusters(
    paths: LeakTracePathItem[],
    snapshot: IHeapSnapshot,
    aggregateDominatorMetrics: AggregateNodeCb,
  ): TraceCluster[] {
    info.overwrite('Clustering leak traces (unclassified)');
    const clusters: TraceCluster[] = [];
    if (paths.length === 0) {
      info.midLevel('No leaks found');
      return clusters;
    }

    // cluster the current instances
    const newCluster: TraceCluster = {
      path: paths[0],
      count: 1,
      snapshot,
    };
    this.aggregateRetainedSize(newCluster, paths[0]);
    clusters.push(newCluster);

    paths = this.samplePaths(paths);

    for (let i = 1; i < paths.length; ++i) {
      info.overwrite(`clustering trace [${i + 1}/${paths.length}]`);
      const path = paths[i];
      const newCluster = {path, count: 1, snapshot};
      this.aggregateRetainedSize(newCluster, path);
      clusters.push(newCluster);
    }

    for (const cluster of clusters) {
      this.calculateClusterRetainedSize(
        cluster,
        snapshot,
        aggregateDominatorMetrics,
      );
    }
    clusters.sort((c1, c2) => (c2.retainedSize ?? 0) - (c1.retainedSize ?? 0));
    return clusters;
  }

  static updateCluster(
    paths: LeakTracePathItem[],
    snapshot: IHeapSnapshot,
  ): {newCluster: number} {
    if (paths.length === 0) {
      return {newCluster: 0};
    }
    const persistCluster = NormalizedTrace.loadCluster();
    let newCluster = 0;
    if (persistCluster.length <= 0) {
      persistCluster.push(new NormalizedTrace(paths[0], snapshot));
      ++newCluster;
    }
    outer: for (const p of paths) {
      const trace = new NormalizedTrace(p);
      for (const repTrace of persistCluster) {
        if (NormalizedTrace.isSimilarNormalizedTrace(repTrace, trace)) {
          continue outer;
        }
      }
      persistCluster.push(new NormalizedTrace(p, snapshot));
      ++newCluster;
    }
    NormalizedTrace.saveCluster(persistCluster);
    return {newCluster};
  }

  static isSimilarNormalizedTrace(
    t1: NormalizedTrace,
    t2: NormalizedTrace,
  ): boolean {
    return ClusterUtils.isSimilarTrace(t1.trace, t2.trace);
  }

  static isSimilarPaths(p1: LeakTracePathItem, p2: LeakTracePathItem): boolean {
    const t1 = new NormalizedTrace(p1);
    const t2 = new NormalizedTrace(p2);
    return ClusterUtils.isSimilarTrace(t1.trace, t2.trace);
  }

  static loadCluster(): NormalizedTrace[] {
    const file = config.traceClusterFile;
    let ret = [];
    try {
      const content = fs.readFileSync(file, 'UTF-8');
      ret = JSON.parse(content);
    } catch {
      // nothing
    }
    return ret;
  }

  static saveCluster(clusters: NormalizedTrace[]): void {
    const file = config.traceClusterFile;
    const content = JSON.stringify(clusters, null, 2);
    fs.writeFileSync(file, content, 'UTF-8');
  }

  private normalizeTrace(p: LeakTracePathItem): NormalizedTraceElement[] {
    const trace = [];
    let curItem: LeakTracePathItem | undefined = p;
    while (curItem) {
      if (curItem.node) {
        trace.push(new NodeRecord(curItem.node));
        // only consider the trace from GC root to the first detached element
        // NOTE: do not use utils.isDetachedDOMNode, which relies on
        //       the fact that p.node is a HeapNode
        if (
          curItem.node.name.startsWith('Detached ') &&
          curItem.node.name !== 'Detached InternalNode'
        ) {
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
}

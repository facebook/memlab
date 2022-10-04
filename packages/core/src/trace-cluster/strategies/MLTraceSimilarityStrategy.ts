/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import config from '../../lib/Config';
import type {IClusterStrategy, LeakTrace, TraceDiff} from '../../lib/Types';
import {distance} from './machine-learning/DistanceMatrix';
import {cluster} from './machine-learning/HAC';
import {TfidfVectorizer} from './machine-learning/TfidfVectorizer';

export default class MLTraceSimilarityStrategy implements IClusterStrategy {
  public diffTraces(newLeakTraces: LeakTrace[]): TraceDiff {
    const rawDocuments = newLeakTraces.map(this.traceToDoc);
    const vectorizer = new TfidfVectorizer({rawDocuments});
    const tfidfs = vectorizer.computeTfidfs();
    const dmatrix = distance(tfidfs);
    const result = cluster(
      rawDocuments.length,
      dmatrix,
      config.mlClusteringLinkageMaxDistance,
    );
    const map = new Map<LeakTrace, LeakTrace[]>();
    for (let i = 0; i < result.length; i++) {
      const traceIdx = result[i];
      const repTrace = newLeakTraces[traceIdx];
      const trace = newLeakTraces[i];
      if (!map.has(repTrace)) {
        map.set(repTrace, [repTrace]);
      }
      // to please linter
      map.get(repTrace)?.push(trace);
    }

    return {
      allClusters: Array.from(map.values()),
      staleClusters: [],
      clustersToAdd: [],
    };
  }

  traceToDoc(trace: LeakTrace): string {
    const res: string[] = [];
    for (const t of trace) {
      let name = t.kind === 'node' ? String(t.name) : String(t.name_or_index);

      if (name === '') {
        name = '_null_';
      }
      name = name.replace(/ /g, '_');
      name = name.replace(/\d/g, '');
      if (name === '') {
        name = '_number_';
      }

      res.push(name);
    }
    return res.join(' ');
  }
}

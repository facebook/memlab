/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';

/**
 * Page, dedicated worker, service worker or shared worker, from the global
 * PROXY's name (`DedicatedWorkerGlobalScope / <url>`). Constructor and
 * prototype objects of every scope class exist in every realm, so a bare
 * class-name match is wrong.
 */
const REALM_GLOBAL_RE =
  /^(Window|DedicatedWorkerGlobalScope|ServiceWorkerGlobalScope|SharedWorkerGlobalScope) \/ /;
const REALM_KIND: Readonly<Record<string, string>> = {
  Window: 'page',
  DedicatedWorkerGlobalScope: 'dedicated worker',
  ServiceWorkerGlobalScope: 'service worker',
  SharedWorkerGlobalScope: 'shared worker',
};

export function realmKind(snapshot: IHeapSnapshot): string {
  let kind = 'unknown';
  snapshot.nodes.forEach((n: IHeapNode) => {
    const m = REALM_GLOBAL_RE.exec(n.name);
    if (m == null) return;
    kind = REALM_KIND[m[1]] ?? 'unknown';
    return false;
  });
  return kind;
}

/**
 * A worker's title from a capture filename (`worker_<title>_<id>.heapsnapshot`,
 * as memlab_capture and the hunt runner write them). Every worker of an app
 * often runs the same bootstrap URL, so the filename is the only place the
 * title survives.
 */
export function workerTitleFromFile(fileName: string): string | null {
  const m = /(?:^|[._])worker_(.+?)_[0-9A-Fa-f]{6,}\.heapsnapshot$/.exec(
    fileName,
  );
  return m != null ? m[1] : null;
}

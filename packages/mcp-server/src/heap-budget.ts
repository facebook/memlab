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
import {classifyArtifact} from './artifact-classes.js';
import type {ArtifactKind} from './artifact-classes.js';
import {
  collectDevRoots,
  computeReachableWithoutDevRoots,
  summarizeDevOnly,
} from './tools/dev-artifacts.js';
import type {DevOnlyTotals, DevRootCategory} from './tools/dev-artifacts.js';

/**
 * The one bucket split of a heap into "app" and the several distinct reasons a
 * byte might not be the app.
 *
 * Extracted so `memlab_app_heap` and `memlab_artifact_budget` cannot drift: they
 * are two views of the same partition, and two implementations of "what counts
 * as the app" that disagree by a few percent is worse than either one alone,
 * because the disagreement is invisible in each tool's own output.
 */

const CODE_TYPES: ReadonlySet<string> = new Set(['code']);

// The V8 structures that hold loaded code. These exist because the app was
// *loaded*, not because it did anything.
const BUNDLE_NAME_RE =
  /InstructionStream|BytecodeArray|SharedFunctionInfo|ScopeInfo|UncompiledData|FeedbackVector|FeedbackMetadata|FeedbackCell|ClosureFeedbackCellArray|\(constant pool\)|ConstantPool/;

const EXTERNAL_STRING_DATA = 'system / ExternalStringData';

/**
 * Node indexes of the external string data that backs a script's SOURCE.
 *
 * Only that is bundle text. An app can hold its own data in external strings
 * too (one measured app kept 1.3 MB of animation JSON in 12 of them), and
 * counting every `ExternalStringData` as bundle hid it from the app
 * total.
 */
export function scriptSourceStringData(snapshot: IHeapSnapshot): Set<number> {
  const out = new Set<number>();
  snapshot.nodes.forEach((node: IHeapNode) => {
    if (!node.name.startsWith('system / Script')) return;
    for (const e of node.references) {
      if (e.name_or_index !== 'source') continue;
      const src = e.toNode;
      out.add(src.nodeIndex);
      for (const e2 of src.references) {
        if (e2.toNode.name === EXTERNAL_STRING_DATA)
          out.add(e2.toNode.nodeIndex);
      }
    }
  });
  return out;
}

export interface HeapBudget {
  total: number;
  app: number;
  appNodes: number;
  bundle: number;
  code: number;
  devOnly: number;
  artifact: number;
  /** Known-artifact self bytes split by family (warmup / ax / cdp-* / …). */
  artifactByKind: Map<ArtifactKind, number>;
  /** Dev-only totals split by root family, or null when no dev roots exist. */
  devOnlyTotals: DevOnlyTotals | null;
}

export function computeHeapBudget(snapshot: IHeapSnapshot): HeapBudget {
  const devRoots = collectDevRoots(snapshot);
  const reached =
    devRoots.byId.size > 0
      ? computeReachableWithoutDevRoots(snapshot, devRoots)
      : null;

  let total = 0;
  let code = 0;
  let bundle = 0;
  let devOnly = 0;
  let artifact = 0;
  let app = 0;
  let appNodes = 0;
  const artifactByKind = new Map<ArtifactKind, number>();

  const isDevOnly = (node: IHeapNode): boolean =>
    reached != null && reached[node.nodeIndex] === 0;
  const scriptSource = scriptSourceStringData(snapshot);

  snapshot.nodes.forEach((node: IHeapNode) => {
    if (node.id <= 3) return;
    const size = node.self_size;
    total += size;
    // Precedence matters: a node is counted once, in the most specific bucket
    // that explains why it is NOT app memory.
    if (isDevOnly(node)) {
      devOnly += size;
      return;
    }
    if (CODE_TYPES.has(node.type)) {
      code += size;
      return;
    }
    if (
      BUNDLE_NAME_RE.test(node.name) ||
      (node.name === EXTERNAL_STRING_DATA && scriptSource.has(node.nodeIndex))
    ) {
      bundle += size;
      return;
    }
    const kind = classifyArtifact(node.name);
    if (kind != null) {
      artifact += size;
      artifactByKind.set(kind, (artifactByKind.get(kind) ?? 0) + size);
      return;
    }
    app += size;
    appNodes++;
  });

  return {
    total,
    app,
    appNodes,
    bundle,
    code,
    devOnly,
    artifact,
    artifactByKind,
    devOnlyTotals:
      reached != null ? summarizeDevOnly(snapshot, devRoots, reached) : null,
  };
}

export function devFamilyBytes(
  budget: HeapBudget,
): Array<{family: DevRootCategory; nodes: number; selfBytes: number}> {
  const out: Array<{
    family: DevRootCategory;
    nodes: number;
    selfBytes: number;
  }> = [];
  const byCategory = budget.devOnlyTotals?.byCategory;
  if (byCategory == null) return out;
  for (const [family, v] of byCategory) {
    out.push({family, nodes: v.nodes, selfBytes: v.selfBytes});
  }
  out.sort((a, b) => b.selfBytes - a.selfBytes);
  return out;
}

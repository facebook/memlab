/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapEdge, IHeapNode, IHeapSnapshot} from '@memlab/core';

/**
 * Dead captured variables: context slots that no code which can still run will
 * ever read.
 *
 * V8 allocates one Context per scope instance and puts every variable an inner
 * function captures into it. All closures created in that scope share the
 * Context, so a variable read by only ONE inner function stays alive as long as
 * ANY of them does. The classic case: a large object read by a callback that
 * already ran and was dropped, kept alive by a sibling closure that never
 * touches it.
 *
 * Since V8 15.6 a snapshot carries the source scope tree of every script:
 * which variables each scope puts in its context (`scope_context_vars`) and
 * which scopes read which slots (`scope_uses`). Joined with the closures and
 * suspended generators that exist in the heap, that says for each Context slot
 * whether any live code can still read it. A slot nothing live can read is
 * dead: its value is retained purely because it shares a Context with
 * something that is still alive.
 *
 * Inputs read from the heap graph (all present since V8 15.5):
 * - Context → `scope_info` → ScopeInfo, with `scope_id`, `outer_scope_info`,
 *   `start_position`, `end_position`, `function_name`;
 * - closure → `shared` → SharedFunctionInfo, with `scope_id`, `script`,
 *   `name_or_scope_info`, `raw_outer_scope_info_or_feedback_metadata`;
 * - Script → `infos` (its SharedFunctionInfos) and `eval_from_scope_info`;
 * - generator objects (found by their map's `instance_type_name`), with
 *   `continuation`, `function` and `context`.
 */

/** V8's scope id of a script's outermost (script, eval or module) scope. */
const ROOT_SCOPE_ID = -2;
/** V8's `JSGeneratorObject::kGeneratorClosed`. */
const GENERATOR_CLOSED = -1;
const GENERATOR_INSTANCE_TYPES = new Set([
  'JS_GENERATOR_OBJECT_TYPE',
  'JS_ASYNC_FUNCTION_OBJECT_TYPE',
  'JS_ASYNC_GENERATOR_OBJECT_TYPE',
]);

export interface DeadField {
  name: string;
  valueId: number;
  valueName: string;
  valueType: string;
  selfSize: number;
  retainedSize: number;
}

export interface DeadContext {
  contextId: number;
  retainedSize: number;
  deadRetainedSize: number;
  deadFields: DeadField[];
}

export interface DeadScope {
  scopeInfoId: number;
  scriptId: number;
  scriptName: string;
  scopeName: string;
  start: number;
  end: number;
  /** True for a script's outermost (script, eval or module) scope. */
  isRootScope: boolean;
  fieldCount: number;
  contexts: DeadContext[];
}

export interface ScriptWithoutScopes {
  scriptId: number;
  scriptName: string;
  contextCount: number;
}

export interface ContextAnalysis {
  /** False when the snapshot carries no scope tree at all (V8 < 15.6). */
  hasScopeMetadata: boolean;
  scopes: DeadScope[];
  /** Scripts that own contexts but have no scope tree in the snapshot. */
  scriptsWithoutScopes: ScriptWithoutScopes[];
  contextCount: number;
  liveClosureCount: number;
}

interface EmbeddedScope {
  scopeId: number;
  parent?: EmbeddedScope;
  variables: VariableDefinition[];
}

interface VariableDefinition {
  name: string;
  uses: EmbeddedScope[];
}

/** Scope ids are unique per script only, so key by script first. */
type ByScope<T> = Map<number, Map<number, T>>;

interface RawScopeSections {
  snapshot: {
    meta: Record<string, unknown>;
    node_count: number;
  };
  nodes: ArrayLike<number>;
  strings: string[];
  scopes?: ArrayLike<number>;
  scope_context_vars?: ArrayLike<number>;
  scope_uses?: ArrayLike<number>;
}

function rawOf(snapshot: IHeapSnapshot): RawScopeSections | null {
  const raw = (snapshot as unknown as {snapshot?: RawScopeSections}).snapshot;
  return raw?.snapshot?.meta != null ? raw : null;
}

/** Whether the snapshot carries V8's source scope tree. */
export function hasScopeMetadata(snapshot: IHeapSnapshot): boolean {
  const fields = rawOf(snapshot)?.snapshot.meta.scope_fields;
  return Array.isArray(fields) && fields.length > 0;
}

function internal(node: IHeapNode, name: string): IHeapNode | null {
  return node.getReferenceNode(name, 'internal');
}

/** V8 writes small ints as a shared `int` node whose `value` names the number. */
function intValue(node: IHeapNode | null): number | undefined {
  if (node == null || node.name !== 'int') return undefined;
  const value = internal(node, 'value');
  if (value == null) return undefined;
  const n = parseInt(value.name, 10);
  return Number.isNaN(n) ? undefined : n;
}

function intEdge(node: IHeapNode, name: string): number | undefined {
  return intValue(internal(node, name));
}

function isContext(node: IHeapNode): boolean {
  const name = node.name;
  return name === 'system / Context' || name.startsWith('system / Context / ');
}

function isScopeInfo(node: IHeapNode): boolean {
  return node.name === 'system / ScopeInfo';
}

function isRootScopeInfo(node: IHeapNode): boolean {
  return intEdge(node, 'scope_id') === ROOT_SCOPE_ID;
}

function parseScopes(snapshot: IHeapSnapshot): ByScope<EmbeddedScope> {
  const byScript: ByScope<EmbeddedScope> = new Map();
  const raw = rawOf(snapshot);
  if (raw == null) return byScript;
  const meta = raw.snapshot.meta;
  const scopeFields = (meta.scope_fields as string[] | undefined) ?? [];
  const varFields =
    (meta.scope_context_var_fields as string[] | undefined) ?? [];
  const useFields = (meta.scope_use_fields as string[] | undefined) ?? [];
  const scopeStride = scopeFields.length;
  if (scopeStride === 0) return byScript;
  const varStride = varFields.length;
  const useStride = useFields.length;
  const rawScopes = raw.scopes ?? [];
  const rawVars = raw.scope_context_vars ?? [];
  const rawUses = raw.scope_uses ?? [];
  const strings = raw.strings;

  const scriptOff = scopeFields.indexOf('script_node_index');
  const idOff = scopeFields.indexOf('scope_id');
  const depthOff = scopeFields.indexOf('depth');
  const varsOff = scopeFields.indexOf('scope_context_vars_count');
  const usesOff = scopeFields.indexOf('scope_uses_count');
  const nameOff = varFields.indexOf('name');
  const declOff = useFields.indexOf('declaring_scope_id');
  const slotOff = useFields.indexOf('slot_index');
  // `script_node_index` is an offset into the flat node array. Derive the
  // stride from the data rather than the meta, which a parser may annotate.
  const nodeStride =
    raw.snapshot.node_count > 0
      ? raw.nodes.length / raw.snapshot.node_count
      : ((meta.node_fields as string[] | undefined)?.length ?? 1);

  // Pass 1: scopes and their variables. `scopes` is a pre-order walk of each
  // script's scope tree, with the tree shape encoded by depth.
  const ordered: Array<{script: number; scope: EmbeddedScope}> = [];
  const stack: EmbeddedScope[] = [];
  let currentScript = -1;
  let varPos = 0;
  for (let i = 0; i + scopeStride <= rawScopes.length; i += scopeStride) {
    const script = rawScopes[i + scriptOff] / nodeStride;
    const depth = rawScopes[i + depthOff];
    const varsCount = rawScopes[i + varsOff];
    const variables: VariableDefinition[] = [];
    for (let j = 0; j < varsCount; ++j) {
      variables.push({
        name: strings[rawVars[varPos + j * varStride + nameOff]] ?? '',
        uses: [],
      });
    }
    varPos += varsCount * varStride;
    const scope: EmbeddedScope = {
      scopeId: rawScopes[i + idOff],
      variables,
    };
    if (script !== currentScript) {
      currentScript = script;
      stack.length = 0;
    }
    if (depth > 0 && stack[depth - 1] != null) {
      scope.parent = stack[depth - 1];
    }
    stack[depth] = scope;
    stack.length = depth + 1;
    let scopes = byScript.get(script);
    if (scopes == null) {
      scopes = new Map();
      byScript.set(script, scopes);
    }
    scopes.set(scope.scopeId, scope);
    ordered.push({script, scope});
  }

  // Pass 2: each scope's uses, consumed in the same order.
  let usePos = 0;
  for (let k = 0; k < ordered.length; ++k) {
    const {script, scope} = ordered[k];
    const usesCount = rawScopes[k * scopeStride + usesOff];
    const scopes = byScript.get(script);
    for (let j = 0; j < usesCount; ++j) {
      const at = usePos + j * useStride;
      const variable = scopes?.get(rawUses[at + declOff])?.variables[
        rawUses[at + slotOff]
      ];
      if (variable != null && !variable.uses.includes(scope)) {
        variable.uses.push(scope);
      }
    }
    usePos += usesCount * useStride;
  }
  return byScript;
}

interface LiveClosure {
  ownerIdx: number;
  contextIdx: number;
  scriptIdx: number;
  scopeId: number;
}

interface Scan {
  scripts: Map<number, {id: number; name: string}>;
  contexts: Array<{idx: number; scopeInfoIdx: number}>;
  liveClosures: LiveClosure[];
  /** Top-level functions of modules that finished evaluating. */
  finishedModuleFns: Set<number>;
  /** ScopeInfo → script; a stored `undefined` memoizes a failed lookup. */
  scopeInfoScript: Map<number, number | undefined>;
}

function scriptName(node: IHeapNode): string {
  const prefix = 'system / Script / ';
  const name = node.name.startsWith(prefix)
    ? node.name.slice(prefix.length)
    : '';
  return name || (internal(node, 'source_url')?.name ?? '');
}

/**
 * Assign a ScopeInfo and the ones enclosing it to a script, stopping at the
 * script's root scope, at an already assigned ScopeInfo, or at `stopAt` (the
 * call site of the `eval` that created the script, which belongs to the
 * calling script).
 */
function attributeChain(
  scopeInfoScript: Map<number, number | undefined>,
  start: IHeapNode,
  stopAt: number | undefined,
  scriptIdx: number,
): void {
  let current: IHeapNode | null = start;
  while (current != null) {
    const idx = current.nodeIndex;
    if (idx === stopAt || scopeInfoScript.has(idx)) return;
    scopeInfoScript.set(idx, scriptIdx);
    // A root scope's outer ScopeInfo lies in another script.
    if (isRootScopeInfo(current)) return;
    current = internal(current, 'outer_scope_info');
  }
}

function attributeScriptScopeInfos(
  scopeInfoScript: Map<number, number | undefined>,
  script: IHeapNode,
): void {
  const infos = internal(script, 'infos');
  if (infos == null) return;
  const evalFrom = internal(script, 'eval_from_scope_info');
  const stopAt =
    evalFrom != null && isScopeInfo(evalFrom) ? evalFrom.nodeIndex : undefined;
  const scriptIdx = script.nodeIndex;
  infos.forEachReference((edge: IHeapEdge) => {
    const info = edge.toNode;
    if (isScopeInfo(info)) {
      // The innermost scope with a context around a direct `eval` call.
      attributeChain(scopeInfoScript, info, stopAt, scriptIdx);
      return;
    }
    if (!info.name.startsWith('system / SharedFunctionInfo')) return;
    const own = internal(info, 'name_or_scope_info');
    if (own != null && isScopeInfo(own)) {
      attributeChain(scopeInfoScript, own, stopAt, scriptIdx);
      return;
    }
    // An uncompiled function has no ScopeInfo yet; its enclosing scope's
    // belongs to this script unless it is the script's root function.
    const scopeId = intEdge(info, 'scope_id');
    if (scopeId === undefined || scopeId === ROOT_SCOPE_ID) return;
    const outer = internal(info, 'raw_outer_scope_info_or_feedback_metadata');
    if (outer != null && isScopeInfo(outer)) {
      attributeChain(scopeInfoScript, outer, stopAt, scriptIdx);
    }
  });
}

function addLiveClosure(
  out: LiveClosure[],
  owner: IHeapNode,
  sfi: IHeapNode,
  context: IHeapNode,
): void {
  const script = internal(sfi, 'script');
  const scopeId = intEdge(sfi, 'scope_id');
  if (script == null || scopeId === undefined) return;
  out.push({
    ownerIdx: owner.nodeIndex,
    contextIdx: context.nodeIndex,
    scriptIdx: script.nodeIndex,
    scopeId,
  });
}

/**
 * Generators, async functions, async generators and module top-level code are
 * generator objects. A suspended one resumes in a context only it refers to,
 * so it counts as a live closure of its function with that context. A closed
 * one can never run again and counts as nothing.
 */
function processGenerator(scan: Scan, gen: IHeapNode): void {
  const continuation = intEdge(gen, 'continuation');
  const fn = internal(gen, 'function');
  if (continuation === undefined || fn == null || fn.type !== 'closure') {
    return;
  }
  const sfi = internal(fn, 'shared');
  if (sfi == null) return;
  if (continuation === GENERATOR_CLOSED) {
    // Only module top-level code is both a generator and a root scope. Its
    // function can no longer run once the generator finished.
    if (intEdge(sfi, 'scope_id') === ROOT_SCOPE_ID) {
      scan.finishedModuleFns.add(fn.nodeIndex);
    }
    return;
  }
  const context = internal(gen, 'context');
  if (context != null) addLiveClosure(scan.liveClosures, gen, sfi, context);
}

function scanHeap(snapshot: IHeapSnapshot): Scan {
  const scan: Scan = {
    scripts: new Map(),
    contexts: [],
    liveClosures: [],
    finishedModuleFns: new Set(),
    scopeInfoScript: new Map(),
  };
  const generatorMaps: IHeapNode[] = [];
  snapshot.nodes.forEach((node: IHeapNode) => {
    const name = node.name;
    if (name.startsWith('system / Script')) {
      scan.scripts.set(node.nodeIndex, {id: node.id, name: scriptName(node)});
      attributeScriptScopeInfos(scan.scopeInfoScript, node);
    } else if (isContext(node)) {
      const scopeInfo = internal(node, 'scope_info');
      if (scopeInfo != null) {
        scan.contexts.push({
          idx: node.nodeIndex,
          scopeInfoIdx: scopeInfo.nodeIndex,
        });
      }
    } else if (node.type === 'closure') {
      const sfi = internal(node, 'shared');
      const context = internal(node, 'context');
      if (sfi != null && context != null) {
        addLiveClosure(scan.liveClosures, node, sfi, context);
      }
    } else if (name === 'system / Map') {
      const typeName = internal(node, 'instance_type_name')?.name;
      if (typeName != null && GENERATOR_INSTANCE_TYPES.has(typeName)) {
        generatorMaps.push(node);
      }
    }
  });
  // A handful of maps describe every generator object, so walking back from
  // them beats checking the map of every object in the heap.
  for (const map of generatorMaps) {
    map.forEachReferrer((edge: IHeapEdge) => {
      if (edge.name_or_index === 'map' && edge.fromNode.type === 'object') {
        processGenerator(scan, edge.fromNode);
      }
    });
  }
  return scan;
}

/** Per function scope: every Context its live closures can reach. */
function buildLiveFunctions(
  snapshot: IHeapSnapshot,
  scan: Scan,
): ByScope<Set<number>> {
  const out: ByScope<Set<number>> = new Map();
  for (const closure of scan.liveClosures) {
    if (scan.finishedModuleFns.has(closure.ownerIdx)) continue;
    let fns = out.get(closure.scriptIdx);
    if (fns == null) {
      fns = new Map();
      out.set(closure.scriptIdx, fns);
    }
    let reach = fns.get(closure.scopeId);
    if (reach == null) {
      reach = new Set();
      fns.set(closure.scopeId, reach);
    }
    let idx: number | undefined = closure.contextIdx;
    while (idx !== undefined && !reach.has(idx)) {
      const ctx = snapshot.nodes.get(idx);
      if (ctx == null || !isContext(ctx)) break;
      reach.add(idx);
      idx = internal(ctx, 'previous')?.nodeIndex;
    }
  }
  return out;
}

function resolveScopeInfoScript(
  memo: Map<number, number | undefined>,
  scopeInfo: IHeapNode,
): number | undefined {
  if (memo.has(scopeInfo.nodeIndex)) return memo.get(scopeInfo.nodeIndex);
  const visited: number[] = [];
  let current: IHeapNode | null = scopeInfo;
  let script: number | undefined;
  while (current != null && !visited.includes(current.nodeIndex)) {
    if (memo.has(current.nodeIndex)) {
      script = memo.get(current.nodeIndex);
      break;
    }
    visited.push(current.nodeIndex);
    if (isRootScopeInfo(current)) break;
    current = internal(current, 'outer_scope_info');
  }
  for (const idx of visited) memo.set(idx, script);
  return script;
}

/**
 * Whether live code can read `variable` out of this Context: some scope that
 * reads it, or a scope enclosing that one, is a function with a live closure
 * whose context chain includes this Context. A live outer closure can create
 * any function nested in it, so those count even with no closure on the heap.
 */
function isUsed(
  liveFns: Map<number, Set<number>> | undefined,
  contextIdx: number,
  variable: VariableDefinition,
): boolean {
  if (liveFns == null) return false;
  for (const use of variable.uses) {
    for (let s: EmbeddedScope | undefined = use; s != null; s = s.parent) {
      if (liveFns.get(s.scopeId)?.has(contextIdx)) return true;
    }
  }
  return false;
}

interface ScopeGroup {
  scopeInfo: IHeapNode;
  scriptIdx: number;
  scope: EmbeddedScope;
  contextIdxs: number[];
}

export function analyzeContexts(snapshot: IHeapSnapshot): ContextAnalysis {
  const scopesByScript = parseScopes(snapshot);
  const scan = scanHeap(snapshot);
  const liveFns = buildLiveFunctions(snapshot, scan);

  // Group contexts by ScopeInfo and match each group to its embedded scope.
  const groups = new Map<number, ScopeGroup | null>();
  const withoutScopes = new Map<number, ScriptWithoutScopes>();
  for (const ctx of scan.contexts) {
    const known = groups.get(ctx.scopeInfoIdx);
    if (known !== undefined) {
      if (known != null) {
        known.contextIdxs.push(ctx.idx);
      } else {
        // Already resolved to a script without scopes (or to nothing).
        const script = scan.scopeInfoScript.get(ctx.scopeInfoIdx);
        const entry = script != null ? withoutScopes.get(script) : undefined;
        if (entry != null) entry.contextCount++;
      }
      continue;
    }
    const scopeInfo = snapshot.nodes.get(ctx.scopeInfoIdx);
    const scopeId =
      scopeInfo != null ? intEdge(scopeInfo, 'scope_id') : undefined;
    if (scopeInfo == null || scopeId === undefined) {
      groups.set(ctx.scopeInfoIdx, null);
      continue;
    }
    const scriptIdx = resolveScopeInfoScript(scan.scopeInfoScript, scopeInfo);
    const script = scriptIdx != null ? scan.scripts.get(scriptIdx) : undefined;
    if (scriptIdx == null || script == null) {
      groups.set(ctx.scopeInfoIdx, null);
      continue;
    }
    const embedded = scopesByScript.get(scriptIdx);
    if (embedded == null) {
      groups.set(ctx.scopeInfoIdx, null);
      const entry = withoutScopes.get(scriptIdx);
      if (entry != null) {
        entry.contextCount++;
      } else {
        withoutScopes.set(scriptIdx, {
          scriptId: script.id,
          scriptName: script.name,
          contextCount: 1,
        });
      }
      continue;
    }
    const scope = embedded.get(scopeId);
    if (scope == null) {
      groups.set(ctx.scopeInfoIdx, null);
      continue;
    }
    groups.set(ctx.scopeInfoIdx, {
      scopeInfo,
      scriptIdx,
      scope,
      contextIdxs: [ctx.idx],
    });
  }

  const scopes: DeadScope[] = [];
  for (const group of groups.values()) {
    if (group == null) continue;
    const varByName = new Map(group.scope.variables.map(v => [v.name, v]));
    const fns = liveFns.get(group.scriptIdx);
    const contexts: DeadContext[] = [];
    let fieldCount = 0;
    for (const idx of group.contextIdxs) {
      const ctx = snapshot.nodes.get(idx);
      if (ctx == null) continue;
      const deadFields: DeadField[] = [];
      let fields = 0;
      ctx.forEachReference((edge: IHeapEdge) => {
        if (edge.type !== 'context') return;
        fields++;
        const variable = varByName.get(String(edge.name_or_index));
        // A slot with no definition is not ours to judge.
        if (variable == null || isUsed(fns, idx, variable)) return;
        const value = edge.toNode;
        deadFields.push({
          name: variable.name,
          valueId: value.id,
          valueName: value.name,
          valueType: value.type,
          selfSize: value.self_size,
          retainedSize: value.retainedSize,
        });
      });
      fieldCount = Math.max(fieldCount, fields);
      if (deadFields.length === 0) continue;
      deadFields.sort(
        (a, b) => b.retainedSize - a.retainedSize || a.valueId - b.valueId,
      );
      contexts.push({
        contextId: ctx.id,
        retainedSize: ctx.retainedSize,
        deadRetainedSize: deadFields.reduce((s, f) => s + f.retainedSize, 0),
        deadFields,
      });
    }
    if (contexts.length === 0) continue;
    contexts.sort(compareContexts);
    const script = scan.scripts.get(group.scriptIdx);
    scopes.push({
      scopeInfoId: group.scopeInfo.id,
      scriptId: script?.id ?? 0,
      scriptName: script?.name ?? '',
      scopeName: internal(group.scopeInfo, 'function_name')?.name ?? '',
      start: intEdge(group.scopeInfo, 'start_position') ?? 0,
      end: intEdge(group.scopeInfo, 'end_position') ?? 0,
      isRootScope: group.scope.scopeId === ROOT_SCOPE_ID,
      fieldCount,
      contexts,
    });
  }
  scopes.sort((a, b) => compareContexts(a.contexts[0], b.contexts[0]));

  return {
    hasScopeMetadata: hasScopeMetadata(snapshot),
    scopes,
    scriptsWithoutScopes: [...withoutScopes.values()].sort(
      (a, b) => b.contextCount - a.contextCount || a.scriptId - b.scriptId,
    ),
    contextCount: scan.contexts.length,
    liveClosureCount: scan.liveClosures.length,
  };
}

function compareContexts(a: DeadContext, b: DeadContext): number {
  return (
    b.deadRetainedSize - a.deadRetainedSize ||
    b.retainedSize - a.retainedSize ||
    a.contextId - b.contextId
  );
}

/** Total dead bytes of one scope: the sum over its contexts. */
export function scopeDeadBytes(scope: DeadScope): number {
  return scope.contexts.reduce((s, c) => s + c.deadRetainedSize, 0);
}

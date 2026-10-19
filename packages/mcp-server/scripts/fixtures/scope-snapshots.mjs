/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Hand-built V8 heap snapshots that carry the source scope tree (V8 15.6+),
 * one per dead-context case. Each case documents the answer it expects; see
 * check-fixtures.mjs.
 */
import fs from 'fs';
import path from 'path';

const NODE_TYPES = [
  'hidden',
  'array',
  'string',
  'object',
  'code',
  'closure',
  'regexp',
  'number',
  'native',
  'synthetic',
  'concatenated string',
  'sliced string',
  'symbol',
  'bigint',
  'object shape',
];
const EDGE_TYPES = [
  'context',
  'element',
  'property',
  'internal',
  'hidden',
  'shortcut',
  'weak',
];

function build(mock) {
  const strings = [''];
  const sidx = new Map([['', 0]]);
  const s = str => {
    if (!sidx.has(str)) {
      sidx.set(str, strings.length);
      strings.push(str);
    }
    return sidx.get(str);
  };
  const nodes = [];
  let nextId = 301;
  const mk = (type, name, self = 0) => {
    const n = {
      type,
      name,
      id: nodes.length === 0 ? 1 : (nextId += 2),
      self,
      edges: [],
    };
    nodes.push(n);
    return n;
  };
  const link = (from, to, etype, name) => from.edges.push({etype, name, to});
  const root = mk('synthetic', '');
  const byName = new Map();
  const add = (key, type, name, self = 0) => {
    const n = mk(type, name, self);
    link(root, n, 'element', root.edges.length);
    byName.set(key, n);
    return n;
  };
  const N = key => {
    if (!byName.has(key)) throw new Error('no node ' + key);
    return byName.get(key);
  };
  const ints = new Map();
  const int = v => {
    if (!ints.has(v)) {
      const n = mk('number', 'int');
      link(n, mk('string', String(v)), 'internal', 'value');
      ints.set(v, n);
    }
    return ints.get(v);
  };
  const intEdge = (from, name, v) => link(from, int(v), 'internal', name);

  for (const sc of mock.scripts)
    add(sc.name, 'code', `system / Script / ${sc.name}`);
  for (const si of mock.scopeInfos) add(si.name, 'code', 'system / ScopeInfo');
  for (const f of mock.sfis)
    add(f.name, 'code', `system / SharedFunctionInfo / ${f.name}`);
  for (const c of mock.contexts)
    add(c.name, 'object', `system / Context / ${c.name}`, 16);
  for (const c of mock.closures ?? []) add(c.name, 'closure', c.name, 32);
  mock.scripts.forEach((sc, i) => intEdge(N(sc.name), 'id', i + 1));
  for (const si of mock.scopeInfos) {
    const n = N(si.name);
    intEdge(n, 'scope_id', si.scopeId);
    intEdge(n, 'start_position', si.start ?? 14);
    intEdge(n, 'end_position', si.end ?? 67);
    link(
      n,
      mk('string', si.functionName ?? si.name),
      'internal',
      'function_name',
    );
    if (si.outer) link(n, N(si.outer), 'internal', 'outer_scope_info');
  }
  const infos = new Map();
  for (const f of mock.sfis) {
    const n = N(f.name);
    if (f.scopeInfo) link(n, N(f.scopeInfo), 'internal', 'name_or_scope_info');
    if (f.outerScopeInfo)
      link(
        n,
        N(f.outerScopeInfo),
        'internal',
        'raw_outer_scope_info_or_feedback_metadata',
      );
    link(n, N(f.script), 'internal', 'script');
    intEdge(n, 'scope_id', f.scopeId);
    if (!infos.has(f.script)) {
      const arr = mk('array', 'system / WeakFixedArray');
      link(N(f.script), arr, 'internal', 'infos');
      infos.set(f.script, arr);
    }
    const arr = infos.get(f.script);
    link(arr, n, 'weak', arr.edges.length);
  }
  for (const c of mock.contexts) {
    const n = N(c.name);
    link(n, N(c.scopeInfo), 'internal', 'scope_info');
    if (c.previous) link(n, N(c.previous), 'internal', 'previous');
    for (const f of c.fields) {
      // each value is a distinct object with a payload, so retained sizes show
      const v = mk('object', f.value, f.size ?? 100);
      link(
        v,
        mk('array', 'payload', f.payload ?? 1000),
        'internal',
        'elements',
      );
      link(n, v, 'context', f.name);
    }
  }
  for (const c of mock.closures ?? []) {
    link(N(c.name), N(c.sfi), 'internal', 'shared');
    link(N(c.name), N(c.context), 'internal', 'context');
  }
  // generator objects: one map per instance type, shared
  const maps = new Map();
  for (const g of mock.generators ?? []) {
    const type = g.instanceType ?? 'JS_ASYNC_FUNCTION_OBJECT_TYPE';
    if (!maps.has(type)) {
      const m = add('map:' + type, 'code', 'system / Map');
      link(m, mk('string', type), 'internal', 'instance_type_name');
      maps.set(type, m);
    }
    const gen = add(g.name, 'object', g.className ?? 'AsyncFunction', 40);
    link(gen, maps.get(type), 'internal', 'map');
    link(gen, N(g.closure), 'internal', 'function');
    if (g.context) link(gen, N(g.context), 'internal', 'context');
    intEdge(gen, 'continuation', g.continuation);
  }

  const raw = {
    snapshot: {
      meta: {
        node_fields: [
          'type',
          'name',
          'id',
          'self_size',
          'edge_count',
          'detachedness',
        ],
        node_types: [
          NODE_TYPES,
          'string',
          'number',
          'number',
          'number',
          'number',
        ],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [EDGE_TYPES, 'string_or_number', 'node'],
        trace_function_info_fields: [
          'function_id',
          'name',
          'script_name',
          'script_id',
          'line',
          'column',
        ],
        trace_node_fields: [
          'id',
          'function_info_index',
          'count',
          'size',
          'children',
        ],
        sample_fields: ['timestamp_us', 'last_assigned_id'],
        location_fields: ['object_index', 'script_id', 'line', 'column'],
      },
      node_count: nodes.length,
      edge_count: 0,
      trace_function_count: 0,
    },
    nodes: [],
    edges: [],
    trace_function_infos: [],
    trace_tree: [],
    samples: [],
    locations: [],
  };
  const F = 6;
  const index = new Map(nodes.map((n, i) => [n, i * F]));
  for (const n of nodes) {
    raw.nodes.push(
      NODE_TYPES.indexOf(n.type),
      s(n.name),
      n.id,
      n.self,
      n.edges.length,
      0,
    );
    for (const e of n.edges) {
      const isIdx =
        e.etype === 'element' || e.etype === 'hidden' || e.etype === 'weak';
      raw.edges.push(
        EDGE_TYPES.indexOf(e.etype),
        isIdx ? e.name : s(e.name),
        index.get(e.to),
      );
    }
  }
  raw.snapshot.edge_count = raw.edges.length / 3;
  if (mock.scripts.some(sc => sc.scopes)) {
    Object.assign(raw.snapshot.meta, {
      scope_fields: [
        'script_node_index',
        'scope_id',
        'depth',
        'scope_context_vars_count',
        'scope_uses_count',
      ],
      scope_context_var_fields: ['name'],
      scope_use_fields: ['declaring_scope_id', 'slot_index'],
    });
    raw.scopes = [];
    raw.scope_context_vars = [];
    raw.scope_uses = [];
    for (const sc of mock.scripts) {
      for (const scope of sc.scopes ?? []) {
        const vars = scope.vars ?? [];
        const uses = scope.uses ?? [];
        raw.scopes.push(
          index.get(N(sc.name)),
          scope.id,
          scope.depth ?? 0,
          vars.length,
          uses.length,
        );
        for (const v of vars) raw.scope_context_vars.push(s(v));
        for (const [d, slot] of uses) raw.scope_uses.push(d, slot);
      }
    }
  }
  raw.strings = strings;
  return {raw, ids: Object.fromEntries([...byName].map(([k, n]) => [k, n.id]))};
}

function base() {
  return {
    scripts: [
      {
        name: 'test.js',
        scopes: [
          {id: 100, vars: ['liveVar', 'deadVar']},
          {id: 101, depth: 1, uses: [[100, 0]]},
          {id: 102, depth: 1, uses: [[100, 1]]},
        ],
      },
    ],
    scopeInfos: [
      {name: 'fn', scopeId: 100},
      {name: 'liveReader', scopeId: 101, outer: 'fn'},
      {name: 'deadReader', scopeId: 102, outer: 'fn'},
    ],
    sfis: [
      {name: 'fnSfi', scopeInfo: 'fn', script: 'test.js', scopeId: 100},
      {
        name: 'liveReaderSfi',
        scopeInfo: 'liveReader',
        script: 'test.js',
        scopeId: 101,
      },
      {
        name: 'deadReaderSfi',
        scopeInfo: 'deadReader',
        script: 'test.js',
        scopeId: 102,
      },
    ],
    contexts: [
      {
        name: 'fnCall',
        scopeInfo: 'fn',
        fields: [
          {name: 'liveVar', value: 'LiveValue'},
          {name: 'deadVar', value: 'DeadValue', payload: 5000},
        ],
      },
    ],
    closures: [
      {name: 'liveReaderClosure', sfi: 'liveReaderSfi', context: 'fnCall'},
    ],
  };
}

const addSecondScript = (m, name) => {
  m.scripts.push({name});
  m.scopeInfos.push({name: 'otherFn', scopeId: 200});
  m.sfis.push({
    name: 'otherFnSfi',
    scopeInfo: 'otherFn',
    script: name,
    scopeId: 200,
  });
  m.contexts.push({name: 'otherCall', scopeInfo: 'otherFn', fields: []});
  m.closures.push({
    name: 'otherClosure',
    sfi: 'otherFnSfi',
    context: 'otherCall',
  });
};

const cases = {
  // deadVar dead, liveVar live
  base: base(),
  // block scope reached only through outer_scope_info: blockDead dead, in test.js
  block: (() => {
    const m = base();
    m.scripts[0].scopes.push({id: 103, depth: 1, vars: ['blockDead']});
    m.scopeInfos.push({name: 'block', scopeId: 103, outer: 'fn'});
    m.contexts.push({
      name: 'blockEntry',
      scopeInfo: 'block',
      previous: 'fnCall',
      fields: [{name: 'blockDead', value: 'BlockValue'}],
    });
    return m;
  })(),
  // a context slot with no variable definition is ignored
  missingVar: (() => {
    const m = base();
    m.contexts[0].fields.push({name: 'missingVar', value: 'MissingValue'});
    return m;
  })(),
  // no scope metadata anywhere: tool says unavailable; 2 scripts unchecked
  noMetadata: (() => {
    const m = base();
    delete m.scripts[0].scopes;
    addSecondScript(m, 'other.js');
    return m;
  })(),
  // one script lacks scopes: deadVar reported, without-scopes.js listed
  mixed: (() => {
    const m = base();
    addSecondScript(m, 'without-scopes.js');
    return m;
  })(),
  // outer { x; return middle() { return inner() { x } } }: only `middle` is
  // live; inner is nested in it, so x is NOT dead. `y` is read by nothing.
  nested: {
    scripts: [
      {
        name: 'nested.js',
        scopes: [
          {id: 10, vars: ['x', 'y']},
          {id: 11, depth: 1},
          {id: 12, depth: 2, uses: [[10, 0]]},
        ],
      },
    ],
    scopeInfos: [
      {name: 'outer', scopeId: 10},
      {name: 'middle', scopeId: 11, outer: 'outer'},
    ],
    sfis: [
      {name: 'outerSfi', scopeInfo: 'outer', script: 'nested.js', scopeId: 10},
      {
        name: 'middleSfi',
        scopeInfo: 'middle',
        script: 'nested.js',
        scopeId: 11,
      },
      // uncompiled inner: no ScopeInfo of its own
      {
        name: 'innerSfi',
        outerScopeInfo: 'middle',
        script: 'nested.js',
        scopeId: 12,
      },
    ],
    contexts: [
      {
        name: 'outerCall',
        scopeInfo: 'outer',
        fields: [
          {name: 'x', value: 'XValue'},
          {name: 'y', value: 'YValue'},
        ],
      },
    ],
    closures: [{name: 'middleClosure', sfi: 'middleSfi', context: 'outerCall'}],
  },
  // async fn body context: a suspended frame keeps `pending` live; a finished
  // one (continuation -1) leaves `done` dead
  generators: {
    scripts: [
      {
        name: 'async.js',
        scopes: [
          {id: 20, vars: ['pending']},
          {id: 21, depth: 1, uses: [[20, 0]]},
          {id: 30, vars: ['done']},
          {id: 31, depth: 1, uses: [[30, 0]]},
        ],
      },
    ],
    scopeInfos: [
      {name: 'suspendedFn', scopeId: 20},
      {name: 'suspendedBody', scopeId: 21, outer: 'suspendedFn'},
      {name: 'finishedFn', scopeId: 30},
      {name: 'finishedBody', scopeId: 31, outer: 'finishedFn'},
    ],
    sfis: [
      {
        name: 'suspendedFnSfi',
        scopeInfo: 'suspendedFn',
        script: 'async.js',
        scopeId: 20,
      },
      {
        name: 'suspendedBodySfi',
        scopeInfo: 'suspendedBody',
        script: 'async.js',
        scopeId: 21,
      },
      {
        name: 'finishedFnSfi',
        scopeInfo: 'finishedFn',
        script: 'async.js',
        scopeId: 30,
      },
      {
        name: 'finishedBodySfi',
        scopeInfo: 'finishedBody',
        script: 'async.js',
        scopeId: 31,
      },
    ],
    contexts: [
      {
        name: 'suspendedCtx',
        scopeInfo: 'suspendedFn',
        fields: [{name: 'pending', value: 'PendingValue'}],
      },
      {
        name: 'finishedCtx',
        scopeInfo: 'finishedFn',
        fields: [{name: 'done', value: 'DoneValue'}],
      },
    ],
    // the closures exist only to give the generators a function; their own
    // context is irrelevant (they are not live readers of 20/30)
    closures: [
      {
        name: 'suspendedBodyFn',
        sfi: 'suspendedBodySfi',
        context: 'unrelatedCtx',
      },
      {name: 'finishedBodyFn', sfi: 'finishedBodySfi', context: 'unrelatedCtx'},
    ],
    generators: [
      {
        name: 'suspendedGen',
        closure: 'suspendedBodyFn',
        context: 'suspendedCtx',
        continuation: 3,
      },
      {
        name: 'finishedGen',
        closure: 'finishedBodyFn',
        context: 'finishedCtx',
        continuation: -1,
      },
    ],
  },
};
// `unrelatedCtx` for the generator closures
cases.generators.scopeInfos.push({name: 'unrelated', scopeId: 99});
cases.generators.scripts[0].scopes.push({id: 99});
cases.generators.contexts.push({
  name: 'unrelatedCtx',
  scopeInfo: 'unrelated',
  fields: [],
});

/** Write every case to `outDir`; returns {case: {file, ids}}. */
export function writeScopeFixtures(outDir) {
  fs.mkdirSync(outDir, {recursive: true});
  const written = {};
  for (const [name, mock] of Object.entries(cases)) {
    const {raw, ids} = build(mock);
    const file = path.join(outDir, `${name}.heapsnapshot`);
    fs.writeFileSync(file, JSON.stringify(raw));
    written[name] = {file, ids};
  }
  return written;
}

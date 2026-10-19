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
 * Fixture checks: drive the BUILT server over stdio against snapshots this
 * script makes itself, and assert invariants every report must keep.
 *
 *   npm run build-pkg && node scripts/check-fixtures.mjs
 *
 * Fixtures: the hand-built scope-tree snapshots in fixtures/ (exact expected
 * answers) and a real Node.js snapshot of this process (shape invariants:
 * shares never exceed 100%, partitions add up, paging is complete and
 * deterministic, structured results carry their snapshot).
 */
import {spawn} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import v8 from 'v8';
import {fileURLToPath, pathToFileURL} from 'url';
import {writeScopeFixtures} from './fixtures/scope-snapshots.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '..', 'dist', 'index.js');
if (!fs.existsSync(server)) {
  console.error('check-fixtures: dist/index.js is missing; build first.');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memlab-fixtures-'));
const scope = writeScopeFixtures(path.join(tmp, 'scope'));
// Something recognizable to find in the Node.js snapshot.
globalThis.__fixtureRecords = Array.from({length: 500}, (_, i) => ({
  id: i,
  label: `record-${i}`,
}));
// A chain of near-equal retained sizes that collapse mode folds into one
// group, then distinct arrays: the largest-objects candidate list stays
// capped while its groups run out, the case its paging has to get right.
let chainTail = {payload: new Array(200_000).fill(1.5)};
for (let i = 0; i < 100; i++) chainTail = {next: chainTail, i};
globalThis.__fixtureChain = chainTail;
globalThis.__fixtureArrays = Array.from({length: 60}, (_, i) =>
  new Array(20_000 - i * 100).fill(2.5),
);
// A class with an exact, small instance count.
class FixtureWidget {}
globalThis.__fixtureWidgets = [
  new FixtureWidget(),
  new FixtureWidget(),
  new FixtureWidget(),
];
// Two views of one subtree (a holder and its payload) with more equal-size
// arrays than any fixed look-back window between them in size-then-scan order:
// collapse mode must still fold the payload into its holder.
function makePlateauArray() {
  const a = [];
  for (let i = 0; i < 30_000; i++) a.push(i + 0.5);
  return a;
}
globalThis.__fixturePlateau = Array.from({length: 70}, makePlateauArray);
globalThis.__fixturePlateauHolder = {plateauPayload: makePlateauArray()};
// Enough instances of one class to page past the bounded-heap threshold.
class FixtureMany {
  constructor(n) {
    this.n = n;
  }
}
globalThis.__fixtureMany = Array.from(
  {length: 12_000},
  (_, i) => new FixtureMany(i),
);
// A long class name, to check the session name width against a per-call one.
class FixtureWidthProbeWithAVeryLongClassNameForNameWidthChecks {}
globalThis.__fixtureWidthProbe =
  new FixtureWidthProbeWithAVeryLongClassNameForNameWidthChecks();
const nodeSnapshot = v8.writeHeapSnapshot(path.join(tmp, 'node.heapsnapshot'));

const child = spawn(process.execPath, [server], {
  stdio: ['pipe', 'pipe', 'ignore'],
});
// However the run ends, do not leave the server or the fixtures behind.
process.on('exit', () => {
  child.kill();
  fs.rmSync(tmp, {recursive: true, force: true});
});
let buf = '';
let nextId = 0;
const pending = new Map();
child.stdout.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
// A crashed or wedged server must fail the run, not hang it.
const RPC_TIMEOUT_MS = 5 * 60 * 1000;
let exited = null;
child.on('exit', code => {
  // Keep the first reason: a timeout kills the child, which then exits.
  exited ??= `the server exited (code ${code})`;
  for (const resolve of pending.values()) {
    resolve({error: {message: exited}});
  }
  pending.clear();
});
// Writing to a server that already exited must not throw asynchronously.
child.stdin.on('error', () => {});
const rpc = (method, params) =>
  new Promise(resolve => {
    if (exited != null) {
      resolve({error: {message: exited}});
      return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      // A server that stopped answering is wedged: fail every later call at
      // once instead of letting each wait out its own timeout.
      exited = `${method} got no reply in ${RPC_TIMEOUT_MS / 1000}s`;
      child.kill();
      resolve({error: {message: exited}});
    }, RPC_TIMEOUT_MS);
    pending.set(id, msg => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(
      JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n',
    );
  });
async function call(name, args = {}) {
  const r = await rpc('tools/call', {name, arguments: args});
  if (r.error) throw new Error(`${name}: ${r.error.message}`);
  const text = (r.result.content ?? []).map(c => c.text).join('\n');
  if (r.result.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
  return {text, data: r.result.structuredContent};
}

const results = [];
async function check(label, fn) {
  try {
    await fn();
    results.push([label, null]);
  } catch (err) {
    results.push([label, err instanceof Error ? err.message : String(err)]);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: {name: 'check-fixtures', version: '0'},
});
if (init.error) {
  console.error(`check-fixtures: ${init.error.message}`);
  process.exit(1);
}
child.stdin.write(
  JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n',
);

// Dead captured variables: exact answers on the scope-tree fixtures.
const deadExpected = {
  base: ['deadVar'],
  block: ['deadVar', 'blockDead'],
  missingVar: ['deadVar'],
  mixed: ['deadVar'],
  nested: ['y'],
  generators: ['done'],
};
for (const [name, expected] of Object.entries(deadExpected)) {
  await check(`dead_context_variables: ${name}`, async () => {
    const {data} = await call('memlab_dead_context_variables', {
      snapshot: scope[name].file,
    });
    const dead = data.scopes
      .flatMap(s => s.contexts.flatMap(c => c.dead_fields.map(f => f.name)))
      .sort();
    assert(
      JSON.stringify(dead) === JSON.stringify([...expected].sort()),
      `expected ${expected.join(', ')}, got ${dead.join(', ') || 'none'}`,
    );
  });
}
await check('dead_context_variables: no scope metadata', async () => {
  const {data} = await call('memlab_dead_context_variables', {
    snapshot: scope.noMetadata.file,
  });
  assert(
    data.has_scope_metadata === false,
    'expected has_scope_metadata false',
  );
  assert(
    data.scripts_without_scopes.length === 2,
    'expected 2 unchecked scripts',
  );
});

// Shape invariants on a real snapshot.
// A failed load is a FAIL like any other, and the checks that need the
// snapshot report as skipped rather than crashing the run.
let nodeLoaded = false;
await check('load a Node.js snapshot', async () => {
  await call('memlab_load_snapshot', {file_path: nodeSnapshot});
  nodeLoaded = true;
});
const shapeCheck = (label, fn) =>
  check(label, async () => {
    if (!nodeLoaded)
      throw new Error('skipped: the Node.js snapshot did not load');
    await fn();
  });

await shapeCheck('class_histogram: no row above 100% of the heap', async () => {
  const {text} = await call('memlab_class_histogram', {
    include_retained_size: true,
    limit: 25,
    suppress_suggestions: true,
  });
  const pcts = [...text.matchAll(/\|\s*([\d.]+)%\s*\|/g)].map(m =>
    Number(m[1]),
  );
  assert(pcts.length > 0, 'no % column found');
  assert(
    pcts.every(p => p <= 100),
    `a row reads ${Math.max(...pcts)}%`,
  );
});

await shapeCheck('snapshot_summary: native + V8 heap = total', async () => {
  const {data} = await call('memlab_snapshot_summary');
  const s = data.statistics;
  assert(
    Math.abs(s.native.total + s.v8_heap.total - s.total) <= 1,
    `${s.native.total} + ${s.v8_heap.total} != ${s.total}`,
  );
});

await shapeCheck(
  'native_contexts: owned + shared + unattributed = total',
  async () => {
    const {data} = await call('memlab_native_contexts');
    const owned = data.contexts.reduce((s, c) => s + c.owned_size, 0);
    const sum = owned + data.shared.size + data.unattributed.size;
    assert(sum === data.total_self_size, `${sum} != ${data.total_self_size}`);
  },
);

await shapeCheck(
  'query_objects: pages are complete, disjoint and repeatable',
  async () => {
    const args = {class_name: '^Object$', node_type: 'object', page_size: 40};
    const ids = [];
    let offset = 0;
    let total = null;
    for (let pages = 0; offset != null && pages < 1000; pages++) {
      const {data} = await call('memlab_query_objects', {...args, offset});
      total ??= data.total;
      ids.push(...data.objects.map(o => o.id));
      offset = data.pagination.next_offset;
    }
    assert(ids.length === total, `paged ${ids.length} of ${total}`);
    assert(new Set(ids).size === ids.length, 'a node appeared on two pages');
    const again = await call('memlab_query_objects', {...args, offset: 0});
    assert(
      JSON.stringify(again.data.objects.map(o => o.id)) ===
        JSON.stringify(ids.slice(0, 40)),
      'the first page changed between two calls',
    );
  },
);

await shapeCheck('query_objects: finds the fixture records', async () => {
  const {data} = await call('memlab_query_objects', {
    property_name: '^label$',
    node_type: 'object',
    page_size: 1,
  });
  assert(data.total >= 500, `found ${data.total} objects with a label`);
});

await shapeCheck('structured results carry their snapshot', async () => {
  const calls = [
    ['memlab_largest_objects', {limit: 1}],
    ['memlab_class_histogram', {limit: 1, suppress_suggestions: true}],
    ['memlab_get_node', {node_id: 1}],
  ];
  for (const [name, args] of calls) {
    const {data} = await call(name, args);
    assert(typeof data?.snapshot === 'string', `${name} has no snapshot`);
  }
});

await shapeCheck('retained_by: every kind within the heap', async () => {
  const {data} = await call('memlab_retained_by', {top_classes: 0});
  for (const k of data.kinds) {
    assert(k.self_size <= data.heap_self_size, `${k.kind} exceeds the heap`);
  }
});

await shapeCheck(
  'largest_objects: every advertised next page has rows',
  async () => {
    let offset = 0;
    let pages = 0;
    for (; offset != null && pages < 60; pages++) {
      const {text} = await call('memlab_largest_objects', {limit: 5, offset});
      const rows = (text.match(/^\| @/gm) ?? []).length;
      assert(rows > 0, `the page at offset ${offset} came back empty`);
      const next = text.match(/Next page: `offset: (\d+)`/);
      offset = next != null ? Number(next[1]) : null;
    }
    assert(pages > 1, 'expected more than one page');
  },
);

await shapeCheck(
  'find_nodes_by_class: a short page and a past-end offset give the exact count',
  async () => {
    const args = {class_name: 'FixtureWidget', node_type: 'object'};
    const page = await call('memlab_find_nodes_by_class', {...args, limit: 5});
    assert(
      page.text.includes('Showing 1–3 of 3 instances'),
      `short page footer: ${page.text.slice(-120)}`,
    );
    const past = await call('memlab_find_nodes_by_class', {
      ...args,
      limit: 5,
      offset: 7,
    });
    assert(
      past.text.includes('past the last of 3'),
      `past-end message: ${past.text.slice(0, 120)}`,
    );
  },
);

await shapeCheck(
  'name width: the session width replaces defaults, a per-call width wins',
  async () => {
    const longName =
      'FixtureWidthProbeWithAVeryLongClassNameForNameWidthChecks';
    const args = {class_name: `^${longName}$`, node_type: 'object'};
    await call('memlab_snapshots', {action: 'list', max_name_length: 12});
    try {
      const session = await call('memlab_query_objects', args);
      assert(
        !session.text.includes(longName),
        'the session width did not clip the name',
      );
      const perCall = await call('memlab_query_objects', {
        ...args,
        max_name_length: 60,
      });
      assert(
        perCall.text.includes(longName),
        'a per-call max_name_length did not win over the session width',
      );
    } finally {
      await call('memlab_snapshots', {action: 'list', max_name_length: 0});
    }
  },
);

await shapeCheck(
  'largest_objects: a payload folds into its holder past a long equal-size run',
  async () => {
    const holder = await call('memlab_query_objects', {
      property_name: '^plateauPayload$',
      node_type: 'object',
      page_size: 1,
    });
    const holderId = holder.data.objects[0]?.id;
    assert(holderId != null, 'the plateau holder was not found');
    const refs = await call('memlab_get_references', {
      node_id: holderId,
      edge_filter: 'plateauPayload',
    });
    const payloadId = refs.data.references[0]?.node.id;
    assert(payloadId != null, 'the plateau payload was not found');
    const {text} = await call('memlab_largest_objects', {limit: 300});
    const row = text.split('\n').find(l => l.startsWith(`| @${holderId} `));
    assert(row != null, `holder @${holderId} is not in the top 300`);
    assert(
      /more views? of this subtree/.test(row),
      'the holder folded nothing',
    );
    assert(
      !text.includes(`| @${payloadId} `),
      `payload @${payloadId} has a row of its own`,
    );
  },
);

await shapeCheck(
  'find_nodes_by_class: deep pages continue the shallow order exactly',
  async () => {
    const ids = text => (text.match(/IDs: (.*)/)?.[1] ?? '').split(', ');
    for (const order of ['retained_size', 'newest']) {
      const args = {
        class_name: 'FixtureMany',
        node_type: 'object',
        order,
        offset: 9_990,
        output_mode: 'ids',
      };
      // limit 10 stays on the bounded heap; limit 11 crosses to the sort.
      const shallow = await call('memlab_find_nodes_by_class', {
        ...args,
        limit: 10,
      });
      const deep = await call('memlab_find_nodes_by_class', {
        ...args,
        limit: 11,
      });
      assert(
        JSON.stringify(ids(deep.text).slice(0, 10)) ===
          JSON.stringify(ids(shallow.text)),
        `${order}: rows 9,991-10,000 differ between the two paths`,
      );
    }
  },
);

await check(
  'SubtreeCollapser equals the pairwise collapse on random dominator trees',
  async () => {
    const {SubtreeCollapser} = await import(
      pathToFileURL(path.join(here, '..', 'dist', 'utils.js')).href
    );
    const EPS = 0.99;
    const MAX_WALK = 200;
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    // Views of one subtree: chains of small, often zero, self sizes above a
    // big payload, so ancestors are near-equal; ids shuffled so scan order
    // often brings a child before its equal-size ancestor.
    const tree = n => {
      const nodes = [];
      const add = (parent, self) => {
        const node = {self, dominatorNode: parent, kids: []};
        parent?.kids.push(node);
        nodes.push(node);
        return node;
      };
      const root = add(null, 0);
      while (nodes.length < n) {
        let top = nodes[Math.floor(rand() * nodes.length)];
        const depth = 1 + Math.floor(rand() * 25);
        for (let d = 0; d < depth; d++) {
          top = add(top, rand() < 0.5 ? 0 : 8 + Math.floor(rand() * 16));
        }
        add(top, 10_000 + Math.floor(rand() * 90_000));
      }
      const ids = nodes.map((_, i) => i).sort(() => rand() - 0.5);
      nodes.forEach((node, i) => (node.id = ids[i] * 2 + 1));
      const total = node =>
        (node.retainedSize = node.kids.reduce(
          (s, k) => s + total(k),
          node.self,
        ));
      total(root);
      return nodes;
    };
    // The original collapse: scan the rows newest first.
    const dominates = (a, n) => {
      let cur = n.dominatorNode;
      for (let s = 0; cur != null && s < MAX_WALK; s++) {
        if (cur.id === a.id) return true;
        cur = cur.dominatorNode;
      }
      return false;
    };
    const reference = candidates => {
      const rows = [];
      for (const c of candidates) {
        let merged = false;
        for (let i = rows.length - 1; i >= 0; i--) {
          const k = rows[i];
          if (k.node.retainedSize * EPS > c.retainedSize) break;
          const lo = Math.min(c.retainedSize, k.node.retainedSize);
          const hi = Math.max(c.retainedSize, k.node.retainedSize);
          if (
            hi > 0 &&
            lo / hi >= EPS &&
            (dominates(k.node, c) || dominates(c, k.node))
          ) {
            if (dominates(c, k.node)) k.node = c;
            k.mergedCount++;
            merged = true;
            break;
          }
        }
        if (!merged) rows.push({node: c, mergedCount: 0});
      }
      return rows;
    };
    const signature = rows =>
      rows.map(r => `${r.node.id}:${r.mergedCount}`).join(',');
    for (let t = 0; t < 200; t++) {
      const candidates = tree(30 + Math.floor(rand() * 300)).sort(
        (a, b) => b.retainedSize - a.retainedSize || a.id - b.id,
      );
      const collapser = new SubtreeCollapser(EPS, MAX_WALK);
      for (const c of candidates) collapser.push(c);
      assert(
        signature(collapser.rows) === signature(reference(candidates)),
        `tree ${t}: the collapse differs from the pairwise scan`,
      );
    }
  },
);

child.kill();
fs.rmSync(tmp, {recursive: true, force: true});

const failed = results.filter(([, err]) => err != null);
for (const [label, err] of results) {
  console.log(
    `${err == null ? 'PASS' : 'FAIL'}  ${label}${err ? ` — ${err}` : ''}`,
  );
}
console.log(
  `check-fixtures: ${results.length - failed.length} of ${results.length} passed.`,
);
process.exit(failed.length > 0 ? 1 : 0);

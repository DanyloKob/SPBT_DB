import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rng, tmpDir } from './util.js';
import { openDB, coreSchemas } from '../src/index.js';
import { aiSchemas, DAY } from '../src/ai-schema.js';
import { attachVectors, createVectorStore, autoSlots, quantize } from '../src/vector.js';

const D = 256;
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function open(kind, extra = {}) {
  if (kind === 'memory') return openDB({ backend: 'memory', schemas: { ...coreSchemas, ...aiSchemas }, ...extra });
  const dir = tmpDir('vec');
  dirs.push(dir);
  return openDB({ dir, schemas: { ...coreSchemas, ...aiSchemas }, ...extra });
}

function gauss(r) {
  const u = r.float() || 1e-12, v = r.float();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = 1 / Math.sqrt(s);
  for (let i = 0; i < v.length; i++) v[i] *= s;
  return v;
}
const randVec = (r) => normalize(Float32Array.from({ length: D }, () => gauss(r)));

/**
 * Clustered data: `clusters` random unit centres; point = normalise(centre + noise * g), g a random
 * vector of expected norm 1. noise 0.5 / 1 / 2 put points at cos ~0.9 / 0.7 / 0.45 from their centre.
 */
function clustered(r, n, clusters, noise) {
  const centres = Array.from({ length: clusters }, () => randVec(r));
  const point = () => {
    const c = centres[r.int(clusters)];
    return normalize(Float32Array.from({ length: D }, (_, j) => c[j] + (noise * gauss(r)) / Math.sqrt(D)));
  };
  return { data: Array.from({ length: n }, point), point };
}

function bruteTopK(data, q, k) {
  const s = data.map((v, i) => { let a = 0; for (let j = 0; j < D; j++) a += v[j] * q[j]; return [a, i]; });
  s.sort((a, b) => b[0] - a[0]);
  return s.slice(0, k).map((x) => x[1]);
}

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

describe('vector store: layout and quantisation', () => {
  test('autoSlots fills the overflow pages a 64-slot segment uses', async () => {
    const pages = (bytes, ps) => Math.floor((15 + bytes) / ps) + 1; // LMDB OVPAGES
    assert.equal(autoSlots(256, 4096), 77);
    for (const dim of [16, 128, 256, 384, 512, 768, 1024]) {
      for (const ps of [4096, 8192]) {
        const s = autoSlots(dim, ps), rec = dim + 8;
        assert.ok(s >= 64);
        assert.equal(pages(s * rec + 1, ps), pages(64 * rec + 1, ps), `dim ${dim} ps ${ps}: ${s} slots need more pages than 64`);
        assert.ok(pages((s + 1) * rec + 1, ps) > pages(64 * rec + 1, ps) || s === 1024, `dim ${dim}: ${s} is not maximal`);
      }
    }
  });

  test('quantize: per-vector scale, normalised, zero vector', async () => {
    const r = rng(1);
    const v = Float32Array.from({ length: D }, () => gauss(r) * 3);
    const b = Buffer.alloc(D);
    const scale = quantize(v, b, 0, D, true);
    const n = Math.hypot(...v);
    let maxErr = 0, peak = 0;
    for (let j = 0; j < D; j++) {
      const code = (b[j] << 24) >> 24;
      peak = Math.max(peak, Math.abs(code));
      maxErr = Math.max(maxErr, Math.abs(code * scale - v[j] / n));
    }
    assert.equal(peak, 127);
    assert.ok(maxErr <= scale / 2 + 1e-7);
    assert.equal(quantize(new Float32Array(D), b, 0, D), 0);
    assert.ok(b.every((x) => x === 0));
    assert.throws(() => quantize(Float32Array.from({ length: D }, (_, i) => (i ? 0 : NaN)), b, 0, D), /NaN/);
  });
});

for (const kind of ['memory', 'lmdb']) {
  describe(`vector store on ${kind}`, () => {
    test('add / knn / replace / remove keep (id -> vector) equal to a model', async () => {
      const db = open(kind);
      const ai = attachVectors(db, { slots: 8 }); // small segments: many segment boundaries
      assert.equal(attachVectors(db), ai);
      const r = rng(7);
      const gid = 123456789012345678n;
      const model = new Map();
      const check = () => {
        assert.equal(ai.count(gid), model.size);
        assert.deepEqual(new Set(ai.ids(gid)), new Set(model.keys()));
        assert.equal(ai.ids(gid).length, model.size, 'duplicate ids stored');
        for (const [id, v] of model) {
          const [top] = ai.knn(gid, v, 1);
          assert.equal(top.chunkId, id);
          assert.ok(top.score > 0.99, `self score ${top.score}`);
          assert.equal(top.text, `t${id}`);
        }
      };
      // auto ids, one at a time and in batches
      for (let i = 0; i < 5; i++) { const v = randVec(r); const id = ai.add(gid, null, v, ''); model.set(id, v); }
      for (const [id] of model) db.aiChunk.patch(gid, id, { text: `t${id}` });
      const batch = Array.from({ length: 30 }, () => ({ vec: randVec(r) }));
      const ids = ai.addMany(gid, batch.map((b) => ({ ...b, text: '' })));
      assert.deepEqual(ids, Array.from({ length: 30 }, (_, i) => 6 + i));
      ai.addMany(gid, ids.map((id, i) => ({ chunkId: id, vec: batch[i].vec, text: `t${id}` }))); // replace all: count unchanged
      ids.forEach((id, i) => model.set(id, batch[i].vec));
      check();
      // explicit ids bump the counter
      ai.add(gid, 1000, randVec(r), 't1000');
      assert.equal(ai.add(gid, null, randVec(r), 'x'), 1001);
      ai.remove(gid, 1000); ai.remove(gid, 1001);
      // random replace / add / remove rounds
      let next = 2000;
      for (let round = 0; round < 40; round++) {
        const op = r.int(4);
        const keys = [...model.keys()];
        if (op === 0 && keys.length) {
          const id = keys[r.int(keys.length)], v = randVec(r);
          ai.add(gid, id, v, `t${id}`); model.set(id, v);
        } else if (op === 1) {
          const items = Array.from({ length: 1 + r.int(12) }, () => ({ chunkId: next++, vec: randVec(r) }));
          ai.addMany(gid, items.map((it) => ({ ...it, text: `t${it.chunkId}` })));
          for (const it of items) model.set(it.chunkId, it.vec);
        } else if (keys.length) {
          const del = keys.filter(() => r.int(4) === 0);
          if (op === 3) del.push(999999); // unknown id is ignored
          const n = ai.removeMany(gid, del);
          assert.equal(n, del.filter((id) => model.has(id)).length);
          for (const id of del) model.delete(id);
          for (const id of del) assert.equal(ai.chunk(gid, id), undefined);
        }
        if (round % 8 === 7) check();
      }
      check();
      // remove everything
      ai.removeMany(gid, [...model.keys()]);
      model.clear();
      check();
      assert.deepEqual(ai.knn(gid, randVec(r)), []);
      assert.equal(db.aiVec.count(gid), 1, 'only the header row is left');
      await db.close();
    });

    test('wasm and js kernels, cached and uncached, return identical results', async () => {
      const db = open(kind);
      const a = createVectorStore(db, { kernel: 'auto' });
      const b = createVectorStore(db, { kernel: 'js', cacheBytes: 0 });
      assert.equal(b.kernel, 'js');
      const r = rng(11);
      const { data, point } = clustered(r, 700, 10, 2);
      a.addMany(1n, data.map((vec, i) => ({ chunkId: i, vec, text: `c${i}` })));
      for (let i = 0; i < 50; i++) {
        const q = point();
        const ra = a.knn(1n, q, 10), rb = b.knn(1n, q, 10);
        assert.deepEqual(ra, rb);
        assert.deepEqual(a.knn(1n, q, 10), ra); // second call: served from the cache
      }
      assert.ok(a.stats().hits >= 50);
      assert.equal(b.stats().cacheUsed, 0);
      await db.close();
    });

    test('LRU respects its byte budget; generation check catches writes from another instance', async () => {
      const db = open(kind);
      const perGuild = 100 * (D + 8);
      const a = createVectorStore(db, { cacheBytes: 3 * perGuild + 200 }); // room for 3 guilds of 100
      const w = createVectorStore(db, { cacheBytes: 0 });
      const r = rng(5);
      const vecs = new Map();
      for (let g = 1; g <= 6; g++) {
        const items = Array.from({ length: 100 }, (_, i) => ({ chunkId: i, vec: randVec(r), text: `${g}:${i}` }));
        w.addMany(g, items);
        vecs.set(g, items);
      }
      for (let pass = 0; pass < 3; pass++) {
        for (let g = 1; g <= 6; g++) {
          const it = vecs.get(g)[r.int(100)];
          assert.equal(a.knn(g, it.vec, 1)[0].chunkId, it.chunkId);
          const s = a.stats();
          assert.ok(s.cacheUsed <= s.cacheBytes, `cache ${s.cacheUsed} > budget ${s.cacheBytes}`);
          assert.ok(s.cachedGuilds <= 3);
        }
      }
      // a caches guild 1; w (another instance, like another process) replaces a vector
      const q = randVec(r);
      a.knn(1, q, 1);
      w.add(1, 42, q, 'replaced');
      assert.deepEqual(a.knn(1, q, 1).map((x) => [x.chunkId, x.text]), [[42, 'replaced']]);
      w.remove(1, 42);
      assert.notEqual(a.knn(1, q, 1)[0].chunkId, 42);
      // a guild larger than the budget is scanned uncached
      const big = Array.from({ length: 400 }, (_, i) => ({ chunkId: i, vec: randVec(r) }));
      w.addMany(99, big);
      assert.equal(a.knn(99, big[123].vec, 1, { text: false })[0].chunkId, 123);
      assert.ok(a.stats().cacheUsed <= a.stats().cacheBytes);
      await db.close();
    });

    test('txn rollback leaves vectors, header and cache untouched', async () => {
      const db = open(kind);
      const ai = attachVectors(db);
      const r = rng(3);
      const v = Array.from({ length: 10 }, () => randVec(r));
      ai.addMany(5, v.map((vec, i) => ({ chunkId: i, vec, text: `t${i}` })));
      ai.knn(5, v[0], 1); // warm the cache
      const extra = randVec(r);
      assert.throws(() => db.txn(() => {
        ai.add(5, 77, extra, 'gone');
        ai.remove(5, 3);
        assert.equal(ai.knn(5, extra, 1)[0].chunkId, 77); // visible inside the txn
        throw new Error('abort');
      }), /abort/);
      assert.equal(ai.count(5), 10);
      assert.equal(ai.knn(5, extra, 1)[0].chunkId !== 77, true);
      assert.equal(ai.knn(5, v[3], 1)[0].chunkId, 3);
      assert.equal(ai.chunk(5, 77), undefined);
      await db.close();
    });

    test('expired chunks are skipped by knn, swept, and deleting a chunk row removes its vector', async () => {
      const db = open(kind);
      const ai = attachVectors(db);
      const r = rng(9);
      const v = Array.from({ length: 20 }, () => randVec(r));
      ai.addMany(8, v.map((vec, i) => ({ chunkId: i, vec, text: `t${i}` })));
      // chunk 0 expired (written with a past expiry): its vector is still stored
      db.aiChunk.put({ gid: 8, chunkId: 0, text: 't0' }, { expiresAt: Date.now() - 1 });
      const res = ai.knn(8, v[0], 3);
      assert.equal(res.length, 3);
      assert.ok(!res.some((x) => x.chunkId === 0));
      assert.equal(ai.sweep(8), 1);
      assert.equal(ai.count(8), 19);
      // the TTL sweeper deletes with delByKey; a manual del goes through del: both drop the vector
      db.aiChunk.delByKey(db.aiChunk.keyOf(8, 5));
      db.aiChunk.del(8, 6);
      assert.equal(ai.count(8), 17);
      assert.ok(!ai.ids(8).includes(5) && !ai.ids(8).includes(6));
      ai.dropGuild(8);
      assert.equal(ai.count(8), 0);
      assert.equal(db.aiChunk.count(8), 0);
      assert.equal(db.aiVec.count(8), 0);
      await db.close();
    });

    test('argument checks', async () => {
      const db = open(kind);
      const ai = attachVectors(db);
      assert.throws(() => ai.add(1, 1, new Float32Array(10), 'x'), /256 components/);
      assert.throws(() => ai.add(1, -1, new Float32Array(D), 'x'), /u32/);
      ai.add(1, 1, randVec(rng(1)), 'x');
      assert.throws(() => ai.knn(1, new Float32Array(D + 1)), /256 components/);
      assert.throws(() => ai.knn(1, new Float32Array(D), 0), /positive/);
      const other = createVectorStore(db, { dim: 128 });
      assert.throws(() => other.knn(1, new Float32Array(128)), /dim 256/);
      assert.throws(() => createVectorStore(db, { dim: 100 }), /multiple of 16/);
      assert.deepEqual(ai.knn(2, new Float32Array(D)), []);
      await db.close();
    });
  });
}

describe('ai.quota (§5.8)', () => {
  test('atomic per-scope daily counter with a limit and a 2-day expiry', async () => {
    const db = open('memory');
    const { quota } = attachVectors(db);
    const day = quota.today();
    for (let i = 1; i <= 3; i++) assert.deepEqual(quota.use('guild', 42n, day, 3), { ok: true, used: i });
    assert.deepEqual(quota.use('guild', 42n, day, 3), { ok: false, used: 3 });
    assert.deepEqual(quota.use('guild', 42n, day, 5, 2), { ok: true, used: 5 });
    // scopes, ids and days are independent: a premium user does not lift any guild's limit
    assert.deepEqual(quota.use('user', 42n, day, 1), { ok: true, used: 1 });
    assert.deepEqual(quota.use(0, 43n, day, 1), { ok: true, used: 1 });
    assert.deepEqual(quota.use('guild', 42n, day + 1, 1), { ok: true, used: 1 });
    assert.equal(quota.used('guild', 42n), 5);
    const m = db.aiQuota.getMeta(0, 42n, day);
    assert.equal(m.expiresAt, (day + 2) * DAY);
    // a row from 2 days ago has expired: counting starts over
    assert.deepEqual(quota.use('guild', 7n, day - 2, 1), { ok: true, used: 1 });
    assert.equal(quota.used('guild', 7n, day - 2), 0);
    assert.throws(() => quota.use('server', 1n, day, 1), /scope/);
    // inside a rolled-back txn nothing sticks
    assert.throws(() => db.txn(() => { quota.use('user', 9n, day, 10); throw new Error('x'); }));
    assert.equal(quota.used('user', 9n), 0);
    await db.close();
  });
});

describe('recall and latency (§13 bench 06)', () => {
  test('recall@10 vs fp32 brute force >= 0.95 on clustered data', async () => {
    const db = open('lmdb');
    const ai = attachVectors(db);
    const r = rng(2025);
    const lines = [];
    for (const [n, clusters, noise] of [[2000, 20, 0.5], [2000, 50, 1], [5000, 50, 1], [5000, 100, 2]]) {
      const gid = n * 1000 + clusters;
      const { data, point } = clustered(r, n, clusters, noise);
      ai.addMany(gid, data.map((vec, i) => ({ chunkId: i, vec })));
      let hit = 0;
      const Q = 200;
      for (let i = 0; i < Q; i++) {
        const q = point();
        const truth = new Set(bruteTopK(data, q, 10));
        for (const x of ai.knn(gid, q, 10, { text: false })) if (truth.has(x.chunkId)) hit++;
      }
      const recall = hit / (Q * 10);
      lines.push(`N=${n} clusters=${clusters} noise=${noise}: recall@10 = ${recall.toFixed(4)}`);
      assert.ok(recall >= 0.95, lines.at(-1));
    }
    console.log(lines.join("\n"));
    await db.close();
  });

  test('knn latency p50/p99 at N = 400 / 2000 / 5000 / 20000, bytes per vector on disk', async () => {
    const db = open('lmdb');
    const ai = attachVectors(db);                                            // wasm, 4 MiB LRU
    const raw = createVectorStore(db, { cacheBytes: 0 });                    // wasm, no LRU
    const js = createVectorStore(db, { kernel: 'js', cacheBytes: 0 });       // scalar fallback
    const r = rng(99);
    const rows = [];
    for (const n of [400, 2000, 5000, 20000]) {
      const { data, point } = clustered(r, n, Math.max(10, n / 40), 2);
      db.txn(() => { for (let i = 0; i < n; i += 1000) ai.addMany(n, data.slice(i, i + 1000).map((vec, j) => ({ chunkId: i + j, vec, text: `chunk ${i + j}` }))); });
      const qs = Array.from({ length: 300 }, point);
      const measure = (store, opts) => {
        for (let i = 0; i < 30; i++) store.knn(n, qs[i], 8, opts);
        const t = qs.map((q) => { const s = process.hrtime.bigint(); store.knn(n, q, 8, opts); return Number(process.hrtime.bigint() - s) / 1e3; });
        return [pct(t, 50), pct(t, 99)];
      };
      const c = measure(ai), u = measure(raw), j = measure(js);
      rows.push({ n, c, u, j, cached: ai.stats().cachedGuilds });
    }
    const st = db.stats().hot.collections.ai_vec;
    const total = 400 + 2000 + 5000 + 20000;
    const bpv = (st.pages * 4096) / total;
    const fmt = ([a, b]) => `${a.toFixed(0)} / ${b.toFixed(0)} us`;
    console.log("knn k=8 incl. text fetch, p50 / p99:");
    for (const x of rows) console.log(`  N=${String(x.n).padStart(5)}  wasm+LRU ${fmt(x.c)}   wasm uncached ${fmt(x.u)}   js uncached ${fmt(x.j)}`);
    console.log(`ai_vec on disk: ${st.pages} pages for ${total} vectors = ${bpv.toFixed(1)} B/vector`);
    // §13 bench 06 thresholds (set for the Zen 1 target; this box is faster)
    assert.ok(rows[0].c[1] <= 1000 && rows[0].u[1] <= 1000, 'N=400 p99 <= 1 ms');
    assert.ok(rows[2].c[1] <= 8000 && rows[2].u[1] <= 8000, 'N=5000 p99 <= 8 ms');
    assert.ok(bpv < 280, `${bpv} B/vector`);
    await db.close();
  });
});

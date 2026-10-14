// Lagged indexes (src/collection.js "lagged indexes") and the event_log defaults built on them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BACKENDS, rng, tmpDir } from './util.js';
import { createCollection, runTxn, runTxnAsync } from '../src/collection.js';
import { openDB, eventLogSchema, snowflakeTs, DISCORD_EPOCH } from '../src/index.js';

const hex = (b) => Buffer.from(b.subarray(0, b.length)).toString('hex');
const SCHEMA = {
  key: 'ts:u48 seq:u16',
  indexes: {
    lg_by_chan: { key: 'gid:u64 chan:u64 ts:u48 seq:u16', lag: 50 },   // suffix mode (ends with the pk)
    lg_by_author: { key: 'author:u64', lag: 37 },                       // dup mode (value = pk)
    lg_by_msg: { key: 'msg:u64 ts:u48 seq:u16' },                       // a normal index next to them
  },
};
const id = (r) => `${r.ts}/${r.seq}`;

/** expected query result from a model of the rows (Map pk -> rec) */
function expected(model, { index, where = [], desc }) {
  const rows = [...model.values()].filter((r) => (index === 'lg_by_chan' ? where.every((v, i) => [r.gid, r.chan][i] === v) : where.every((v) => r.author === v)));
  const key = index === 'lg_by_chan' ? (r) => [r.gid, r.chan, r.ts, r.seq] : (r) => [r.author, r.ts, r.seq];
  const cmp = (a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
  rows.sort(cmp);
  if (desc) rows.reverse();
  return rows.map(id);
}

function pages(col, o, size) {
  const out = [];
  let after;
  for (let n = 0; n < 1000; n++) {
    const p = col.query({ ...o, limit: size, after });
    out.push(...p.items);
    if (!p.next) return out;
    after = p.next;
  }
  throw new Error('paging did not end');
}

for (const [bname, make] of Object.entries(BACKENDS)) {
  describe(`lagged index on ${bname}`, () => {
    test('reads always equal a model; the DBI holds exactly the rows <= watermark; catch-up is one batch', async () => {
      const { backend, cleanup } = make();
      const col = createCollection({ backend, name: 'lg', schema: SCHEMA });
      const reader = createCollection({ backend, name: 'lg', schema: SCHEMA }); // a second process's view
      const R = rng(7);
      const model = new Map();
      const gids = [1n, 2n], chans = [10n, 11n, 12n], authors = [100n, 101n, 102n, 103n];
      let ts = 1_760_000_000_000, seq = 0;
      const mk = (t) => ({ ts: t, seq: (seq = (seq + 1) & 0xffff), gid: gids[R.int(2)], chan: chans[R.int(3)], author: authors[R.int(4)], msg: BigInt(1e12 + R.int(1e9)), body: 'x'.repeat(R.int(40)) });
      const check = (label) => {
        for (const c of [col, reader]) {
          for (const desc of [false, true]) {
            for (const [index, where] of [['lg_by_chan', [1n, 11n]], ['lg_by_chan', [2n]], ['lg_by_chan', []], ['lg_by_author', [102n]], ['lg_by_author', []]]) {
              const want = expected(model, { index, where, desc });
              assert.deepEqual(c.query({ index, where, desc, limit: 10_000 }).items.map(id), want, `${label} ${index} ${where} desc=${desc}`);
              assert.deepEqual(pages(c, { index, where, desc }, 7).map(id), want, `${label} paged ${index}`);
              const cov = c.query({ index, where, desc, covered: true, limit: 10_000 }).items;
              assert.deepEqual(cov.map(id), want, `${label} covered ${index}`);
            }
          }
          assert.equal(c.countIndex('lg_by_chan'), model.size);
        }
        // invariant: DBI entries == rows with pk <= W
        const meta = backend.openCollection('__meta', {});
        for (const [ixName, lag] of [['lg_by_chan', 50], ['lg_by_author', 37]]) {
          const wb = backend.get(meta, Buffer.from(`w:${ixName}`));
          const w = wb === undefined ? null : hex(wb);
          const below = [...model.values()].filter((r) => w !== null && hex(col.keyOf(r.ts, r.seq)) <= w).length;
          const d = backend.openCollection(ixName, { dupSort: ixName === 'lg_by_author' });
          assert.equal([...backend.range(d, {})].length, below, `${label}: ${ixName} DBI = rows <= W`);
          assert.ok(model.size - below <= lag + 60, `${label}: ${ixName} tail ${model.size - below} bounded by lag`);
        }
      };
      for (let round = 0; round < 30; round++) {
        const batch = [];
        for (let i = 0; i < 10 + R.int(30); i++) batch.push(mk((ts += 1 + R.int(30))));
        if (R.float() < 0.2) batch.push(mk(ts - 5000 - R.int(100000))); // late row: may land below W
        const abort = R.float() < 0.15;
        const ops = () => {
          for (const r of batch) col.put(r);
          if (R.float() < 0.4 && model.size) { const victim = [...model.values()][R.int(model.size)]; col.del(victim.ts, victim.seq); if (!abort) model.delete(id(victim)); }
          if (R.float() < 0.4 && model.size) { const v = { ...[...model.values()][R.int(model.size)], chan: chans[R.int(3)], author: authors[R.int(4)] }; col.put(v); if (!abort) model.set(id(v), v); }
          if (abort) throw new Error('abort');
        };
        if (abort) {
          if (R.float() < 0.5) assert.throws(() => runTxn(backend, ops), /abort/);
          else await assert.rejects(runTxnAsync(backend, ops), /abort/);
        } else {
          if (R.float() < 0.5) runTxn(backend, ops); else await runTxnAsync(backend, ops);
          for (const r of batch) model.set(id(r), r);
        }
        if (round % 5 === 4) check(`round ${round}`);
      }
      check('end');
      // a read inside a write txn sees that txn's rows
      assert.throws(() => runTxn(backend, () => {
        const r = mk((ts += 10));
        col.put(r);
        assert.ok(col.query({ index: 'lg_by_chan', where: [r.gid, r.chan], desc: true, limit: 1 }).items.map(id).includes(id(r)));
        throw new Error('rollback');
      }), /rollback/);
      check('after an aborted read-your-write');
      col.flushLagged();
      const meta = backend.openCollection('__meta', {});
      const last = [...model.values()].map((r) => hex(col.keyOf(r.ts, r.seq))).sort().at(-1);
      assert.equal(hex(backend.get(meta, Buffer.from('w:lg_by_chan'))), last, 'flushLagged moves W to the last pk');
      check('after flushLagged');
      col.reindex();
      check('after reindex');
      await cleanup();
    });
  });
}

describe('lagged index persistence (lmdb)', () => {
  test('the tail is rebuilt from disk after a reopen; catch-up writes one batch', async () => {
    const dir = tmpDir('lagged');
    let db = openDB({ dir, schemas: {}, boot: false });
    let col = db.collection('lg', { ...SCHEMA, indexes: { lg_by_chan: { key: 'gid:u64 chan:u64 ts:u48 seq:u16', lag: 100 } } });
    db.txn(() => { for (let i = 0; i < 150; i++) col.put({ ts: 1000 + i, seq: 0, gid: 1n, chan: BigInt(i % 3), author: 1n }); });
    const be = db.backend('hot');
    const ixd = be.openCollection('lg_by_chan', {});
    assert.equal(be.stat(ixd).entries, 100, 'the write that crossed lag=100 caught the first 100 up, in its txn');
    db.txn(() => { for (let i = 150; i < 190; i++) col.put({ ts: 1000 + i, seq: 0, gid: 1n, chan: BigInt(i % 3), author: 1n }); });
    assert.equal(be.stat(ixd).entries, 100, '90 rows wait in the tail');
    await db.close();
    db = openDB({ dir, schemas: {}, boot: false });
    col = db.collection('lg', { ...SCHEMA, indexes: { lg_by_chan: { key: 'gid:u64 chan:u64 ts:u48 seq:u16', lag: 100 } } });
    assert.equal(col.query({ index: 'lg_by_chan', where: [1n, 2n], limit: 1000 }).items.length, 63);
    assert.deepEqual(col.query({ index: 'lg_by_chan', where: [1n, 1n], desc: true, limit: 2 }).items.map((r) => r.ts), [1187, 1184]);
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('event_log defaults', () => {
  for (const kind of ['memory', 'lmdb']) {
    test(`time-ordered bucket, lagged channel index, byMessageId, windowed reads (${kind})`, async () => {
      const dir = kind === 'lmdb' ? tmpDir('elog') : undefined;
      const db = openDB({ dir, backend: kind, boot: false, schemas: {} });
      const elog = db.bucketed('event_log', eventLogSchema, { retentionDays: 30 });
      const snow = (t, n) => ((BigInt(t - DISCORD_EPOCH) << 22n) | BigInt(n));
      const T = Date.UTC(2026, 9, 31, 23, 59, 0); // the window crosses into November
      const rows = [];
      for (let i = 0; i < 400; i++) {
        const ts = T + i * 250;
        rows.push({ gid: 7n, chan: BigInt(i % 4), ts, k: 0, msgId: snow(ts, i), authorId: BigInt(i % 5), content: `m${i}` });
      }
      elog.appendMany(rows.slice(0, 200));
      // an edit and a delete of message 3, logged later
      const m3 = rows[3];
      elog.appendMany([{ gid: 7n, chan: m3.chan, ts: T + 50_000, k: 1, msgId: m3.msgId, content: 'm3 edited' }]);
      elog.appendMany(rows.slice(200));
      elog.append({ gid: 7n, chan: m3.chan, ts: T + 120_000, k: 2, msgId: m3.msgId });
      assert.deepEqual(elog.buckets(), ['event_log_202610', 'event_log_202611']);
      assert.equal(snowflakeTs(m3.msgId), m3.ts);
      const versions = elog.byMessageId(m3.msgId);
      assert.deepEqual(versions.map((r) => [r.k, r.content]), [[0, 'm3'], [1, 'm3 edited'], [2, undefined]]);
      assert.deepEqual(elog.byMessageId(String(rows[399].msgId)).map((r) => r.content), ['m399']);
      // latest 5 of channel 2, across the month boundary
      const want = rows.filter((r) => r.chan === 2n).slice(-5).reverse().map((r) => r.content);
      assert.deepEqual(elog.query({ index: 'elog_by_chan', where: [7n, 2n], desc: true, limit: 5 }).items.map((r) => r.content), want);
      // a time window of one channel: bounds, not a filter
      const from = T + 10_000, to = T + 30_000;
      const win = rows.filter((r) => r.chan === 1n && r.ts >= from && r.ts < to).map((r) => r.content);
      assert.deepEqual(elog.query({ index: 'elog_by_chan', where: [7n, 1n], from, to }).items.map((r) => r.content), win);
      // whole log in time order, paged across months
      let after, all = [];
      for (;;) { const p = elog.query({ limit: 64, after }); all.push(...p.items); if (!p.next) break; after = p.next; }
      assert.equal(all.length, 402);
      assert.ok(all.every((r, i) => i === 0 || all[i - 1].ts <= r.ts));
      await db.close();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });
  }
});

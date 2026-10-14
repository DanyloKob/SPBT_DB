// Regression tests for the bugs fixed in the 2026-10-14 review (CHANGELOG "Fixed").
// One test per fix, on both backends unless the bug was backend-specific.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDB, createCollection } from '../src/index.js';
import { tmpDir } from './util.js';
import { fakeTime, openDb, until } from './ext-util.js';

const GID = 1100000000000000001n;
const uid = (i) => 2000000000000000000n + BigInt(i);
const quiet = () => {};

for (const kind of ['memory', 'lmdb']) {
  describe(`regressions on ${kind}`, () => {
    test('A: a coalescer flush (txnAsync) triggered inside db.txn neither throws nor joins that txn', async () => {
      const h = openDb(kind, { coalesce: { level: { flushMs: 1e9, maxEntries: 3 } } });
      const { db } = h;
      // the third bump reaches maxEntries and starts a flush while the caller's txn is open
      db.txn(() => {
        db.kv.put({ k: 'case', n: 1 });
        for (let i = 1; i <= 3; i++) db.level.bump(GID, uid(i), 10);
      });
      assert.deepEqual(db.kv.get('case'), { n: 1 }, "the caller's txn committed");
      await db.level.bumps.flush();
      for (let i = 1; i <= 3; i++) assert.equal(db.level.get(GID, uid(i)).xp, 10, 'the flushed batch was not lost');
      // a txnAsync started inside a txn that then aborts is its own commit, after that txn
      let p;
      assert.throws(() => db.txn(() => {
        p = db.txnAsync(() => db.kv.put({ k: 'async', n: 2 }));
        db.kv.put({ k: 'rolled-back', n: 3 });
        throw new Error('abort');
      }), /abort/);
      await p;
      assert.deepEqual(db.kv.get('async'), { n: 2 });
      assert.equal(db.kv.get('rolled-back'), undefined);
      await h.cleanup();
    });

    test('B: shared structures saved before a failed savepoint are forgotten when the outer txn aborts', async () => {
      const h = openDb(kind, { schemas: {}, boot: false });
      const { db } = h;
      const c = db.collection('t', { key: 'id:u32' });
      assert.throws(() => db.txn(() => {
        c.put({ id: 1, alpha: 1, beta: 2 }); // saves a new structure inside the txn
        assert.throws(() => db.txn(() => { throw new Error('inner'); }), /inner/);
        c.put({ id: 2, alpha: 3, beta: 4 });
        throw new Error('outer');
      }), /outer/);
      c.put({ id: 3, alpha: 5, beta: 6 });
      // a second reader (another process, or a reopen) only knows the persisted structures
      const fresh = createCollection({ backend: db.backend('hot'), name: 't', schema: { key: 'id:u32' } });
      assert.deepEqual(fresh.get(3), { alpha: 5, beta: 6 });
      assert.equal(c.get(1), undefined);
      await h.cleanup();
    });

    test('C: patch and incr keep "never expires" in a collection with a default ttl', async () => {
      const h = openDb(kind, { schemas: {}, boot: false });
      const c = h.db.collection('sess', { key: 'id:u32', ttl: 60_000 });
      c.put({ id: 1, a: 1 }, { expiresAt: 0 });
      c.patch(1, { a: 2 });
      assert.equal(c.getMeta(1).expiresAt, 0, 'patch');
      c.put({ id: 2, n: 1 }, { expiresAt: 0 });
      c.incr(2, 'n', 1);
      assert.equal(c.getMeta(2).expiresAt, 0, 'incr');
      // records that do have an expiry keep it; new records still get the default
      c.put({ id: 3, a: 1 }, { expiresAt: Date.now() + 5000 });
      const exp = c.getMeta(3).expiresAt;
      c.patch(3, { a: 2 });
      assert.equal(c.getMeta(3).expiresAt, exp);
      c.patch(4, { a: 1 });
      assert.ok(c.getMeta(4).expiresAt > Date.now() + 50_000);
      await h.cleanup();
    });

    test('D: an entry that cannot be written is dropped alone; a failing txn is retried on the timer, not in a loop', async () => {
      const errors = [];
      const h = openDb(kind, { coalesce: { level: { flushMs: 1e9, maxEntries: 3, onError: (e, n, info) => errors.push(info) } } });
      const { db } = h;
      db.level.put({ gid: GID, uid: uid(1), xp: 5 });
      db.level.bump(GID, uid(1), -10); // xp -5 cannot be stored (uint varint): poison
      db.level.bump(GID, uid(2), 7);
      db.level.bump(GID, uid(3), 7); // maxEntries: flush
      await until(() => db.level.bumps.metrics().pending === 0 && !db.level.bumps.metrics().inflight);
      assert.equal(db.level.get(GID, uid(2)).xp, 7);
      assert.equal(db.level.get(GID, uid(3)).xp, 7);
      assert.equal(db.level.get(GID, uid(1)).xp, 5, 'the poisoned entry was rolled back alone');
      const m = db.level.bumps.metrics();
      assert.equal(m.errors, 1, 'one failed flush, then one isolated retry that committed');
      assert.equal(m.rejected, 1);
      assert.equal(m.written, 2);
      assert.equal(m.failing, false);
      assert.ok(errors.some((i) => i && i.rejected));
      await h.cleanup();

      // every entry fails (the txn itself): no retry storm; only the timer retries
      const t = fakeTime();
      const h2 = openDb(kind, { clock: t.clock, timers: t, coalesce: { level: { flushMs: 1000, maxEntries: 2, onError: quiet } } });
      const db2 = h2.db;
      h2.hot.failNext = 1000;
      db2.level.bump(GID, uid(1), 1);
      db2.level.bump(GID, uid(2), 1); // maxEntries: flush -> fails -> isolated retry -> fails
      await until(() => db2.level.bumps.metrics().errors === 2 && !db2.level.bumps.metrics().inflight);
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      assert.equal(1000 - h2.hot.failNext, 2, 'two attempts, then it waits for the timer');
      for (let i = 0; i < 5; i++) db2.level.bump(GID, uid(3 + i), 1); // above maxEntries: no new attempt while failing
      await new Promise((r) => setImmediate(r));
      assert.equal(1000 - h2.hot.failNext, 2);
      assert.ok(t.peek(), 'the retry timer is armed');
      h2.hot.failNext = 0;
      t.fireNext();
      await until(() => db2.level.bumps.metrics().pending === 0 && !db2.level.bumps.metrics().inflight);
      for (let i = 1; i <= 7; i++) assert.equal(db2.level.get(GID, uid(i)).xp, 1, 'nothing was dropped');
      assert.equal(db2.level.bumps.metrics().rejected, 0);
      await h2.cleanup();
    });

    test('E: a bad reschedule fails only its own job; a failed batch commit backs off', async () => {
      const t = fakeTime();
      const seen = [];
      const h = openDb(kind, { clock: t.clock, timers: t, sched: { autoStart: false, onError: (e, job, info) => seen.push([job && job.subject, info && info.final]) } });
      const s = h.db.sched;
      s.defineKind('t', 100);
      const runs = new Map();
      s.on('t', (job) => {
        runs.set(job.subject, (runs.get(job.subject) ?? 0) + 1);
        if (job.subject === 1n) return { reschedule: 'soon' }; // not a time
        if (job.subject === 3n) return { reschedule: 1e300 }; // clamped to the u48 maximum, like at()
      });
      for (const sub of [1, 2, 3]) s.at(t.now - 1, { kind: 't', subject: sub });
      for (let i = 0; i < 3; i++) await s.runDue();
      assert.deepEqual([...runs].map(([k, v]) => [Number(k), v]).sort(), [[1, 1], [2, 1], [3, 1]], 'each handler ran once');
      assert.deepEqual(seen, [[1n, true]], 'the bad reschedule is a final failure of job 1');
      assert.equal(s.count(), 1, 'only the clamped reschedule of job 3 is left');
      assert.equal(s.next().dueAt, 0xffffffffffff);
      s.cancel(0n);
      // a batch whose commit throws: the next wake waits stallMs instead of 0 ms
      s.start();
      s.at(t.now - 1, { kind: 't', subject: 9 });
      h.hot.failNextSync = 1;
      await assert.rejects(s.runDue(), /injected/);
      assert.equal(t.delays.at(-1), 1000, 'stallMs, not a busy loop');
      await s.runDue();
      assert.equal(runs.get(9n), 2, 'at-least-once: the job ran again after the failed commit');
      assert.equal(s.count(), 0);
      await h.cleanup();
    });

    test('F: due jobs of kinds without a handler do not starve a handled job behind them', async () => {
      const t = fakeTime();
      const h = openDb(kind, { clock: t.clock, timers: t, sched: { autoStart: false } });
      const s = h.db.sched;
      s.defineKind('nohandler', 100);
      s.defineKind('ok', 101);
      const due = t.now - 10_000;
      h.db.txn(() => { for (let i = 0; i < 2001; i++) s.at(due, { kind: 'nohandler', subject: i }); });
      let fired = 0;
      s.on('ok', () => { fired++; });
      s.at(due + 1, { kind: 'ok', subject: 1 });
      await s.runDue();
      assert.equal(fired, 1);
      assert.equal(s.stats().unhandled, 2001);
      assert.equal(s.count(), 2001);
      await h.cleanup();
    });

    test('G: dropCollection removes the lagged-index watermark AND epoch keys', async () => {
      const h = openDb(kind, { schemas: {}, boot: false });
      const { db } = h;
      const c = db.collection('ev', { key: 'ts:u48 seq:u16', indexes: { ev_by_g: { key: 'g:u32 ts:u48 seq:u16', lag: 4 } } });
      for (let i = 0; i < 6; i++) c.put({ ts: 1000 + i, seq: 0, g: 1 }); // a catch-up writes w:
      c.put({ ts: 1005, seq: 0, g: 2 }); // overwrite of a tail row: writes e:
      const be = db.backend('hot');
      const meta = be.openCollection('__meta', {});
      const keys = () => [...be.range(meta, {})].map((e) => e.key.toString()).filter((k) => k.endsWith('ev_by_g'));
      assert.deepEqual(keys().sort(), ['e:ev_by_g', 'w:ev_by_g']);
      db.dropCollection('ev');
      assert.deepEqual(keys(), []);
      await h.cleanup();
    });

    test('I: flush() during an in-flight flush resolves only after the newer ops are committed', async () => {
      const h = openDb(kind, { coalesce: { level: { flushMs: 1e9, maxEntries: 1e9 } } });
      const { db } = h;
      db.level.bump(GID, uid(1), 1);
      const p1 = db.level.bumps.flush();
      db.level.bump(GID, uid(2), 5);
      await db.level.bumps.flush();
      assert.equal(db.level.get(GID, uid(2))?.xp, 5);
      assert.equal(db.level.bumps.pending, 0);
      await p1;
      await h.cleanup();
    });

    test('J: TTL job mode deletes rows whose job fired inside the fire-early window', async () => {
      let now = 1_800_000_000_000;
      const clock = () => now;
      const h = openDb(kind, { clock, sched: { autoStart: false }, ttl: { schedule: false } });
      const { db } = h;
      const col = db.collection('tok', { key: 'id:u32', ttlSweep: 'job' });
      col.put({ id: 1, v: 'a' }, { expiresAt: now + 1000 });
      col.put({ id: 2, v: 'b' }, { expiresAt: now + 1030 }); // its job runs in the same wake as id 1's
      col.put({ id: 3, v: 'c' }, { expiresAt: now + 1040 });
      col.put({ id: 3, v: 'c2' }, { expiresAt: now + 90_000 }); // refreshed: its first job must just end
      now += 1000;
      await db.sched.runDue();
      assert.equal(col.count(), 2, 'id 1 deleted; id 2 not yet expired, its job re-armed');
      now += 100;
      await db.sched.runDue();
      assert.equal(col.count(), 1, 'id 2 deleted on time');
      assert.equal(db.sched.count(), 1, 'only the refreshed row has a job');
      now += 90_000;
      await db.sched.runDue();
      assert.equal(col.count(), 0);
      assert.equal(db.sched.count(), 0);
      await h.cleanup();
    });

    test('P: string and fractional query limits are honoured', async () => {
      const h = openDb(kind);
      const { db } = h;
      db.txn(() => { for (let i = 1; i <= 50; i++) db.level.put({ gid: GID, uid: uid(i), xp: i }); });
      assert.equal(db.level.top(GID, '10').length, 10);
      const r = db.level.query({ limit: 2.5 });
      assert.equal(r.items.length, 2);
      assert.ok(r.next, 'a cursor for the rest');
      assert.equal(db.level.query({ limit: 2, after: r.next }).items[0].uid, uid(3));
      assert.throws(() => db.level.query({ limit: 'ten' }), /limit/);
      const elog = db.bucketed('ev', { key: 'ts:u48 seq:u16' }, { env: 'hot' });
      const t0 = Date.UTC(2026, 8, 30, 23, 0);
      for (let i = 0; i < 6; i++) elog.append({ ts: t0 + i * 20 * 60_000, seq: 0, n: i }); // spans two months
      assert.equal(elog.buckets().length, 2);
      assert.equal(elog.query({ limit: '3' }).items.length, 3, 'merged query');
      assert.equal(elog.query({ limit: 1.5, from: t0, to: t0 + 60_000 }).items.length, 1, 'single-month query');
      await h.cleanup();
    });
  });
}

test('H: close() twice resolves (no touching closed envs) and the second call shares the first', async () => {
  const dir = tmpDir('close-twice');
  const db = openDB({ dir });
  db.level.put({ gid: GID, uid: uid(1), xp: 1 });
  const a = db.close();
  const b = db.close();
  assert.equal(a, b);
  await a;
  await db.close();
  const db2 = openDB({ dir });
  assert.equal(db2.bootInfo().lastShutdownClean, true);
  assert.equal(db2.level.get(GID, uid(1)).xp, 1);
  await db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

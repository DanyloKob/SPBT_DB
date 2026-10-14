import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDB, flushAllPending, createAppender } from '../src/index.js';
import { tmpDir } from './util.js';
import { fakeTime, openDb, until } from './ext-util.js';

const here = dirname(fileURLToPath(import.meta.url));
const GID = 1100000000000000001n;
const uid = (i) => 2000000000000000000n + BigInt(i);

for (const kind of ['memory', 'lmdb']) {
  describe(`coalescers on ${kind}`, () => {
    test('level.bump buffers in RAM and a flush is exactly ONE commit; xp and leaderboard correct', async () => {
      const h = openDb(kind, { coalesce: { level: { flushMs: 60_000, maxEntries: 1e9 } } });
      const { db } = h;
      db.txn(() => { for (let i = 0; i < 100; i++) db.level.put({ gid: GID, uid: uid(i), xp: 1000 }); });
      const expect = new Map();
      for (let i = 0; i < 500; i++) expect.set(uid(i), i < 100 ? 1000 : 0);
      const c0 = h.hot.commits;
      for (let i = 0; i < 20_000; i++) {
        const u = uid(i % 500), d = 1 + (i % 3);
        db.level.bump(i % 2 ? GID : String(GID), i % 3 ? u : String(u), d); // bigint and string ids hit the same key
        expect.set(u, expect.get(u) + d);
      }
      assert.equal(h.hot.commits, c0, 'nothing written while buffering');
      const m = db.level.bumps.metrics();
      assert.equal(m.pending, 500);
      assert.equal(m.ops, 20_000);
      assert.ok(db.level.bumps.peek(GID, uid(7)) > 0);
      assert.equal(db.level.bumps.peek(GID, uid(7)), db.level.bumps.peek(String(GID), String(uid(7))));
      await db.level.bumps.flush();
      assert.equal(h.hot.commits - c0, 1, 'ONE commit for 500 keys / 20k bumps');
      const after = db.level.bumps.metrics();
      assert.equal(after.pending, 0);
      assert.equal(after.flushes, 1);
      assert.equal(after.written, 500);
      for (const [u, xp] of expect) assert.equal(db.level.get(GID, u).xp, xp);
      const top = db.level.top(GID, 500);
      assert.equal(top.length, 500, 'level_by_xp has exactly one entry per member');
      for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].xp >= top[i].xp);
      await h.cleanup();
    });

    test('maxEntries triggers flushes; every flush is one commit', async () => {
      const h = openDb(kind, { coalesce: { level: { flushMs: 1e9, maxEntries: 100 } } });
      const { db } = h;
      db.level.bump(GID, uid(0), 1); // creates the coalescer
      await db.level.bumps.flush();
      const c0 = h.hot.commits;
      // 10 bursts of 100 new keys, with event-loop turns between them; flush() is never called
      for (let r = 0; r < 10; r++) {
        for (let i = 0; i < 100; i++) db.level.bump(GID, uid(r * 100 + i), 2);
        await until(() => !db.level.bumps.metrics().inflight);
      }
      const m = db.level.bumps.metrics();
      assert.equal(m.flushes, 11, 'one flush per 100-key burst (+1 setup)');
      assert.equal(m.lastFlushEntries, 100);
      assert.equal(m.pending, 0);
      assert.equal(h.hot.commits - c0, 10, 'commits == flushes');
      // deltas that net to zero: the 10 maxEntries flushes open no txn at all
      for (let i = 0; i < 1000; i++) db.level.bump(GID, uid(i), 0);
      await until(() => !db.level.bumps.metrics().inflight && !db.level.bumps.pending);
      assert.equal(db.level.bumps.metrics().flushes, 21);
      assert.equal(h.hot.commits - c0, 10, 'no commit, no fsync for a no-op flush');
      // a synchronous burst while a flush is in flight keeps buffering; the rest goes out as ONE follow-up flush
      const c1 = h.hot.commits, f1 = db.level.bumps.metrics().flushes;
      for (let i = 0; i < 1000; i++) db.level.bump(GID, uid(i), 1);
      await until(() => !db.level.bumps.metrics().inflight && !db.level.bumps.pending);
      assert.equal(db.level.bumps.metrics().flushes - f1, 2, 'flush at 100 keys, then one flush of the 900 buffered meanwhile');
      assert.equal(h.hot.commits - c1, 2);
      assert.equal(db.level.get(GID, uid(500)).xp, 3);
      assert.equal(db.level.get(GID, uid(0)).xp, 4, "1 (setup) + 2 + 0 + 1");
      assert.equal(db.level.get(GID, uid(999)).xp, 3);
      assert.equal(db.level.count(GID), 1000);
      await h.cleanup();
    });

    test('flushMs timer (fake timers) bounds the lag; lag metrics', async () => {
      const t = fakeTime();
      const h = openDb(kind, { clock: t.clock, timers: t, coalesce: { level: { flushMs: 30_000 } } });
      const { db } = h;
      db.level.bump(GID, uid(1), 5);
      assert.equal(t.delays.at(-1), 30_000, 'timer armed at the first buffered op');
      t.now += 10_000;
      db.level.bump(GID, uid(2), 5);
      assert.equal(t.pending.size, 1, 'one timer, not one per op');
      assert.equal(db.level.bumps.metrics().oldestAgeMs, 10_000);
      t.fireNext();
      await db.level.bumps.flush(); // waits for the in-flight timer flush
      const m = db.level.bumps.metrics();
      assert.equal(m.flushes, 1);
      assert.equal(m.lastAgeMs, 30_000);
      assert.equal(m.oldestAgeMs, 0);
      assert.equal(t.pending.size, 0, 'idle: no timer armed');
      assert.equal(db.level.get(GID, uid(1)).xp, 5);
      await h.cleanup();
    });

    test('generic coalescer: patch (last write wins per field) and a custom associative merge', async () => {
      const h = openDb(kind);
      const { db } = h;
      const pvc = db.collection('pvc_room', { key: 'chan:u64' });
      pvc.put({ chan: 1n, ownerId: 5n, isPublic: false, invited: [] });
      const rooms = db.coalescer(pvc, undefined, { flushMs: 1e9 });
      rooms.add({ chan: 1n, isPublic: true });
      rooms.add({ chan: 1n, invited: [7n] });
      rooms.add({ chan: 2n, ownerId: 9n });
      assert.deepEqual(rooms.peek(1n), { chan: 1n, isPublic: true, invited: [7n] });
      const c0 = h.hot.commits;
      await rooms.flush();
      assert.equal(h.hot.commits - c0, 1);
      assert.deepEqual(pvc.get(1n), { ownerId: 5n, isPublic: true, invited: [7n] });
      assert.deepEqual(pvc.get(2n), { ownerId: 9n });

      const stat = db.collection('automod_hour', { key: 'gid:u64 hour:u32' });
      const sum = (a, b) => ({ ...b, joins: (a.joins ?? 0) + (b.joins ?? 0), peak: Math.max(a.peak ?? 0, b.peak ?? 0) });
      const agg = db.coalescer(stat, sum, { flushMs: 1e9 });
      for (let i = 0; i < 10; i++) agg.add({ gid: 1n, hour: 7, joins: 1, peak: i });
      await agg.flush();
      for (let i = 0; i < 5; i++) agg.add({ gid: 1n, hour: 7, joins: 2, peak: 3 });
      await agg.flush();
      assert.deepEqual(stat.get(1n, 7), { joins: 20, peak: 9 });
      assert.equal(db.coalesceMetrics().length, 2);
      await h.cleanup();
    });

    test('a failed commit keeps the batch and the next flush writes it', async () => {
      const h = openDb(kind, { coalesce: { level: { flushMs: 1e9, onError: () => {} } } });
      const { db } = h;
      db.level.bump(GID, uid(1), 10);
      h.hot.failNext = 1;
      await assert.rejects(db.level.bumps.flush(), /injected/);
      db.level.bump(GID, uid(1), 5);
      assert.equal(db.level.bumps.pending, 1);
      await db.level.bumps.flush();
      assert.equal(db.level.get(GID, uid(1)).xp, 15, 'restored deltas merged with newer ones');
      assert.equal(db.level.bumps.metrics().errors, 1);
      await h.cleanup();
    });

    test('flushAllPending (the beforeExit listener) and close() flush every buffer', async () => {
      const h = openDb(kind, { coalesce: { level: { flushMs: 1e9 } } });
      const { db } = h;
      db.level.bump(GID, uid(1), 1);
      const kvc = db.coalescer(db.kv, undefined, { flushMs: 1e9 });
      kvc.add({ k: 'x', v: 1 });
      await flushAllPending();
      assert.equal(db.level.get(GID, uid(1)).xp, 1);
      assert.deepEqual(db.kv.get('x'), { v: 1 });
      db.level.bump(GID, uid(1), 1);
      kvc.add({ k: 'x', v: 2 });
      if (kind === 'lmdb') {
        await h.close();
        const db2 = openDB({ dir: h.dir });
        assert.equal(db2.level.get(GID, uid(1)).xp, 2, 'close() flushed');
        assert.deepEqual(db2.kv.get('x'), { v: 2 });
        assert.equal(db2.bootInfo().lastShutdownClean, true);
        await db2.close();
      }
      await h.cleanup();
    });

    test('appender: ring cap drops the oldest rows; maxEntries flushes in one commit', async () => {
      const h = openDb(kind);
      const { db } = h;
      const log = db.collection('log_test', { key: 'ts:u48 seq:u16' });
      const app = createAppender(db.backend('hot'), (rows) => { for (const r of rows) log.put(r); }, { flushMs: 1e9, maxEntries: 1e9, cap: 100 });
      db.coalescers.add(app);
      for (let i = 0; i < 150; i++) app.append({ ts: 1000 + i, seq: 0, msg: `m${i}` });
      assert.equal(app.pending, 100);
      assert.equal(app.metrics().dropped, 50);
      const c0 = h.hot.commits;
      await app.flush();
      assert.equal(h.hot.commits - c0, 1);
      assert.equal(log.count(), 100);
      assert.equal(log.range({ limit: 1 })[0].msg, 'm50', 'oldest 50 dropped');
      await h.cleanup();
    });
  });
}

describe('__boot', () => {
  test('first open, clean close, reopen (lmdb)', async () => {
    const dir = tmpDir('boot');
    const db1 = openDB({ dir });
    const b1 = db1.bootInfo();
    assert.equal(b1.previous, null);
    assert.equal(b1.lastShutdownClean, null);
    assert.equal(b1.current.writerPid, process.pid);
    assert.equal(db1.kv.get('__boot').cleanShutdown, false, 'dirty while running');
    await db1.close();
    const db2 = openDB({ dir });
    const b2 = db2.bootInfo();
    assert.equal(b2.lastShutdownClean, true);
    assert.equal(b2.previous.bootId, b1.current.bootId);
    assert.ok(b2.previous.stoppedAt >= b2.previous.startedAt);
    assert.equal(b2.dirtyBoots, 0);
    await db2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('kill -9 loses only the coalescer buffer and the next open reports a dirty boot (lmdb)', () => {
    const dir = tmpDir('kill9');
    const src = pathToFileURL(join(here, '..', 'src', 'index.js')).href;
    const child = `
      import { openDB } from ${JSON.stringify(src)};
      const db = openDB({ dir: ${JSON.stringify(dir)}, coalesce: { level: { flushMs: 1e9 } } });
      for (let i = 0; i < 100; i++) db.level.bump(${GID}n, ${uid(0)}n + BigInt(i), 10);
      await db.level.bumps.flush();                       // committed: survives
      for (let i = 0; i < 100; i++) db.level.bump(${GID}n, ${uid(0)}n + BigInt(i), 1);   // buffered: lost
      process.kill(process.pid, 'SIGKILL');
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: process.env, encoding: 'utf8' });
    assert.equal(r.signal, 'SIGKILL', r.stderr);
    const db = openDB({ dir });
    const b = db.bootInfo();
    assert.equal(b.lastShutdownClean, false);
    assert.equal(b.dirtyBoots, 1);
    assert.notEqual(b.previous.writerPid, process.pid);
    for (let i = 0; i < 100; i++) assert.equal(db.level.get(GID, uid(i)).xp, 10, 'flushed bumps survive, buffered ones are gone');
    assert.equal(db.level.top(GID, 1000).length, 100);
    return db.close().then(() => fs.rmSync(dir, { recursive: true, force: true }));
  });
});

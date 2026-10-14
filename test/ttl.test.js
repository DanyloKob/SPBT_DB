import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDB } from '../src/index.js';
import { tmpDir } from './util.js';
import { fakeTime, openDb, DAY } from './ext-util.js';

const SESS = {
  key: 'sid:u32',
  ttl: 3600_000,
  indexes: { sess_by_user: { key: 'uid:u64' } },
};

for (const kind of ['memory', 'lmdb']) {
  describe(`ttl sweeper on ${kind}`, () => {
    test('scan mode: deletes only expired rows, <= batch deletes per txn, indexes maintained', async () => {
      const h = openDb(kind, { ttl: { batch: 100, scanBudget: 250, schedule: false } });
      const col = h.db.collection('sess', SESS);
      const past = Date.now() - 1000;
      // one-time writes first (shape structures, the kv __ttl registry), so the counts below are pure
      col.put({ sid: 99999, uid: 1n }, { expiresAt: past });
      assert.equal((await h.db.ttl.sweep()).deleted, 1);
      h.db.txn(() => {
        for (let i = 0; i < 1000; i++) col.put({ sid: i, uid: BigInt(i % 7) }, i % 4 === 0 ? undefined : { expiresAt: past });
      });
      assert.equal(col.count(), 1000, 'expired rows are still physically there');
      assert.equal(col.countLive(), 250, 'but invisible');
      assert.deepEqual(h.db.ttl.targets(), ['sess']);
      const c0 = h.hot.commits, l0 = h.hot.log.length;
      const r = await h.db.ttl.sweep();
      assert.equal(r.deleted, 750);
      assert.equal(r.txns, 8, '750 deletes / batch 100');
      assert.equal(h.hot.commits - c0, r.txns, 'one commit per batch, nothing else');
      assert.ok(r.maxPerTxn <= 100);
      // each txn deleted <= 100 records (+ their index entries)
      for (const s of h.hot.log.slice(l0)) assert.ok(s.dels <= 200, `txn with ${s.dels} deletes`);
      assert.equal(col.count(), 250);
      assert.equal(col.countIndex('sess_by_user'), 250, 'index entries removed with their rows');
      assert.equal(col.get(4).uid, 4n, "live rows untouched");
      assert.ok(col.has(4) && !col.has(5));
      const again = await h.db.ttl.sweep();
      assert.equal(again.deleted, 0);
      await h.cleanup();
    });

    test('a collection seen writing TTL frames is swept and remembered across restarts', async () => {
      const h = openDb(kind, { ttl: { schedule: false } });
      const col = h.db.collection('link_cooldown', { key: 'uid:u64' }); // no schema.ttl
      assert.deepEqual(h.db.ttl.targets(), []);
      col.put({ uid: 1n, lastActionAt: 1 }, { expiresAt: Date.now() - 1 });
      col.put({ uid: 2n, lastActionAt: 2 }, { ttl: 7 * DAY });
      assert.deepEqual(h.db.ttl.targets(), ['link_cooldown']);
      const r = await h.db.ttl.sweep();
      assert.equal(r.deleted, 1);
      assert.deepEqual(h.db.kv.get('__ttl'), { cols: ['link_cooldown'] });
      if (kind === 'lmdb') {
        await h.close();
        const db2 = openDB({ dir: h.dir, ttl: { schedule: false } });
        db2.collection('link_cooldown', { key: 'uid:u64' });
        assert.deepEqual(db2.ttl.targets(), ['link_cooldown'], 'restored from kv __ttl');
        await db2.close();
      }
      await h.cleanup();
    });

    test("job mode: an expire job is queued in the same txn and deletes only still-expired rows", async () => {
      const t = fakeTime();
      const h = openDb(kind, { sched: { autoStart: false }, ttl: { schedule: false }, clock: t.clock, timers: t });
      const col = h.db.collection('ai_chunk', { key: 'gid:u64 id:u32', ttlSweep: 'job' });
      const base = Date.now();
      col.put({ gid: 1n, id: 1, text: 'a' }, { expiresAt: base + 1000 }); // first shape: +1 structures commit
      const c0 = h.hot.commits;
      col.put({ gid: 1n, id: 2, text: 'b' }, { expiresAt: base + 1000 });
      assert.equal(h.hot.commits - c0, 1, 'row + its expire job: one commit');
      col.put({ gid: 1n, id: 2, text: 'b2' }, { expiresAt: base + 10 * DAY }); // refreshed
      assert.equal(h.db.sched.count(), 3);
      const be = h.db.backend('hot');
      assert.equal(be.stat(be.openCollection('sched_by_subject', { dupSort: true })).entries, 0, 'expire jobs are not indexed');
      assert.deepEqual(h.db.ttl.targets(), [], 'job-mode collections are not scanned');
      // a cold-env 'job' collection cannot join the hot sched txn: no job, scanned instead
      const coldJob = h.db.collection('cold_chunk', { key: 'id:u32', env: 'cold', ttlSweep: 'job' });
      coldJob.put({ id: 1, text: 'c' }, { expiresAt: Date.now() - 1 });
      assert.equal(h.db.sched.count(), 3);
      assert.deepEqual(h.db.ttl.targets(), ['cold_chunk']);
      assert.equal((await h.db.ttl.sweep({ now: Date.now() })).deleted, 1); // the fake clock is frozen behind real time
      t.now = base + 2000;
      assert.equal(await h.db.sched.runDue(), 2);
      assert.equal(col.count(), 1, 'expired row physically deleted');
      assert.equal(col.get(1n, 2).text, 'b2', 'refreshed row survives its stale job');
      assert.equal(h.db.sched.count(), 1);
      await h.cleanup();
    });

    test('expire_range is one recurring sched job that sweeps and re-arms itself', async () => {
      const t = fakeTime();
      const h = openDb(kind, { sched: { autoStart: false }, ttl: { intervalMs: 6 * 3600_000 }, clock: t.clock, timers: t });
      const s = h.db.sched;
      const [job] = s.find(0n, 'expire_range', 0n);
      assert.equal(job.dueAt, t.now + 6 * 3600_000);
      const col = h.db.collection('music_session', { key: 'gid:u64', ttl: 3600_000 });
      col.put({ gid: 1n, trackIndex: 3 }, { expiresAt: Date.now() - 1 });
      t.now += 6 * 3600_000;
      await s.runDue();
      assert.equal(col.count(), 0);
      const [next] = s.find(0n, 'expire_range', 0n);
      assert.equal(next.dueAt, t.now + 6 * 3600_000);
      assert.equal(s.count(), 1);
      await h.cleanup();
    });
  });
}

test('expire_range is registered once across reopen (lmdb)', async () => {
  const dir = tmpDir('ttl-reopen');
  for (let i = 0; i < 3; i++) {
    const db = openDB({ dir, sched: true, ttl: true });
    assert.equal(db.sched.find(0n, 'expire_range', 0n).length, 1);
    await db.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

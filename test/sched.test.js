import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDB, createScheduler, MAX_SLEEP_MS, MAX_TIMER_MS } from '../src/index.js';
import { FIRE_EARLY_MS } from '../src/sched.js';
import { tmpDir } from './util.js';
import { fakeTime, openDb, DAY, until } from './ext-util.js';

const ixEntries = (db) => {
  const be = db.backend('hot');
  return be.stat(be.openCollection('sched_by_subject', { dupSort: true })).entries;
};

for (const kind of ['memory', 'lmdb']) {
  describe(`sched on ${kind}`, () => {
    test('at / next / find / cancel through sched_by_subject (exact, prefix, by ref)', async () => {
      const t = fakeTime();
      const h = openDb(kind, { sched: { autoStart: false }, clock: t.clock, timers: t });
      const s = h.db.sched;
      const now = t.now;
      s.at(now + 5000, { kind: 'unban', gid: 1n, subject: 100n, object: 7n, caseNo: 42, payload: { reason: 'spam', roles: ['1', '2'] } });
      s.at(now + 1000, { kind: 'unmute', gid: '1', subject: 100 });
      s.at(now + 3000, { kind: 'unban', gid: 1n, subject: 101n });
      s.at(now + 3000, { kind: 'unban', gid: 2n, subject: 100n });
      assert.equal(s.count(), 4);
      assert.equal(ixEntries(h.db), 4);

      const head = s.next();
      assert.equal(head.kind, 'unmute');
      assert.equal(head.gid, 1n);
      assert.equal(head.subject, 100n);
      assert.equal(head.dueAt, now + 1000);

      const [j] = s.find(1n, 'unban', 100n);
      assert.equal(j.object, 7n);
      assert.equal(j.caseNo, 42);
      assert.deepEqual(j.payload, { reason: 'spam', roles: ['1', '2'] });
      assert.equal(j.catchUp, 'run');
      assert.equal(j.attempt, 0);

      assert.equal(s.cancel(1n, 'unban', 100n), 1);
      assert.equal(s.cancel(1n, 'unban', 100n), 0, 'cancel is idempotent');
      assert.deepEqual(s.find(1n, 'unban', 100n), []);
      assert.equal(s.cancel(1n), 2, 'prefix cancel: every job of guild 1');
      assert.equal(s.count(), 1);
      assert.equal(ixEntries(h.db), 1, 'no stale index entries');

      const ref = s.at(now + 10, { kind: 'msg_send', gid: 3n, subject: 1n });
      assert.equal(s.cancelRef(ref), true);
      assert.equal(s.cancelRef(ref.id), false);

      // many jobs at the same millisecond get distinct keys
      const refs = Array.from({ length: 50 }, () => s.at(now + 7777, { kind: 'unban', gid: 9n, subject: 9n }));
      assert.equal(new Set(refs.map((r) => r.id)).size, 50);
      assert.equal(s.find(9n, 'unban', 9n).length, 50);
      // replace: atomically cancel the old ones and insert one
      s.at(now + 1, { kind: 'unban', gid: 9n, subject: 9n, replace: true });
      assert.equal(s.find(9n, 'unban', 9n).length, 1);
      assert.equal(s.count(), 2);
      assert.equal(ixEntries(h.db), 2);
      await h.cleanup();
    });

    test('row format: 19 B minimum frame, 9 B key, 17 B index key', async () => {
      const h = openDb(kind, { sched: { autoStart: false } });
      const { encodeJob, decodeJob } = h.db.sched._codec;
      const v = encodeJob({ gid: 1n, subject: 2n }, 10);
      assert.equal(v.length, 19);
      assert.equal(v[0], 0x22, 'frame HDR: v1, raw codec');
      const full = encodeJob({ gid: 1n, subject: 2n, object: 3n, caseNo: 4, catchUp: 'runIfWithin', maxLagMs: 5000, payload: 'x' }, 10);
      assert.equal(full.length, 19 + 8 + 4 + 4 + 2);
      const key = Buffer.from('000000000001000002', 'hex');
      const d = decodeJob(key, full);
      assert.equal(d.dueAt, 1);
      assert.equal(d.seq, 2);
      assert.equal(d.maxLagMs, 5000);
      assert.equal(d.catchUp, 'runIfWithin');
      assert.equal(d.payload, 'x');
      assert.throws(() => h.db.sched.at(Date.now(), { kind: 'nope' }), /unknown kind/);
      assert.throws(() => h.db.sched.at(Date.now(), { kind: 'unban', catchUp: 'runIfWithin' }), /maxLagMs/);
      h.db.sched.defineKind('custom_thing', 200);
      assert.equal(h.db.sched.at(Date.now(), { kind: 'custom_thing' }).seq >= 0, true);
      assert.equal(h.db.sched.next().kind, 'custom_thing');
      await h.cleanup();
    });

    test('a 90-day job never reaches setTimeout with more than 60 s (24.85-day overflow impossible)', async () => {
      const t = fakeTime(Date.UTC(2026, 9, 14, 12));
      const h = openDb(kind, { sched: true, clock: t.clock, timers: t });
      const s = h.db.sched;
      const fired = [];
      s.on('role_remove', (job, ctx) => { fired.push({ subject: job.subject, at: ctx.now, due: job.dueAt }); });
      const start = t.now;
      const due25 = start + 2 ** 31 + 5000; // just past the overflow point: naive setTimeout would fire at once
      const due90 = start + 90 * DAY;
      s.at(due90, { kind: 'role_remove', gid: 1n, subject: 90n });
      s.at(due25, { kind: 'role_remove', gid: 1n, subject: 25n });
      let wakes = 0;
      while (fired.length < 2 && t.now <= due90 + MAX_SLEEP_MS) {
        assert.ok(t.fireNext(), 'a timer is always armed');
        await s.idle();
        wakes++;
      }
      assert.equal(fired.length, 2);
      assert.deepEqual(fired.map((f) => f.subject), [25n, 90n]);
      for (const f of fired) {
        assert.ok(f.at >= f.due - FIRE_EARLY_MS && f.at <= f.due, `fired on time (${f.at - f.due} ms)`);
      }
      assert.ok(t.delays.length > 100_000, `slept in <=60 s steps (${t.delays.length} arms)`);
      assert.ok(t.delays.every((d) => d >= 0 && d <= MAX_SLEEP_MS && d <= MAX_TIMER_MS), `max delay ${t.delays.reduce((a, b) => Math.max(a, b), 0)}`);
      assert.ok(wakes >= Math.floor((90 * DAY) / MAX_SLEEP_MS) - 5);
      await h.cleanup();
    });

    test('clock jumps: forward runs everything due on the next wake, backward never runs early', async () => {
      const t = fakeTime(Date.UTC(2026, 9, 14, 12));
      const h = openDb(kind, { sched: true, clock: t.clock, timers: t });
      const s = h.db.sched;
      const ran = [];
      s.on('unmute', (job) => { ran.push(job.subject); });
      const t0 = t.now;
      s.at(t0 + 10 * 60_000, { kind: 'unmute', subject: 1n });
      s.at(t0 + 5 * DAY, { kind: 'unmute', subject: 2n });
      // NTP step / suspended VM: the wall clock jumps 6 days while a 60 s timer is pending
      t.jump(6 * DAY);
      t.fireNext();
      await s.idle();
      assert.deepEqual(ran, [1n, 2n], 'both due jobs ran on the first wake, in dueAt order');
      // backward jump: a job due in 2 minutes must not run while the clock is 3 days behind
      s.at(t.now + 2 * 60_000, { kind: 'unmute', subject: 3n });
      const due3 = t.now + 2 * 60_000;
      t.jump(-3 * DAY);
      for (let i = 0; i < 20; i++) { t.fireNext(); await s.idle(); } // 20 wakes = ~20 min of real time
      assert.deepEqual(ran, [1n, 2n], 'a job due in 2 min does not run while the wall clock is 3 days behind');
      assert.ok(t.delays.every((d) => d <= MAX_SLEEP_MS));
      t.now = due3 - 1000;
      for (let i = 0; i < 5 && ran.length < 3; i++) { t.fireNext(); await s.idle(); }
      assert.deepEqual(ran, [1n, 2n, 3n]);
      assert.ok(t.now >= due3 - FIRE_EARLY_MS);
      await h.cleanup();
    });

    test('catchUp policies: run, skip (grace), runIfWithin maxLagMs', async () => {
      const t = fakeTime();
      const h = openDb(kind, { sched: { autoStart: false, graceMs: 60_000 }, clock: t.clock, timers: t });
      const s = h.db.sched;
      const ran = [];
      s.on('msg_send', (j) => { ran.push(j.subject); });
      const now = t.now;
      s.at(now - 10 * 3600_000, { kind: 'msg_send', subject: 1n, catchUp: 'skip' }); // 10 h late: dropped
      s.at(now - 10_000, { kind: 'msg_send', subject: 2n, catchUp: 'skip' }); // within grace: runs
      s.at(now - 2 * 3600_000, { kind: 'msg_send', subject: 3n, catchUp: 'runIfWithin', maxLagMs: 3600_000 }); // too late
      s.at(now - 30 * 60_000, { kind: 'msg_send', subject: 4n, catchUp: 'runIfWithin', maxLagMs: 3600_000 }); // runs
      s.at(now - 30 * DAY, { kind: 'msg_send', subject: 5n }); // 'run': always
      assert.equal(await s.runDue(), 5);
      assert.deepEqual(ran, [5n, 4n, 2n], 'executed in dueAt order');
      const st = s.stats();
      assert.equal(st.fired, 3);
      assert.equal(st.skipped, 2);
      assert.equal(s.count(), 0);
      assert.equal(ixEntries(h.db), 0);
      await h.cleanup();
    });

    test('at-least-once: handlers run before the deletion, and ONE commit deletes a batch', async () => {
      const t = fakeTime();
      const h = openDb(kind, { sched: { autoStart: false, batch: 500 }, clock: t.clock, timers: t });
      const s = h.db.sched;
      const c0 = h.hot.commits;
      h.db.txn(() => { for (let i = 0; i < 1200; i++) s.at(t.now - 5000 + i, { kind: 'unban', gid: 7n, subject: BigInt(i) }); });
      assert.equal(h.hot.commits - c0, 1, '1200 at() calls inside db.txn = one commit');
      let stillThere = 0, n = 0;
      s.on('unban', async (job) => {
        await new Promise((r) => setImmediate(r));
        if (s.find(job.gid, 'unban', job.subject).length === 1) stillThere++; // row is deleted only after the handler
        n++;
      });
      const c1 = h.hot.commits;
      assert.equal(await s.runDue(), 1200);
      assert.equal(n, 1200);
      assert.equal(stillThere, 1200);
      assert.equal(h.hot.commits - c1, 3, '1200 jobs, batch 500 -> exactly 3 commits');
      assert.equal(s.count(), 0);
      assert.equal(ixEntries(h.db), 0);
      await h.cleanup();
    });

    test('a throwing handler is retried with backoff, then dropped; inTxn handlers use savepoints', async () => {
      const t = fakeTime();
      const errors = [];
      const h = openDb(kind, {
        sched: { autoStart: false, maxAttempts: 3, retryBaseMs: 1000, onError: (e, job, info) => errors.push([job.subject, job.attempt, info.final]) },
        clock: t.clock, timers: t,
      });
      const s = h.db.sched;
      const attempts = [];
      s.on('unban', (job) => { attempts.push(job.attempt); throw new Error('discord 500'); });
      s.at(t.now - 1, { kind: 'unban', gid: 1n, subject: 5n, payload: { p: 1 } });
      await s.runDue();
      let [j] = s.find(1n, 'unban', 5n);
      assert.equal(j.attempt, 1);
      assert.equal(j.dueAt, t.now + 1000);
      assert.deepEqual(j.payload, { p: 1 }, 'retry keeps the payload');
      t.now += 1000; await s.runDue();
      [j] = s.find(1n, 'unban', 5n);
      assert.equal(j.attempt, 2);
      assert.equal(j.dueAt, t.now + 2000);
      t.now += 2000; await s.runDue();
      assert.equal(s.count(), 0, 'dropped after maxAttempts');
      assert.deepEqual(attempts, [0, 1, 2]);
      assert.deepEqual(errors, [[5n, 0, false], [5n, 1, false], [5n, 2, true]]);
      assert.equal(s.stats().failed, 1);
      assert.equal(s.stats().retried, 2);

      // inTxn: DB writes commit together with the deletion; a throw rolls back only that job
      s.on('premium_expire', (job) => {
        h.db.kv.put({ k: `p:${job.subject}`, done: true });
        if (job.subject === 2n) throw new Error('boom');
      }, { inTxn: true });
      s.at(t.now - 3, { kind: 'premium_expire', subject: 1n });
      s.at(t.now - 2, { kind: 'premium_expire', subject: 2n });
      s.at(t.now - 1, { kind: 'premium_expire', subject: 3n });
      const c0 = h.hot.commits;
      await s.runDue();
      assert.equal(h.hot.commits - c0, 1, 'one commit for the batch, inTxn writes included');
      assert.deepEqual(h.db.kv.get('p:1'), { done: true });
      assert.equal(h.db.kv.get('p:2'), undefined, 'savepoint rolled back the failing job');
      assert.deepEqual(h.db.kv.get('p:3'), { done: true });
      assert.equal(s.find(0n, 'premium_expire', 2n)[0].attempt, 1, 'failing inTxn job is retried');
      await h.cleanup();
    });

    test('handlers can reschedule (recurring jobs) in the same commit', async () => {
      const t = fakeTime();
      const h = openDb(kind, { sched: { autoStart: false }, clock: t.clock, timers: t });
      const s = h.db.sched;
      let runs = 0;
      s.on('builder_timer', (job) => { runs++; return runs < 3 ? { reschedule: job.dueAt + 30_000, payload: { n: runs } } : undefined; });
      s.at(t.now, { kind: 'builder_timer', gid: 4n, subject: 8n, payload: { n: 0 } });
      for (let i = 0; i < 5; i++) { await s.runDue(); t.now += 30_000; }
      assert.equal(runs, 3);
      assert.equal(s.count(), 0);
      assert.equal(s.stats().rescheduled, 2);
      await h.cleanup();
    });

    test('due jobs without a handler do not spin the loop; on() picks them up', async () => {
      const t = fakeTime();
      const h = openDb(kind, { sched: { stallMs: 1000 }, clock: t.clock, timers: t });
      const s = h.db.sched;
      s.at(t.now - 10, { kind: 'vc_autoclose', subject: 1n });
      t.fireNext(); await s.idle();
      assert.equal(s.stats().stalled, true);
      assert.equal(t.delays.at(-1), 1000, 'stalled: re-check in stallMs, not 0');
      const ran = [];
      s.on('vc_autoclose', (j) => { ran.push(j.subject); });
      assert.equal(t.delays.at(-1), 0, 'on() re-arms immediately');
      t.fireNext(); await s.idle();
      assert.deepEqual(ran, [1n]);
      await h.cleanup();
    });
  });
}

test('maxSleepMs above the setTimeout limit is rejected', () => {
  const db = openDB({ backend: 'memory' });
  assert.throws(() => createScheduler(db, { maxSleepMs: 2 ** 31 }), /maxSleepMs/);
});

test('restart recovery (lmdb): overdue jobs run within moments of open, in dueAt order, with catchUp', async () => {
  const dir = tmpDir('sched-restart');
  const db1 = openDB({ dir, sched: { autoStart: false } });
  const now = Date.now();
  db1.txn(() => {
    db1.sched.at(now - 5000, { kind: 'unban', gid: 1n, subject: 1n }); // run
    db1.sched.at(now - 2 * 3600_000, { kind: 'msg_send', gid: 1n, subject: 2n, catchUp: 'skip' }); // stale reminder
    db1.sched.at(now - 10 * 60_000, { kind: 'vc_autoclose', gid: 1n, subject: 3n, catchUp: 'runIfWithin', maxLagMs: 5 * 60_000 });
    db1.sched.at(now - 60_000, { kind: 'vc_autoclose', gid: 1n, subject: 4n, catchUp: 'runIfWithin', maxLagMs: 5 * 60_000 });
    db1.sched.at(now - 3 * DAY, { kind: 'unban', gid: 1n, subject: 5n });
    db1.sched.at(now + 3600_000, { kind: 'unban', gid: 1n, subject: 6n });
  });
  await db1.close();

  const t0 = Date.now();
  const db2 = openDB({ dir, sched: true });
  const ran = [];
  db2.sched.on('unban', (j) => { ran.push(j.subject); });
  db2.sched.on('msg_send', (j) => { ran.push(j.subject); });
  db2.sched.on('vc_autoclose', (j) => { ran.push(j.subject); });
  await until(() => db2.sched.count() === 1 && !db2.sched.stats().running, 3000);
  const took = Date.now() - t0;
  assert.deepEqual(ran, [5n, 4n, 1n], 'overdue jobs ran in dueAt order (-3 d, -1 min, -5 s); skip/runIfWithin applied');
  assert.ok(took < 1000, `recovered in ${took} ms`);
  assert.equal(db2.sched.next().subject, 6n);
  assert.equal(db2.sched.stats().skipped, 2);
  await db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

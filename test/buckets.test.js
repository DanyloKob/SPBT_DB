import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDB, monthOf, monthEnd, nextDailyAt, tuple } from '../src/index.js';
import { rng } from './util.js';
import { fakeTime, openDb, DAY } from './ext-util.js';

const ELOG = {
  key: 'gid:u64 chan:u64 ts:u48 seq:u16',
  indexes: { elog_by_author: { key: 'gid:u64 author:u64 ts:u48' } },
};
const pkT = tuple(ELOG.key);
const ixT = tuple(ELOG.indexes.elog_by_author.key);
const AUG = Date.UTC(2026, 7, 1), SEP = Date.UTC(2026, 8, 1), OCT = Date.UTC(2026, 9, 1), NOV = Date.UTC(2026, 10, 1);

/** random rows spread over Aug..Oct 2026, plus rows at the exact month boundaries */
function rows(n, seed = 7) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ gid: BigInt(1 + r.int(2)), chan: BigInt(1 + r.int(3)), ts: AUG + r.int(NOV - AUG), seq: i & 0xffff, author: BigInt(1 + r.int(4)), k: 0, content: `m${i}` });
  }
  for (const ts of [SEP - 1, SEP, OCT - 1, OCT]) out.push({ gid: 1n, chan: 1n, ts, seq: 9999, author: 1n, k: 0, content: `edge${ts}` });
  return out;
}
const pkHex = (x) => pkT.encode([x.gid, x.chan, x.ts, x.seq]).toString('hex');
const sortKey = (x) => Buffer.concat([ixT.encode([x.gid, x.author, x.ts]), pkT.encode([x.gid, x.chan, x.ts, x.seq])]).toString('hex');
const byHex = (f) => (a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0);

for (const kind of ['memory', 'lmdb']) {
  describe(`time buckets on ${kind}`, () => {
    test('append routes by UTC month; appendMany is one commit across months; registry; get', async () => {
      const h = openDb(kind);
      const elog = h.db.bucketed('event_log', ELOG, { env: 'cold', retentionDays: 30 });
      const data = rows(300);
      const c0 = h.cold.commits;
      elog.appendMany(data);
      assert.equal(h.cold.commits - c0, 1, 'one cold txn for 304 rows over 3 months');
      assert.deepEqual(elog.buckets(), ['event_log_202608', 'event_log_202609', 'event_log_202610']);
      assert.equal(elog.count(), data.length);
      const aug = data.filter((x) => x.ts < SEP).length;
      assert.equal(h.db.collections.get('event_log_202608').count(), aug);
      assert.ok(h.db.collections.get('event_log_202609').indexes.elog_by_author_202609, 'per-month index names');
      assert.equal(elog.nameOf(SEP - 1), 'event_log_202608');
      assert.equal(elog.nameOf(SEP), 'event_log_202609');
      const x = data[17];
      assert.equal(elog.get(x.gid, x.chan, x.ts, x.seq).content, x.content);
      assert.equal(elog.get(1n, 1n, Date.UTC(2025, 0, 1), 0), undefined, 'month that does not exist');
      elog.append({ gid: 5n, chan: 5n, ts: NOV + 5, seq: 0, author: 5n, k: 1 });
      assert.equal(elog.buckets().length, 4);
      await h.cleanup();
    });

    test('query merges month cursors in key order: asc, desc, paging, index, from/to', async () => {
      const h = openDb(kind);
      const elog = h.db.bucketed('event_log', ELOG, { env: 'cold' });
      const data = rows(400, 11);
      elog.appendMany(data);

      // primary key order across months
      const g1 = data.filter((x) => x.gid === 1n).sort(byHex(pkHex));
      const asc = elog.query({ where: [1n], limit: 10_000 });
      assert.deepEqual(asc.items.map(pkHex), g1.map(pkHex));
      assert.equal(asc.next, undefined);
      const desc = elog.query({ where: [1n], desc: true, limit: 10_000 });
      assert.deepEqual(desc.items.map(pkHex), g1.map(pkHex).reverse());

      // paging with cursors, small pages so many of them straddle a month boundary
      for (const d of [false, true]) {
        const seen = [];
        let after;
        do {
          const page = elog.query({ where: [1n], limit: 7, desc: d, after });
          seen.push(...page.items.map(pkHex));
          after = page.next;
        } while (after);
        assert.deepEqual(seen, d ? g1.map(pkHex).reverse() : g1.map(pkHex), `paged ${d ? 'desc' : 'asc'}`);
      }

      // channel history: one (gid, chan) prefix, ts ascending across 3 months
      const ch = elog.query({ where: [1n, 1n], limit: 10_000 }).items;
      for (let i = 1; i < ch.length; i++) assert.ok(ch[i - 1].ts <= ch[i].ts);
      assert.ok(ch.some((x) => x.ts < SEP) && ch.some((x) => x.ts >= OCT));

      // secondary index (dupSort, per-month DBI names) merged in (index key, pk) order, also paged
      const a2 = data.filter((x) => x.gid === 2n && x.author === 3n).sort(byHex(sortKey));
      const ix = elog.query({ index: 'elog_by_author', where: [2n, 3n], limit: 10_000 });
      assert.deepEqual(ix.items.map(pkHex), a2.map(pkHex));
      const ixPaged = [];
      let after;
      do {
        const p = elog.query({ index: 'elog_by_author', where: [2n, 3n], limit: 5, after });
        ixPaged.push(...p.items.map(pkHex));
        after = p.next;
      } while (after);
      assert.deepEqual(ixPaged, a2.map(pkHex));

      // from/to picks months and filters rows: [Sep 1, Oct 1) only touches September
      const sep = elog.query({ where: [1n], from: SEP, to: OCT, limit: 10_000 }).items;
      assert.deepEqual(sep.map(pkHex), g1.filter((x) => x.ts >= SEP && x.ts < OCT).map(pkHex));
      assert.ok(sep.some((x) => x.ts === SEP) && !sep.some((x) => x.ts === OCT));
      assert.deepEqual([...elog.iterate({ where: [2n] })].map(pkHex), data.filter((x) => x.gid === 2n).sort(byHex(pkHex)).map(pkHex));
      await h.cleanup();
    });

    test('dropExpired drops whole months (data + index DBIs + registry entry)', async () => {
      const h = openDb(kind);
      const elog = h.db.bucketed('event_log', ELOG, { env: 'cold', retentionDays: 30 });
      elog.appendMany(rows(200, 3));
      const now = Date.UTC(2026, 9, 14, 4, 17); // cutoff = Sep 14: August ended before it, September did not
      assert.deepEqual(elog.dropExpired(now), ['event_log_202608']);
      assert.deepEqual(elog.buckets(), ['event_log_202609', 'event_log_202610']);
      const cols = h.db.stats().cold.collections;
      assert.equal(cols.event_log_202608, undefined);
      assert.equal(cols.elog_by_author_202608, undefined);
      assert.ok(cols.event_log_202609.entries > 0);
      assert.equal(elog.query({ where: [1n], to: SEP }).items.length, 0);
      assert.deepEqual(elog.dropExpired(now), [], 'idempotent');
      assert.deepEqual(elog.dropExpired(Date.UTC(2026, 11, 31)), ['event_log_202609', 'event_log_202610']);
      assert.equal(elog.count(), 0);
      if (kind === 'lmdb') {
        await h.close();
        const db2 = openDB({ dir: h.dir });
        assert.deepEqual(db2.bucketed('event_log', ELOG, { env: 'cold' }).buckets(), []);
        await db2.close();
      }
      await h.cleanup();
    });

    test('dropExpired finds months this process never opened (after reopen)', { skip: kind !== 'lmdb' && 'needs persistence' }, async () => {
      const h = openDb(kind);
      h.db.bucketed('audit', { key: 'gid:u64 ts:u48 seq:u16' }, { env: 'cold' })
        .appendMany([{ gid: 1n, ts: Date.UTC(2026, 0, 5), seq: 0, action: 1 }, { gid: 1n, ts: Date.UTC(2026, 9, 5), seq: 0, action: 2 }]);
      await h.close();
      const db2 = openDB({ dir: h.dir });
      const audit = db2.bucketed('audit', { key: 'gid:u64 ts:u48 seq:u16' }, { env: 'cold', retentionDays: 90 });
      assert.deepEqual(audit.dropExpired(Date.UTC(2026, 9, 14)), ['audit_202601']);
      assert.deepEqual(audit.buckets(), ['audit_202610']);
      await db2.close();
      await h.cleanup();
    });

    test('appender: buffered rows go out as one commit, routed across months', async () => {
      const h = openDb(kind);
      const elog = h.db.bucketed('event_log', ELOG, { env: 'cold', seqField: 'seq' });
      const app = elog.appender({ flushMs: 1e9, maxEntries: 1e9 });
      for (let i = 0; i < 100; i++) app.append({ gid: 1n, chan: 1n, ts: (i % 2 ? SEP : OCT) + i, author: 1n, k: 0, content: 'x' });
      assert.equal(elog.count(), 0);
      const c0 = h.cold.commits;
      await app.flush();
      assert.equal(h.cold.commits - c0, 1);
      assert.equal(elog.count(), 100);
      assert.deepEqual(elog.buckets(), ['event_log_202609', 'event_log_202610']);
      app.append({ gid: 1n, chan: 1n, ts: OCT + 7777, author: 1n, k: 0 });
      await h.close(); // close() flushes registered appenders
      if (kind === 'lmdb') {
        const db2 = openDB({ dir: h.dir });
        assert.equal(db2.bucketed('event_log', ELOG, { env: 'cold' }).count(), 101);
        await db2.close();
      }
      await h.cleanup();
    });

    test('retention runs as a daily bucket_drop job at 04:17 UTC', async () => {
      const t = fakeTime(Date.UTC(2026, 9, 14, 12));
      const h = openDb(kind, { sched: { autoStart: false }, clock: t.clock, timers: t });
      const elog = h.db.bucketed('event_log', ELOG, { env: 'cold', retentionDays: 30 });
      h.db.bucketed('audit', { key: 'gid:u64 ts:u48 seq:u16' }, { env: 'cold', retentionDays: 90 });
      const jobs = h.db.sched.find(0n, 'bucket_drop', 0n);
      assert.equal(jobs.length, 1, 'one job for every bucketed set');
      assert.equal(jobs[0].dueAt, Date.UTC(2026, 9, 15, 4, 17));
      elog.appendMany(rows(50, 5));
      t.now = jobs[0].dueAt;
      await h.db.sched.runDue();
      assert.deepEqual(elog.buckets(), ['event_log_202609', 'event_log_202610']);
      assert.equal(h.db.sched.find(0n, 'bucket_drop', 0n)[0].dueAt, Date.UTC(2026, 9, 16, 4, 17));
      await h.cleanup();
    });
  });
}

test('month helpers (UTC)', () => {
  assert.equal(monthOf(Date.UTC(2026, 11, 31, 23, 59, 59, 999)), 202612);
  assert.equal(monthOf(Date.UTC(2027, 0, 1)), 202701);
  assert.equal(monthEnd(202612), Date.UTC(2027, 0, 1));
  assert.equal(nextDailyAt(Date.UTC(2026, 9, 14, 4, 17)), Date.UTC(2026, 9, 15, 4, 17), 'strictly after now');
  assert.equal(nextDailyAt(Date.UTC(2026, 9, 14, 3)), Date.UTC(2026, 9, 14, 4, 17));
  assert.ok(DAY === 86_400_000);
});

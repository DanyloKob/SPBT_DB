// bench/05 - hot paths of the scheduler / coalescer / event_log layer (README "Scheduler, TTL
// sweeper, coalescers, time buckets"). Not the doc's §13 05 (scheduler drift over months, which
// needs the target and libfaketime); this is the per-operation cost of what the bot does all day.
//
//   node --expose-gc bench/05-hotpaths.mjs [--dir D] [--levels 100000] [--jobs 50000]
//
// 1. level.bump into the coalescer: 1M bumps over 20k active keys (bigint ids, then string ids)
// 2. coalescer flush of 2 000 keys into a 100k-row `level` (with level_by_xp): txnAsync (as
//    shipped), the same unsorted, and a sync flush -> wall time, main-thread apply, entries/s
// 3. on-disk bytes per sched row with 50k jobs of a realistic kind mix (sched + sched_by_subject)
// 4. scheduler wake with nothing due (50k rows in the tree): wall and CPU per wake
// 5. firing 500 due jobs: handlers + ONE commit
// 6. event_log lagged-index catch-up (src/schema.js eventLogSchema, lag 8192 over 80 channels):
//    the main-thread time of the one txn callback that writes the tail into the index DBIs

import fs from 'node:fs';
import { openDB } from '../src/index.js';
import { parseArgs, freshDir, fsInfo, report, rng, log, eventRow, elogSchema, lmdbWithCold, checkColdPageSize } from './lib.mjs';

const args = parseArgs();
const USERS = args.levels ?? 100_000;
const N_JOBS = args.jobs ?? 50_000;
const dir = freshDir(args, '05-hotpaths');
const fsi = fsInfo(dir);
const rep = report('05-hotpaths', { levels: USERS, jobs: N_JOBS, dir });
log(`05-hotpaths: ${dir} (${fsi.type})`);
const hr = () => process.hrtime.bigint();
const ms = (t0) => Number(hr() - t0) / 1e6;
const R = rng(0x9e3779b9);
const results = { fs: fsi };

const db = openDB({ dir, sched: true, coalesce: { level: { flushMs: 1e9, maxEntries: 1e9, cap: 1e9 } }, lmdb: lmdbWithCold(args) });

/* ---- 1. level.bump into the coalescer */
const GUILDS = 500;
const gids = Array.from({ length: GUILDS }, () => R.snow());
const members = Array.from({ length: USERS }, (_, i) => [gids[i % GUILDS], R.snow()]);
for (let i = 0; i < USERS; i += 5000) db.txn(() => { for (let j = i; j < Math.min(USERS, i + 5000); j++) db.level.put({ gid: members[j][0], uid: members[j][1], xp: R.int(50_000) }); });
await db.flushed();
const pick = Array.from({ length: 1_000_000 }, () => members[R.int(20_000)]); // 20k active keys (the §7.3 cap)
db.level.bump(pick[0][0], pick[0][1], 1); // creates the coalescer
await db.level.bumps.flush();
for (let rep0 = 0; rep0 < 2; rep0++) { // the first pass warms up
  const t0 = hr();
  for (let i = 0; i < pick.length; i++) db.level.bump(pick[i][0], pick[i][1], 15);
  const t = ms(t0);
  if (rep0) results.bumpBigint = { ops: pick.length, nsPerOp: Math.round((t * 1e6) / pick.length), opsPerSec: Math.round(pick.length / (t / 1000)), keys: db.level.bumps.pending };
  await db.level.bumps.flush();
}
{
  const pickS = pick.map(([g, u]) => [String(g), String(u)]);
  for (let i = 0; i < 200_000; i++) db.level.bump(pickS[i][0], pickS[i][1], 15);
  await db.level.bumps.flush();
  const t0 = hr();
  for (let i = 0; i < pickS.length; i++) db.level.bump(pickS[i][0], pickS[i][1], 15);
  const t = ms(t0);
  results.bumpString = { nsPerOp: Math.round((t * 1e6) / pickS.length), opsPerSec: Math.round(pickS.length / (t / 1000)) };
  await db.level.bumps.flush();
}
rep.check('level.bump into the coalescer, bigint ids', results.bumpBigint.nsPerOp, '<=', 1000, { unit: 'ns/op', scale: 'cpu', informational: true });
rep.check('level.bump into the coalescer, string ids', results.bumpString.nsPerOp, '<=', 1000, { unit: 'ns/op', scale: 'cpu', informational: true });
log(`  bump ${results.bumpBigint.nsPerOp} ns (bigint), ${results.bumpString.nsPerOp} ns (string)`);

/* ---- 2. flush of 2 000 keys: one txn */
for (const mode of ['async', 'async-unsorted', 'sync']) {
  const c = db.counter(db.level, 'xp', { flushMs: 1e9, maxEntries: 1e9, async: mode !== 'sync', sorted: mode !== 'async-unsorted', name: `level.${mode}` });
  const times = [], blocked = [], apply = [];
  for (let f = 0; f < 20; f++) {
    for (let i = 0; i < 2000; i++) { const [g, u] = members[R.int(USERS)]; c.bump(g, u, 7); }
    const t0 = hr();
    const p = c.flush();
    blocked.push(ms(t0)); // main thread until flush() returns
    await p;
    await db.flushed();
    times.push(ms(t0));
    apply.push(c.metrics().lastApplyMs);
  }
  for (const a of [times, blocked, apply]) a.sort((x, y) => x - y);
  results[`flush2000_${mode}`] = { wallMsP50: +times[10].toFixed(2), wallMsP90: +times[18].toFixed(2), flushCallReturnsMsP50: +blocked[10].toFixed(2), mainThreadApplyMsP50: +apply[10].toFixed(2), entriesPerSec: Math.round(2000 / (times[10] / 1000)) };
  await c.close();
}
rep.check('coalescer flush of 2000 keys (txnAsync, sorted): wall p50', results.flush2000_async.wallMsP50, '<=', 1000, { unit: 'ms', informational: true });
rep.check('coalescer flush of 2000 keys: main-thread apply p50', results.flush2000_async.mainThreadApplyMsP50, '<=', 100, { unit: 'ms', scale: 'cpu', informational: true });
log(`  flush 2000: ${results.flush2000_async.wallMsP50} ms wall, ${results.flush2000_async.mainThreadApplyMsP50} ms main thread`);

/* ---- 3. on-disk bytes per sched row */
const s = db.sched;
const be = db.backend('hot');
const statOf = (name, dup) => be.stat(be.openCollection(name, { dupSort: dup }));
const before = { d: statOf('sched', false).pages, i: statOf('sched_by_subject', true).pages };
const now = Date.now();
const kinds = ['unban', 'unmute', 'role_remove', 'msg_send', 'vc_autoclose', 'ticket_autoclose'];
const tAt = hr();
for (let b = 0; b < N_JOBS; b += 1000) {
  db.txn(() => {
    for (let i = b; i < Math.min(N_JOBS, b + 1000); i++) {
      const k = kinds[i % kinds.length];
      s.at(now + 3600_000 + R.int(90 * 86_400_000), {
        kind: k, gid: gids[i % GUILDS], subject: R.snow(),
        object: k === 'role_remove' ? R.snow() : undefined,
        caseNo: k === 'unban' || k === 'unmute' ? i : undefined,
        catchUp: k === 'msg_send' ? 'skip' : k.endsWith('autoclose') ? 'runIfWithin' : 'run',
        maxLagMs: k.endsWith('autoclose') ? 300_000 : undefined,
        payload: k === 'msg_send' ? { ch: String(R.snow()), tpl: i % 64 } : undefined,
      });
    }
  });
}
const atMs = ms(tAt);
await db.flushed();
const ps = db.stats().hot.pageSize;
const dS = statOf('sched', false), iS = statOf('sched_by_subject', true);
let valueBytes = 0;
for (const { value } of be.range(be.openCollection('sched', {}), {})) valueBytes += value.length;
results.schedRows = {
  rows: dS.entries,
  avgValueBytes: +(valueBytes / dS.entries).toFixed(1),
  keyBytes: 9,
  dataBytesPerRow: +(((dS.pages - before.d) * ps) / N_JOBS).toFixed(1),
  indexBytesPerRow: +(((iS.pages - before.i) * ps) / N_JOBS).toFixed(1),
  totalBytesPerRow: +((((dS.pages - before.d) + (iS.pages - before.i)) * ps) / N_JOBS).toFixed(1),
  atPerSecBatched1000: Math.round(N_JOBS / (atMs / 1000)),
};
rep.check('on-disk bytes per sched row (sched + sched_by_subject)', results.schedRows.totalBytesPerRow, '<=', 200, { unit: 'B', informational: true, note: '§6.1 sizes sched + idx at 60 B logical/row' });
log(`  sched: ${results.schedRows.totalBytesPerRow} B/row on pages, ${results.schedRows.atPerSecBatched1000} at()/s`);

/* ---- 4. scheduler wake with nothing due */
for (const k of kinds) s.on(k, () => {});
await s.idle();
for (let i = 0; i < 2000; i++) await s.runDue(); // warm-up
const W = 20_000;
let t0 = hr();
for (let i = 0; i < W; i++) await s.runDue();
const wakeUs = (ms(t0) * 1000) / W;
const cpu0 = process.cpuUsage();
for (let i = 0; i < W; i++) await s.runDue();
const cpu = process.cpuUsage(cpu0);
results.schedWake = { idleWakeUs: +wakeUs.toFixed(2), idleWakeCpuUs: +((cpu.user + cpu.system) / W).toFixed(2), lastScanUs: s.stats().lastWakeUs, cpuMsPerDayAt60s: +((1440 * wakeUs) / 1000).toFixed(1) };
rep.check('scheduler idle wake (50k rows, nothing due)', results.schedWake.idleWakeUs, '<=', 1000, { unit: 'µs', scale: 'cpu', informational: true });

/* ---- 5. firing 500 due jobs: handlers + ONE commit */
db.txn(() => { for (let i = 0; i < 500; i++) s.at(Date.now() - 1000 + i, { kind: 'unban', gid: gids[0], subject: BigInt(i) }); });
await db.flushed();
t0 = hr();
const fired = await s.runDue();
results.schedFire500 = { fired, ms: +ms(t0).toFixed(2), usPerJob: +((ms(t0) * 1000) / fired).toFixed(1) };
rep.check('scheduler: fire 500 due jobs + one commit', results.schedFire500.ms, '<=', 1000, { unit: 'ms', informational: true });
log(`  wake ${results.schedWake.idleWakeUs} µs idle, fire 500 in ${results.schedFire500.ms} ms`);

/* ---- 6. event_log lagged-index catch-up: the main-thread cost of the one txn that writes it */
{
  const ev = db.collection('event_log_202610', elogSchema(202610));
  const chans = Array.from({ length: 80 }, (_, i) => ({ gid: gids[i % 20], chan: R.snow() }));
  let ts = 1_760_000_000_000, seq = 0;
  const lag = ev.schema.indexes.elog_by_chan_202610.lag;
  const cb = [], plain = [];
  for (let n = 0; n < lag * 4; n += 512) {
    const rows = Array.from({ length: 512 }, () => { const c = R.float() < 0.33 ? chans[R.int(8)] : chans[R.int(80)]; return eventRow(R, c.gid, c.chan, (ts += R.int(41)), (seq = (seq + 1) & 0xffff)); });
    const ix = ev.backend.openCollection('elog_by_chan_202610');
    const e0 = ev.backend.stat(ix).entries;
    let cbMs = 0;
    db.coldTxn(() => { const a = hr(); for (const r of rows) ev.put(r); cbMs = ms(a); });
    (ev.backend.stat(ix).entries > e0 ? cb : plain).push(cbMs);
  }
  plain.sort((a, b) => a - b);
  results.coldPageSize = db.stats().cold.pageSize;
  checkColdPageSize(rep, args, results.coldPageSize);
  results.eventLogCatchUp = { lag, catchUps: cb.length, mainThreadMsPerCatchUpTxn: cb.map((x) => +x.toFixed(2)), mainThreadMsPlain512P50: +plain[Math.floor(plain.length / 2)].toFixed(2) };
  rep.check('event_log lagged catch-up: main-thread ms of that txn (512 rows + 8192-row tail, 2 indexes)', Math.max(...cb), '<=', 50, { unit: 'ms', scale: 'cpu', informational: true, note: 'once per 8192 rows; a plain 512-row append txn for comparison is mainThreadMsPlain512P50' });
  log(`  event_log catch-up ${cb.map((x) => x.toFixed(1)).join(', ')} ms vs ${results.eventLogCatchUp.mainThreadMsPlain512P50} ms for a plain 512-row txn`);
}

await db.close();
fs.rmSync(dir, { recursive: true, force: true });
rep.finish(results);

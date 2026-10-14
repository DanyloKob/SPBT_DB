// bench/01 - write throughput and write amplification (design §13 row 01, §7).
//
//   node bench/01-write-throughput.mjs [--dir D] [--level 200000] [--batch 1000] [--events 300000]
//        [--sim-seconds 35] [--rate 50]
//
// A. `level` (§5.4): batched inserts with level_by_xp maintained, then coalescer-shaped flushes
//    (2 000 random incr per txn, §7.3) -> put/s, dirty pages and bytes per commit.
// B. event_log (§5.7, cold env), as shipped (src/schema.js eventLogSchema: pk `ts seq`, lagged
//    elog_by_chan, elog_by_msg - the index work counts in the bytes written), two shapes:
//    B1 one stream: a single channel, strictly increasing key (pure append-key)
//    B2 event_log-shaped: 80 concurrently active channels in 20 guilds (§6.3 "write frontier"),
//       one wall clock (~20 ms between messages = 50 msg/s), 512 rows per commit (§7.3 flush
//       size) and 250 rows per commit (50 msg/s x 5 s). The same B2 also runs on the doc's key
//       (`gid chan ts seq`, as shipped before r2) for comparison.
// C. 50 msg/s synthetic load in REAL time with the §7.3 coalescing policy (event_log 5 s / 512
//    rows, level 30 s / 2 000 entries; the real src/coalesce.js) and the read path of a messageCreate -> commits/s, plus
//    fdatasync calls/s counted by strace when it is available.
//
// How "dirty pages per commit" is measured: lmdb-js runs without MDB_WRITEMAP, so a commit
// pwrite()s every dirty page; /proc/self/io `wchar` before/after the commit is exactly the bytes
// handed to the kernel (pages + the meta page). dirtyPages = floor(dWchar / pageSize). Nothing
// else writes during a measured commit. `newPages` is the growth of lastPageNumber (env.getStats).
// Write amplification = bytes written by the commit / logical bytes (key + frame) of the rows.

import fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDB, coreSchemas, createAppender } from '../src/index.js';
import { parseArgs, freshDir, fsInfo, report, rng, summary, procIo, log, eventRow, benchSchemas, elogSchema, BENCH_DIR, sleep } from './lib.mjs';

const args = parseArgs();

// child mode for the strace fsync count
if (args.child === 'commits') {
  const db = openDB({ dir: args.cdir, schemas: { level: coreSchemas.level } });
  const ev = db.collection('event_log_202610', elogSchema(202610));
  db.txn(() => {}); db.coldTxn(() => {});
  process.stdout.write('READY\n');
  const R = rng(1);
  for (let i = 0; i < args.k; i++) {
    if (i % 2) db.txn(() => db.level.put({ gid: 1n, uid: BigInt(i), xp: i }));
    else db.coldTxn(() => ev.put(eventRow(R, 1n, 2n, 1_700_000_000_000 + i, i & 0xffff)));
  }
  await db.flushed();
  await db.close();
  process.exit(0);
}

const N_LEVEL = args.level ?? 200_000;
const BATCH = args.batch ?? 1000;
const N_EV = args.events ?? 300_000;
const SIM_S = args['sim-seconds'] ?? 35;
const RATE = args.rate ?? 50;
const dir = freshDir(args, '01-write');
const fsi = fsInfo(dir);
const rep = report('01-write-throughput', { level: N_LEVEL, batch: BATCH, events: N_EV, simSeconds: SIM_S, rate: RATE, dir });
log(`01-write-throughput: ${dir} (${fsi.type})`);

const hr = () => process.hrtime.bigint();
const ns2ms = (n) => Number(n) / 1e6;

/** Run one measured commit; returns timing split and bytes written. */
function measured(txnFn, env, body) {
  const s0 = env.getStats().lastPageNumber;
  const w0 = procIo().wchar;
  let cb = 0n;
  const t0 = hr();
  txnFn(() => { const a = hr(); body(); cb = hr() - a; });
  const total = hr() - t0;
  const w1 = procIo().wchar;
  const pageSize = env.getStats().pageSize;
  return { totalMs: ns2ms(total), cbMs: ns2ms(cb), commitMs: ns2ms(total - cb), bytes: w1 - w0, dirtyPages: Math.floor((w1 - w0) / pageSize), newPages: env.getStats().lastPageNumber - s0 };
}

function agg(list, rowsPerCommit, logicalBytes) {
  const totalMs = list.reduce((s, x) => s + x.totalMs, 0);
  const cbMs = list.reduce((s, x) => s + x.cbMs, 0);
  const bytes = list.reduce((s, x) => s + x.bytes, 0);
  const rows = rowsPerCommit * list.length;
  return {
    commits: list.length,
    rows,
    opsPerSec: Math.round((rows / totalMs) * 1000),
    msPerCommit: summary(list.map((x) => x.totalMs)),
    cpuShare: +(cbMs / totalMs).toFixed(3),
    cpuMsPerCommitMean: +(cbMs / list.length).toFixed(3),
    commitMsPerCommitMean: +((totalMs - cbMs) / list.length).toFixed(3),
    dirtyPagesPerCommit: summary(list.map((x) => x.dirtyPages), 1),
    bytesPerCommitMean: Math.round(bytes / list.length),
    newPagesPerCommitMean: +(list.reduce((s, x) => s + x.newPages, 0) / list.length).toFixed(1),
    ...(logicalBytes ? { logicalBytesPerCommitMean: Math.round(logicalBytes / list.length), writeAmplification: +(bytes / logicalBytes).toFixed(2) } : {}),
  };
}

/** projected target time: callback CPU x cpu factor + commit x fsync factor */
function projectOps(a, rowsPerCommit) {
  const f = rep.r.calibration.factors;
  if (!f || f.fsync == null) return null;
  const ms = a.cpuMsPerCommitMean * f.cpu + a.commitMsPerCommitMean * f.fsync;
  return Math.round((rowsPerCommit / ms) * 1000);
}

const db = openDB({ dir, schemas: { level: coreSchemas.level } });
const hot = db.backend('hot').env;
const results = { fs: fsi };

/* ---------------------------------------------------------------- A. level */
{
  const R = rng(11);
  const gids = Array.from({ length: 500 }, () => R.snow());
  const rows = Array.from({ length: N_LEVEL }, (_, i) => ({ gid: gids[i % 500], uid: R.snow(), xp: R.int(100_000) }));
  const ins = [];
  for (let i = 0; i < N_LEVEL; i += BATCH) {
    ins.push(measured(db.txn, hot, () => { for (let j = i; j < Math.min(N_LEVEL, i + BATCH); j++) db.level.put(rows[j]); }));
  }
  // logical bytes of a level row: 16 B key + frame, index entry 12 B key + 8 B value
  const frameB = db.level.getFrame(db.level.keyOf(rows[0].gid, rows[0].uid)).length;
  const logicalRow = 16 + frameB + 12 + 8;
  const insert = agg(ins, BATCH, logicalRow * N_LEVEL);
  // coalescer flush: 2 000 random (gid, uid) gain xp -> index entries move
  const FLUSH = 2000, flushes = Math.max(20, Math.floor(N_LEVEL / FLUSH / 2));
  const fl = [];
  for (let f = 0; f < flushes; f++) {
    const pick = Array.from({ length: FLUSH }, () => rows[R.int(N_LEVEL)]);
    fl.push(measured(db.txn, hot, () => { for (const r of pick) db.level.incr(r.gid, r.uid, 'xp', 1 + R.int(30)); }));
  }
  const flush = agg(fl, FLUSH, logicalRow * FLUSH * flushes);
  // one active guild only (locality): 2 000 incr in 1 guild
  const g0 = rows.filter((r) => r.gid === gids[0]);
  const fl1 = [];
  for (let f = 0; f < 10; f++) fl1.push(measured(db.txn, hot, () => { for (let k = 0; k < FLUSH; k++) { const r = g0[R.int(g0.length)]; db.level.incr(r.gid, r.uid, 'xp', 1); } }));
  const st = db.stats().hot;
  results.level = { frameBytes: frameB, logicalBytesPerRow: logicalRow, insert, coalescerFlush2000: flush, flush2000OneGuild: agg(fl1, FLUSH), file: { bytes: st.fileBytes, pages: st.pages, freePages: st.freePages, levelPages: st.collections.level.pages, indexPages: st.collections.level_by_xp.pages } };
  rep.check('level put/s, batched 1000, +index', insert.opsPerSec, '>=', 15000, { unit: 'put/s', projected: projectOps(insert, BATCH) });
  rep.check('level dirty pages per 2000-incr flush (p50)', flush.dirtyPagesPerCommit.p50, '<=', 300, { unit: 'pages', informational: true, note: '§7.2 estimates ~300 dirty pages per 30 s flush' });
  log(`  level insert ${insert.opsPerSec} put/s, flush2000 ${flush.dirtyPagesPerCommit.p50} dirty pages`);
}

/* ------------------------------------------------------------ B. event_log */
const ev = db.collection('event_log_202610', elogSchema(202610));
const evOld = db.collection('event_log_r1_202610', benchSchemas.event_log_r1);
const cold = db.backend('cold').env;
const coldTxn = db.coldTxn;
function evLogical(col, rowsList) {
  let n = 0;
  for (const r of rowsList) { const k = col.keyOf(...col.pk.fields.map((f) => r[f.name])); n += k.length + col.getFrame(k).length; }
  return n;
}
{
  const R = rng(22);
  // B1: single stream
  const T0 = 1_760_000_000_000;
  const gid = R.snow(), chan = R.snow();
  const one = [];
  let logical1 = 0, ts = T0, seq = 0;
  const nB1 = Math.min(Math.floor(N_EV / 3), 100_000), B1 = 512;
  for (let i = 0; i < nB1; i += B1) {
    const batch = Array.from({ length: Math.min(B1, nB1 - i) }, () => eventRow(R, gid, chan, (ts += 1 + R.int(50)), (seq = (seq + 1) & 0xffff)));
    one.push(measured(coldTxn, cold, () => { for (const r of batch) ev.put(r); }));
    logical1 += evLogical(ev, batch);
  }
  const b1 = agg(one, B1, logical1);

  // B2: 80 channels across 20 guilds, one wall clock; a third of the traffic in 8 busy channels
  const guilds = Array.from({ length: 20 }, () => R.snow());
  const chans = Array.from({ length: 80 }, (_, i) => ({ gid: guilds[i % 20], chan: R.snow() }));
  const shapedFor = (col) => {
    const out = {};
    for (const B of [512, 250]) {
      const list = [];
      let logical = 0;
      const n = Math.floor((N_EV - nB1) / 2);
      for (let i = 0; i < n; i += B) {
        const batch = Array.from({ length: B }, () => {
          const c = R.float() < 0.33 ? chans[R.int(8)] : chans[R.int(80)];
          return eventRow(R, c.gid, c.chan, (ts += R.int(41)), (seq = (seq + 1) & 0xffff));
        });
        list.push(measured(coldTxn, cold, () => { for (const r of batch) col.put(r); }));
        logical += evLogical(col, batch);
      }
      // steady state only: skip the first 20 % (tree still small, everything fits in a few leaves)
      const steady = list.slice(Math.floor(list.length / 5));
      const steadyLogical = logical * (steady.length / list.length);
      out[`batch${B}`] = agg(steady, B, steadyLogical);
    }
    return out;
  };
  const shaped = shapedFor(ev);
  const shapedOld = shapedFor(evOld);
  const st = db.stats().cold;
  const pagesOf = (names) => names.reduce((p, n) => p + (st.collections[n]?.pages ?? 0), 0);
  const evPages = pagesOf(['event_log_202610']), ixPages = pagesOf(['elog_by_chan_202610', 'elog_by_msg_202610']);
  const rowsTotal = st.collections.event_log_202610.entries;
  results.eventLog = {
    schema: 'src/schema.js eventLogSchema (pk ts seq; elog_by_chan lag 8192; elog_by_msg)',
    pageSize: st.pageSize,
    meanFrameBytes: +(logical1 / nB1 - 8).toFixed(1),
    singleStreamAppend512: b1,
    shaped80ch: shaped,
    shaped80chPreR2Key: shapedOld,
    file: {
      bytes: st.fileBytes, rows: rowsTotal, dataPages: evPages, indexPages: ixPages,
      bytesPerRowOnPages: +((evPages * st.pageSize) / rowsTotal).toFixed(1),
      bytesPerRowWithIndexes: +(((evPages + ixPages) * st.pageSize) / rowsTotal).toFixed(1),
      bytesPerRowPreR2Key: +((pagesOf(['event_log_r1_202610']) * st.pageSize) / st.collections.event_log_r1_202610.entries).toFixed(1),
      spaceAmplification: +((evPages * st.pageSize) / ((logical1 / nB1) * rowsTotal)).toFixed(2),
    },
  };
  rep.check('event_log put/s, batched 512 (80 channels)', shaped.batch512.opsPerSec, '>=', 15000, { unit: 'put/s', projected: projectOps(shaped.batch512, 512) });
  rep.check('write amplification, append-key single stream (512/commit)', b1.writeAmplification, '<=', 1.6, { unit: 'x' });
  rep.check('write amplification, event_log 80 channels, 512/commit', shaped.batch512.writeAmplification, '<=', 1.6, { unit: 'x', note: 'as shipped: data + lagged elog_by_chan + elog_by_msg, catch-ups included' });
  rep.check('write amplification, event_log 80 channels, 250/commit (50 msg/s x 5 s)', shaped.batch250.writeAmplification, '<=', 1.6, { unit: 'x' });
  rep.check('write amplification, 80 channels, 512/commit, pre-r2 key gid chan ts seq', shapedOld.batch512.writeAmplification, '<=', 1.6, { unit: 'x', informational: true });
  rep.check('write amplification, 80 channels, 250/commit, pre-r2 key gid chan ts seq', shapedOld.batch250.writeAmplification, '<=', 1.6, { unit: 'x', informational: true });
  log(`  event_log single-stream WA ${b1.writeAmplification}, 80ch/512 WA ${shaped.batch512.writeAmplification} (${shaped.batch512.dirtyPagesPerCommit.p50} pages), 80ch/250 WA ${shaped.batch250.writeAmplification}; pre-r2 key 512 ${shapedOld.batch512.writeAmplification} / 250 ${shapedOld.batch250.writeAmplification}`);
}

/* ------------------------------------------------- C. 50 msg/s, real time */
{
  const R = rng(33);
  const guild = db.collection('guild', coreSchemas.guild);
  const fc = db.collection('feature_config', coreSchemas.feature_config);
  const user = db.collection('user', coreSchemas.user);
  const gids = Array.from({ length: 50 }, () => R.snow());
  const uids = Array.from({ length: 2000 }, () => R.snow());
  db.txn(() => {
    for (const gid of gids) { guild.put({ gid, name: 'g', memberCount: 100 }); for (let t = 0; t < 3; t++) fc.put({ gid, tag: t, enabled: true, channelId: 1n }); }
    for (const uid of uids) user.put({ uid, plan: 0, since: 1, username: 'u' });
  });
  const chans = gids.map((gid) => ({ gid, chan: R.snow() }));
  // the REAL coalescers from src/coalesce.js (§7.3 defaults): level.bump = counter(level, xp,
  // 30 s / 2 000 keys), event_log = appender(5 s / 512 rows / 1 MB). Their commits run as
  // txnAsync, so the fsync is off the main thread.
  const evApp = createAppender(db.backend('cold'), (rows) => { for (const r of rows) ev.put(r); }, { name: 'event_log' });
  let mainBusyNs = 0n, msgs = 0, seq = 0;
  const perMsgUs = [];
  const t0 = performance.now();
  const end = t0 + SIM_S * 1000;
  const period = 1000 / RATE;
  let next = t0;
  while (performance.now() < end) {
    const now = performance.now();
    if (now < next) { await sleep(Math.max(0, next - now)); continue; }
    next += period;
    const c = chans[R.int(chans.length)], uid = uids[R.int(uids.length)];
    const row = eventRow(R, c.gid, c.chan, Date.now(), (seq = (seq + 1) & 0xffff)); // generating the row is bench overhead: not timed
    const a = hr();
    // read path of messageCreate: guild, 3 feature configs, user, level (§7.2: 8-12 gets)
    guild.get(c.gid); fc.get(c.gid, 0); fc.get(c.gid, 1); fc.get(c.gid, 2); user.get(uid); db.level.get(c.gid, uid);
    // write path: one log row + one xp delta, coalesced
    evApp.append(row);
    db.level.bump(c.gid, uid, 15);
    const d = hr() - a;
    mainBusyNs += d;
    perMsgUs.push(Number(d) / 1e3);
    msgs++;
  }
  await evApp.close(); // SIGTERM path: drain
  await db.level.bumps.close();
  const secs = (performance.now() - t0) / 1000;
  const mEv = evApp.metrics(), mLv = db.level.bumps.metrics();
  results.sim50 = {
    seconds: +secs.toFixed(1), messages: msgs, coalescers: { event_log: mEv, level: mLv },
    commitsPerSec: +((mEv.commits + mLv.commits) / secs).toFixed(3),
    mainThreadBusyShare: +(Number(mainBusyNs) / 1e9 / secs).toFixed(4),
    mainThreadUsPerMessage: +(Number(mainBusyNs) / 1e3 / msgs).toFixed(2),
    perMessageUs: summary(perMsgUs, 2),
  };
}

await db.flushed();
await db.close();

/* --------- fdatasync per commit (strace, separate child: exact syscall count) */
let straceCount = null;
{
  const K = 200;
  const cdir = join(dir, 'strace');
  const run = (k) => {
    fs.rmSync(cdir, { recursive: true, force: true });
    const r = spawnSync('strace', ['-f', '-c', '-e', 'trace=fsync,fdatasync,msync,sync_file_range', process.execPath, join(BENCH_DIR, '01-write-throughput.mjs'), '--child', 'commits', '--cdir', cdir, '--k', String(k)], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    let n = 0;
    for (const l of r.stderr.split('\n')) { const m = l.trim().split(/\s+/); if (['fsync', 'fdatasync', 'msync', 'sync_file_range'].includes(m[m.length - 1])) n += Number(m[3]); }
    return n;
  };
  const base = run(0), withK = run(K);
  if (base != null && withK != null) {
    const perCommit = (withK - base) / K;
    results.fdatasyncPerCommit = { measuredWith: 'strace -f -c', perCommit, note: 'plus one O_DSYNC write of the meta page per commit (LMDB writes meta through a separate O_DSYNC fd), so a commit costs ~2 device flushes' };
    straceCount = perCommit;
  } else results.fdatasyncPerCommit = { measuredWith: 'unavailable (strace failed)', perCommit: null };
}
const fps = results.sim50.commitsPerSec * (straceCount ?? 1);
results.sim50.fdatasyncPerSec = +fps.toFixed(3);
rep.check('fsync/s under synthetic 50 msg/s (src/coalesce.js)', fps, '<=', 4, { unit: 'fsync/s', note: 'coalescer commits/s x measured fdatasync per commit; policy-bound (§7.3)' });
rep.check('main-thread share at 50 msg/s (6 gets + append + bump; commits are off-thread)', results.sim50.mainThreadBusyShare, '<=', 1, { unit: 'share', scale: 'cpu', informational: true });

fs.rmSync(dir, { recursive: true, force: true });
rep.finish(results);

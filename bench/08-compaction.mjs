// bench/08 - compaction (design §13 row 08, §4.6).
//
//   node --expose-gc bench/08-compaction.mjs [--scale 0.1] [--dir D]
//
// A. Retention by dropping a month bucket: event_log_202609 with 5M x scale rows (cold env, next
//    to a live event_log_202610 bucket of the same size) -> db.dropCollection() wall time, RSS
//    peak delta, free pages before/after, and whether the next month reuses the freed pages
//    (LMDB never shrinks a file; dropped pages go to the freelist).
// B. Copy-compaction of a fragmented hot env (420 MB x scale, then 40 % of the records deleted at
//    random): lmdb `env.backup(path, compact=true)` (mdb_env_copy2 + MDB_CP_COMPACT, run on an
//    lmdb worker thread) -> time, size before/after, RSS spike, then close + rename + reopen.
//    SPBT_DB has no compaction API of its own; this goes through `db.backend('hot').env`, the
//    README's documented ops hook.
//
// Both operations run in a FRESH child process after the files were evicted from the page cache
// (dd iflag=nocache), so the RSS delta is the operation's own (VmHWM reset via clear_refs) and
// not the builder's mappings.
//
// Thresholds are for the full size on the target. Projections: drop time scales with the tree
// (linear in rows, x cpu factor). Copy-compaction on the target is bound by the block volume:
// 420 MB / target sequential write MB/s (from 00-calibrate; assumed 22.5 MB/s) is a LOWER bound -
// the copy also reads 420 MB through the same volume throughput limit when not cached.

import fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDB, coreSchemas, compactCopy } from '../src/index.js';
import { parseArgs, freshDir, fsInfo, report, rng, log, eventRow, featureConfig, elogSchema, procStatus, resetPeakRss, fileSize, evictFile, MB, BENCH_DIR, lmdbWithCold, coldPageArgv, checkColdPageSize } from './lib.mjs';

const args = parseArgs();
const S = args.scale ?? 0.1;
const ROWS = Math.round(5_000_000 * S);
const HOT_MB = 420 * S;
const gc = globalThis.gc ?? (() => {});
const hotSchemas = { user: coreSchemas.user, feature_config: coreSchemas.feature_config };

/* ============================================================ children */
if (args.child) {
  const cdir = args.cdir;
  const out = {};
  if (args.child === 'drop') {
    const db = openDB({ dir: cdir, schemas: {}, lmdb: lmdbWithCold(args) });
    db.collection('event_log_202609', elogSchema(202609));
    db.collection('event_log_202610', elogSchema(202610));
    const before = db.stats().cold;
    gc();
    const m0 = procStatus();
    resetPeakRss();
    const t0 = performance.now();
    db.dropCollection('event_log_202609');
    out.dropMs = performance.now() - t0;
    out.coldPageSize = db.stats().cold.pageSize;
    const m1 = procStatus();
    const afterDrop = db.stats().cold;
    // the next month: do the freed pages get reused?
    const R = rng(10);
    const next = db.collection('event_log_202611', elogSchema(202611));
    const fileBefore = fileSize(join(cdir, 'cold.mdb'));
    const n = Math.min(Number(args.rows), 200_000);
    const chans = Array.from({ length: 500 }, () => ({ gid: R.snow(), chan: R.snow(), ts: 1_760_000_000_000 }));
    for (let i = 0; i < n; i += 5000) db.coldTxn(() => { for (let j = i; j < Math.min(n, i + 5000); j++) { const c = chans[R.int(500)]; c.ts += 1; next.put(eventRow(R, c.gid, c.chan, c.ts, j & 0xffff)); } });
    await db.flushed();
    out.refillRows = n;
    out.fileGrowthOnRefillBytes = fileSize(join(cdir, 'cold.mdb')) - fileBefore;
    out.droppedRows = before.collections.event_log_202609.entries;
    out.droppedPages = before.collections.event_log_202609.pages;
    out.freePagesBefore = before.freePages;
    out.freePagesAfterDrop = afterDrop.freePages;
    out.rss = { beforeMB: m0.VmRSS, afterMB: m1.VmRSS, peakMB: m1.VmHWM, peakDeltaMB: +(m1.VmHWM - m0.VmRSS).toFixed(2), anonDeltaMB: +(m1.RssAnon - m0.RssAnon).toFixed(2), fileDeltaMB: +(m1.RssFile - m0.RssFile).toFixed(2) };
    await db.close();
  } else if (args.child === 'compact-inproc') {
    // the pre-r2 way: env.backup(compact) inside the bot's own process (informational)
    const db = openDB({ dir: cdir, schemas: hotSchemas, lmdb: lmdbWithCold(args) });
    const dst = join(cdir, 'hot.inproc.mdb');
    gc();
    const m0 = procStatus();
    resetPeakRss();
    const t0 = performance.now();
    await db.backend('hot').env.backup(dst, true);
    out.copyMs = performance.now() - t0;
    const m1 = procStatus();
    out.rss = { beforeMB: m0.VmRSS, peakMB: m1.VmHWM, peakDeltaMB: +(m1.VmHWM - m0.VmRSS).toFixed(2), anonDeltaMB: +(m1.RssAnon - m0.RssAnon).toFixed(2), fileDeltaMB: +(m1.RssFile - m0.RssFile).toFixed(2) };
    await db.close();
    fs.rmSync(dst, { force: true });
  } else if (args.child === 'compact') {
    // as shipped: compactCopy() runs mdb_env_copy2(COMPACT) in a short-lived child process while
    // this process (the bot) keeps the env open; then close + rename + reopen
    const file = join(cdir, 'hot.mdb');
    const db = openDB({ dir: cdir, schemas: hotSchemas, lmdb: lmdbWithCold(args) });
    const st = db.stats().hot;
    const dst = join(cdir, 'hot.compact.mdb');
    gc();
    const m0 = procStatus();
    resetPeakRss();
    const t0 = performance.now();
    const cc = await compactCopy(file, dst);
    out.copyMs = performance.now() - t0;
    out.childPeakRssMB = cc.childPeakRssMB;
    out.childFloorRssMB = cc.childFloorRssMB;
    const m1 = procStatus();
    const counts = { user: db.user.count(), feature_config: db.featureConfig.count() };
    const t1 = performance.now();
    await db.close();
    fs.renameSync(dst, file);
    try { fs.rmSync(file + '-lock'); } catch {}
    const db2 = openDB({ dir: cdir, schemas: hotSchemas, lmdb: lmdbWithCold(args) });
    out.swapCloseRenameReopenMs = performance.now() - t1;
    out.countsMatchAfterSwap = JSON.stringify(counts) === JSON.stringify({ user: db2.user.count(), feature_config: db2.featureConfig.count() });
    out.fileBytesAfter = fileSize(file);
    out.freePagesBefore = st.freePages;
    out.freeShareBefore = +(st.freePages / st.pages).toFixed(3);
    out.rss = { beforeMB: m0.VmRSS, peakMB: m1.VmHWM, peakDeltaMB: +(m1.VmHWM - m0.VmRSS).toFixed(2), anonDeltaMB: +(m1.RssAnon - m0.RssAnon).toFixed(2), fileDeltaMB: +(m1.RssFile - m0.RssFile).toFixed(2) };
    await db2.close();
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

/* ============================================================== parent */
const dir = freshDir(args, '08-compaction');
const fsi = fsInfo(dir);
const rep = report('08-compaction', { scale: S, bucketRows: ROWS, hotTargetMB: HOT_MB, dir });
log(`08-compaction: bucket ${ROWS} rows, hot ~${HOT_MB} MB in ${dir} (${fsi.type})`);
const results = { fs: fsi };
const cal = rep.r.calibration.factors;
const runChild = (mode, cdir) => {
  const r = spawnSync(process.execPath, ['--expose-gc', join(BENCH_DIR, '08-compaction.mjs'), '--child', mode, '--cdir', cdir, '--rows', String(ROWS), ...coldPageArgv(args)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${mode} child failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
};

/* -------------------------------------------------------------- A. drop */
{
  const cdir = join(dir, 'cold');
  const db = openDB({ dir: cdir, schemas: {}, lmdb: lmdbWithCold(args) });
  const R = rng(8);
  const old = db.collection('event_log_202609', elogSchema(202609));
  const cur = db.collection('event_log_202610', elogSchema(202610));
  const chans = Array.from({ length: 2000 }, () => ({ gid: R.snow(), chan: R.snow(), ts: 1_757_000_000_000 }));
  const B = 5000;
  const tb = performance.now();
  for (const col of [old, cur]) for (let i = 0; i < ROWS; i += B) db.coldTxn(() => { for (let j = i; j < Math.min(ROWS, i + B); j++) { const c = chans[R.float() < 0.5 ? R.int(80) : R.int(2000)]; c.ts += 1 + R.int(500); col.put(eventRow(R, c.gid, c.chan, c.ts, j & 0xffff)); } });
  await db.flushed();
  await db.close();
  const buildS = (performance.now() - tb) / 1000;
  const fileBytes = fileSize(join(cdir, 'cold.mdb'));
  const ev = evictFile(join(cdir, 'cold.mdb'));
  const d = runChild('drop', cdir);
  results.drop = { buildSeconds: +buildS.toFixed(1), fileBytes, pageCacheEvicted: ev, ...d, dropMs: +d.dropMs.toFixed(2) };
  results.coldPageSize = d.coldPageSize;
  checkColdPageSize(rep, args, d.coldPageSize);
  const projected = cal ? (d.dropMs / 1000 / S) * cal.cpu : null;
  rep.check(`dropCollection of a ${d.droppedRows}-row month bucket (cold cache)`, d.dropMs / 1000, '<=', 2, { unit: 's', projected, note: `projection: x${(1 / S).toFixed(0)} rows (linear) x cpu factor; threshold is for 5M rows` });
  rep.check('RSS spike during drop', d.rss.peakDeltaMB, '<=', 40, { unit: 'MB', projected: S < 1 ? d.rss.anonDeltaMB + d.rss.fileDeltaMB / S : null, note: 'projection: file-backed part x 1/scale (pages read by the drop + readahead grow with the tree)' });
  rep.check('next month reuses the dropped pages (file growth on refill)', d.fileGrowthOnRefillBytes / 2 ** 20, '<=', 1, { unit: 'MB', informational: true });
  log(`  drop ${d.droppedRows} rows / ${d.droppedPages} pages: ${d.dropMs.toFixed(1)} ms, RSS +${d.rss.peakDeltaMB} MB`);
}

/* ------------------------------------------------- B. copy-compaction */
{
  const hdir = join(dir, 'hot');
  const db = openDB({ dir: hdir, schemas: hotSchemas, lmdb: lmdbWithCold(args) });
  const R = rng(9);
  const keys = [];
  const file = join(hdir, 'hot.mdb');
  // fill to the target size with a §5.1 mix: configs (~700 B) and users (~60 B, 2 indexes)
  while (fileSize(file) < HOT_MB * 2 ** 20) {
    db.txn(() => {
      for (let j = 0; j < 2000; j++) {
        if (j % 4 === 0) { const gid = R.snow(); keys.push(['c', gid]); db.featureConfig.put({ gid, tag: 1, ...featureConfig(R) }); }
        else { const uid = R.snow(); keys.push(['u', uid]); db.user.put({ uid, plan: R.int(4), since: 1, ...(R.float() < 0.1 ? { planExpiresAt: 1_800_000_000_000 + R.int(1e9) } : {}), username: 'u' + R.int(1e9), seenAt: Date.now() }); }
      }
    });
  }
  const del = keys.filter(() => R.float() < 0.4);
  for (let i = 0; i < del.length; i += 5000) db.txn(() => { for (const [k, id] of del.slice(i, i + 5000)) k === 'c' ? db.featureConfig.del(id, 1) : db.user.del(id); });
  await db.flushed();
  await db.close();
  const sizeBefore = fileSize(file);
  evictFile(file);
  const inproc = runChild('compact-inproc', hdir);
  const ev = evictFile(file);
  const c = runChild('compact', hdir);
  results.copyCompaction = {
    api: 'compactCopy(src, dst) from src/backend-lmdb.js: env.backup(compact) in a child process',
    inProcess: inproc,
    fileBytesBefore: sizeBefore,
    pageCacheEvicted: ev,
    ...c,
    copyMs: +c.copyMs.toFixed(1),
    shrink: +(1 - c.fileBytesAfter / sizeBefore).toFixed(3),
    copyMBps: +(sizeBefore / 2 ** 20 / (c.copyMs / 1000)).toFixed(1),
  };
  const projected = cal?.targetSeqWriteMBps ? 420 / cal.targetSeqWriteMBps : null;
  rep.check('copy-compaction of the 420 MB hot env', (c.copyMs / 1000) * (420 / (sizeBefore / 2 ** 20)), '<=', 30, { unit: 's', projected, note: 'local value scaled to 420 MB; projection = 420 MB / target seq write MB/s (writes only: a lower bound, reads share the volume limit)' });
  rep.check('RSS spike during copy-compaction (bot process, compactCopy in a child)', c.rss.peakDeltaMB, '<=', 40, { unit: 'MB', projected: c.rss.anonDeltaMB + c.rss.fileDeltaMB * (420 / (sizeBefore / 2 ** 20)), note: `measured at ${MB(sizeBefore)} MB; projection: file-backed part x 420 MB / size` });
  rep.check('RSS spike, copy-compaction IN the bot process (pre-r2 way)', inproc.rss.peakDeltaMB, '<=', 40, { unit: 'MB', informational: true, projected: inproc.rss.anonDeltaMB + inproc.rss.fileDeltaMB * (420 / (sizeBefore / 2 ** 20)), note: 'the compacting copy reads every live page through the mmap: clean, reclaimable, but RSS' });
  rep.check('compaction child peak RSS (transient, exits)', c.childPeakRssMB, '<=', 40, { unit: 'MB', informational: true, projected: c.childPeakRssMB != null ? c.childFloorRssMB + (c.childPeakRssMB - c.childFloorRssMB) * (420 / (sizeBefore / 2 ** 20)) : null, note: 'child floor (node + lmdb, measured after open) + the live pages it reads; projection scales the part above the floor' });
  rep.check('compacted env reopens with identical counts', +c.countsMatchAfterSwap, '==', 1, { unit: 'bool' });
  log(`  copy-compaction ${MB(sizeBefore)} MB -> ${MB(c.fileBytesAfter)} MB in ${c.copyMs.toFixed(0)} ms, RSS +${c.rss.peakDeltaMB} MB`);
}

fs.rmSync(dir, { recursive: true, force: true });
rep.finish(results);

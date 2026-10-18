// bench/03 - RSS at scale (design §13 row 03, §6 RAM budget).
//
//   node bench/03-rss-at-scale.mjs [--scale 0.1] [--seconds 60] [--rate 500] [--dir D] [--keep] [--reuse]
//        [--no-evict]           start the mix with the freshly written files still in the page cache
//        [--cold-readahead]     experiment: cold.mdb WITH readahead (the doc's §4.5 setting; the profile
//                               ships noReadAhead since r2)
//        [--hot-mapsize BYTES]  experiment: explicit hot mapSize; 0 = lmdb-js grows the map itself (the doc's
//                               setting before r2), which leaves the old, smaller mappings alive: the same
//                               pages count in RSS 2-3 times. The profile ships a fixed 2 GiB map.
//
// 1. A `gen` child builds the target dataset scaled by --scale (1 = §13: 500 guilds, 200k users,
//    200k level rows, 5M event_log rows, 50k feature_configs, 10k builder schemes, 100k mod
//    cases; guilds stay 500 at every scale).
// 2. A `mix` child - started like production (§6.4: --max-old-space-size=200
//    --max-semi-space-size=8) - opens it and runs a messageCreate-shaped mix for --seconds at
//    --rate msg/s over the §6.3 active set (100 active guilds, 5 000 active users): per message
//    guild + 3 feature_config + user + level gets, a coalesced event_log append (5 s / 512) and
//    XP delta (30 s / 2 000), plus per second a panel log view (event_log range 50), a
//    leaderboard top(10), a /history (mod_case index), a feature_config write and a mod_case
//    insert. It samples /proc/self/{status,smaps_rollup,smaps} every second.
//
// Measured: RSS, anonymous vs file-backed (smaps_rollup), per-.mdb resident MB (smaps of that
// mapping = what mincore() would report for our mapping), VmSwap, RSS slope over the second half,
// file sizes and bytes per record per collection. NOT reproduced here: the 30-minute duration
// (CLI --seconds), discord.js / Express / feature code (the §6.4 rows SPBT_DB does not own),
// mincore() sampling of the whole page cache, and memory pressure (needs a cgroup - bench 12).

import fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDB, coreSchemas } from '../src/index.js';
import { parseArgs, baseDir, fsInfo, report, rng, log, eventRow, featureConfig, builderScheme, benchSchemas, elogSchema, lmdbWithCold, coldPageArgv, checkColdPageSize, procStatus, smapsRollup, mappingRss, sleep, BENCH_DIR, fileSize, evictFile } from './lib.mjs';

const args = parseArgs();
const S = args.scale ?? 0.1;
const SECONDS = args.seconds ?? 60;
const RATE = args.rate ?? 500;
const N = {
  guilds: 500,
  users: Math.round(200_000 * S),
  levels: Math.round(200_000 * S),
  events: Math.round(5_000_000 * S),
  configs: Math.round(50_000 * S),
  schemes: Math.round(10_000 * S),
  cases: Math.round(100_000 * S),
};
const schemas = { guild: coreSchemas.guild, user: coreSchemas.user, level: coreSchemas.level, feature_config: coreSchemas.feature_config, mod_case: benchSchemas.mod_case, builder_scheme: benchSchemas.builder_scheme };
const BUCKET = 'event_log_202610';
const T0 = 1_760_000_000_000;

/** deterministic ids shared by gen and mix */
function ids() {
  const R = rng(3);
  const gids = Array.from({ length: N.guilds }, () => R.snow());
  const uids = Array.from({ length: N.users }, () => R.snow());
  const chans = Array.from({ length: 2000 }, (_, i) => ({ gid: gids[i % N.guilds], chan: R.snow() }));
  return { gids, uids, chans };
}

/* ================================================================= gen */
if (args.child === 'gen') {
  const dir = args.cdir;
  const { gids, uids, chans } = ids();
  const R = rng(4);
  const db = openDB({ dir, schemas, lmdb: lmdbWithCold(args) });
  const ev = db.collection(BUCKET, elogSchema(202610));
  const B = 5000;
  const t0 = performance.now();
  db.txn(() => { for (const gid of gids) db.guild.put({ gid, name: `guild ${R.int(1e6)}`, icon: 'a_' + R.int(1e12).toString(16), ownerId: R.snow(), memberCount: R.int(5000), joinedAt: T0 - R.int(1e10), locale: 'uk', flags: R.int(256), lastSeenAt: T0 }); });
  for (let i = 0; i < N.users; i += B) db.txn(() => { for (let j = i; j < Math.min(N.users, i + B); j++) db.user.put({ uid: uids[j], plan: R.float() < 0.03 ? 1 + R.int(3) : 0, since: T0 - R.int(1e11), ...(R.float() < 0.03 ? { planExpiresAt: T0 + R.int(1e10) } : {}), username: `user_${R.int(1e9).toString(36)}`, avatarHash: Buffer.from(Array.from({ length: 16 }, () => R.int(256))), seenAt: T0 - R.int(1e9) }); });
  // levels: members per guild skewed (a few big guilds)
  for (let i = 0; i < N.levels; i += B) db.txn(() => { for (let j = i; j < Math.min(N.levels, i + B); j++) db.level.put({ gid: gids[Math.floor(N.guilds * R.float() ** 2)], uid: uids[R.int(N.users)], xp: R.int(200_000) }); });
  for (let i = 0; i < N.configs; i += B) db.txn(() => { for (let j = i; j < Math.min(N.configs, i + B); j++) db.featureConfig.put({ gid: gids[j % N.guilds], tag: Math.floor(j / N.guilds) % 256, ...featureConfig(R) }); });
  for (let i = 0; i < N.schemes; i += 1000) db.txn(() => { for (let j = i; j < Math.min(N.schemes, i + 1000); j++) { const s = builderScheme(R); db.builderScheme.put({ ownerId: uids[R.int(N.users)], schemeId: Buffer.from(Array.from({ length: 6 }, () => R.int(256))), ...s }); } });
  for (let i = 0; i < N.cases; i += B) db.txn(() => { for (let j = i; j < Math.min(N.cases, i + B); j++) db.modCase.put({ gid: gids[j % N.guilds], caseNo: Math.floor(j / N.guilds) + 1, type: R.int(5), targetId: uids[R.int(N.users)], modId: uids[R.int(200)], reason: 'reason ' + R.int(1e6), createdAt: T0 - R.int(1e10), active: R.float() < 0.05 }); });
  const ts = new Float64Array(chans.length).fill(T0 - 30 * 86_400_000);
  for (let i = 0; i < N.events; i += B) db.coldTxn(() => { for (let j = i; j < Math.min(N.events, i + B); j++) { const c = R.float() < 0.5 ? R.int(80) : R.int(chans.length); ts[c] += 1 + R.int(2000); ev.put(eventRow(R, chans[c].gid, chans[c].chan, ts[c], j & 0xffff)); } });
  await db.flushed();
  const st = db.stats();
  await db.close();
  process.stdout.write(JSON.stringify({ seconds: (performance.now() - t0) / 1000, stats: st }, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
  process.exit(0);
}

/* ================================================================= mix */
if (args.child === 'mix') {
  const dir = args.cdir;
  const gc = globalThis.gc ?? (() => {});
  const snap = (label) => {
    const st = procStatus(), sm = smapsRollup(), hot = mappingRss('hot.mdb'), cold = mappingRss('cold.mdb'), mu = process.memoryUsage();
    return { label, t: +(performance.now() / 1000).toFixed(2), rssMB: st.VmRSS, rssAnonMB: st.RssAnon, rssFileMB: st.RssFile, rssShmemMB: st.RssShmem, swapMB: st.VmSwap, hwmMB: st.VmHWM, pssAnonMB: sm.Pss_Anon, pssFileMB: sm.Pss_File, pssShmemMB: sm.Pss_Shmem, anonymousMB: sm.Anonymous, hotMdbRssMB: hot.rssMB, coldMdbRssMB: cold.rssMB, hotMdbMappings: hot.mappings, coldMdbMappings: cold.mappings, heapUsedMB: +(mu.heapUsed / 2 ** 20).toFixed(2), externalMB: +(mu.external / 2 ** 20).toFixed(2), arrayBuffersMB: +(mu.arrayBuffers / 2 ** 20).toFixed(2) };
  };
  const samples = [];
  gc();
  samples.push(snap('node+imports'));
  const { gids, uids, chans } = ids();
  const lmdbOpts = { hot: {}, cold: {} };
  if (args['cold-noreadahead']) lmdbOpts.cold.noReadAhead = true;
  if (args['cold-readahead']) lmdbOpts.cold.noReadAhead = false;
  if (args['hot-mapsize'] !== undefined) lmdbOpts.hot.mapSize = Number(args['hot-mapsize']);
  const db = openDB({ dir, schemas, lmdb: lmdbWithCold(args, lmdbOpts) });
  const ev = db.collection(BUCKET, elogSchema(202610));
  gc();
  samples.push(snap('opened'));
  const R = rng(5);
  // §6.3 active set: 100 guilds, 5 000 users; the channels of active guilds
  const activeG = gids.slice(0, 100);
  const activeU = Array.from({ length: Math.min(5000, uids.length) }, () => uids[R.int(uids.length)]);
  const activeC = chans.filter((c) => activeG.includes(c.gid));
  const cfgTags = Math.max(1, Math.floor(N.configs / N.guilds));
  // existing schemes to read
  const schemeKeys = db.builderScheme.query({ limit: 200 }).items.map((s) => [s.ownerId, s.schemeId]);
  let evBuf = [], evFirst = performance.now(), lv = new Map(), lvFirst = performance.now(), seq = 0, caseNo = 1_000_000;
  const stats = { msgs: 0, commits: 0, panelReads: 0, errors: 0, errorSamples: [] };
  const flushEv = () => { if (!evBuf.length) return; const b = evBuf; evBuf = []; db.coldTxn(() => { for (const r of b) ev.put(r); }); stats.commits++; };
  const flushLv = () => { if (!lv.size) return; const b = lv; lv = new Map(); db.txn(() => { for (const d of b.values()) db.level.incr(d.gid, d.uid, 'xp', d.dxp); }); stats.commits++; };
  const t0 = performance.now(), end = t0 + SECONDS * 1000;
  let nextSample = t0 + 1000, nextPanel = t0 + 1000, sink = 0;
  const perTick = Math.max(1, Math.round(RATE / 100)); // 10 ms ticks
  while (performance.now() < end) {
    const tick = performance.now();
    try {
      for (let m = 0; m < perTick; m++) {
        const c = activeC[R.int(activeC.length)], uid = activeU[R.int(activeU.length)];
        sink += db.guild.get(c.gid) ? 1 : 0;
        for (let k = 0; k < 3; k++) sink += db.featureConfig.get(c.gid, R.int(cfgTags)) ? 1 : 0;
        sink += db.user.get(uid) ? 1 : 0;
        sink += db.level.get(c.gid, uid)?.xp ?? 0;
        evBuf.push(eventRow(R, c.gid, c.chan, Date.now(), seq++ & 0xffff));
        const key = `${c.gid}:${uid}`;
        const d = lv.get(key);
        if (d) d.dxp += 15; else lv.set(key, { gid: c.gid, uid, dxp: 15 });
        stats.msgs++;
      }
      const now = performance.now();
      if (evBuf.length >= 512 || now - evFirst >= 5000) { flushEv(); evFirst = now; }
      if (lv.size >= 2000 || now - lvFirst >= 30_000) { flushLv(); lvFirst = now; }
      if (now >= nextPanel) {
        nextPanel += 1000;
        const c = activeC[R.int(activeC.length)], g = activeG[R.int(activeG.length)];
        sink += ev.query({ index: 'elog_by_chan_202610', where: [c.gid, c.chan], limit: 50, desc: true }).items.length;
        sink += db.level.top(g, 10).length;
        sink += db.modCase.query({ index: 'case_by_target', where: [g, activeU[R.int(activeU.length)]], limit: 10 }).items.length;
        if (schemeKeys.length) sink += db.builderScheme.get(...schemeKeys[R.int(schemeKeys.length)]) ? 1 : 0;
        db.featureConfig.put({ gid: g, tag: R.int(cfgTags), ...featureConfig(R) });
        db.modCase.put({ gid: g, caseNo: caseNo++, type: R.int(5), targetId: activeU[R.int(activeU.length)], modId: uids[R.int(200)], reason: 'bench', createdAt: Date.now(), active: false });
        stats.commits += 2;
        stats.panelReads++;
      }
      if (now >= nextSample) { nextSample += 1000; samples.push(snap('mix')); }
    } catch (e) { stats.errors++; if (stats.errorSamples.length < 3) stats.errorSamples.push(String(e.stack).split('\n').slice(0, 4).join(' | ')); }
    const wait = 10 - (performance.now() - tick);
    if (wait > 0) await sleep(wait);
  }
  flushEv(); flushLv();
  gc();
  samples.push(snap('end+gc'));
  const st = db.stats();
  await db.close();
  if (sink === Math.PI) process.stderr.write('');
  process.stdout.write(JSON.stringify({ samples, stats, seconds: (performance.now() - t0) / 1000, dbStats: st }));
  process.exit(0);
}

/* ============================================================== parent */
const dir = join(baseDir(args), '03-rss');
const fsi = fsInfo(baseDir(args));
const rep = report('03-rss-at-scale', { scale: S, seconds: SECONDS, rate: RATE, rows: N, dir });
const self = join(BENCH_DIR, '03-rss-at-scale.mjs');
let gen;
if (args.reuse && fs.existsSync(join(dir, 'hot.mdb'))) {
  gen = { reused: true };
} else {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  log(`03-rss-at-scale: generating scale ${S} into ${dir} (${fsi.type}) ...`);
  const g = spawnSync(process.execPath, [self, '--child', 'gen', '--cdir', dir, '--scale', String(S), ...coldPageArgv(args)], { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });
  if (g.status !== 0) { log(g.stderr); process.exit(2); }
  gen = JSON.parse(g.stdout);
  log(`  generated in ${gen.seconds.toFixed(1)} s`);
}
// Start the mix from an evicted page cache (like a bot after a reboot). Without this, the files
// sit in the page cache as the LARGE folios btrfs created while gen wrote them, and on this
// kernel (7.x) one read fault maps the whole folio: measured 12-24 lmdb pages mapped per 50-row
// range instead of 2.4-2.8 from an evicted cache. That inflates RSS by a host artefact.
const evicted = fsi.realDisk && !args['no-evict'] ? { hot: evictFile(join(dir, 'hot.mdb')), cold: evictFile(join(dir, 'cold.mdb')) } : null;
log(`  mix: ${SECONDS} s at ${RATE} msg/s ...`);
const m = spawnSync(process.execPath, ['--max-old-space-size=200', '--max-semi-space-size=8', '--expose-gc', self, '--child', 'mix', '--cdir', dir, '--scale', String(S), '--seconds', String(SECONDS), '--rate', String(RATE), ...coldPageArgv(args), ...(args['cold-noreadahead'] ? ['--cold-noreadahead'] : []), ...(args['cold-readahead'] ? ['--cold-readahead'] : []), ...(args['hot-mapsize'] !== undefined ? ['--hot-mapsize', String(args['hot-mapsize'])] : [])], { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });
if (m.status !== 0) { log(m.stderr); process.exit(2); }
const mix = JSON.parse(m.stdout);

const samples = mix.samples;
const mixS = samples.filter((s) => s.label === 'mix');
const last = samples[samples.length - 1];
const peak = (k) => Math.max(...samples.map((s) => s[k] ?? 0));
// linear regression of RSS (MB) over time (min) for the second half of the mix
const half = mixS.slice(Math.floor(mixS.length / 2));
let slope = null;
if (half.length >= 3) {
  const xs = half.map((s) => s.t / 60), ys = half.map((s) => s.rssMB);
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
}
// file-backed: on tmpfs the mapped .mdb pages are shmem, not file
const fileBacked = (s) => (fsi.realDisk ? s.rssFileMB : s.rssFileMB + s.rssShmemMB);
const anon = (s) => s.rssAnonMB;

// sizes per collection
const perCollection = {};
for (const env of ['hot', 'cold']) {
  const e = mix.dbStats[env];
  if (!e) continue;
  for (const [name, c] of Object.entries(e.collections)) perCollection[name] = { env, entries: c.entries, pages: c.pages, bytesOnPages: c.pages * e.pageSize, bytesPerRecord: c.entries ? +((c.pages * e.pageSize) / c.entries).toFixed(1) : null };
}
const records = (name, ...ix) => {
  const p = perCollection[name];
  if (!p) return null;
  const total = p.bytesOnPages + ix.reduce((s, i) => s + (perCollection[i]?.bytesOnPages ?? 0), 0);
  return { entries: p.entries, dataBytesPerRecord: p.bytesPerRecord, withIndexesBytesPerRecord: +(total / p.entries).toFixed(1) };
};
const files = { hotMB: +(fileSize(join(dir, 'hot.mdb')) / 2 ** 20).toFixed(1), coldMB: +(fileSize(join(dir, 'cold.mdb')) / 2 ** 20).toFixed(1) };

const results = {
  coldPageSize: mix.dbStats.cold.pageSize,
  fs: fsi,
  gen,
  pageCacheEvictedBeforeMix: evicted,
  mix: { seconds: +mix.seconds.toFixed(1), ...mix.stats, msgsPerSec: Math.round(mix.stats.msgs / mix.seconds) },
  memory: {
    atNodeStart: samples[0],
    afterOpen: samples[1],
    end: last,
    peakRssMB: peak('rssMB'),
    peakAnonMB: peak('rssAnonMB'),
    peakHotMdbRssMB: peak('hotMdbRssMB'),
    peakColdMdbRssMB: peak('coldMdbRssMB'),
    peakSwapMB: peak('swapMB'),
    hotMdbMappingsEnd: last.hotMdbMappings,
    coldMdbMappingsEnd: last.coldMdbMappings,
    rssSlopeMBPerMinSecondHalf: slope == null ? null : +slope.toFixed(3),
    hotResidentShareOfFile: +(last.hotMdbRssMB / files.hotMB).toFixed(3),
    coldResidentShareOfFile: +(last.coldMdbRssMB / files.coldMB).toFixed(3),
  },
  files,
  bytesPerRecord: {
    user: records('user', 'user_by_plan', 'user_by_expiry'),
    level: records('level', 'level_by_xp'),
    feature_config: records('feature_config'),
    builder_scheme: records('builder_scheme', 'scheme_by_updated'),
    mod_case: records('mod_case', 'case_by_target', 'case_by_mod', 'case_active'),
    event_log: records(BUCKET),
    guild: records('guild'),
  },
  docBytesPerRow: { user: 60, level: 6, feature_config: 700, builder_scheme: 1500, mod_case: 150, event_log: 200, guild: 70, note: '§5 logical B/row; ×1.35 B+tree fill-factor per §5.10' },
  perCollection,
  samples,
};

checkColdPageSize(rep, args, mix.dbStats.cold.pageSize);
// §6.4: whole-process budget (TANO = Node + discord.js + web + features + SPBT_DB)
rep.check('RSS peak (Node + SPBT_DB only) <= 270 MB', results.memory.peakRssMB, '<=', 270, { unit: 'MB' });
rep.check('anonymous peak <= 200 MB', results.memory.peakAnonMB, '<=', 200, { unit: 'MB' });
rep.check('VmSwap == 0', results.memory.peakSwapMB, '<=', 0, { unit: 'MB', note: 'this dev box swaps to zram under its own load; a non-zero value here is host pressure, not SPBT_DB' });
rep.check('RSS slope, second half of mix', results.memory.rssSlopeMBPerMinSecondHalf ?? 0, '<=', 0.5, { unit: 'MB/min', informational: SECONDS < 1800, note: SECONDS < 1800 ? `over ${SECONDS / 2} s: the mmap working set is still warming up; the gate needs --seconds 1800 (last 15 min)` : 'last 15 min' });
// §6.4 rows SPBT_DB owns: Node floor 42 + JS layer 10 + lmdb native 14 (+ GC headroom 22) anonymous;
// file-backed hot 35 + cold 18. At scale < 1 the file-backed comparison is optimistic.
rep.check('anonymous end (after gc) <= 88 MB (§6.4 Node floor 42 + SPBT_DB JS 10 + lmdb native 14 + GC 22)', anon(last), '<=', 88, { unit: 'MB' });
rep.check('file-backed .mdb resident <= 53 MB (§6.3 hot 35 + cold 18)', +(peak('hotMdbRssMB') + peak('coldMdbRssMB')).toFixed(2), '<=', 53, { unit: 'MB', note: S < 1 ? `scale ${S}: branch pages are ~${S}x of full size, active set is full size` : undefined });
rep.check('hot.mdb resident <= 35 MB', results.memory.peakHotMdbRssMB, '<=', 35, { unit: 'MB', informational: true });
rep.check('cold.mdb resident <= 18 MB', results.memory.peakColdMdbRssMB, '<=', 18, { unit: 'MB', informational: true });
rep.check('mix errors', mix.stats.errors, '==', 0, { unit: '' });
if (!fsi.realDisk) rep.note('tmpfs: .mdb mappings count as RssShmem, added to file-backed here');
rep.note('process RSS excludes discord.js (40 MB), Express/SSR (16 MB), feature logic (24 MB) and the 24 MB CacheBudget of §6.4: this is the SPBT_DB slice only');
rep.note('working-set residency (>= 95 %) is trivially 100 % here: the box has free RAM; it is only meaningful under memory pressure (bench 12, needs a cgroup)');

log(`  RSS peak ${results.memory.peakRssMB} MB, anon ${results.memory.peakAnonMB} MB, hot.mdb ${results.memory.peakHotMdbRssMB} MB, cold.mdb ${results.memory.peakColdMdbRssMB} MB, files hot ${files.hotMB} / cold ${files.coldMB} MB`);
if (!args.keep) fs.rmSync(dir, { recursive: true, force: true });
rep.finish(results);

// bench/02 - read latency (design §13 row 02).
//
//   node --expose-gc bench/02-read-latency.mjs [--dir D] [--scale 1] [--gets 300000] [--cold-gets 3000] [--hot-mapsize BYTES]
//   (--hot-mapsize 0 = lmdb-js's growing map, the pre-r2 setting)
//
// Dataset (scale 1 = the §5 row counts for these collections): level 200k, user 200k (2 indexes),
// feature_config 50k (~700 B, deflated above 512 B), mod_case 100k (3 indexes), event_log 300k
// (cold env). Then, in this process after a warm-up pass (HOT = every page resident and mapped):
//   * get + frame decode: level (varint), user (msgpack ~60 B), feature_config (msgpack+deflate)
//   * index lookup: mod_case by (gid, targetId) via case_by_target, limit 10, with primary fetch
//     ("/history @user"), and level.rank() (index range count)
//   * range(100): the latest 100 event_log rows of one channel (event_log as shipped: the lagged
//     elog_by_chan index, its RAM tail, 100 primary gets + msgpack decode), and level.top(gid, 100)
//     (covered index range). event_log edit/delete lookups: byMessageId through the primary key.
//
// COLD case. Dropping the page cache needs root, and a dataset bigger than this box's 15 GB RAM or
// a memory cgroup is not available here. What we do instead: close the env, `sync`, then
// `dd if=<file> iflag=nocache count=0` (GNU dd -> posix_fadvise(POSIX_FADV_DONTNEED), no root
// needed), verify with `fincore` that the files left the page cache, and read random keys from a
// FRESH process. Each first touch is then a real major fault served by the disk (noReadAhead =
// MADV_RANDOM on hot.mdb, so ~1 page per fault). On tmpfs this is impossible (tmpfs IS the page
// cache): the report then says the cold numbers are minor faults only.

import fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDB, coreSchemas } from '../src/index.js';
import { prefixEnd } from '../src/keys.js';
import { parseArgs, freshDir, fsInfo, report, rng, latencyNs, log, eventRow, featureConfig, benchSchemas, elogSchema, evictFile, fincore, BENCH_DIR, summary } from './lib.mjs';
import { snowflakeTs } from '../src/schema.js';

const args = parseArgs();
const S = args.scale ?? 1;
const GETS = args.gets ?? 300_000;
const COLD = args['cold-gets'] ?? 3000;

const schemas = { level: coreSchemas.level, user: coreSchemas.user, feature_config: coreSchemas.feature_config, mod_case: benchSchemas.mod_case };
const SEED = 2;
const lmdbOpts = args['hot-mapsize'] !== undefined ? { hot: { mapSize: Number(args['hot-mapsize']) } } : undefined;
const N = { level: Math.round(200_000 * S), user: Math.round(200_000 * S), fc: Math.round(50_000 * S), cases: Math.round(100_000 * S), events: Math.round(300_000 * S) };

/** Deterministic key material, shared by the parent (writer) and the cold child (reader). */
function keys() {
  const R = rng(SEED);
  const gids = Array.from({ length: 500 }, () => R.snow());
  const levelKeys = Array.from({ length: N.level }, (_, i) => [gids[i % 500], R.snow()]);
  const uids = Array.from({ length: N.user }, () => R.snow());
  return { R, gids, levelKeys, uids };
}

const majflt = () => Number(fs.readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ')[9]);

/* ------------------------------------------------------- cold child */
if (args.child === 'cold') {
  const { gids, levelKeys, uids } = keys();
  const t0 = performance.now();
  const db = openDB({ dir: args.cdir, schemas, lmdb: lmdbOpts });
  const openMs = performance.now() - t0;
  const R = rng(999);
  const lat = [], latU = [];
  const f0 = majflt();
  for (let i = 0; i < COLD; i++) {
    const k = levelKeys[R.int(levelKeys.length)];
    const a = process.hrtime.bigint();
    db.level.get(k[0], k[1]);
    lat.push(Number(process.hrtime.bigint() - a) / 1e3);
  }
  const f1 = majflt();
  for (let i = 0; i < COLD; i++) {
    const u = uids[R.int(uids.length)];
    const a = process.hrtime.bigint();
    db.user.get(u);
    latU.push(Number(process.hrtime.bigint() - a) / 1e3);
  }
  const f2 = majflt();
  // the same keys again: now resident (shows the cold/hot gap within one process)
  const R2 = rng(999);
  const again = [];
  for (let i = 0; i < COLD; i++) { const k = levelKeys[R2.int(levelKeys.length)]; const a = process.hrtime.bigint(); db.level.get(k[0], k[1]); again.push(Number(process.hrtime.bigint() - a) / 1e3); }
  void gids;
  process.stdout.write(JSON.stringify({ openMs, levelGetUs: summary(lat, 1), userGetUs: summary(latU, 1), sameKeysAgainUs: summary(again, 2), majorFaults: { level: f1 - f0, user: f2 - f1 }, majorFaultsPerGet: { level: +((f1 - f0) / COLD).toFixed(3), user: +((f2 - f1) / COLD).toFixed(3) } }));
  await db.close();
  process.exit(0);
}

/* ------------------------------------------------------------ build */
const dir = freshDir(args, '02-read');
const fsi = fsInfo(dir);
const rep = report('02-read-latency', { scale: S, gets: GETS, coldGets: COLD, dir, rows: N });
log(`02-read-latency: ${dir} (${fsi.type}), rows ${JSON.stringify(N)}`);
const gc = globalThis.gc ?? (() => {});

const { R, gids, levelKeys, uids } = keys();
let db = openDB({ dir, schemas, lmdb: lmdbOpts });
const ev = db.collection('event_log_202610', elogSchema(202610));
const EV_IX = 'elog_by_chan_202610';
const B = 5000;
const tb = performance.now();
for (let i = 0; i < N.level; i += B) db.txn(() => { for (let j = i; j < Math.min(N.level, i + B); j++) db.level.put({ gid: levelKeys[j][0], uid: levelKeys[j][1], xp: R.int(500_000) }); });
for (let i = 0; i < N.user; i += B) db.txn(() => { for (let j = i; j < Math.min(N.user, i + B); j++) db.user.put({ uid: uids[j], plan: R.float() < 0.05 ? 1 + R.int(3) : 0, since: 1_600_000_000_000 + R.int(1e11), ...(R.float() < 0.05 ? { planExpiresAt: 1_800_000_000_000 + R.int(1e10) } : {}), username: `user_${R.int(1e9).toString(36)}`, avatarHash: Buffer.from(Array.from({ length: 16 }, () => R.int(256))), seenAt: 1_760_000_000_000 + R.int(1e9) }); });
const fcKeys = [];
for (let i = 0; i < N.fc; i += B) db.txn(() => { for (let j = i; j < Math.min(N.fc, i + B); j++) { const gid = gids[j % 500], tag = Math.floor(j / 500) % 256; fcKeys.push([gid, tag]); db.featureConfig.put({ gid, tag, ...featureConfig(R) }); } });
const caseKeys = [];
const targetsByGid = gids.map(() => Array.from({ length: 40 }, () => R.snow()));
const mods = Array.from({ length: 20 }, () => R.snow());
for (let i = 0; i < N.cases; i += B) db.txn(() => { for (let j = i; j < Math.min(N.cases, i + B); j++) { const g = j % 500, gid = gids[g], caseNo = Math.floor(j / 500) + 1; const targetId = targetsByGid[g][R.int(40)]; caseKeys.push([gid, targetId]); db.modCase.put({ gid, caseNo, type: R.int(5), targetId, modId: mods[R.int(20)], reason: 'reason ' + R.int(1e6), createdAt: 1_700_000_000_000 + j, active: R.float() < 0.1 }); } });
const chans = Array.from({ length: 400 }, (_, i) => ({ gid: gids[i % 500], chan: R.snow(), ts: 1_760_000_000_000, seq: 0 }));
// one wall clock (~2.5 ms between messages), seq unique per row: the shipped pk is (ts, seq)
let evTs = 1_760_000_000_000, evSeq = 0;
const msgIds = [];
for (let i = 0; i < N.events; i += B) db.coldTxn(() => { for (let j = i; j < Math.min(N.events, i + B); j++) { const c = chans[R.int(400)]; const r = eventRow(R, c.gid, c.chan, (evTs += 1 + R.int(4)), (evSeq = (evSeq + 1) & 0xffff)); if (r.k === 0) msgIds.push(r.msgId); ev.put(r); } });
await db.flushed();
const buildS = (performance.now() - tb) / 1000;
const st = db.stats();
log(`  built in ${buildS.toFixed(1)} s: hot ${(st.hot.fileBytes / 2 ** 20).toFixed(1)} MB, cold ${(st.cold.fileBytes / 2 ** 20).toFixed(1)} MB`);

/* -------------------------------------------------------------- hot */
const RK = rng(77);
const idxL = Uint32Array.from({ length: GETS }, () => RK.int(N.level));
const idxU = Uint32Array.from({ length: GETS }, () => RK.int(N.user));
const idxF = Uint32Array.from({ length: GETS }, () => RK.int(fcKeys.length));
let sink = 0;
const warm = (fn) => { for (let i = 0; i < GETS; i++) fn(i); };
const lvGet = (i) => { const k = levelKeys[idxL[i]]; sink += db.level.get(k[0], k[1]).xp; };
const usGet = (i) => { sink += db.user.get(uids[idxU[i]]).plan; };
const fcGet = (i) => { const k = fcKeys[idxF[i]]; sink += db.featureConfig.get(k[0], k[1]).limits.perUser; };
const hot = {};
for (const [name, fn] of [['levelGet', lvGet], ['userGet', usGet], ['featureConfigGet', fcGet]]) {
  warm(fn); gc();
  hot[name] = latencyNs(fn, GETS);
}
// index lookups
const NI = Math.min(GETS, 100_000);
const idxC = Uint32Array.from({ length: NI }, () => RK.int(caseKeys.length));
const history = (i) => { const k = caseKeys[idxC[i]]; sink += db.modCase.query({ index: 'case_by_target', where: k, limit: 10 }).items.length; };
const rank = (i) => { const k = levelKeys[idxL[i]]; sink += db.level.rank(k[0], k[1]); };
for (const [name, fn] of [['indexLookupCaseByTarget', history], ['levelRank', rank]]) {
  for (let i = 0; i < NI; i++) fn(i);
  gc();
  hot[name] = latencyNs(fn, NI);
}
// range(100)
const NR = Math.min(GETS, 30_000);
const idxCh = Uint32Array.from({ length: NR }, () => RK.int(chans.length));
const idxG = Uint32Array.from({ length: NR }, () => RK.int(500));
const evRange = (i) => { const c = chans[idxCh[i]]; sink += ev.query({ index: EV_IX, where: [c.gid, c.chan], desc: true, limit: 100 }).items.length; };
const idxM = Uint32Array.from({ length: NR }, () => RK.int(msgIds.length));
// byMessageId as db.bucketed does it, for one month: the k=0 row at its snowflake time
const byMsg = (i) => { const id = msgIds[idxM[i]]; for (const r of ev.query({ prefix: [snowflakeTs(id)], limit: 16 }).items) if (r.msgId === id) { sink++; break; } };
const top100 = (i) => { sink += db.level.top(gids[idxG[i]], 100).length; };
const evRangeCount = (() => { let n = 0; for (let i = 0; i < 200; i++) { const c = chans[idxCh[i]]; n += ev.query({ index: EV_IX, where: [c.gid, c.chan], desc: true, limit: 100 }).items.length; } return n / 200; })();
// baselines: the bare Backend (lmdb getRange + getBinaryFast, no SPBT_DB decode, no RAM tail)
const coldB = db.backend('cold'), hotB = db.backend('hot');
const evDbi = coldB.openCollection('event_log_202610'), evIxDbi = coldB.openCollection(EV_IX), ixDbi = hotB.openCollection('level_by_xp', { dupSort: true });
const chPre = chans.map((c) => ev.indexes[EV_IX].tuple.encode([c.gid, c.chan]));
const gPre = gids.map((g) => db.level.pk.encode([g]).subarray(0, 8));
const rawEv = (i) => { const k = chPre[idxCh[i]]; for (const e of coldB.range(evIxDbi, { start: prefixEnd(k), end: k, reverse: true, exclusiveStart: true, limit: 100 })) sink += coldB.get(evDbi, e.key.subarray(16)).length; };
const rawIx = (i) => { const k = Buffer.from(gPre[idxG[i]]); for (const e of hotB.range(ixDbi, { start: k, end: prefixEnd(k), limit: 100 })) sink += e.value.length; };
for (const [name, fn] of [['eventLogRange100', evRange], ['levelTop100Covered', top100], ['rawBackendRange100EventLog', rawEv], ['rawBackendRange100LevelByXp', rawIx], ['eventLogByMessageId', byMsg]]) {
  for (let i = 0; i < NR; i++) fn(i);
  gc();
  hot[name] = latencyNs(fn, NR);
}
hot.eventLogRange100.meanItems = evRangeCount;
// event-paced: what a messageCreate handler sees at 50 msg/s - the process idles 20 ms between
// messages (lmdb-js resets its read txn on the next event turn, CPU caches go cold), then does
// a burst of gets. First get of the burst vs the rest.
{
  const N_PACED = args.paced ?? 400;
  const first = [], rest = [];
  const RP = rng(4242);
  for (let i = 0; i < N_PACED; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const k = levelKeys[RP.int(N.level)], k2 = levelKeys[RP.int(N.level)], f = fcKeys[RP.int(fcKeys.length)];
    let a = process.hrtime.bigint();
    sink += db.level.get(k[0], k[1]).xp;
    first.push(Number(process.hrtime.bigint() - a));
    a = process.hrtime.bigint();
    sink += db.user.get(uids[RP.int(N.user)]).plan;
    sink += db.featureConfig.get(f[0], f[1]).limits.perUser;
    sink += db.level.get(k2[0], k2[1]).xp;
    rest.push(Number(process.hrtime.bigint() - a) / 3);
  }
  hot.pacedFirstGet = summary(first, 0);
  hot.pacedNextGetsAvg = summary(rest, 0);
}
const toUs = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' && k !== 'n' && k !== 'meanItems' ? +(v / 1000).toFixed(3) : v]));
const hotUs = Object.fromEntries(Object.entries(hot).map(([k, v]) => [k, toUs(v)]));

rep.check('hot level.get p50', hotUs.levelGet.p50, '<=', 2, { unit: 'µs', scale: 'cpu' });
rep.check('hot level.get p99', hotUs.levelGet.p99, '<=', 10, { unit: 'µs', scale: 'cpu' });
rep.check('hot user.get p50 (msgpack)', hotUs.userGet.p50, '<=', 2, { unit: 'µs', scale: 'cpu' });
rep.check('hot user.get p99 (msgpack)', hotUs.userGet.p99, '<=', 10, { unit: 'µs', scale: 'cpu' });
rep.check('hot feature_config.get p50 (~700 B, deflate)', hotUs.featureConfigGet.p50, '<=', 2, { unit: 'µs', scale: 'cpu', informational: true, note: 'design reads configs through configLRU (§6.2), not a decode per read' });
rep.check('hot feature_config.get p99', hotUs.featureConfigGet.p99, '<=', 10, { unit: 'µs', scale: 'cpu', informational: true });
rep.check('event-paced first get after 20 ms idle p50 (50 msg/s handler)', hotUs.pacedFirstGet.p50, '<=', 2, { unit: 'µs', scale: 'cpu', informational: true, note: 'not the doc\'s steady-state metric, but what each messageCreate pays first: read-txn renewal + cold CPU caches after an idle event turn' });
rep.check('event-paced following gets p50 (avg of user + feature_config + level)', hotUs.pacedNextGetsAvg.p50, '<=', 10, { unit: 'µs', scale: 'cpu', informational: true });
rep.check('index lookup case_by_target (limit 10, +primary) p99', hotUs.indexLookupCaseByTarget.p99, '<=', 200, { unit: 'µs', scale: 'cpu', informational: true, note: 'no explicit doc threshold; range(100) limit used as a sanity bound' });
rep.check('range(100) event_log p99 (latest 100 of a channel, full rows)', hotUs.eventLogRange100.p99, '<=', 200, { unit: 'µs', scale: 'cpu' });
rep.check('range(100) event_log p50', hotUs.eventLogRange100.p50, '<=', 200, { unit: 'µs', scale: 'cpu', informational: true });
rep.check('range(100) level.top covered p99', hotUs.levelTop100Covered.p99, '<=', 200, { unit: 'µs', scale: 'cpu' });
rep.check('range(100) bare lmdb event_log p99 (index range + 100 gets, engine floor, no decode)', hotUs.rawBackendRange100EventLog.p99, '<=', 200, { unit: 'µs', scale: 'cpu', informational: true, note: 'what the range costs before SPBT_DB decodes anything' });
rep.check('event_log byMessageId p99 (edit/delete lookup)', hotUs.eventLogByMessageId.p99, '<=', 10, { unit: 'µs', scale: 'cpu', informational: true });
log(`  hot level.get p50 ${hotUs.levelGet.p50} µs p99 ${hotUs.levelGet.p99} µs; event_log range100 p99 ${hotUs.eventLogRange100.p99} µs`);

/* ------------------------------------------------------------- cold */
await db.close();
const hotFile = join(dir, 'hot.mdb'), coldFile = join(dir, 'cold.mdb');
const ev1 = evictFile(hotFile), ev2 = evictFile(coldFile);
const cr = spawnSync(process.execPath, [join(BENCH_DIR, '02-read-latency.mjs'), '--child', 'cold', '--cdir', dir, '--scale', String(S), '--cold-gets', String(COLD), ...(lmdbOpts ? ['--hot-mapsize', String(args['hot-mapsize'])] : [])], { encoding: 'utf8' });
let cold = null;
try { cold = JSON.parse(cr.stdout); } catch { rep.note(`cold child failed: ${cr.stderr.slice(0, 400)}`); }
const coldKind = !fsi.realDisk ? 'minor faults only: tmpfs cannot be evicted' : ev1.after === 0 ? 'major faults from disk (page cache evicted: fincore 0 B before the run)' : `partially evicted (fincore ${ev1.after} B still resident)`;
if (cold) {
  rep.check('cold level.get p50 (first touch)', cold.levelGetUs.p50, '<=', 600, { unit: 'µs', informational: true, note: '§6.5 assumes a page fault on the target costs 400-600 µs' });
  rep.check('cold level.get p99', cold.levelGetUs.p99, '<=', 600, { unit: 'µs', informational: true });
}
rep.note(`cold case: ${coldKind}`);
rep.note('lmdb readahead: hot.mdb uses noReadAhead (MADV_RANDOM), cold.mdb does not');

const residentAfter = fincore(hotFile);
fs.rmSync(dir, { recursive: true, force: true });
if (sink === Math.PI) log(sink);
rep.finish({
  fs: fsi,
  build: { seconds: +buildS.toFixed(1), hotFileMB: +(st.hot.fileBytes / 2 ** 20).toFixed(1), coldFileMB: +(st.cold.fileBytes / 2 ** 20).toFixed(1) },
  hotUs,
  cold: cold && { kind: coldKind, eviction: { hot: ev1, cold: ev2 }, residentAfterRunHotBytes: residentAfter, ...cold },
});

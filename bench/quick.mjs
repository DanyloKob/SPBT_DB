// Quick micro-benchmark for the `level` collection (design §5.4).
//
//   node bench/quick.mjs [dir]        default dir: $SPBTDB_BENCH_DIR or $TMPDIR/spbt-db-bench/quick (removed afterwards)
//   SPBTDB_BENCH_N=100000 SPBTDB_BENCH_GETS=1000000 SPBTDB_BENCH_BATCH=1000
//
// Measures: batched puts (with level_by_xp index maintenance), batched incr (index key
// moves), random gets (bigint and string snowflakes; ops/s + p50/p99 latency),
// leaderboard top(10), and on-disk bytes per record.

import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { openDB } from '../src/index.js';

// never inside the repo; note that on tmpfs the put numbers exclude fsync (see bench/00-calibrate)
const dir = process.argv[2] ?? join(process.env.SPBTDB_BENCH_DIR ?? join(os.tmpdir(), 'spbt-db-bench'), 'quick');
const N = Number(process.env.SPBTDB_BENCH_N ?? 100_000);
const GETS = Number(process.env.SPBTDB_BENCH_GETS ?? 1_000_000);
const BATCH = Number(process.env.SPBTDB_BENCH_BATCH ?? 1000);
const GUILDS = 500;

fs.rmSync(dir, { recursive: true, force: true });
const db = openDB({ dir, backend: process.env.SPBTDB_BENCH_BACKEND ?? 'lmdb', schemas: {} });
const { coreSchemas } = await import('../src/schema.js');
const level = db.collection('level', coreSchemas.level);

// deterministic snowflake-ish ids (~2^60)
let seed = 0x9e3779b9;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const snow = () => (BigInt(Math.floor(rnd() * 2 ** 28) + 2 ** 28) << 32n) | BigInt(Math.floor(rnd() * 2 ** 32));
const gids = Array.from({ length: GUILDS }, snow);
const rows = Array.from({ length: N }, (_, i) => ({ gid: gids[i % GUILDS], uid: snow(), xp: Math.floor(rnd() * 100_000) }));

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const out = {};

// 1. batched puts
let t0 = process.hrtime.bigint();
let worstTxn = 0;
for (let i = 0; i < N; i += BATCH) {
  const t = process.hrtime.bigint();
  db.txn(() => { for (let j = i; j < Math.min(N, i + BATCH); j++) level.put(rows[j]); });
  worstTxn = Math.max(worstTxn, ms(t));
}
let el = ms(t0);
out.put = { ops: N, ms: el, opsPerSec: (N / el) * 1000, txns: Math.ceil(N / BATCH), msPerTxn: el / Math.ceil(N / BATCH), worstTxnMs: worstTxn };

// 2. batched incr: every row gains xp -> the level_by_xp entry moves
t0 = process.hrtime.bigint();
for (let i = 0; i < N; i += BATCH) db.txn(() => { for (let j = i; j < Math.min(N, i + BATCH); j++) level.incr(rows[j].gid, rows[j].uid, 'xp', 1 + (j % 7)); });
el = ms(t0);
out.incr = { ops: N, ms: el, opsPerSec: (N / el) * 1000 };
await db.flushed();

// 3. random gets - throughput
const idx = new Uint32Array(GETS);
for (let i = 0; i < GETS; i++) idx[i] = Math.floor(rnd() * N);
let sink = 0;
t0 = process.hrtime.bigint();
for (let i = 0; i < GETS; i++) { const r = rows[idx[i]]; sink += level.get(r.gid, r.uid).xp; }
el = ms(t0);
out.get = { ops: GETS, ms: el, opsPerSec: (GETS / el) * 1000 };

// 4. random gets - latency distribution (each op timed; timer overhead reported separately)
const lat = new Float64Array(GETS);
for (let i = 0; i < GETS; i++) {
  const r = rows[idx[i]];
  const t = process.hrtime.bigint();
  sink += level.get(r.gid, r.uid).xp;
  lat[i] = Number(process.hrtime.bigint() - t);
}
lat.sort();
const timer = new Float64Array(100_000);
for (let i = 0; i < timer.length; i++) { const t = process.hrtime.bigint(); timer[i] = Number(process.hrtime.bigint() - t); }
timer.sort();
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
out.getLatencyNs = { p50: pct(lat, 0.5), p99: pct(lat, 0.99), p999: pct(lat, 0.999), max: lat[lat.length - 1], timerOverheadP50: pct(timer, 0.5) };

// 5. gets with discord.js-style string snowflakes
const strRows = rows.map((r) => [String(r.gid), String(r.uid)]);
t0 = process.hrtime.bigint();
for (let i = 0; i < GETS; i++) { const r = strRows[idx[i]]; sink += level.get(r[0], r[1]).xp; }
el = ms(t0);
out.getStringKeys = { ops: GETS, ms: el, opsPerSec: (GETS / el) * 1000 };

// 6. leaderboard
const TOPS = 20_000;
t0 = process.hrtime.bigint();
for (let i = 0; i < TOPS; i++) sink += level.top(gids[i % GUILDS], 10).length;
el = ms(t0);
out.top10 = { ops: TOPS, ms: el, opsPerSec: (TOPS / el) * 1000 };

// 7. on-disk size
const st = db.stats().hot;
const pageSize = st.pageSize ?? 4096;
const c = st.collections;
const dataPages = c.level.pages, ixPages = c.level_by_xp.pages;
out.disk = {
  records: c.level.entries,
  fileBytes: st.fileBytes,
  envPages: st.pages,
  freePages: st.freePages,
  levelPages: dataPages,
  indexPages: ixPages,
  bytesPerRecordData: (dataPages * pageSize) / N,
  bytesPerRecordIndex: (ixPages * pageSize) / N,
  bytesPerRecordFile: st.fileBytes / N,
  frameBytes: level.getFrame(level.keyOf(rows[0].gid, rows[0].uid)).length,
};
out.rssMB = process.memoryUsage().rss / 2 ** 20;

await db.close();
if (!process.argv[2]) fs.rmSync(dir, { recursive: true, force: true });

console.log(`SPBT_DB quick bench - node ${process.version}, N=${fmt(N)}, gets=${fmt(GETS)}, batch=${BATCH}, dir=${dir}`);
console.log(`put   (batched, +index)  ${fmt(out.put.opsPerSec)} ops/s   ${out.put.txns} txns, ${out.put.msPerTxn.toFixed(2)} ms/txn avg, worst ${out.put.worstTxnMs.toFixed(1)} ms`);
console.log(`incr  (batched, index moves) ${fmt(out.incr.opsPerSec)} ops/s`);
console.log(`get   (bigint keys)      ${fmt(out.get.opsPerSec)} ops/s`);
console.log(`get   (string keys)      ${fmt(out.getStringKeys.opsPerSec)} ops/s`);
console.log(`get latency              p50 ${out.getLatencyNs.p50} ns, p99 ${out.getLatencyNs.p99} ns, p99.9 ${out.getLatencyNs.p999} ns (incl. ~${out.getLatencyNs.timerOverheadP50} ns timer)`);
console.log(`top(gid, 10)             ${fmt(out.top10.opsPerSec)} ops/s`);
console.log(`disk                     frame ${out.disk.frameBytes} B; tree pages: data ${out.disk.bytesPerRecordData.toFixed(1)} B/rec + index ${out.disk.bytesPerRecordIndex.toFixed(1)} B/rec; file ${fmt(out.disk.fileBytes)} B = ${out.disk.bytesPerRecordFile.toFixed(1)} B/rec (${out.disk.freePages} free pages)`);
console.log(`rss                      ${out.rssMB.toFixed(1)} MB`);
if (process.env.SPBTDB_BENCH_JSON) console.log(JSON.stringify(out));
if (sink === -1) console.log(sink);

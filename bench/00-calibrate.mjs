// bench/00 - calibration (design §13 row 00). Informational: no thresholds, always exits 0.
//
//   node bench/00-calibrate.mjs [--dir D] [--seq-mb 64] [--fsyncs 300] [--rand 500]
//   node bench/00-calibrate.mjs --save-target      ON THE TARGET BOX: writes bench/target-host.json
//
// Measures on this host: a single-core CPU score (a fixed mix of the work SPBT_DB does - key
// encode, Buffer compare, msgpackr pack/unpack, JSON, sort), memcpy bandwidth, sequential write
// MB/s (1 MiB writes + one fsync), random 4 KiB sync writes (pwrite + fdatasync each, QD1),
// fdatasync latency of a 4 KiB append, and the end-to-end latency of a 1-row SPBT_DB commit.
//
// It then prints `factors`: "the target is f x slower than this host" per resource. Other
// benches multiply local latencies by them (run.mjs passes them via SPBTDB_BENCH_CAL).
// When bench/target-host.json exists (00 run with --save-target on the target), factors are
// measured ratios. Otherwise they come from the ASSUMPTIONS below - stated, not measured.

import fs from 'node:fs';
import { randomFillSync } from 'node:crypto';
import { join } from 'node:path';
import { Packr } from 'msgpackr';
import { tuple } from '../src/keys.js';
import { openDB } from '../src/index.js';
import { parseArgs, freshDir, fsInfo, report, rng, summary, BENCH_DIR, eventRow, featureConfig, log, MB } from './lib.mjs';

const args = parseArgs();
const SEQ_MB = args['seq-mb'] ?? 64;
const FSYNCS = args.fsyncs ?? 300;
const RAND = args.rand ?? 500;
const dir = freshDir(args, '00-calibrate');
const rep = report('00-calibrate', { seqMB: SEQ_MB, fsyncs: FSYNCS, rand: RAND, dir });

// ---------------------------------------------------------------- assumptions
// Target: Oracle VM.Standard.E2.1.Micro (doc "Цільове залізо"). Sources: AMD/Oracle spec sheets;
// none of this was measured on the box - run `--save-target` there to replace it.
const ASSUMED_TARGET = {
  // EPYC 7551 Zen 1: 2.0 GHz base / 2.55 all-core / 3.0 max boost. This host: Ryzen 5 7535HS,
  // Zen 3+, ~4.4 GHz single-core under load. Zen1 -> Zen3 IPC ~ +37 % (Zen2 +15 %, Zen3 +19 %).
  // (4.4 / 2.55) x 1.37 ~ 2.4x. The doc (§7.2) says "~2x". We take 2.4 WHILE BURSTING.
  // E2.1.Micro is burstable with a 1/8-OCPU baseline: once burst credit is gone, sustained
  // throughput can drop up to ~8x further. Latency of a single op does not change, queueing does.
  cpuSlowdown: 2.4,
  cpuSlowdownThrottled: 2.4 * 8,
  // Balanced block volume: 60 IOPS/GB and 480 KB/s per GB. A ~47 GB boot volume -> ~2 800 IOPS,
  // ~22.5 MB/s. NOTE the doc (§4.6) assumes ~60 MB/s for copy-compaction; the per-GB rule says ~22.
  seqWriteMBps: 22.5,
  randWriteIops: 2800,        // async, at queue depth; QD1 sync IOPS is bound by fsync latency below
  // iSCSI/paravirtualised network block device + ext4 journal: assume ~2 ms per fdatasync (QD1).
  fsyncMs: 2.0,
  memcpyGBps: 6,              // single Zen 1 core, DDR4-2666, virtualised
};

// ----------------------------------------------------------------- CPU score
function cpuSuite() {
  const R = rng(42);
  const out = {};
  const time = (name, n, fn) => {
    fn(Math.min(n, 2000)); // warm up the JIT
    const t = process.hrtime.bigint();
    fn(n);
    out[name] = Number(process.hrtime.bigint() - t) / n; // ns/op
  };
  const pk = tuple('gid:u64 uid:u64');
  const kb = Buffer.allocUnsafe(16);
  const ids = Array.from({ length: 4096 }, () => [R.snow(), R.snow()]);
  time('keyEncode', 2_000_000, (n) => { for (let i = 0; i < n; i++) pk.encodeInto(ids[i & 4095], kb); });
  const keys = ids.map((v) => pk.encode(v));
  let sink = 0;
  time('bufCompare', 5_000_000, (n) => { for (let i = 0; i < n; i++) sink += Buffer.compare(keys[i & 4095], keys[(i * 7) & 4095]); });
  const pr = new Packr({ useRecords: false });
  const rows = Array.from({ length: 256 }, (_, i) => eventRow(R, 1n, 2n, 1_700_000_000_000 + i, i));
  const packed = rows.map((r) => pr.pack(r));
  time('msgpackPack', 300_000, (n) => { for (let i = 0; i < n; i++) sink += pr.pack(rows[i & 255]).length; });
  time('msgpackUnpack', 300_000, (n) => { for (let i = 0; i < n; i++) sink += pr.unpack(packed[i & 255]).k; });
  const cfg = JSON.stringify(featureConfig(R), (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  time('jsonParse', 200_000, (n) => { for (let i = 0; i < n; i++) sink += JSON.parse(cfg).limits.perUser; });
  time('sort1k', 2_000, (n) => { for (let i = 0; i < n; i++) { const a = new Float64Array(1000); for (let j = 0; j < 1000; j++) a[j] = (j * 2654435761) % 1000; a.sort(); sink += a[0]; } });
  const geo = Math.exp(Object.values(out).reduce((s, x) => s + Math.log(x), 0) / Object.keys(out).length);
  if (sink === Math.PI) log(sink);
  return { nsPerOp: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, +v.toFixed(2)])), geoMeanNs: +geo.toFixed(3), score: Math.round(1e5 / geo) };
}

function memcpy() {
  const a = Buffer.alloc(64 * 2 ** 20, 1), b = Buffer.allocUnsafe(a.length);
  a.copy(b);
  const t = process.hrtime.bigint();
  const n = 20;
  for (let i = 0; i < n; i++) a.copy(b);
  const s = Number(process.hrtime.bigint() - t) / 1e9;
  return +((a.length * n) / s / 1e9).toFixed(2);
}

// --------------------------------------------------------------------- disk
function seqWrite() {
  const f = join(dir, 'seq.bin');
  const fd = fs.openSync(f, 'w');
  const chunk = randomFillSync(Buffer.alloc(2 ** 20)); // incompressible: btrfs/zfs compress constant data
  const t = process.hrtime.bigint();
  for (let i = 0; i < SEQ_MB; i++) fs.writeSync(fd, chunk);
  fs.fsyncSync(fd);
  const s = Number(process.hrtime.bigint() - t) / 1e9;
  fs.closeSync(fd);
  fs.rmSync(f);
  return +(SEQ_MB / s).toFixed(1);
}

function randWrite() {
  const f = join(dir, 'rand.bin');
  const size = 64 * 2 ** 20;
  const fd = fs.openSync(f, 'w+');
  const z = randomFillSync(Buffer.alloc(2 ** 20));
  for (let i = 0; i < size / z.length; i++) fs.writeSync(fd, z);
  fs.fsyncSync(fd);
  const R = rng(7);
  const page = randomFillSync(Buffer.alloc(4096));
  const lat = [];
  for (let i = 0; i < RAND; i++) {
    const t = process.hrtime.bigint();
    fs.writeSync(fd, page, 0, 4096, R.int(size / 4096) * 4096);
    fs.fdatasyncSync(fd);
    lat.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  // un-synced random writes, one fsync at the end (what an lmdb commit of many pages looks like)
  const t = process.hrtime.bigint();
  for (let i = 0; i < 4096; i++) fs.writeSync(fd, page, 0, 4096, R.int(size / 4096) * 4096);
  fs.fdatasyncSync(fd);
  const batchS = Number(process.hrtime.bigint() - t) / 1e9;
  fs.closeSync(fd);
  fs.rmSync(f);
  const s = summary(lat);
  return { syncQD1: { iops: Math.round(1000 / s.mean), latencyMs: s }, batched4096: { iops: Math.round(4096 / batchS), seconds: +batchS.toFixed(3) } };
}

function fsyncLatency() {
  const f = join(dir, 'fsync.bin');
  const fd = fs.openSync(f, 'w');
  const page = randomFillSync(Buffer.alloc(4096));
  const lat = [];
  for (let i = 0; i < FSYNCS; i++) {
    fs.writeSync(fd, page);
    const t = process.hrtime.bigint();
    fs.fdatasyncSync(fd);
    lat.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  fs.closeSync(fd);
  fs.rmSync(f);
  return summary(lat);
}

async function commitLatency() {
  const d = join(dir, 'db');
  const db = openDB({ dir: d });
  const lat = [];
  for (let i = 0; i < Math.min(FSYNCS, 300); i++) {
    const t = process.hrtime.bigint();
    db.level.put({ gid: 1n, uid: BigInt(i), xp: i }); // outside db.txn = its own durable commit
    lat.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  await db.close();
  return summary(lat);
}

// ---------------------------------------------------------------------- run
const fsi = fsInfo(dir);
log(`00-calibrate: dir ${dir} (${fsi.type}${fsi.compress ? ', compress=' + fsi.compress : ''})`);
const cpu = cpuSuite();
const mem = memcpy();
const seq = seqWrite();
const rand = randWrite();
const fsy = fsyncLatency();
const commit = await commitLatency();
fs.rmSync(dir, { recursive: true, force: true });

const local = { cpuGeoMeanNs: cpu.geoMeanNs, memcpyGBps: mem, seqWriteMBps: seq, randWriteSyncIops: rand.syncQD1.iops, fsyncMsP50: fsy.p50, commit1RowMsP50: commit.p50 };

const targetFile = join(BENCH_DIR, 'target-host.json');
if (args['save-target']) {
  fs.writeFileSync(targetFile, JSON.stringify({ savedAt: new Date().toISOString(), fs: fsi, local }, null, 2) + '\n');
  rep.note(`saved this host as the target reference: ${targetFile}`);
}

let target, source;
if (!args['save-target'] && fs.existsSync(targetFile)) {
  const t = JSON.parse(fs.readFileSync(targetFile, 'utf8')).local;
  target = { cpuGeoMeanNs: t.cpuGeoMeanNs, memcpyGBps: t.memcpyGBps, seqWriteMBps: t.seqWriteMBps, randWriteSyncIops: t.randWriteSyncIops, fsyncMsP50: t.fsyncMsP50 };
  source = 'measured (bench/target-host.json)';
} else {
  target = { cpuGeoMeanNs: cpu.geoMeanNs * ASSUMED_TARGET.cpuSlowdown, memcpyGBps: ASSUMED_TARGET.memcpyGBps, seqWriteMBps: ASSUMED_TARGET.seqWriteMBps, randWriteSyncIops: Math.round(1000 / ASSUMED_TARGET.fsyncMs), fsyncMsP50: ASSUMED_TARGET.fsyncMs };
  source = 'ASSUMED (no bench/target-host.json; see ASSUMED_TARGET in 00-calibrate.mjs)';
}

// f = "target is f x slower". Disk factors are meaningless when this host's dir is tmpfs.
const disk = fsi.realDisk;
const factors = {
  cpu: +(target.cpuGeoMeanNs / cpu.geoMeanNs).toFixed(3),
  memcpy: +(mem / target.memcpyGBps).toFixed(3),
  seqWrite: disk ? +(seq / target.seqWriteMBps).toFixed(3) : null,
  randWrite: disk ? +(rand.syncQD1.iops / target.randWriteSyncIops).toFixed(3) : null,
  fsync: disk ? +(target.fsyncMsP50 / fsy.p50).toFixed(3) : null,
  // absolute target figures (not factors) for benches that project from bytes, e.g. 08
  targetSeqWriteMBps: target.seqWriteMBps,
  targetFsyncMs: target.fsyncMsP50,
};
if (!disk) rep.note('dataset dir is tmpfs: fsync is a no-op, so disk factors are null and disk-bound checks in other benches are gated on raw (meaningless) local values');
rep.note(`factors source: ${source}`);
rep.note(`CPU factor is for a BURSTING E2.1.Micro. Throttled to its 1/8-OCPU baseline, sustained throughput can be ~${ASSUMED_TARGET.cpuSlowdownThrottled}x slower than this host.`);
if (factors.fsync != null && factors.fsync < 1) rep.note(`local fsync (${fsy.p50} ms on ${fsi.type}) is SLOWER than the assumed target fsync (${ASSUMED_TARGET.fsyncMs} ms): btrfs COW fsync is expensive. Projected commit-bound numbers therefore get FASTER on the target - treat with suspicion until measured there.`);

rep.finish({
  fs: fsi,
  cpu,
  memcpyGBps: mem,
  seqWriteMBps: seq,
  randWrite: rand,
  fsyncMs: fsy,
  spbtdbCommit1RowMs: commit,
  local,
  target: { ...target, source },
  assumptions: ASSUMED_TARGET,
  factors,
});

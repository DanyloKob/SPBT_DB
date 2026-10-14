// Shared helpers for the SPBT_DB benchmark suite (design §13). No tests here.
//
// Every bench prints ONE JSON document on stdout (progress goes to stderr) and exits 1 when a
// threshold fails. Thresholds are for the TARGET host (Oracle VM.Standard.E2.1.Micro, EPYC 7551
// Zen 1, 952 MB). When a calibration is supplied (SPBTDB_BENCH_CAL, set by run.mjs from
// 00-calibrate), each check is gated on the value PROJECTED to the target; otherwise on the raw
// local value, and the report says so.

import fs from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { eventLogSchema } from '../src/schema.js';

export const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
export const DB_DIR = join(BENCH_DIR, '..');

/* ------------------------------------------------------------------ args */

/** `--k=v`, `--k v`, `--flag`, positionals in `_`. Numbers are converted. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (v === undefined) v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[k] = v === 'true' ? true : v === 'false' ? false : v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
  }
  return out;
}

/* ------------------------------------------------------------- data dirs */

/** Base directory for datasets: --dir, $SPBTDB_BENCH_DIR, else $TMPDIR/spbt-db-bench. Never the repo. */
export function baseDir(args) {
  const d = args?.dir ?? process.env.SPBTDB_BENCH_DIR ?? join(os.tmpdir(), 'spbt-db-bench');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Fresh (emptied) sub-directory for one bench. */
export function freshDir(args, name) {
  const d = join(baseDir(args), name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const FS_MAGIC = { 0x01021994: 'tmpfs', 0x9123683e: 'btrfs', 0xef53: 'ext4', 0x58465342: 'xfs', 0x2fc12fc1: 'zfs', 0x794c7630: 'overlayfs' };

/** Filesystem facts that change what the numbers mean (tmpfs: fsync is free, mmap = shmem). */
export function fsInfo(dir) {
  let type = 'unknown', options = '', source = '';
  try { type = FS_MAGIC[fs.statfsSync(dir).type] ?? `0x${fs.statfsSync(dir).type.toString(16)}`; } catch {}
  try {
    const l = execFileSync('findmnt', ['-no', 'FSTYPE,SOURCE,OPTIONS', '-T', dir], { encoding: 'utf8' }).trim().split(/\s+/);
    [type, source, options] = [l[0] || type, l[1] || '', l[2] || ''];
  } catch {}
  const realDisk = type !== 'tmpfs' && type !== 'ramfs';
  return { dir, type, source, compress: (options.match(/compress=([^,]+)/) || [])[1] ?? null, realDisk };
}

/* -------------------------------------------------------------- host info */

export function hostInfo() {
  const cpu = os.cpus()[0]?.model?.trim();
  let lmdbVersion;
  try { lmdbVersion = JSON.parse(fs.readFileSync(join(DB_DIR, 'node_modules/lmdb/package.json'), 'utf8')).version; } catch {}
  let swap = null;
  try {
    const sw = fs.readFileSync('/proc/swaps', 'utf8').trim().split('\n').slice(1).map((l) => l.split(/\s+/)[0]);
    swap = sw.join(',') || 'none';
  } catch {}
  return { cpu, cores: os.cpus().length, memMB: Math.round(os.totalmem() / 2 ** 20), node: process.version, lmdb: lmdbVersion, kernel: os.release(), swap, loadavg: os.loadavg().map((x) => +x.toFixed(2)) };
}

/* ------------------------------------------------------------------- rng */

/** Deterministic PRNG (mulberry32) - same algorithm as test/util.js. */
export function rng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    float: next,
    int: (n) => Math.floor(next() * n),
    /** discord-like snowflake: ~2^60, bigint */
    snow: () => (BigInt(Math.floor(next() * 2 ** 27) + 2 ** 27) << 32n) | BigInt(Math.floor(next() * 2 ** 32)),
    pick: (a) => a[Math.floor(next() * a.length)],
  };
}

/* ----------------------------------------------------------------- stats */

export const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];

export function summary(arr, digits = 3) {
  const a = Float64Array.from(arr).sort();
  if (!a.length) return { n: 0 };
  let sum = 0;
  for (const x of a) sum += x;
  const r = (x) => +x.toFixed(digits);
  return { n: a.length, mean: r(sum / a.length), p50: r(pct(a, 0.5)), p90: r(pct(a, 0.9)), p99: r(pct(a, 0.99)), p999: r(pct(a, 0.999)), max: r(a[a.length - 1]) };
}

/** Per-call latency in ns of fn(i), n calls; returns summary + the hrtime overhead p50. */
export function latencyNs(fn, n) {
  const lat = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    fn(i);
    lat[i] = Number(process.hrtime.bigint() - t);
  }
  const ov = new Float64Array(20000);
  for (let i = 0; i < ov.length; i++) { const t = process.hrtime.bigint(); ov[i] = Number(process.hrtime.bigint() - t); }
  ov.sort();
  return { ...summary(lat, 0), timerOverheadP50: pct(ov, 0.5) };
}

export const nowMs = () => performance.now();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const MB = (b) => +(b / 2 ** 20).toFixed(2);

/* ------------------------------------------------------- /proc readers */

/** /proc/self/io: wchar = bytes handed to write(2)/pwrite(2) - lmdb (no writemap) pwrites every dirty page. */
export function procIo(pid = 'self') {
  const o = {};
  for (const l of fs.readFileSync(`/proc/${pid}/io`, 'utf8').trim().split('\n')) { const [k, v] = l.split(': '); o[k] = Number(v); }
  return o;
}

/** kB fields of /proc/<pid>/status (VmRSS, VmHWM, VmSwap, RssAnon, RssFile, RssShmem) in MB. */
export function procStatus(pid = 'self') {
  const o = {};
  for (const l of fs.readFileSync(`/proc/${pid}/status`, 'utf8').split('\n')) {
    const m = l.match(/^(Vm\w+|Rss\w+):\s+(\d+) kB/);
    if (m) o[m[1]] = +(Number(m[2]) / 1024).toFixed(2);
  }
  return o;
}

/** /proc/<pid>/smaps_rollup in MB (Rss, Pss_Anon, Pss_File, Pss_Shmem, Anonymous, Swap, ...). */
export function smapsRollup(pid = 'self') {
  const o = {};
  for (const l of fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').split('\n')) {
    const m = l.match(/^(\w+):\s+(\d+) kB/);
    if (m) o[m[1]] = +(Number(m[2]) / 1024).toFixed(2);
  }
  return o;
}

/** Rss/Pss/Anonymous (MB) of every mapping whose path contains `needle` (e.g. 'hot.mdb'). */
export function mappingRss(needle, pid = 'self') {
  const txt = fs.readFileSync(`/proc/${pid}/smaps`, 'utf8');
  const out = { mappings: 0, sizeMB: 0, rssMB: 0, anonMB: 0 };
  let inside = false;
  for (const l of txt.split('\n')) {
    if (/^[0-9a-f]+-[0-9a-f]+ /.test(l)) { inside = l.trimEnd().endsWith(needle) || l.includes(needle + ' '); if (inside) out.mappings++; continue; }
    if (!inside) continue;
    const m = l.match(/^(Size|Rss|Anonymous):\s+(\d+) kB/);
    if (m) out[{ Size: 'sizeMB', Rss: 'rssMB', Anonymous: 'anonMB' }[m[1]]] += Number(m[2]) / 1024;
  }
  for (const k of ['sizeMB', 'rssMB', 'anonMB']) out[k] = +out[k].toFixed(2);
  return out;
}

/** Reset VmHWM (peak RSS) of this process - allowed for one's own process. */
export function resetPeakRss() {
  try { fs.writeFileSync('/proc/self/clear_refs', '5'); return true; } catch { return false; }
}

/* --------------------------------------------------------- page cache */

/** Bytes of `file` resident in the page cache (util-linux fincore), or null. */
export function fincore(file) {
  try {
    const out = execFileSync('fincore', ['-bno', 'RES', file], { encoding: 'utf8' }).trim();
    return Number(out);
  } catch { return null; }
}

/**
 * Drop `file` from the page cache without root: GNU dd iflag=nocache -> posix_fadvise(DONTNEED).
 * Only clean, unmapped pages are dropped, so close the env first. Does nothing on tmpfs.
 * @returns {{ before: number|null, after: number|null }}
 */
export function evictFile(file) {
  const before = fincore(file);
  try { execFileSync('sync', [file]); } catch {}
  try { execFileSync('dd', [`if=${file}`, 'iflag=nocache', 'count=0'], { stdio: 'ignore' }); } catch {}
  return { before, after: fincore(file) };
}

export function fileSize(p) { try { return fs.statSync(p).size; } catch { return 0; } }

/* ---------------------------------------------------------- calibration */

/** Calibration produced by 00-calibrate (via run.mjs: SPBTDB_BENCH_CAL = JSON or a path). */
export function loadCalibration() {
  const v = process.env.SPBTDB_BENCH_CAL;
  if (!v) return null;
  try {
    const j = JSON.parse(v.trim().startsWith('{') ? v : fs.readFileSync(v, 'utf8'));
    return j.factors ?? j.results?.factors ?? null;
  } catch { return null; }
}

/* --------------------------------------------------------------- report */

/**
 * Report builder. check(name, value, op, limit, { unit, scale }):
 *   scale 'cpu' | 'fsync' | 'seqWrite' | 'randWrite' | null - which calibration factor projects
 *   the local value to the target. Factors are "target is f x slower": latencies x f,
 *   throughputs / f. With no calibration the gate is the raw local value. `o.projected` overrides
 *   the projection (e.g. CPU part x cpu factor + commit part x fsync factor).
 */
export function report(bench, args = {}) {
  const cal = loadCalibration();
  const r = { bench, startedAt: new Date().toISOString(), host: hostInfo(), args, calibration: cal ? { applied: true, factors: cal } : { applied: false }, results: {}, checks: [], notes: [], pass: true };
  return {
    r,
    note(s) { r.notes.push(s); },
    /** @param {'<='|'>='|'=='} op */
    check(name, value, op, limit, o = {}) {
      const f = o.scale && cal ? cal[o.scale] : null;
      const projected = o.projected != null ? o.projected : value == null || !f ? null : op === '>=' ? value / f : value * f;
      const gate = projected ?? value;
      const ok = (v) => (v == null || Number.isNaN(v) ? false : op === '<=' ? v <= limit : op === '>=' ? v >= limit : v === limit);
      const c = { name, value: value == null ? null : +(+value).toPrecision(6), unit: o.unit ?? '', op, limit, scale: o.scale ?? null, projected: projected == null ? null : +projected.toPrecision(6), localPass: ok(value), pass: o.informational ? null : ok(gate) };
      if (o.informational) c.informational = true;
      if (o.note) c.note = o.note;
      r.checks.push(c);
      if (c.pass === false) r.pass = false;
      return c.pass;
    },
    finish(results) {
      Object.assign(r.results, results);
      r.finishedAt = new Date().toISOString();
      process.stdout.write(JSON.stringify(r, jsonReplacer, 2) + '\n');
      process.exitCode = r.pass ? 0 : 1;
    },
  };
}

export const jsonReplacer = (_, v) => (typeof v === 'bigint' ? v.toString() : v);

export const log = (...a) => process.stderr.write(a.join(' ') + '\n');

/* ------------------------------------------------- dataset shapes (§5) */

const WORDS = ('the a to and of in is it you that he was for on are with as I his they be at one have this from or had by hot word but what some we can out other were all there when up use your how said an each she which do their time if will way about many then them write would like so these her long make thing see him two has look more day could go come did number sound no most people my over know water than call first who may down side been now find any new work part take get place made live where after back little only round man year came show every good me give our under name very through just form sentence great think say help low line differ turn cause much mean before move right boy old too same tell does set three want air well also play small end put home read hand port large spell add even land here must big high such follow act why ask men change went light kind off need house picture try us again animal point mother world near build self earth father head stand own page should country found answer school grow study still learn plant cover food sun four between state keep eye never last let thought city tree cross farm hard start might story saw far sea draw left late run don\'t while press close night real life few north привіт дякую добре сервер гра музика').split(' ');

/** ~`len` chars of words */
export function text(R, len) {
  let s = '';
  while (s.length < len) s += (s ? ' ' : '') + R.pick(WORDS);
  return s;
}

/* event_log row: k, msgId, authorId, content, attachments, embeds, stickers. ~200 B framed. */
let snowSeq = 0;
/** event_log row (§5.7). msgId is a real-shaped snowflake: the message's own time for k=0 (msg), a
 * message up to 10 min older for k=1/2 (edit/delete) - Discord ids are time-ordered, random ids
 * would make every msgId-keyed structure look scattered. */
export function eventRow(R, gid, chan, ts, seq) {
  const k = R.float() < 0.85 ? 0 : R.float() < 0.6 ? 1 : 2;
  const msgId = (BigInt(Math.max(0, ts - (k ? R.int(600_000) : 0) - 1420070400000)) << 22n) | BigInt((snowSeq = (snowSeq + 1) & 0x3fffff));
  const row = { gid, chan, ts, seq, k, msgId, authorId: R.snow(), content: text(R, 20 + R.int(220)) };
  if (R.float() < 0.08) row.attachments = [{ id: R.snow(), name: `IMG_${R.int(9999)}.png`, size: R.int(4e6), w: 1280, h: 720, blobHash: Buffer.from(Array.from({ length: 16 }, () => R.int(256))) }];
  if (R.float() < 0.03) row.embeds = [{ title: text(R, 30), description: text(R, 120) }];
  return row;
}

/** feature_config value (§5.1): JSON-ish config, ~700 B msgpack, compressible. */
export function featureConfig(R) {
  return {
    enabled: true,
    channelId: R.snow(),
    roleIds: Array.from({ length: R.int(6) }, () => R.snow()),
    messages: { welcome: text(R, 80 + R.int(200)), leave: text(R, 40 + R.int(80)), dm: R.float() < 0.5 ? text(R, 60) : '' },
    embed: { color: R.int(0xffffff), title: text(R, 30), description: text(R, 100 + R.int(150)), imageUrl: `https://cdn.example.com/${R.int(1e9)}.png`, footer: text(R, 20) },
    limits: { perUser: R.int(10), cooldownSec: R.int(3600), maxMentions: R.int(20) },
    flags: Array.from({ length: 8 }, () => R.float() < 0.5),
  };
}

/** builder_scheme value (§5.6): nodes/edges graph, ~1.5 KB after deflate. */
export function builderScheme(R, nNodes = 20 + R.int(60)) {
  const nodes = Array.from({ length: nNodes }, (_, i) => ({ id: i, type: R.pick(['trigger', 'condition', 'action', 'delay', 'set', 'send']), x: R.int(2000), y: R.int(2000), data: { text: R.float() < 0.5 ? text(R, 20 + R.int(60)) : '', ref: R.int(1000) } }));
  const edges = Array.from({ length: Math.floor(nNodes * 1.3) }, () => ({ a: R.int(nNodes), b: R.int(nNodes), port: R.int(3) }));
  return { version: 3, name: text(R, 16), description: text(R, 80), tags: [R.pick(WORDS), R.pick(WORDS)], nodes, edges, createdAt: Date.now() - R.int(1e10), updatedAt: Date.now() - R.int(1e9), public: R.float() < 0.2 };
}

/**
 * event_log as shipped (src/schema.js eventLogSchema: time-ordered pk `ts seq`, lagged
 * elog_by_chan, elog_by_msg) for ONE month: index DBI names are global per env, so they get the
 * month suffix exactly as db.bucketed() gives them. Query with index `elog_by_chan_${ym}`.
 */
export function elogSchema(ym) {
  return { ...eventLogSchema, indexes: Object.fromEntries(Object.entries(eventLogSchema.indexes).map(([n, spec]) => [`${n}_${ym}`, spec])) };
}

/** Bench schemas for collections the core does not ship yet (shapes from §5.2, §5.6, §5.7). */
export const benchSchemas = {
  // §5.7 event_log with the doc's key (gid chan ts seq), as shipped before r2: kept for comparison
  event_log_r1: { key: 'gid:u64 chan:u64 ts:u48 seq:u16', env: 'cold' },
  // §5.7 audit, cold
  audit: { key: 'gid:u64 ts:u48 seq:u16', env: 'cold' },
  // §5.2 mod_case with its three indexes
  mod_case: {
    key: 'gid:u64 caseNo:u32',
    indexes: {
      case_by_target: { key: 'gid:u64 targetId:u64 caseNo:u32' },
      case_by_mod: { key: 'gid:u64 modId:u64 caseNo:u32' },
      case_active: { key: 'gid:u64 type:u8 targetId:u64', filter: (r) => !!r.active },
    },
  },
  // §5.6 builder_scheme, deflated msgpack, index by owner + updatedAt desc
  builder_scheme: {
    key: 'ownerId:u64 schemeId:b6',
    compress: { threshold: 512 },
    indexes: { scheme_by_updated: { key: 'ownerId:u64 updatedAt:inv48' } },
  },
};

// bench/04 - crash safety under kill -9 (design §13 row 04, §4.5).
//
//   node bench/04-crash-safety.mjs [--iterations 200] [--max-delay 400] [--drop-kills 60] [--dir D] [--seed 1]
//
// Each iteration: a CHILD process opens the db, reads where the sequence stopped (kv 'last'),
// and keeps committing the deterministic transaction sequence t = last+1, last+2, ... forever
// (70 % db.txn, 30 % db.txnAsync; 1-40 ops per txn, sometimes 300; ~2 % of puts carry a
// 5-12 KB value -> overflow pages). After every commit it prints `t` on stdout (a pipe: a
// synchronous write on Linux). The PARENT kill -9s it at a random moment (5 % of the time
// before the child even finished opening), then reopens and verifies:
//   (a) the db opens;
//   (b) the last visible txn L is >= every txn the child reported committed (nothing durable
//       lost; a kill -9 does not drop the page cache) and the FULL contents equal the model
//       state after exactly txns 1..L (consistent prefix, nothing half-applied);
//   (c) every index entry matches the data and vice versa, for all 5 indexes (dup, suffix,
//       unique, sparse+filter, dup with shared prefix) - checked from the data actually read
//       back, not from the model;
//   (d) open time (openDB + first read) <= 50 ms. Since r2 the __boot record is committed
//       without an fsync, so the first DURABLE commit after the crash is timed on its own
//       (firstDurableCommitMs): it flushes whatever the killed writer left dirty.
// The same directory is reused across iterations, so the file ages (freelist reuse, splits).
// Phase 2 (--drop-kills): kill -9 during db.dropCollection() of an indexed collection, then check
// that no bucket is left with data but no index (or the reverse).
//
// Not covered here: power loss / torn writes below the page cache (the doc's dm-flakey run
// needs root and a device-mapper target). kill -9 only proves process-crash safety.

import fs from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { openDB, coreSchemas } from '../src/index.js';
import { parseArgs, freshDir, fsInfo, report, rng, summary, log, sleep, BENCH_DIR, fileSize } from './lib.mjs';

const args = parseArgs();
const SEED = args.seed ?? 1;
const KEYS = 3000;

const schemas = {
  kv: coreSchemas.kv,
  rec: {
    key: 'i:u32',
    indexes: {
      rec_by_v: { key: 'v:u32' },                                     // dup: value = pk
      rec_by_t: { key: 't:u32 i:u32' },                               // suffix (ends with pk), sparse when t missing
      rec_by_tag: { key: 'tag:str', unique: true },                   // unique, variable-size key
      rec_live: { key: 'v:u32 i:u32', filter: (r) => !!r.live },      // suffix + filter
    },
  },
  ctr: {
    key: 'g:u8 u:u32',
    codec: 'varint',
    fields: ['n'],
    indexes: { ctr_by_n: { key: 'g:u8 n:inv32' } },                  // dup, shares 1 leading byte with pk
  },
};

/** Deterministic op list for txn t (independent of state). */
function opsFor(t) {
  const R = rng((SEED * 1_000_003 + t * 7919) >>> 0);
  const n = R.float() < 0.03 ? 300 : 1 + R.int(40);
  const ops = [];
  for (let k = 0; k < n; k++) {
    const x = R.float();
    const i = R.int(KEYS);
    if (x < 0.55) {
      const big = R.float() < 0.02;
      const padLen = big ? 5000 + R.int(7000) : R.int(100);
      ops.push({ op: 'put', rec: { i, v: R.int(1000), t, tag: 'k' + i.toString(36), live: R.float() < 0.5, ...(padLen ? { pad: String.fromCharCode(97 + R.int(26)).repeat(padLen) + t } : {}) } });
    } else if (x < 0.7) ops.push({ op: 'patch', i, partial: { v: R.int(1000), live: R.float() < 0.5 } });
    else if (x < 0.8) ops.push({ op: 'del', i });
    else ops.push({ op: 'incr', g: R.int(4), u: R.int(200), d: 1 + R.int(5) });
  }
  return { ops, async: R.float() < 0.3 };
}

function applyDb(db, t, { ops }) {
  for (const o of ops) {
    if (o.op === 'put') db.rec.put(o.rec);
    else if (o.op === 'patch') db.rec.patch(o.i, o.partial);
    else if (o.op === 'del') db.rec.del(o.i);
    else db.ctr.incr(o.g, o.u, 'n', o.d);
  }
  db.kv.put({ k: 'last', t });
}

function applyModel(m, { ops }) {
  for (const o of ops) {
    if (o.op === 'put') m.rec.set(o.rec.i, { ...o.rec });
    else if (o.op === 'patch') m.rec.set(o.i, { ...(m.rec.get(o.i) ?? {}), ...o.partial, i: o.i });
    else if (o.op === 'del') m.rec.delete(o.i);
    else { const k = `${o.g}:${o.u}`; m.ctr.set(k, (m.ctr.get(k) ?? 0) + o.d); }
  }
}

/* ========================================== child: drop under kill -9 */
const dropSchema = (n) => ({ key: 'i:u32', indexes: { [`dix_${n}`]: { key: 'v:u32 i:u32' } } });
if (args.child === 'drop') {
  // loop: create bucket b<n> with one index, fill 20k rows in one txn, dropCollection it
  const db = openDB({ dir: args.cdir, schemas: {} });
  for (let n = 0; ; n++) {
    const c = db.collection(`b${n}`, dropSchema(n));
    db.txn(() => { for (let i = 0; i < 20000; i++) c.put({ i, v: i % 97, pad: 'x'.repeat(40) }); });
    process.stdout.write(`B ${n}\n`);
    db.dropCollection(`b${n}`);
  }
}

/* ================================================================ child */
if (args.child === 1 || args.child === 'seq') {
  const db = openDB({ dir: args.cdir, schemas });
  let t = (db.kv.get('last')?.t ?? 0) + 1;
  process.stdout.write(`READY ${t}\n`);
  for (;;) {
    const plan = opsFor(t);
    const tt = t;
    if (plan.async) await db.txnAsync(() => applyDb(db, tt, plan));
    else db.txn(() => applyDb(db, tt, plan));
    process.stdout.write(`${t}\n`);
    t++;
  }
}

/* =============================================================== parent */
const ITER = args.iterations ?? 200;
const MAX_DELAY = args['max-delay'] ?? 400;
const dir = freshDir(args, '04-crash');
const fsi = fsInfo(dir);
const rep = report('04-crash-safety', { iterations: ITER, maxDelayMs: MAX_DELAY, seed: SEED, keys: KEYS, dir });
log(`04-crash-safety: ${ITER} iterations in ${dir} (${fsi.type})`);
const KR = rng(SEED + 99);

const model = { rec: new Map(), ctr: new Map() };
let modelT = 0;
const canon = (o) => JSON.stringify(Object.keys(o).sort().reduce((a, k) => ((a[k] = typeof o[k] === 'bigint' ? String(o[k]) : o[k]), a), {}));

function verify() {
  const out = { ok: true, problems: [] };
  const bad = (s) => { out.ok = false; if (out.problems.length < 8) out.problems.push(s); };
  let db;
  const t0 = performance.now();
  try {
    db = openDB({ dir, schemas });
    out.last = db.kv.get('last')?.t ?? 0;
  } catch (e) { bad(`open failed: ${e.message}`); return out; }
  out.openMs = performance.now() - t0;
  { // host fsync probe right after the open: separates a slow open from a slow disk
    const pf = join(dir, 'fsync-probe'), fd = fs.openSync(pf, 'w'), a = performance.now();
    fs.writeSync(fd, Buffer.alloc(4096, 1)); fs.fdatasyncSync(fd); fs.closeSync(fd);
    out.fsyncProbeMs = performance.now() - a;
  }
  { // the first durable (fsynced) commit after the crash
    const a = performance.now();
    try { db.txn(() => db.kv.put({ k: 'probe', at: Date.now() })); } catch {}
    out.firstDurableCommitMs = performance.now() - a;
  }
  try {
    out.staleReadersCleared = db.backend('hot').env.readerCheck();
    // (b) advance the model to L and compare everything
    if (out.last < modelT) bad(`last visible txn went BACKWARDS: ${out.last} < ${modelT}`);
    for (let t = modelT + 1; t <= out.last; t++) applyModel(model, opsFor(t));
    modelT = Math.max(modelT, out.last);
    const recs = new Map();
    for (const r of db.rec.iterate()) recs.set(r.i, r);
    if (recs.size !== model.rec.size) bad(`rec count ${recs.size} != model ${model.rec.size}`);
    let diff = 0;
    for (const [i, m] of model.rec) { const r = recs.get(i); if (!r || canon(r) !== canon(m)) { diff++; if (diff <= 2) bad(`rec ${i} differs: db=${r ? canon(r).slice(0, 120) : 'missing'} model=${canon(m).slice(0, 120)}`); } }
    for (const i of recs.keys()) if (!model.rec.has(i)) { diff++; if (diff <= 4) bad(`rec ${i} exists in db, not in model`); }
    const ctrs = new Map();
    for (const c of db.ctr.iterate()) ctrs.set(`${c.g}:${c.u}`, c.n);
    if (ctrs.size !== model.ctr.size) bad(`ctr count ${ctrs.size} != model ${model.ctr.size}`);
    for (const [k, n] of model.ctr) if (ctrs.get(k) !== n) { bad(`ctr ${k} = ${ctrs.get(k)} != model ${n}`); break; }
    out.dataDiffs = diff;
    // (c) index <-> data, from what was read back
    const sets = {
      rec_by_v: [db.rec, [...recs.values()].filter((r) => r.v != null).map((r) => `${r.v}|${r.i}`), (e) => `${e.v}|${e.i}`],
      rec_by_t: [db.rec, [...recs.values()].filter((r) => r.t != null).map((r) => `${r.t}|${r.i}`), (e) => `${e.t}|${e.i}`],
      rec_by_tag: [db.rec, [...recs.values()].filter((r) => r.tag != null).map((r) => `${r.tag}|${r.i}`), (e) => `${e.tag}|${e.i}`],
      rec_live: [db.rec, [...recs.values()].filter((r) => r.live && r.v != null).map((r) => `${r.v}|${r.i}`), (e) => `${e.v}|${e.i}`],
      ctr_by_n: [db.ctr, [...ctrs].map(([k, n]) => `${k.split(':')[0]}|${n}|${k.split(':')[1]}`), (e) => `${e.g}|${e.n}|${e.u}`],
    };
    let ixMismatch = 0;
    for (const [ix, [col, expected, fmt]] of Object.entries(sets)) {
      const got = [];
      for (const e of col.iterate({ index: ix, covered: true })) got.push(fmt(e));
      const g = new Set(got), x = new Set(expected);
      if (got.length !== g.size) { ixMismatch++; bad(`${ix}: duplicate index entries (${got.length} vs ${g.size} distinct)`); }
      let missing = 0, extra = 0;
      for (const k of x) if (!g.has(k)) missing++;
      for (const k of g) if (!x.has(k)) extra++;
      if (missing || extra) { ixMismatch += missing + extra; bad(`${ix}: ${missing} entries missing, ${extra} dangling`); }
      if (col.countIndex(ix) !== got.length) bad(`${ix}: countIndex ${col.countIndex(ix)} != scanned ${got.length}`);
    }
    out.indexMismatches = ixMismatch;
  } catch (e) {
    bad(`verify threw (corruption or decode failure): ${e.stack?.split('\n').slice(0, 3).join(' | ')}`);
  }
  out.closePromise = db.close();
  return out;
}

const results = { fs: fsi, iterations: [], summary: {} };
const slowOpens = [];
let corrupt = 0, maxLost = 0, maxInflight = 0, earlyKills = 0, childErrors = 0, totalTxns = 0;
const openMs = [], firstCommitMs = [], delays = [];
const tStart = performance.now();
for (let it = 0; it < ITER; it++) {
  const early = KR.float() < 0.05;
  const delay = early ? KR.int(80) : KR.int(MAX_DELAY + 1);
  const child = spawn(process.execPath, [join(BENCH_DIR, '04-crash-safety.mjs'), '--child', 'seq', '--cdir', dir, '--seed', String(SEED)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let reported = 0, started = null, stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((res) => {
    lines.on('line', (l) => {
      if (l.startsWith('READY')) { started = Number(l.split(' ')[1]); res(); } else reported = Math.max(reported, Number(l));
    });
  });
  const exited = new Promise((res) => child.on('exit', (code, sig) => res({ code, sig })));
  if (early) { earlyKills++; await sleep(delay); } else { await Promise.race([ready, exited]); await sleep(delay); }
  child.kill('SIGKILL');
  const ex = await exited;
  await new Promise((r) => setImmediate(r)); // drain the last stdout lines
  if (ex.sig !== 'SIGKILL') { childErrors++; rep.note(`iteration ${it}: child exited by itself (code ${ex.code}): ${stderr.slice(0, 300)}`); }
  const prevT = modelT;
  const v = verify();
  await v.closePromise;
  delete v.closePromise;
  const lost = Math.max(0, reported - (v.last ?? 0));
  const inflight = Math.max(0, (v.last ?? 0) - reported - (reported ? 0 : (started ?? prevT + 1) - 1));
  maxLost = Math.max(maxLost, lost);
  maxInflight = Math.max(maxInflight, reported ? (v.last ?? 0) - reported : 0);
  if (lost > 0) v.ok = false, v.problems.push(`lost ${lost} committed txn(s): child reported ${reported}, visible ${v.last}`);
  if (!v.ok) corrupt++;
  if (v.openMs != null) openMs.push(v.openMs);
  if (v.firstDurableCommitMs != null) firstCommitMs.push(v.firstDurableCommitMs);
  delays.push(delay);
  totalTxns += Math.max(0, (v.last ?? 0) - prevT);
  if (v.openMs > 50 || v.firstDurableCommitMs > 50) slowOpens.push({ it, openMs: +v.openMs.toFixed(1), firstDurableCommitMs: +v.firstDurableCommitMs.toFixed(1), fsyncProbeMs: +v.fsyncProbeMs.toFixed(1) });
  results.iterations.push({ it, early, delayMs: delay, startedAt: started, reported, visible: v.last, txnsThisIter: (v.last ?? 0) - prevT, openMs: v.openMs && +v.openMs.toFixed(2), ok: v.ok, ...(v.ok ? {} : { problems: v.problems }) });
  if (!v.ok) log(`  iteration ${it}: FAILED ${v.problems.join(' / ')}`);
  if ((it + 1) % 25 === 0) log(`  ${it + 1}/${ITER}: corrupt ${corrupt}, txns ${totalTxns}, open p99 ${summary(openMs).p99} ms`);
  void inflight;
}
const elapsed = (performance.now() - tStart) / 1000;

// Negative control: prove the verifier is not vacuous. Corrupt the file through the raw Backend
// (bypassing index maintenance) and require verify() to flag it; then repair with reindex().
const control = {};
if (ITER > 0) {
  const db = openDB({ dir, schemas });
  const b = db.backend('hot');
  const ix = db.rec.indexes.rec_by_v;
  const [e] = [...b.range(ix.dbi, { limit: 1 })];
  b.txn(() => b.del(ix.dbi, e.key, e.value));                  // 1) drop one index entry
  await db.close();
  const v1 = verify(); await v1.closePromise;
  control.droppedIndexEntryDetected = !v1.ok;
  const db2 = openDB({ dir, schemas });
  db2.rec.reindex('rec_by_v');
  await db2.close();
  const v2 = verify(); await v2.closePromise;
  control.reindexRepaired = v2.ok;
  const db3 = openDB({ dir, schemas });
  const b3 = db3.backend('hot');
  const dataDbi = b3.openCollection('rec');
  const ids = [...model.rec.keys()].slice(0, 2);
  const f = db3.rec.getFrame(db3.rec.keyOf(ids[1]));               // volatile: copy exactly .length bytes
  const other = Buffer.from(f.subarray(0, f.length));
  b3.txn(() => b3.put(dataDbi, db3.rec.keyOf(ids[0]), other));  // 2) data changed behind the indexes' back
  await db3.close();
  const v3 = verify(); await v3.closePromise;
  control.staleIndexAfterRawDataWriteDetected = !v3.ok;
  control.problemsSeen = [...(v1.problems ?? []).slice(0, 2), ...(v3.problems ?? []).slice(0, 2)];
}
results.negativeControl = control;

// Phase 2: kill -9 during db.dropCollection() of a collection WITH an index (time-bucket retention
// when e.g. elog_by_author is enabled). Every bucket the child ever created is reopened and its
// index entry count compared with its row count.
const DROP_KILLS = args['drop-kills'] ?? 60;
let dropBad = 0;
const dropProblems = [];
{
  const ddir = join(dir, 'drop');
  fs.mkdirSync(ddir, { recursive: true });
  for (let k = 0; k < DROP_KILLS; k++) {
    const p = spawn(process.execPath, [join(BENCH_DIR, '04-crash-safety.mjs'), '--child', 'drop', '--cdir', ddir], { stdio: ['ignore', 'pipe', 'pipe'] });
    const seen = new Set();
    createInterface({ input: p.stdout }).on('line', (l) => seen.add(Number(l.split(' ')[1])));
    await sleep(100 + KR.int(400));
    p.kill('SIGKILL');
    await new Promise((r) => p.on('exit', r));
    await new Promise((r) => setImmediate(r));
    const db = openDB({ dir: ddir, schemas: {} });
    for (const n of [...seen, seen.size]) { // + the bucket being filled when killed
      const c = db.collection(`b${n}`, dropSchema(n));
      const rows = c.count(), ix = c.countIndex(`dix_${n}`);
      if (rows !== ix) { dropBad++; if (dropProblems.length < 5) dropProblems.push(`kill ${k}: bucket b${n} has ${rows} rows but ${ix} index entries`); }
      db.dropCollection(`b${n}`);
    }
    await db.close();
  }
}
results.dropUnderKill = { kills: DROP_KILLS, inconsistentBuckets: dropBad, examples: dropProblems };
rep.check(`dropCollection under kill -9: buckets left with index != data (${DROP_KILLS} kills)`, dropBad, '==', 0, { unit: '', note: 'src/collection.js drop() drops the index DBIs, the data DBI and the structures key in ONE write txn (mdb_drop is transactional)' });
if (dropBad) log(`  drop under kill -9: ${dropBad} inconsistent buckets, e.g. ${dropProblems[0]}`);
if (ITER > 0) rep.check('verifier negative control (detects injected corruption, reindex repairs)', +(control.droppedIndexEntryDetected && control.reindexRepaired && control.staleIndexAfterRawDataWriteDetected), '==', 1, { unit: 'bool' });
const openS = summary(openMs, 2);
results.summary = {
  seconds: +elapsed.toFixed(1),
  iterations: ITER,
  earlyKills,
  totalTxnsCommitted: totalTxns,
  corruptIterations: corrupt,
  maxLostCommittedTxns: maxLost,
  maxTxnsVisibleBeyondLastReport: maxInflight,
  openMs: openS,
  firstDurableCommitMs: summary(firstCommitMs, 2),
  slowOpens, // opens > 50 ms with the fdatasync probe taken right after: a slow probe = host disk stall
  killDelayMs: summary(delays, 0),
  finalRecords: model.rec.size,
  finalCounters: model.ctr.size,
  fileBytes: fileSize(join(dir, 'hot.mdb')),
};
rep.check('corrupt iterations (open / prefix / index<->data)', corrupt, '==', 0, { unit: '' });
rep.check('committed txns lost after kill -9 (max)', maxLost, '<=', 0, { unit: 'txns', note: 'design allows <= 1 for POWER loss; for kill -9 nothing reported committed may vanish' });
rep.check('child processes that died on their own', childErrors, '==', 0, { unit: '' });
if (ITER > 0) rep.check('open time after crash p99', openS.p99, '<=', 50, { unit: 'ms', scale: 'cpu' });
if (ITER > 0) rep.check('open time after crash max', openS.max, '<=', 50, { unit: 'ms', informational: true });
if (ITER > 0) rep.check('first durable commit after crash p99 (flushes what the killed writer left dirty)', summary(firstCommitMs, 2).p99, '<=', 50, { unit: 'ms', informational: true });
if (ITER > 0) rep.check('first durable commit after crash max', summary(firstCommitMs, 2).max, '<=', 50, { unit: 'ms', informational: true });
rep.note('maxTxnsVisibleBeyondLastReport: txns committed after the last stdout report (killed between commit and report) - expected 0 or 1');
rep.note('power-loss (dm-flakey) run not possible here: needs root + device-mapper');
results.iterations = results.iterations.filter((x) => !x.ok).concat(results.iterations.filter((x) => x.ok).slice(0, 5));
fs.rmSync(dir, { recursive: true, force: true });
log(`  done: ${corrupt} corrupt, ${totalTxns} txns, max lost ${maxLost}, open p99 ${openS.p99} ms`);
rep.finish(results);

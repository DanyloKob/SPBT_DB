// bench/09 - multi-process (design §13 row 09, §11).
//
//   node bench/09-multiprocess.mjs [--ticks 300] [--incr-ops 20000] [--control-ops 2000] [--dir D]
//
// Separate OS processes on one env, with no IPC between them except stdout lines to the parent
// (timestamps from process.hrtime = CLOCK_MONOTONIC, which is system-wide):
//   A. visibility: a writer commits kv 'tick' = seq every 20 ms and reports the time its
//      db.txn returned; a reader polls db.kv.get('tick') every 1 ms (setTimeout - lmdb-js renews
//      the read txn on the next event turn) and reports when it first sees each seq.
//      latency = seen - committed. Also checked: a reader spinning WITHOUT yielding keeps its
//      old snapshot until it calls env.resetReadTxn() (§11.3 rule 4).
//   B. atomic increments: two processes each run incr(kv-like counter) N/2 times, every incr its
//      own durable txn, racing on the same key -> final value must be exactly N. Control: the
//      same race with a non-atomic get-then-put (two txns) must LOSE increments, proving the
//      test can see a lost update.
//   C. writer kill -9 while it HOLDS the write lock (inside db.txn, mid-batch): the reader must
//      keep reading without stalls, a new writer must get the lock (MDB_USE_ROBUST), the killed
//      txn's writes must be invisible, and readerCheck() must clear the dead reader slot.
// Not measured: the write-lease takeover (≤ 20 s) - there is no lease implementation in src yet.

import fs from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { openDB, coreSchemas } from '../src/index.js';
import { parseArgs, freshDir, fsInfo, report, summary, log, sleep, BENCH_DIR } from './lib.mjs';

const args = parseArgs();
const schemas = { kv: coreSchemas.kv, ctr: { key: 'k:u32', codec: 'varint', fields: ['n'] } };
const now = () => Number(process.hrtime.bigint() / 1000n); // µs, CLOCK_MONOTONIC
const out = (s) => process.stdout.write(s + '\n');

/* ============================================================ children */
if (args.child) {
  const db = openDB({ dir: args.cdir, schemas });
  const env = db.backend('hot').env;
  const role = args.child;
  if (role === 'writer') {
    out('READY');
    for (let seq = 1; seq <= args.ticks; seq++) {
      db.txn(() => db.kv.put({ k: 'tick', seq }));
      out(`C ${seq} ${now()}`);
      await sleep(20);
    }
    out('DONE');
  } else if (role === 'reader') {
    out('READY');
    let last = 0;
    const deadline = Date.now() + Number(args.ms);
    while (Date.now() < deadline && last < args.ticks) {
      const v = db.kv.get('tick');
      if (v && v.seq > last) { last = v.seq; out(`S ${v.seq} ${now()}`); }
      await sleep(1);
    }
    // stale-snapshot check: spin without yielding; then resetReadTxn()
    out('SPIN');
    const a = db.kv.get('probe')?.n ?? null;
    const t0 = Date.now();
    let seenInSpin = a;
    while (Date.now() - t0 < 400) seenInSpin = db.kv.get('probe')?.n ?? null;
    env.resetReadTxn();
    const after = db.kv.get('probe')?.n ?? null;
    out(`SNAP ${a} ${seenInSpin} ${after}`);
    out('DONE');
  } else if (role === 'prober') {
    // writes kv 'probe' while the reader spins
    await sleep(100);
    db.txn(() => db.kv.put({ k: 'probe', n: 42 }));
    out('DONE');
  } else if (role === 'incr' || role === 'rmw') {
    out('READY');
    await new Promise((r) => process.stdin.once('data', r)); // start together
    const n = Number(args.ops);
    const t0 = now();
    for (let i = 0; i < n; i++) {
      if (role === 'incr') db.ctr.incr(7, 'n', 1);
      else {
        // the classic lost update: read in one txn, "work" 0-4 ms, write in another txn. A FIXED work
        // time phase-locks the two processes (the 4 ms commits alternate under the write lock) and
        // hides the race; jitter like real handler code exposes it.
        env.resetReadTxn();
        const v = db.ctr.get(7)?.n ?? 0;
        const w = now() + Math.floor(Math.random() * 4000); while (now() < w);
        db.ctr.put({ k: 7, n: v + 1 });
      }
    }
    out(`DONE ${now() - t0}`);
  } else if (role === 'holder') {
    out('READY');
    db.txn(() => {
      for (let i = 0; i < 1000; i++) db.ctr.put({ k: 100_000 + i, n: i });
      db.kv.put({ k: 'holder', n: 1 });
      out('INTXN');
      for (;;) {} // hold the write lock (and a reader slot) until killed
    });
  } else if (role === 'survivor') {
    // reads continuously; after 'GO' on stdin tries to write and reports how long the lock took
    out('READY');
    let maxGapUs = 0, reads = 0, last = now();
    let writeReq = false;
    process.stdin.on('data', () => { writeReq = true; });
    for (;;) {
      db.ctr.get(7); db.kv.get('holder'); reads++;
      const t = now(); maxGapUs = Math.max(maxGapUs, t - last); last = t;
      if (writeReq) {
        const t1 = now();
        db.txn(() => db.kv.put({ k: 'after-kill', n: 1 }));
        const lockUs = now() - t1;
        env.resetReadTxn();
        const holderVisible = db.kv.get('holder') != null || db.ctr.get(100_000) != null;
        out(`W ${lockUs} ${maxGapUs} ${reads} ${holderVisible} ${env.readerCheck()}`);
        break;
      }
      await sleep(1);
    }
    out('DONE');
  }
  await db.close();
  process.exit(0);
}

/* ============================================================== parent */
const dir = freshDir(args, '09-multiproc');
const fsi = fsInfo(dir);
const TICKS = args.ticks ?? 300;
const INCR = args['incr-ops'] ?? 20000;
const CONTROL = args['control-ops'] ?? 2000;
const rep = report('09-multiprocess', { ticks: TICKS, incrOps: INCR, controlOps: CONTROL, dir });
log(`09-multiprocess: ${dir} (${fsi.type})`);
// create the env and DBIs once, so children never race on DBI creation
{ const db = openDB({ dir, schemas }); db.txn(() => db.ctr.put({ k: 0, n: 0 })); await db.close(); }

function child(role, extra = []) {
  const p = spawn(process.execPath, [join(BENCH_DIR, '09-multiprocess.mjs'), '--child', role, '--cdir', dir, ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const waiters = [];
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  createInterface({ input: p.stdout }).on('line', (l) => { lines.push(l); for (const w of [...waiters]) if (w.re.test(l)) { waiters.splice(waiters.indexOf(w), 1); w.res(l); } });
  const exit = new Promise((res) => p.on('exit', (code, sig) => res({ code, sig, err })));
  return {
    p, lines, exit,
    wait: (re, ms = 120_000) => new Promise((res, rej) => {
      const hit = lines.find((l) => re.test(l));
      if (hit) return res(hit);
      const timer = setTimeout(() => rej(new Error(`${role}: timeout waiting for ${re} (stderr: ${err.slice(0, 300)})`)), ms);
      waiters.push({ re, res: (l) => { clearTimeout(timer); res(l); } });
    }),
  };
}
const results = { fs: fsi };

/* ---------------------------------------------------------- A. visibility */
{
  const r = child('reader', ['--ticks', String(TICKS), '--ms', String(TICKS * 20 + 10_000)]);
  await r.wait(/^READY/);
  const w = child('writer', ['--ticks', String(TICKS)]);
  await w.wait(/^DONE/);
  await r.wait(/^SPIN/);
  const pr = child('prober');
  await pr.wait(/^DONE/);
  const snap = (await r.wait(/^SNAP/)).split(' ');
  await r.exit; await w.exit; await pr.exit;
  const C = new Map(w.lines.filter((l) => l.startsWith('C ')).map((l) => l.split(' ')).map(([, s, t]) => [Number(s), Number(t)]));
  const lat = r.lines.filter((l) => l.startsWith('S ')).map((l) => l.split(' ')).map(([, s, t]) => (Number(t) - C.get(Number(s))) / 1000);
  const seen = lat.length;
  const skipped = TICKS - seen; // the reader may coalesce two ticks between polls (never more than TICKS)
  const s = summary(lat, 3);
  results.visibility = { ticks: TICKS, observed: seen, coalesced: skipped, latencyMs: s, staleSnapshot: { before: snap[1], duringSpinWithoutYield: snap[2], afterResetReadTxn: snap[3] } };
  rep.check('cross-process visibility p99 (writer commit -> reader sees)', s.p99, '<=', 600, { unit: 'ms' });
  rep.check('cross-process visibility max', s.max, '<=', 600, { unit: 'ms' });
  rep.check('non-yielding reader stays on its snapshot until resetReadTxn()', +(snap[2] === 'null' && snap[3] === '42'), '==', 1, { unit: 'bool', informational: true, note: '§11.3 rule 4 - expected behaviour, documents the need for resetReadTxn/__epoch' });
  log(`  visibility p50 ${s.p50} ms p99 ${s.p99} ms max ${s.max} ms; snapshot spin=${snap[2]} after reset=${snap[3]}`);
}

/* ------------------------------------------------------ B. atomic incr */
async function race(role, total) {
  { const db = openDB({ dir, schemas }); db.txn(() => db.ctr.put({ k: 7, n: 0 })); await db.close(); }
  const a = child(role, ['--ops', String(total / 2)]), b = child(role, ['--ops', String(total / 2)]);
  await a.wait(/^READY/); await b.wait(/^READY/);
  const t0 = performance.now();
  a.p.stdin.write('go\n'); b.p.stdin.write('go\n');
  await a.wait(/^DONE/); await b.wait(/^DONE/);
  const secs = (performance.now() - t0) / 1000;
  await a.exit; await b.exit;
  const db = openDB({ dir, schemas });
  const n = db.ctr.get(7).n;
  await db.close();
  return { ops: total, final: n, lost: total - n, seconds: +secs.toFixed(2), opsPerSec: Math.round(total / secs) };
}
{
  const atomic = await race('incr', INCR);
  const control = await race('rmw', CONTROL);
  results.incr = { atomic, nonAtomicControl: control };
  rep.check(`lost increments, 2 processes x ${INCR / 2} incr`, atomic.lost, '==', 0, { unit: 'ops' });
  rep.check('control (non-atomic get+put) does lose updates - test is sensitive', +(control.lost > 0), '==', 1, { unit: 'bool' });
  log(`  incr: ${atomic.final}/${INCR} (${atomic.opsPerSec} ops/s); control lost ${control.lost}/${CONTROL}`);
}

/* -------------------------------------------- C. writer killed holding the lock */
{
  const s = child('survivor');
  await s.wait(/^READY/);
  const h = child('holder');
  await h.wait(/^INTXN/);
  await sleep(300); // the survivor keeps reading while the lock is held
  const tKill = performance.now();
  h.p.kill('SIGKILL');
  await h.exit;
  s.p.stdin.write('go\n');
  let line, hung = false;
  try { line = await s.wait(/^W /, 15_000); } catch { hung = true; }
  const recoverMs = performance.now() - tKill;
  if (hung) s.p.kill('SIGKILL');
  await s.exit;
  const [, lockUs, maxGapUs, reads, holderVisible, staleCleared] = line ? line.split(' ') : [];
  results.writerKill = hung ? { hung: true } : { readerReads: Number(reads), readerMaxGapMs: Number(maxGapUs) / 1000, newWriterLockMs: Number(lockUs) / 1000, killToWriteMs: +recoverMs.toFixed(1), killedTxnVisible: holderVisible === 'true', staleReadersClearedByReaderCheck: Number(staleCleared) };
  rep.check('reader + new writer not hung after writer kill -9 (robust mutex)', +!hung, '==', 1, { unit: 'bool' });
  if (!hung) {
    rep.check('killed txn writes invisible', +(holderVisible === 'false'), '==', 1, { unit: 'bool' });
    rep.check('max read stall while lock held / after kill', Number(maxGapUs) / 1000, '<=', 50, { unit: 'ms', informational: true, note: 'includes the 1 ms poll sleep' });
  }
  log(`  writer kill: ${hung ? 'HUNG' : `new writer got the lock in ${(Number(lockUs) / 1000).toFixed(2)} ms, killed txn visible=${holderVisible}`}`);
}
rep.note('lease takeover (§11.3 rule 3, threshold <= 20 s) not measured: no lease implementation in src/');
fs.rmSync(dir, { recursive: true, force: true });
rep.finish(results);

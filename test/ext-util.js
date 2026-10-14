// Helpers for the scheduler / TTL / coalescer / bucket suites (no tests in this file).
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './util.js';
import { openDB, createMemoryBackend, createLmdbBackend } from '../src/index.js';

export const DAY = 86_400_000;

/**
 * Fake clock + timer functions. No real waiting. Like the real thing, timers run on a
 * monotonic clock and `clock()` is wall time = mono + offset:
 *   t.now = x      time passes (mono and wall move together)
 *   t.jump(d)      the wall clock steps by d (NTP step, VM resume); timers are unaffected
 *   t.fireNext()   advance mono to the earliest timer and run it
 * Every requested delay is recorded in t.delays.
 */
export function fakeTime(start = Date.now()) {
  let mono = 0, offset = start;
  const t = {
    get now() { return mono + offset; },
    set now(v) { mono += v - (mono + offset); },
    jump(d) { offset += d; },
    delays: [],
    pending: new Map(),
    seq: 0,
    clock: () => mono + offset,
    setTimeout(fn, ms) {
      t.delays.push(ms);
      if (!(ms >= 0 && ms <= 2 ** 31 - 1)) throw new RangeError(`fake setTimeout: delay ${ms} would overflow`);
      const id = ++t.seq;
      t.pending.set(id, { at: mono + ms, fn });
      return id;
    },
    clearTimeout(id) { t.pending.delete(id); },
    /** earliest pending timer, or undefined */
    peek() {
      let best;
      for (const [id, x] of t.pending) if (!best || x.at < best.x.at || (x.at === best.x.at && id < best.id)) best = { id, x };
      return best;
    },
    /** run the earliest timer; throws if none is armed (a stopped loop would hang a test) */
    fireNext() {
      const b = t.peek();
      if (!b) throw new Error('fakeTime: no timer armed');
      t.pending.delete(b.id);
      if (b.x.at > mono) mono = b.x.at;
      b.x.fn();
      return true;
    },
  };
  return t;
}

/**
 * Wrap a Backend to count commits: outer txn/txnAsync calls and auto-committed writes.
 * `log` holds per-txn { puts, dels } so tests can check batch bounds.
 */
export function counted(be) {
  const c = { commits: 0, log: [], cur: null, failNext: 0 };
  const w = { ...be };
  const track = (fn) => () => {
    const s = { puts: 0, dels: 0 };
    const prev = c.cur;
    c.cur = s;
    c.log.push(s);
    try { return fn(); } finally { c.cur = prev; }
  };
  w.txn = (fn) => {
    if (be.inTxn()) return be.txn(fn);
    c.commits++;
    return be.txn(track(fn));
  };
  w.txnAsync = (fn) => {
    if (c.failNext > 0) { c.failNext--; return Promise.reject(new Error('injected commit failure')); }
    c.commits++;
    return be.txnAsync(track(fn));
  };
  w.put = (d, k, v) => {
    if (!be.inTxn()) c.commits++;
    else if (c.cur) c.cur.puts++;
    return be.put(d, k, v);
  };
  w.del = (d, k, v) => {
    if (!be.inTxn()) c.commits++;
    else if (c.cur) c.cur.dels++;
    return be.del(d, k, v);
  };
  return { backend: w, counter: c };
}

/**
 * Open a SPBT_DB on 'memory' or 'lmdb' with commit counters on both envs.
 * @returns {{ db: any, dir: string, hot: any, cold: any, reopen: (o?: object) => any, cleanup: () => Promise<void> }}
 */
export function openDb(kind, o = {}) {
  const dir = o.dir ?? tmpDir(`ext-${kind}`);
  const make = (env) => (kind === 'memory'
    ? createMemoryBackend()
    : createLmdbBackend({ path: join(dir, `${env}.mdb`), profile: env }));
  const hot = counted(make('hot'));
  const cold = counted(make('cold'));
  const db = openDB({ backend: kind, dir, ...o, backends: { hot: hot.backend, cold: cold.backend } });
  let closed = false;
  return {
    db,
    dir,
    hot: hot.counter,
    cold: cold.counter,
    async close() { if (!closed) { closed = true; await db.close(); } },
    async cleanup() {
      if (!closed) { closed = true; await db.close(); }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Promise that resolves when cond() is true (polls every 5 ms), or rejects after ms. */
export function until(cond, ms = 2000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return resolve(Date.now() - t0);
      if (Date.now() - t0 > ms) return reject(new Error('until: timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

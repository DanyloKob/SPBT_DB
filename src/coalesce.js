// SPBT_DB write coalescers (design §7.3). Hot paths buffer in RAM and flush in ONE txn.
//
//   counter(col, field)      numeric deltas per key (level.bump): Map<key, {k, d}>
//   coalescer(col, mergeFn)  records per key folded with mergeFn (pvc_room, music_session, ...)
//   appender(sink)           append-only ring (event_log), flushed as one batch
//
// Flush triggers: `flushMs` after the first buffered op (so the oldest op waits at most
// flushMs), or `maxEntries` keys/rows, or flush()/close()/process 'beforeExit'. A flush
// swaps the buffer out and commits it in exactly one txn - `txnAsync` by default, so the
// ~5 ms commit + fsync runs off the main thread. If the txn fails, the batch is merged
// back into the buffer and retried once at once with every entry in its own savepoint (an
// entry that fails on its own is dropped and reported), then only on the flushMs timer.
//
// What kill -9 loses: everything still in the buffer, i.e. at most `flushMs` of updates
// (level: <= 30 s of XP, event_log: <= 5 s of logs). Nothing already committed is lost.
// The loss is detectable: the __boot record (boot.js) is only marked clean by db.close(),
// so the next open reports lastShutdownClean === false.

import { runTxn, runTxnAsync } from './collection.js';

/** Defaults from §7.3. */
export const DEFAULTS = Object.freeze({
  level: Object.freeze({ flushMs: 30_000, maxEntries: 2000, cap: 20_000 }),
  event_log: Object.freeze({ flushMs: 5000, maxEntries: 512, maxBytes: 1 << 20, cap: 4096 }),
  generic: Object.freeze({ flushMs: 1000, maxEntries: 1000, cap: 20_000 }),
});

/**
 * @typedef {object} CoalesceOptions
 * @property {string} [name]
 * @property {number} [flushMs]        flush this long after the first buffered op
 * @property {number} [maxEntries]     flush when this many keys (or rows) are buffered
 * @property {number} [cap]            soft cap: above it, ops are still merged but `overCap` counts them
 *                                     (appender: hard ring, oldest rows are dropped and counted)
 * @property {boolean} [async=true]    commit via txnAsync (off-thread fsync); false = sync txn
 * @property {boolean} [sorted=true]   counter: apply a flush in key order
 * @property {() => number} [clock=Date.now]
 * @property {{ setTimeout: Function, clearTimeout: Function }} [timers=globalThis]
 * @property {(err: any, n: number) => void} [onError]
 */

/* ---- process-wide flush on 'beforeExit' (one listener for all coalescers) */
const live = new Set();
let exitHooked = false;
/** Flush every live coalescer that has pending entries. What the 'beforeExit' listener runs. */
export function flushAllPending() {
  const ps = [];
  for (const c of live) if (c.pending > 0) ps.push(c.flush().catch(() => {}));
  return Promise.all(ps);
}
function track(c) {
  live.add(c);
  if (!exitHooked) {
    exitHooked = true;
    // beforeExit may schedule async work; it fires again afterwards, and stops once nothing is pending
    process.on('beforeExit', () => { flushAllPending(); });
  }
}

/**
 * Shared flush machinery.
 *
 * Failures. A flush that throws (a commit error, or one entry that cannot be written, e.g. an
 * XP delta that would make a varint negative) restores its batch. The next attempt runs at once
 * in ISOLATION mode: every entry in its own savepoint, so an entry that fails on its own is
 * dropped (counted in `rejected`, reported to onError) and the rest commit. If every entry fails,
 * the problem is the txn, not an entry: the batch is kept and retried on the flushMs timer, never
 * in a loop, so a full disk cannot spin the event loop.
 * @param {import('./backend.js').Backend} backend
 * @param {CoalesceOptions} o
 * @param {{ size(): number, take(): any, apply(batch: any): void, applyEach(batch: any, one: (fn: () => void) => boolean): any[], discard(batch: any, failed: any[]): void, restore(batch: any): void, count(batch: any): number }} impl
 *        applyEach runs every entry through one() and returns the entries that failed; discard
 *        removes them from the batch so that a later restore() does not bring them back
 */
function core(backend, o, impl) {
  const clock = o.clock ?? Date.now;
  const timers = o.timers ?? globalThis;
  const flushMs = o.flushMs;
  const useAsync = o.async !== false;
  let timer = null, firstAt = 0, inflight = null, again = false, closed = false, failures = 0;
  const m = {
    ops: 0, flushes: 0, commits: 0, written: 0, errors: 0, overCap: 0, dropped: 0, rejected: 0,
    lastFlushMs: 0, lastApplyMs: 0, lastFlushEntries: 0, lastAgeMs: 0, maxAgeMs: 0,
  };
  const report = (e, n, info) => {
    if (o.onError) o.onError(e, n, info);
    else console.error(`[spbt-db coalesce ${o.name ?? ''}] ${info && info.rejected ? 'entry rejected (dropped)' : 'flush failed, batch kept'}`, e);
  };

  function armTimer() {
    if (timer !== null || closed) return;
    timer = timers.setTimeout(() => { timer = null; c.flush().catch(() => {}); }, flushMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function clearTimer() { if (timer !== null) { timers.clearTimeout(timer); timer = null; } }

  /** called by the front-end after each buffered op */
  function touched(n) {
    m.ops++;
    if (firstAt === 0) { firstAt = clock(); armTimer(); }
    if (n >= o.maxEntries && failures === 0) { // while flushes fail, only the timer retries
      if (inflight) again = true;
      else c.flush().catch(() => {});
    }
  }

  const c = {
    name: o.name,
    m,
    touched,
    get pending() { return impl.size(); },

    /**
     * Commit everything buffered in ONE txn. Resolves when everything buffered at the time of
     * the call is durably committed (a flush already in flight is waited for, then whatever was
     * buffered meanwhile is flushed too).
     */
    flush() {
      if (inflight) {
        again = true;
        // the in-flight batch was taken before the caller's latest ops: wait for it, then for the
        // flush that picks those ops up (started by its finally, or started here)
        return inflight.catch(() => {}).then(() => inflight ?? c.flush());
      }
      if (impl.size() === 0) { clearTimer(); firstAt = 0; return Promise.resolve(0); }
      clearTimer();
      const age = firstAt ? clock() - firstAt : 0;
      firstAt = 0;
      const b = impl.take();
      const n = impl.count(b);
      if (n === 0) { m.flushes++; m.lastFlushEntries = 0; return Promise.resolve(0); } // nothing to write: no txn, no fsync
      const t0 = performance.now();
      const isolate = failures > 0;
      let rejected = 0, firstErr;
      // one entry in its own savepoint; false = it failed and was rolled back alone
      const one = (fn) => {
        try { runTxn(backend, fn); return true; } catch (e) { rejected++; firstErr ??= e; return false; }
      };
      // the txn callback always runs on the main thread (lmdb childTransaction included);
      // only commit + fsync move off-thread. lastApplyMs is that main-thread cost.
      const apply = () => {
        const a0 = performance.now();
        rejected = 0; firstErr = undefined;
        if (!isolate) impl.apply(b);
        else {
          const failed = impl.applyEach(b, one);
          if (failed.length && failed.length === n) throw firstErr; // not one entry went in: a txn-level failure, keep them all
          if (failed.length) impl.discard(b, failed);
        }
        m.lastApplyMs = performance.now() - a0;
      };
      const p = useAsync ? runTxnAsync(backend, apply) : new Promise((r) => r(runTxn(backend, apply)));
      inflight = p.then(
        () => {
          failures = 0;
          const w = n - rejected;
          m.flushes++; m.commits++; m.written += w; m.rejected += rejected;
          m.lastFlushMs = performance.now() - t0; m.lastFlushEntries = w;
          m.lastAgeMs = age; if (age > m.maxAgeMs) m.maxAgeMs = age;
          if (rejected) report(firstErr, rejected, { rejected: true });
          return w;
        },
        (e) => {
          failures++;
          m.errors++;
          impl.restore(b);
          if (firstAt === 0 && impl.size()) firstAt = clock() - age;
          report(e, n);
          throw e;
        },
      ).finally(() => {
        inflight = null;
        if (impl.size() > 0) {
          // after the first failure: one immediate retry in isolation mode; after that, the timer
          if (failures === 1 || (failures === 0 && (again || impl.size() >= o.maxEntries))) c.flush().catch(() => {});
          else armTimer();
        }
        again = false;
      });
      return inflight;
    },

    /** Lag metrics. oldestAgeMs = age of the oldest unflushed op (what kill -9 would lose). */
    metrics() {
      return { name: o.name, pending: impl.size(), oldestAgeMs: firstAt ? clock() - firstAt : 0, inflight: !!inflight, failing: failures > 0, ...m };
    },

    /** Flush and stop. */
    async close() {
      // drain: an in-flight flush, then whatever was buffered meanwhile (bounded if commits keep failing)
      for (let i = 0; i < 4 && (inflight || impl.size() > 0); i++) {
        if (inflight) await inflight.catch(() => {});
        else await c.flush().catch(() => {});
      }
      closed = true;
      clearTimer();
      live.delete(c);
    },
  };
  track(c);
  return c;
}

/**
 * Numeric delta coalescer: bump(...key, delta) adds into a Map; a flush applies each key
 * with col.incr (atomic read-modify-write, index maintained) inside one txn.
 * level.bump is counter(db.level, 'xp', DEFAULTS.level).
 * @param {any} col  collection
 * @param {string} field
 * @param {CoalesceOptions} [opts]
 */
export function createCounter(col, field, opts = {}) {
  const o = { ...DEFAULTS.level, name: `${col.name}.${field}`, ...opts };
  const fields = col.pk.fields;
  const pkN = fields.length;
  // u64 key fields are normalized to bigint, so bigint / decimal string / number ids of the
  // same snowflake share one entry. Nested Maps keyed by those bigints are ~3x cheaper per
  // bump than a `${gid}:${uid}` string key (bigint -> decimal is the expensive part).
  const toBig = (x) => (typeof x === 'bigint' ? x : BigInt(x));
  const norm = fields.map((f) => (f.type === 'u64' || f.type === 'u64s' ? toBig : null));
  const n0 = norm[0], n1 = norm[1];
  const nested = pkN === 2;
  const flatKey = (k) => (pkN === 1 ? k[0] : k.join('\0')); // pkN >= 3: one string-keyed level
  /** @type {Map<any, any>} */
  let root = new Map();
  let size = 0;

  function each(r, fn) {
    if (nested) { for (const g of r.values()) for (const e of g.values()) fn(e); } else for (const e of r.values()) fn(e);
  }
  function slot(k) { // existing entry for normalized key k, or a new one
    let m = root, last = flatKey(k);
    if (nested) {
      m = root.get(k[0]);
      if (m === undefined) root.set(k[0], (m = new Map()));
      last = k[1];
    }
    let e = m.get(last);
    if (e === undefined) {
      if (size >= o.cap) c.m.overCap++;
      m.set(last, (e = { k, d: 0 }));
      size++;
    }
    return e;
  }
  const cmp = (x, y) => { for (let i = 0; i < pkN; i++) { const a = x.k[i], b = y.k[i]; if (a !== b) return a < b ? -1 : 1; } return 0; };

  function listOf(b) {
    const list = [];
    each(b, (e) => { if (e.d !== 0) list.push(e); });
    if (o.sorted !== false) list.sort(cmp); // key order: neighbouring rows share leaf pages and cursor paths
    return list;
  }
  const impl = {
    size: () => size,
    take() { const b = root; root = new Map(); size = 0; return b; },
    count(b) { let n = 0; each(b, (e) => { if (e.d !== 0) n++; }); return n; }, // keys that net to 0 cost nothing
    apply(b) { for (const e of listOf(b)) col.incr(...e.k, field, e.d); },
    applyEach(b, one) {
      const failed = [];
      for (const e of listOf(b)) if (!one(() => col.incr(...e.k, field, e.d))) failed.push(e);
      return failed;
    },
    discard(b, failed) { for (const e of failed) e.d = 0; },
    restore(b) { each(b, (e) => { if (e.d !== 0) slot(e.k).d += e.d; }); },
  };
  const c = core(col.backend, o, impl);
  const normKey = (k) => k.map((v, i) => (norm[i] ? norm[i](v) : v));

  if (nested) {
    c.bump = (a, b, d = 1) => {
      if (n0) a = n0(a);
      if (n1) b = n1(b);
      let g = root.get(a);
      if (g === undefined) root.set(a, (g = new Map()));
      const e = g.get(b);
      if (e !== undefined) e.d += d;
      else {
        if (size >= o.cap) c.m.overCap++;
        g.set(b, { k: [a, b], d });
        size++;
      }
      c.touched(size);
    };
  } else if (pkN === 1) {
    c.bump = (a, d = 1) => { if (n0) a = n0(a); slot([a]).d += d; c.touched(size); };
  } else {
    c.bump = (...args) => { slot(normKey(args.slice(0, pkN))).d += args[pkN] ?? 1; c.touched(size); };
  }
  /** buffered delta for a key (stored value + this = the live value) */
  c.peek = (...k) => {
    k = normKey(k);
    const e = nested ? root.get(k[0])?.get(k[1]) : root.get(flatKey(k));
    return e ? e.d : 0;
  };
  return c;
}

const patchMerge = (a, b) => Object.assign({}, a, b);

/**
 * Record coalescer: add(rec) folds rec into the buffered record of the same key with
 * mergeFn(prev, next); a flush writes mergeFn(stored, buffered) per key in one txn.
 * mergeFn must be associative (sum, max, last-write-wins, set union...). Default: shallow
 * patch (last write wins per field). With { blind: true } the stored value is not read.
 * @param {any} col
 * @param {(prev: object, next: object) => object} [mergeFn]
 * @param {CoalesceOptions & { blind?: boolean, put?: { ttl?: number, expiresAt?: number } }} [opts]
 */
export function createCoalescer(col, mergeFn = patchMerge, opts = {}) {
  const o = { ...DEFAULTS.generic, name: col.name, ...opts };
  const fields = col.pk.fields.map((f) => f.name);
  /** @type {Map<string, object>} */
  let map = new Map();
  function applyOne(rec) {
    let next = rec;
    if (!o.blind) {
      const cur = col.get(...fields.map((f) => rec[f]));
      if (cur !== undefined) {
        const stored = Object.assign({}, cur);
        for (const f of fields) stored[f] = rec[f];
        next = mergeFn(stored, rec);
        for (const f of fields) next[f] = rec[f];
      }
    }
    col.put(next, o.put);
  }
  const impl = {
    size: () => map.size,
    take() { const b = map; map = new Map(); return b; },
    count: (b) => b.size,
    apply(b) { for (const rec of b.values()) applyOne(rec); },
    applyEach(b, one) {
      const failed = [];
      for (const [ks, rec] of b) if (!one(() => applyOne(rec))) failed.push(ks);
      return failed;
    },
    discard(b, failed) { for (const ks of failed) b.delete(ks); },
    restore(b) {
      for (const [ks, rec] of b) { // the failed batch is older: fold newer buffered values onto it
        const cur = map.get(ks);
        map.set(ks, cur ? mergeFn(rec, cur) : rec);
      }
    },
  };
  const c = core(col.backend, o, impl);
  c.add = (rec) => {
    const kb = col.pk.encodeRecord(rec);
    if (kb === undefined) throw new TypeError(`spbt-db coalesce: ${col.name} record lacks key fields`);
    const ks = kb.toString('latin1');
    const prev = map.get(ks);
    if (prev === undefined && map.size >= o.cap) c.m.overCap++;
    map.set(ks, prev === undefined ? rec : mergeFn(prev, rec));
    c.touched(map.size);
  };
  c.peek = (...k) => {
    const rec = {};
    fields.forEach((f, i) => { rec[f] = k[i]; });
    return map.get(col.pk.encodeRecord(rec).toString('latin1'));
  };
  return c;
}

/**
 * Append-only ring buffer (event_log, §7.3: 5 s / 512 rows / 1 MB, cap 4096).
 * sink(rows) runs inside the flush txn on `backend`.
 * @param {import('./backend.js').Backend} backend
 * @param {(rows: any[]) => void} sink
 * @param {CoalesceOptions & { maxBytes?: number, sizeOf?: (rec: any) => number }} [opts]
 */
export function createAppender(backend, sink, opts = {}) {
  const o = { ...DEFAULTS.event_log, name: 'appender', ...opts };
  const sizeOf = o.sizeOf ?? approxSize;
  let rows = [], bytes = 0;
  const impl = {
    size: () => rows.length,
    take() { const b = rows; rows = []; bytes = 0; return b; },
    count: (b) => b.length,
    apply: (b) => sink(b),
    applyEach(b, one) {
      const failed = [];
      for (const r of b) if (!one(() => sink([r]))) failed.push(r);
      return failed;
    },
    discard(b, failed) {
      const drop = new Set(failed);
      let w = 0;
      for (let i = 0; i < b.length; i++) if (!drop.has(b[i])) b[w++] = b[i];
      b.length = w;
    },
    restore(b) {
      rows = b.concat(rows);
      if (rows.length > o.cap) { c.m.dropped += rows.length - o.cap; rows = rows.slice(rows.length - o.cap); }
      bytes = 0;
      for (const r of rows) bytes += sizeOf(r);
    },
  };
  const c = core(backend, o, impl);
  c.append = (rec) => {
    if (rows.length >= o.cap) { rows.shift(); c.m.dropped++; } // ring: drop the oldest
    rows.push(rec);
    bytes += sizeOf(rec);
    c.touched(bytes >= o.maxBytes ? o.maxEntries : rows.length);
  };
  return c;
}

/** Cheap encoded-size estimate: string lengths + 9 B per other field. */
function approxSize(rec) {
  let n = 16;
  for (const k in rec) {
    const v = rec[k];
    n += typeof v === 'string' ? v.length + 2 : v && typeof v === 'object' ? 64 : 9;
  }
  return n;
}

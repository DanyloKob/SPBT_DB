// SPBT_DB scheduler (design §5.3, §8): jobs live in the `sched` tree, keyed by time.
//
//   sched              key = u48be(dueAt) || u24be(seq)          value = raw frame (encodeJob)
//   sched_by_subject   key = u64be(gid) || u8(kind) || u64be(subject)   (dupSort)
//                      value = u48be(dueAt) || u24be(seq)        -> cancel without a scan
//
// One timer for the whole process, re-armed to min(head.dueAt, now + maxSleep).
// maxSleep is capped at 60 s (§8.3), so setTimeout never sees a delay anywhere near
// 2^31-1 ms (the 24.85-day overflow that fires immediately). Every wake compares against
// the wall clock, so clock jumps are absorbed within one ceiling.
//
// Delivery is at-least-once: a batch of due jobs is read, handlers run outside any write
// txn, and then ONE txn deletes the batch (idempotent: a row that is already gone is
// skipped). A crash between a handler and that commit re-runs the job on the next open,
// so every handler must be idempotent (§8.5). Handlers registered with { inTxn: true }
// are synchronous and run inside that commit txn, each in its own savepoint: their DB
// writes and the job's deletion commit together (exactly-once for DB-only effects).

import { pack, unpack } from 'msgpackr';
import { writeU24, writeU48, writeU64, writeU32, readU24, readU32, readU48, readU64, prefixEnd } from './keys.js';
import { FRAME_VER, CODEC } from './frame.js';
import { runTxn } from './collection.js';
import { schedSchemas } from './schema.js';

/** Node's setTimeout overflows above this and fires immediately. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
/** Wake ceiling (§8.3). */
export const MAX_SLEEP_MS = 60_000;
/** Jobs due within this window are run in the current wake (§8.2). */
export const FIRE_EARLY_MS = 50;

/**
 * Job kinds (u8 on disk - never renumber). 1..9 internal maintenance, 10..99 bot features
 * from §5.3, 100..255 free for defineKind().
 */
export const KIND = Object.freeze({
  expire: 1, //            per-record TTL delete (ttl.js, schema.ttlSweep = 'job')
  expire_range: 2, //      periodic bounded TTL scan (ttl.js)
  bucket_drop: 3, //       daily time-bucket retention (buckets.js)
  unban: 10,
  unmute: 11,
  unvoicemute: 12,
  role_remove: 13,
  msg_send: 14,
  vc_autoclose: 15,
  ticket_autoclose: 16,
  premium_expire: 17,
  link_cooldown_end: 18,
  builder_timer: 19,
});

/** catchUp policy (u8, low 2 bits of the flags byte). */
export const CATCH_UP = Object.freeze({ run: 0, skip: 1, runIfWithin: 2 });
const CATCH_UP_NAME = ['run', 'skip', 'runIfWithin'];

const HDR = (FRAME_VER << 5) | CODEC.raw; // 0x22: v1, no schema/mtime/ttl, raw payload
const F_OBJECT = 0x04, F_MAXLAG = 0x08, F_PAYLOAD = 0x10, F_CASE = 0x20, F_NOINDEX = 0x40, F_ATTEMPT = 0x80;
const FIXED = 1 + 1 + 1 + 8 + 8; // hdr kind flags gid subject
const KEY_SIZE = 9;
const IX_SIZE = 17;

/**
 * @typedef {bigint | string | number} Id   snowflake: bigint, decimal string or safe integer
 *
 * @typedef {object} JobSpec
 * @property {string | number} kind       name from KIND / defineKind, or the u8 id
 * @property {Id} [gid=0]
 * @property {Id} [subject=0]
 * @property {Id} [object]
 * @property {number} [caseNo]            u32 (mod_case link, §5.2)
 * @property {any} [payload]              anything msgpackr can pack
 * @property {'run'|'skip'|'runIfWithin'|number} [catchUp='run']
 * @property {number} [maxLagMs]          runIfWithin: run only if now - dueAt <= maxLagMs (u32)
 * @property {boolean} [indexed=true]     false: no sched_by_subject entry (never cancelled by subject)
 * @property {boolean} [replace]          cancel existing jobs with the same (gid, kind, subject) first
 *
 * @typedef {object} Job
 * @property {string} id                  hex of the 9-byte key
 * @property {number} dueAt
 * @property {number} seq
 * @property {string | number} kind       name if known, else the u8 id
 * @property {number} kindId
 * @property {bigint} gid
 * @property {bigint} subject
 * @property {bigint} [object]
 * @property {number} [caseNo]
 * @property {any} [payload]
 * @property {'run'|'skip'|'runIfWithin'} catchUp
 * @property {number} [maxLagMs]
 * @property {number} attempt             0 on the first run, +1 per retry
 * @property {boolean} indexed
 *
 * @typedef {object} HandlerContext
 * @property {number} now                 wall clock at this wake
 * @property {number} lagMs               now - dueAt
 * @property {any} db
 *
 * A handler returns nothing, or { reschedule: dueAt, payload? } to re-insert the job
 * (recurring timers) in the same commit that deletes it.
 * @typedef {(job: Job, ctx: HandlerContext) => (void | { reschedule: number, payload?: any } | Promise<void | { reschedule: number, payload?: any }>)} Handler
 *
 * @typedef {object} SchedOptions
 * @property {() => number} [clock=Date.now]
 * @property {{ setTimeout: Function, clearTimeout: Function }} [timers=globalThis]
 * @property {number} [maxSleepMs=60000]  wake ceiling; must be <= 2^31-1
 * @property {number} [fireEarlyMs=50]
 * @property {number} [batch=500]         jobs per wake/commit (§8.4 backpressure)
 * @property {number} [concurrency=8]     async handlers in flight at once
 * @property {number} [graceMs=60000]     catchUp 'skip': a job later than this is dropped
 * @property {number} [maxAttempts=5]     a throwing handler is retried with backoff, then dropped
 * @property {number} [retryBaseMs=1000]
 * @property {number} [retryMaxMs=3600000]
 * @property {number} [stallMs=1000]      re-check interval while due jobs have no handler (or a commit failed)
 * @property {number} [scanMax=batch*64]  due rows of unhandled kinds one wake may step over
 * @property {Record<string, number>} [kinds]  extra kind names -> u8 (100..255)
 * @property {(err: any, job?: Job, info?: { final: boolean }) => void} [onError]
 * @property {boolean} [autoStart=true]
 */

/**
 * Create the scheduler for a SPBT_DB instance (opens the `sched` collection on the hot env).
 * @param {any} db  openDB() result
 * @param {SchedOptions} [o]
 */
export function createScheduler(db, o = {}) {
  const clock = o.clock ?? Date.now;
  const timers = o.timers ?? globalThis;
  const maxSleep = o.maxSleepMs ?? MAX_SLEEP_MS;
  if (!(maxSleep > 0 && maxSleep <= MAX_TIMER_MS)) throw new RangeError(`spbt-db sched: maxSleepMs must be in (0, ${MAX_TIMER_MS}]`);
  const fireEarly = o.fireEarlyMs ?? FIRE_EARLY_MS;
  const batchMax = o.batch ?? 500;
  const concurrency = o.concurrency ?? 8;
  const graceMs = o.graceMs ?? 60_000;
  const maxAttempts = o.maxAttempts ?? 5;
  const retryBase = o.retryBaseMs ?? 1000;
  const retryMax = o.retryMaxMs ?? 3_600_000;
  const stallMs = o.stallMs ?? 1000;
  const onError = o.onError ?? ((e, job) => { console.error('[spbt-db sched]', job ? `${job.kind}#${job.id}` : '', e); });

  const col = db.collection('sched', schedSchemas.sched);
  const backend = col.backend;
  const dbi = backend.openCollection('sched', {});
  const ixDbi = backend.openCollection('sched_by_subject', { dupSort: true });

  /* ---- kinds */
  const kindIds = new Map(Object.entries(KIND));
  const kindNames = new Map([...kindIds].map(([n, id]) => [id, n]));
  function defineKind(name, id) {
    if (!(Number.isInteger(id) && id >= 100 && id <= 255)) throw new RangeError('spbt-db sched: custom kind ids are 100..255');
    const cur = kindIds.get(name);
    if (cur !== undefined && cur !== id) throw new Error(`spbt-db sched: kind ${name} is already ${cur}`);
    if (kindNames.has(id) && kindNames.get(id) !== name) throw new Error(`spbt-db sched: kind id ${id} is already ${kindNames.get(id)}`);
    kindIds.set(name, id);
    kindNames.set(id, name);
  }
  for (const [n, id] of Object.entries(o.kinds ?? {})) defineKind(n, id);
  function kindId(k) {
    if (typeof k === 'number') {
      if ((k & 0xff) !== k) throw new RangeError(`spbt-db sched: bad kind ${k}`);
      return k;
    }
    const id = kindIds.get(k);
    if (id === undefined) throw new Error(`spbt-db sched: unknown kind ${k} (defineKind it first)`);
    return id;
  }

  /* ---- row codec */
  function catchUpId(c) {
    if (c === undefined) return 0;
    const id = typeof c === 'number' ? c : CATCH_UP[c === 'runIfYounger' ? 'runIfWithin' : c];
    if (id === undefined || id > 2 || id < 0) throw new TypeError(`spbt-db sched: bad catchUp ${c}`);
    return id;
  }

  /** @param {JobSpec & { attempt?: number }} j */
  function encodeJob(j, kid) {
    const cu = catchUpId(j.catchUp);
    if (cu === CATCH_UP.runIfWithin && !(j.maxLagMs >= 0)) throw new TypeError('spbt-db sched: catchUp runIfWithin needs maxLagMs');
    const pl = j.payload === undefined ? null : pack(j.payload);
    let flags = cu, size = FIXED;
    if (j.object !== undefined && j.object !== null) { flags |= F_OBJECT; size += 8; }
    if (j.caseNo !== undefined) { flags |= F_CASE; size += 4; }
    if (j.maxLagMs !== undefined) { flags |= F_MAXLAG; size += 4; }
    if (j.attempt) { flags |= F_ATTEMPT; size += 1; }
    if (j.indexed === false) flags |= F_NOINDEX;
    if (pl) { flags |= F_PAYLOAD; size += pl.length; }
    const b = Buffer.allocUnsafe(size);
    b[0] = HDR; b[1] = kid; b[2] = flags;
    let p = writeU64(b, 3, j.gid ?? 0);
    p = writeU64(b, p, j.subject ?? 0);
    if (flags & F_OBJECT) p = writeU64(b, p, j.object);
    if (flags & F_CASE) p = writeU32(b, p, j.caseNo);
    if (flags & F_MAXLAG) p = writeU32(b, p, Math.min(j.maxLagMs, 0xffffffff));
    if (flags & F_ATTEMPT) b[p++] = Math.min(j.attempt, 255);
    if (pl) b.set(pl, p);
    return b;
  }

  /** @returns {Job} */
  function decodeJob(key, v) {
    const end = v.length;
    if (v[0] !== HDR) throw new Error(`spbt-db sched: bad row header ${v[0]}`);
    const kid = v[1], flags = v[2];
    const j = {
      id: Buffer.from(key.subarray(0, KEY_SIZE)).toString('hex'),
      dueAt: readU48(key, 0),
      seq: readU24(key, 6),
      kind: kindNames.get(kid) ?? kid,
      kindId: kid,
      gid: readU64(v, 3),
      subject: readU64(v, 11),
      catchUp: CATCH_UP_NAME[flags & 3],
      attempt: 0,
      indexed: !(flags & F_NOINDEX),
    };
    let p = FIXED;
    if (flags & F_OBJECT) { j.object = readU64(v, p); p += 8; }
    if (flags & F_CASE) { j.caseNo = readU32(v, p); p += 4; }
    if (flags & F_MAXLAG) { j.maxLagMs = readU32(v, p); p += 4; }
    if (flags & F_ATTEMPT) j.attempt = v[p++];
    if (flags & F_PAYLOAD) j.payload = unpack(Buffer.from(v.subarray(p, end)));
    return j;
  }

  function ixKeyOf(gid, kid, subject, n = 3) {
    const b = Buffer.allocUnsafe(n === 1 ? 8 : n === 2 ? 9 : IX_SIZE);
    writeU64(b, 0, gid ?? 0);
    if (n > 1) b[8] = kid;
    if (n > 2) writeU64(b, 9, subject ?? 0);
    return b;
  }
  const ixKeyFromRow = (v) => {
    const b = Buffer.allocUnsafe(IX_SIZE);
    b.set(v.subarray(3, 11), 0); b[8] = v[1]; b.set(v.subarray(11, 19), 9);
    return b;
  };
  function schedKey(dueAt, seq) {
    const k = Buffer.allocUnsafe(KEY_SIZE);
    writeU48(k, 0, dueAt);
    writeU24(k, 6, seq);
    return k;
  }

  const write = (fn) => (backend.inTxn && backend.inTxn() ? fn() : runTxn(backend, fn));

  /* ---- state */
  /** @type {Map<number, { fn: Handler, inTxn: boolean }>} */
  const handlers = new Map();
  let seq = (Math.random() * 0x1000) | 0;
  let handle = null, nextWake = Infinity, started = false, stopped = false, stalled = false, commitFailed = false;
  // due rows of kinds without a handler are skipped by their kind byte (no decode, no copy); a
  // wake looks at no more than this many of them, so they can neither hide handled jobs behind
  // them nor make one wake unbounded
  const scanMax = o.scanMax ?? batchMax * 64;
  /** @type {Promise<any> | null} */
  let running = null;
  const m = {
    wakes: 0, fired: 0, skipped: 0, failed: 0, retried: 0, rescheduled: 0, unhandled: 0, commits: 0,
    lastLagMs: 0, maxLagMs: 0, lastWakeUs: 0, scheduled: 0, cancelled: 0,
  };

  /** insert inside an open txn; returns { dueAt, seq } */
  function insertRow(dueAt, row, ixKey) {
    if (!(dueAt >= 0)) dueAt = 0;
    dueAt = Math.min(Math.floor(dueAt), 0xffffffffffff); // u48, like at()
    const key = schedKey(dueAt, 0);
    let s = seq, tries = 0;
    for (;;) { // seq must be unique per dueAt, also against rows from earlier runs
      writeU24(key, 6, s);
      if (backend.get(dbi, key) === undefined) break;
      s = (s + 1) & 0xffffff;
      if (++tries > 0xffffff) throw new Error('spbt-db sched: no free seq at this dueAt');
    }
    seq = (s + 1) & 0xffffff;
    backend.put(dbi, key, row);
    if (ixKey) backend.put(ixDbi, ixKey, key);
    return key;
  }

  function deleteRow(key, v) {
    if (!(v[2] & F_NOINDEX)) backend.del(ixDbi, ixKeyFromRow(v), key);
    backend.del(dbi, key);
  }

  function cancelWhere(ixk) {
    let n = 0;
    write(() => {
      const hits = [];
      for (const e of backend.range(ixDbi, { start: ixk, end: prefixEnd(ixk) })) hits.push(e);
      for (const { key, value } of hits) {
        if (backend.get(dbi, value) !== undefined) { backend.del(dbi, value); n++; }
        backend.del(ixDbi, key, value);
      }
    });
    m.cancelled += n;
    return n;
  }

  /* ---- timer loop (§8.2) */
  function headDue() {
    for (const { key } of backend.range(dbi, { limit: 1 })) return readU48(key, 0);
    return Infinity;
  }

  function clear() {
    if (handle !== null) { timers.clearTimeout(handle); handle = null; }
    nextWake = Infinity;
  }

  function arm() {
    if (!started || stopped) return;
    if (running) return; // runDue re-arms in its finally
    clear();
    const now = clock();
    const due = headDue();
    let wait = due - now;
    if (!(wait > 0)) wait = Number.isFinite(due) && Number.isFinite(now) ? 0 : maxSleep; // NaN/Infinity -> ceiling
    if (wait === 0 && (stalled || commitFailed)) wait = stallMs; // no busy loop on unhandled jobs or a failing disk
    if (wait > maxSleep) wait = maxSleep; // never anywhere near MAX_TIMER_MS
    nextWake = now + wait;
    handle = timers.setTimeout(onTimer, wait);
    if (handle && typeof handle.unref === 'function') handle.unref();
  }

  function onTimer() {
    handle = null;
    nextWake = Infinity;
    runDue().catch((e) => onError(e));
  }

  async function runPool(items, fn) {
    let i = 0;
    const worker = async () => { while (i < items.length) { const it = items[i++]; await fn(it); } };
    const n = Math.min(concurrency, items.length);
    const ws = [];
    for (let k = 0; k < n; k++) ws.push(worker());
    await Promise.all(ws);
  }

  function backoff(attempt) { return Math.min(retryBase * 2 ** attempt, retryMax); }

  /**
   * Re-insert a job (retry or reschedule) inside the batch commit. A bad value - a reschedule
   * that is not a time, a payload msgpackr cannot pack - fails THIS job (final, reported to
   * onError). Thrown inside the commit, it would roll the whole batch back, and every handler in
   * the batch would run again on every wake.
   */
  function reinsert(dueAt, spec, b) {
    let row;
    try {
      if (dueAt instanceof Date) dueAt = dueAt.getTime();
      if (typeof dueAt !== 'number' || Number.isNaN(dueAt)) throw new TypeError(`spbt-db sched: reschedule must be a time in ms, got ${String(dueAt)}`);
      row = encodeJob(spec, spec.kindId);
    } catch (e) {
      b.err = e; b.final = true; m.failed++;
      return false;
    }
    insertRow(dueAt, row, spec.indexed ? ixKeyFromRow(b.value) : null);
    return true;
  }

  /**
   * Run everything due now (bounded batches, one commit per batch). The timer calls this;
   * tests and tools may call it directly. Resolves with the number of jobs processed.
   */
  function runDue() {
    if (running) return running;
    running = (async () => {
      // An async body runs synchronously until its first await. Without this, a wake with
      // nothing to run would reach `finally { running = null }` BEFORE `running` is
      // assigned, leaving it stuck non-null and the timer loop dead.
      await null;
      let total = 0;
      try {
        for (;;) {
          const t0 = process.hrtime.bigint();
          m.wakes++;
          const now = clock();
          const horizon = Math.min(now + fireEarly, 0xffffffffffff - 1);
          const end = schedKey(Math.max(0, Math.floor(horizon) + 1), 0); // dueAt <= horizon
          const batch = [];
          let unhandled = 0;
          // Unhandled kinds are skipped by their kind byte, without a decode or a copy, and the
          // walk goes on past them: a fixed window (it was batch x 4 rows) let enough of them
          // starve every handled job queued behind them.
          const visit = (key, value) => {
            const h = handlers.get(value[1]); // row = HDR kind flags ...
            if (!h) return ++unhandled < scanMax;
            const v = Buffer.from(value.subarray(0, value.length)); // the scan hands a volatile buffer
            const job = decodeJob(key, v);
            const lag = now - job.dueAt;
            const late = job.catchUp === 'skip' ? lag > graceMs : job.catchUp === 'runIfWithin' ? lag > job.maxLagMs : false;
            batch.push({ key, value: v, job, h, lag, action: late ? 'skip' : 'run', result: undefined, err: undefined });
            return batch.length < batchMax;
          };
          if (backend.scan) backend.scan(dbi, { end }, visit);
          else for (const { key, value } of backend.range(dbi, { end })) if (visit(key, value) === false) break;
          m.unhandled = unhandled;
          stalled = unhandled > 0 && batch.length === 0;
          m.lastWakeUs = Number(process.hrtime.bigint() - t0) / 1000;
          if (!batch.length) break;

          // 1. async handlers, outside any write txn
          const asyncRuns = batch.filter((b) => b.action === 'run' && !b.h.inTxn);
          await runPool(asyncRuns, async (b) => {
            try { b.result = await b.h.fn(b.job, { now, lagMs: b.lag, db }); } catch (e) { b.err = e; }
          });

          // 2. ONE commit: delete the batch (idempotent), run inTxn handlers, retries, reschedules
          const after = clock();
          try {
            runTxn(backend, () => {
              for (const b of batch) {
                const cur = backend.get(dbi, b.key);
                if (cur === undefined) { b.gone = true; continue; } // cancelled meanwhile
                if (b.action === 'run' && b.h.inTxn) {
                  try { b.result = runTxn(backend, () => b.h.fn(b.job, { now, lagMs: b.lag, db })); } catch (e) { b.err = e; }
                }
                deleteRow(b.key, b.value);
                if (b.action === 'skip') { m.skipped++; continue; }
                if (b.err !== undefined) {
                  const j = b.job;
                  if (j.attempt + 1 < maxAttempts) {
                    if (reinsert(after + backoff(j.attempt), { ...j, attempt: j.attempt + 1 }, b)) m.retried++;
                  } else m.failed++;
                  continue;
                }
                m.fired++;
                m.lastLagMs = b.lag;
                if (b.lag > m.maxLagMs) m.maxLagMs = b.lag;
                const r = b.result;
                if (r && typeof r === 'object' && r.reschedule !== undefined) {
                  const j = b.job;
                  if (reinsert(r.reschedule, { ...j, attempt: 0, payload: 'payload' in r ? r.payload : j.payload }, b)) m.rescheduled++;
                }
              }
            });
          } catch (e) {
            commitFailed = true; // the next wake waits stallMs instead of retrying at once
            throw e;
          }
          commitFailed = false;
          m.commits++;
          for (const b of batch) {
            if (b.err !== undefined && !b.gone) onError(b.err, b.job, { final: !!b.final || b.job.attempt + 1 >= maxAttempts });
          }
          total += batch.length;
          if (batch.length < batchMax) break; // the due range is exhausted (or only unhandled rows are left)
          await new Promise((r) => setImmediate(r)); // drain in slices, never hog the loop
        }
      } finally {
        running = null;
        arm();
      }
      return total;
    })();
    return running;
  }

  /* ---- public API */
  const sched = {
    KIND,
    CATCH_UP,
    collection: col,
    defineKind,

    /**
     * Schedule a job. Joins the caller's open txn (so a mod_case and its unban commit
     * atomically); otherwise commits its own (one fsync).
     * @param {number | Date} dueAt  ms epoch
     * @param {JobSpec} spec
     * @returns {{ id: string, dueAt: number, seq: number }}
     */
    at(dueAt, spec) {
      if (dueAt instanceof Date) dueAt = dueAt.getTime();
      if (typeof dueAt !== 'number' || Number.isNaN(dueAt)) throw new TypeError('spbt-db sched: dueAt must be a number (ms)');
      dueAt = Math.min(Math.max(0, Math.floor(dueAt)), 0xffffffffffff);
      const kid = kindId(spec.kind);
      const row = encodeJob(spec, kid);
      const ixk = spec.indexed === false ? null : ixKeyOf(spec.gid, kid, spec.subject);
      const key = write(() => {
        if (spec.replace && ixk) cancelWhere(ixk);
        return insertRow(dueAt, row, ixk);
      });
      m.scheduled++;
      if (dueAt < nextWake) arm(); // re-arm sooner if needed (a running wake re-arms when it ends)
      return { id: key.toString('hex'), dueAt, seq: readU24(key, 6) };
    },

    /**
     * Cancel jobs by (gid, kind, subject) through sched_by_subject. Leave trailing
     * arguments out to cancel by prefix: cancel(gid, kind) or cancel(gid).
     * @returns {number} jobs removed
     */
    cancel(gid, kind, subject) {
      const n = kind === undefined ? 1 : subject === undefined ? 2 : 3;
      return cancelWhere(ixKeyOf(gid, n > 1 ? kindId(kind) : 0, subject, n));
    },

    /** Cancel one job by the ref/id returned from at(). @returns {boolean} */
    cancelRef(ref) {
      const key = typeof ref === 'string' ? Buffer.from(ref, 'hex') : schedKey(ref.dueAt, ref.seq);
      const ok = write(() => {
        const v = backend.get(dbi, key);
        if (v === undefined) return false;
        const copy = Buffer.from(v.subarray(0, v.length));
        deleteRow(key, copy);
        return true;
      });
      if (ok) m.cancelled++;
      return ok;
    },

    /** Jobs for (gid, kind?, subject?) via the index, in index order. @returns {Job[]} */
    find(gid, kind, subject) {
      const n = kind === undefined ? 1 : subject === undefined ? 2 : 3;
      const ixk = ixKeyOf(gid, n > 1 ? kindId(kind) : 0, subject, n);
      const out = [];
      for (const { value } of backend.range(ixDbi, { start: ixk, end: prefixEnd(ixk) })) {
        const v = backend.get(dbi, value);
        if (v !== undefined) out.push(decodeJob(value, v));
      }
      return out;
    },

    /** The head of the tree: the next job to fire, or undefined. @returns {Job | undefined} */
    next() {
      for (const { key, value } of backend.range(dbi, { limit: 1 })) return decodeJob(key, value);
      return undefined;
    },

    /** Jobs in dueAt order (inspection/tools). */
    list({ limit = 100, from, to } = {}) {
      const out = [];
      const start = from !== undefined ? schedKey(Math.max(0, from), 0) : undefined;
      const end = to !== undefined ? schedKey(Math.max(0, to), 0) : undefined;
      for (const { key, value } of backend.range(dbi, { start, end, limit })) out.push(decodeJob(key, value));
      return out;
    },

    count: () => backend.stat(dbi).entries,

    /**
     * Register the handler for a kind. { inTxn: true } = synchronous, runs inside the
     * deletion commit (DB-only effects, exactly-once with the deletion).
     * @param {string | number} kind @param {Handler} fn @param {{ inTxn?: boolean }} [opts]
     */
    on(kind, fn, opts = {}) {
      handlers.set(kindId(kind), { fn, inTxn: !!opts.inTxn });
      if (stalled) { stalled = false; arm(); }
      return sched;
    },
    off(kind) { handlers.delete(kindId(kind)); return sched; },

    /** Ensure exactly one indexed job for (gid, kind, subject) exists (recurring maintenance). */
    ensure(dueAt, spec) {
      const kid = kindId(spec.kind);
      const ixk = ixKeyOf(spec.gid, kid, spec.subject);
      for (const _ of backend.range(ixDbi, { start: ixk, end: prefixEnd(ixk), limit: 1 })) return false;
      sched.at(dueAt, spec);
      return true;
    },

    runDue,
    /** Resolves when the current wake (if any) has finished. */
    idle: () => running ?? Promise.resolve(0),
    /** Arm the timer (restart recovery: overdue jobs run on the next macrotask). */
    start() { if (!started) { started = true; stopped = false; arm(); } return sched; },
    /** Stop the timer and wait for a running wake to finish. */
    async stop() {
      stopped = true;
      clear();
      if (running) await running.catch(() => {});
      started = false;
    },

    /** Metrics snapshot. lastWakeUs = cost of the last head scan + decode (no handlers). */
    stats() {
      return { ...m, pending: sched.count(), nextWakeInMs: Number.isFinite(nextWake) ? nextWake - clock() : null, stalled, running: !!running };
    },

    /** @internal row codec, exported for tests/measurements */
    _codec: { encodeJob, decodeJob, kindId },
  };
  return sched;
}

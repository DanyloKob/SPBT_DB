// SPBT_DB TTL sweeper (design §4.3 "TTL lives in the frame", §8.6).
//
// Readers already hide expired frames, so the sweeper only frees space; it is never on a
// correctness path. Two modes, chosen per collection with `schema.ttlSweep`:
//
//   'scan' (default)  EXPIRE_RANGE: one recurring `expire_range` sched job (every intervalMs)
//                     walks each TTL collection with a resumable cursor, reading at most
//                     `scanBudget` entries per step and deleting at most `batch` (500) per
//                     write txn. No expiresAt index, no extra write per TTL put.
//   'job'             EXPIRE: the write txn that stores a TTL frame also inserts one
//                     un-indexed `expire` job at expiresAt (db.hooks.onExpiring), which
//                     deletes exactly that record if it is still expired when it fires.
//                     Hot env only (a cold write cannot join a hot txn).
//   false             never swept.
//
// Why scan is the default: the §5 TTL collections that are rewritten often (session.lastSeenAt
// every 30 s, music_session every 3 s, ai_quota per AI reply, link_cooldown) would get one
// sched row + one stale job per rewrite under 'job', i.e. the hot path would pay double
// writes to save a few ms of scanning per day; and an expiresAt index would add an index
// move to every refresh. The doc itself assigns EXPIRE_RANGE to these mass-TTL
// collections. 'job' fits large write-once collections with long TTLs (ai_chunk, 90 d),
// where a periodic full scan would fault cold pages into a 952 MB box.
//
// Which collections are scanned: open collections whose schema has `ttl` or
// `ttlSweep: 'scan'`, plus any collection seen writing a TTL frame at runtime (recorded
// by the hook and persisted in kv `__ttl`, so it is swept after a restart too).

import { HAS_TTL, frameExpiresAt } from './frame.js';
import { runTxnAsync } from './collection.js';
import { coreSchemas } from './schema.js';

const TTL_KEY = '__ttl';

/**
 * @typedef {object} SweepOptions
 * @property {() => number} [clock=Date.now]
 * @property {number} [batch=500]           max deletes per write txn
 * @property {number} [scanBudget=2000]     max entries read per step (between yields)
 * @property {number} [intervalMs=86400000] expire_range period (§8.6: once a day)
 * @property {boolean} [schedule=true]      register the recurring expire_range job (needs db.sched)
 * @property {() => Promise<void>} [yieldFn] between steps (default setImmediate)
 */

/**
 * @param {any} db
 * @param {SweepOptions} [o]
 */
export function createSweeper(db, o = {}) {
  const clock = o.clock ?? Date.now;
  const batch = o.batch ?? 500;
  const scanBudget = Math.max(o.scanBudget ?? 2000, batch);
  const intervalMs = o.intervalMs ?? 86_400_000;
  const yieldFn = o.yieldFn ?? (() => new Promise((r) => setImmediate(r)));
  const sched = db.sched;

  /** names seen writing TTL frames in this process */
  const observed = new Set();
  const kv = () => db.collections.get('kv') ?? db.collection('kv', coreSchemas.kv);
  let persisted = new Set(kv().get(TTL_KEY)?.cols ?? []);

  // 'job' needs the scheduler and the same env as `sched` (the job must join the record's
  // write txn); anywhere else a 'job' collection falls back to 'scan'.
  const modeOf = (col) => {
    const m = col.schema.ttlSweep ?? 'scan';
    if (m === 'job' && (!sched || col.backend !== sched.collection.backend)) return 'scan';
    return m;
  };

  /* ---- hook: runs inside the write txn of every TTL put/patch/incr */
  const prevHook = db.hooks.onExpiring;
  const hook = (col, pk, expiresAt) => {
    if (prevHook) prevHook(col, pk, expiresAt);
    const mode = modeOf(col);
    if (mode === 'job') {
      sched.at(expiresAt, { kind: 'expire', indexed: false, payload: [col.name, Buffer.from(pk.subarray(0, pk.length))] });
    } else if (mode === 'scan' && !observed.has(col.name)) observed.add(col.name);
  };
  db.hooks.onExpiring = hook;

  if (sched) {
    // EXPIRE: delete exactly this record if it is still expired (it may have been refreshed,
    // in which case the refresh queued its own job). Runs inside the deletion commit.
    sched.on('expire', (job, ctx) => {
      const [name, pk] = job.payload;
      const col = db.collections.get(name);
      if (!col) throw new Error(`spbt-db ttl: collection ${name} is not open`); // retried with backoff
      const raw = col.getFrame(pk);
      if (raw !== undefined && raw[0] & HAS_TTL && frameExpiresAt(raw) <= ctx.now) col.delByKey(pk);
    }, { inTxn: true });
    sched.on('expire_range', async () => {
      await sweeper.sweep();
      return { reschedule: clock() + intervalMs };
    });
    if (o.schedule !== false) sched.ensure(clock() + intervalMs, { kind: 'expire_range' });
  }

  /** collections to scan right now */
  function targets() {
    const out = [];
    for (const [name, col] of db.collections) {
      const mode = modeOf(col);
      if (mode !== 'scan') continue;
      if (col.schema.ttl || col.schema.ttlSweep === 'scan' || observed.has(name) || persisted.has(name)) out.push(col);
    }
    return out;
  }

  /** Sweep one collection: bounded steps, at most `batch` deletes per txn. */
  async function sweepCollection(col, now, acc) {
    const be = col.backend;
    const dbi = be.openCollection(col.name, {});
    let after;
    for (;;) {
      const dead = [];
      let scanned = 0, last, full = false;
      for (const { key, value } of be.range(dbi, { start: after, exclusiveStart: !!after, limit: scanBudget })) {
        scanned++;
        last = key;
        if (value[0] & HAS_TTL && frameExpiresAt(value) <= now) {
          dead.push(key);
          if (dead.length >= batch) { full = true; break; }
        }
      }
      acc.scanned += scanned;
      if (dead.length) {
        const n = await runTxnAsync(be, () => {
          let d = 0;
          for (const k of dead) {
            const raw = col.getFrame(k); // re-check under the write lock: it may have been refreshed
            if (raw !== undefined && raw[0] & HAS_TTL && frameExpiresAt(raw) <= now) { col.delByKey(k); d++; }
          }
          return d;
        });
        acc.deleted += n;
        acc.txns++;
        if (dead.length > acc.maxPerTxn) acc.maxPerTxn = dead.length;
      }
      if (!full && scanned < scanBudget) return;
      after = last;
      await yieldFn();
    }
  }

  let running = null;
  const m = { sweeps: 0, scanned: 0, deleted: 0, txns: 0, lastSweepMs: 0, lastDeleted: 0 };

  const sweeper = {
    /**
     * Sweep now. @param {{ now?: number, collections?: string[] }} [opts]
     * @returns {Promise<{ scanned: number, deleted: number, txns: number, maxPerTxn: number, collections: string[] }>}
     */
    sweep(opts = {}) {
      if (running) return running;
      running = (async () => {
        const t0 = Date.now();
        const now = opts.now ?? clock();
        const acc = { scanned: 0, deleted: 0, txns: 0, maxPerTxn: 0, collections: [] };
        try {
          // remember collections seen with TTL frames so a restart still sweeps them
          const fresh = [...observed].filter((n) => !persisted.has(n));
          if (fresh.length) {
            const cols = [...persisted, ...fresh].sort();
            kv().put({ k: TTL_KEY, cols });
            persisted = new Set(cols);
          }
          const list = opts.collections ? opts.collections.map((n) => db.collections.get(n)).filter(Boolean) : targets();
          for (const col of list) {
            acc.collections.push(col.name);
            await sweepCollection(col, now, acc);
          }
        } finally {
          running = null;
        }
        m.sweeps++; m.scanned += acc.scanned; m.deleted += acc.deleted; m.txns += acc.txns;
        m.lastSweepMs = Date.now() - t0; m.lastDeleted = acc.deleted;
        return acc;
      })();
      return running;
    },
    /** names that would be scanned now */
    targets: () => targets().map((c) => c.name),
    stats: () => ({ ...m, observed: [...observed], persisted: [...persisted] }),
    async stop() {
      if (running) await running.catch(() => {});
      if (db.hooks.onExpiring === hook) db.hooks.onExpiring = prevHook;
    },
  };
  return sweeper;
}

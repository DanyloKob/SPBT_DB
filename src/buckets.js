// SPBT_DB time-bucketed collections (design §4.6 mechanism 1, §5.7).
//
//   const elog = db.bucketed('event_log', eventLogSchema, { env: 'cold', retentionDays: 30 });
//   elog.append({ gid, chan, ts, seq, k, content });   // -> event_log_202610
//   elog.query({ where: [gid, chan], from, to });      // merges month cursors in key order
//   elog.dropExpired(now);                             // dropCollection on whole months
//
// Every month is its own collection `${base}_YYYYMM` (UTC), so retention is a DBI drop:
// O(tree depth), all pages back to the freelist at once, instead of millions of deletes.
// Index names are global per env, so each month's indexes are suffixed the same way
// (`elog_by_author_202610`); queries keep using the schema's index name.
//
// The months that exist are recorded in a small `__buckets` DBI in the same env
// (key = base \0 YYYYMM), written in the same txn as the first row of a month, so
// dropExpired() also finds months this process never opened.

import { runTxn } from './collection.js';
import { prefixEnd, tuple } from './keys.js';
import { snowflakeTs } from './schema.js';
import { createAppender } from './coalesce.js';

const DAY = 86_400_000;
const REGISTRY = '__buckets';
const EMPTY = Buffer.alloc(0);
/** daily retention run, 04:17 UTC (§4.6) */
export const DROP_AT_UTC_MS = (4 * 60 + 17) * 60_000;

/** YYYYMM (number) of a ms timestamp, UTC. */
export function monthOf(ts) {
  const d = new Date(ts);
  return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
}
/** First ms of a YYYYMM month (UTC). */
export const monthStart = (ym) => Date.UTC(Math.floor(ym / 100), (ym % 100) - 1, 1);
/** First ms after a YYYYMM month (UTC). */
export const monthEnd = (ym) => Date.UTC(Math.floor(ym / 100), ym % 100, 1);
/** Next occurrence of `msOfDay` (UTC) strictly after `now`. */
export function nextDailyAt(now, msOfDay = DROP_AT_UTC_MS) {
  const t = Math.floor(now / DAY) * DAY + msOfDay;
  return t > now ? t : t + DAY;
}

// Cursor format of collection.query (src/collection.js encodeCursor): base64url of
// [u16be keyLen][key][dup value?]. Merged queries hand the same cursor to every month.
function encodeCursor(k, v) {
  const b = Buffer.allocUnsafe(2 + k.length + (v ? v.length : 0));
  b.writeUInt16BE(k.length, 0);
  b.set(k, 2);
  if (v) b.set(v, 2 + k.length);
  return b.toString('base64url');
}

/** db -> Set of bucketed sets with retention, for the shared bucket_drop job */
const retained = new WeakMap();

/**
 * @typedef {object} BucketOptions
 * @property {'hot'|'cold'} [env]          default schema.env ?? 'cold'
 * @property {number} [retentionDays]      dropExpired() drops months that ended before now - retentionDays
 * @property {string} [tsField='ts']       record field that picks the month (ms epoch)
 * @property {string} [seqField]           if set and missing on a record, a rolling u16 is filled in
 *                                         (default: 'seq' when the primary key has a seq field)
 * @property {() => number} [clock=Date.now]
 * @property {boolean} [schedule=true]     with db.sched and retentionDays: daily bucket_drop job at 04:17 UTC
 */

/**
 * @param {any} db
 * @param {string} base
 * @param {import('./collection.js').CollectionSchema} schema
 * @param {BucketOptions} [o]
 */
export function createBucketed(db, base, schema, o = {}) {
  const env = o.env ?? schema.env ?? 'cold';
  const tsField = o.tsField ?? 'ts';
  const pkT = tuple(schema.key);
  const seqField = o.seqField ?? (pkT.fields.some((f) => f.name === 'seq') ? 'seq' : undefined);
  const clock = o.clock ?? Date.now;
  const retentionDays = o.retentionDays;
  const backend = db.backend(env);
  const reg = backend.openCollection(REGISTRY, {});
  const regPrefix = Buffer.from(`${base}\0`);
  const regKey = (ym) => Buffer.from(`${base}\0${ym}`);
  const write = (fn) => (backend.inTxn && backend.inTxn() ? fn() : runTxn(backend, fn));
  // random start: a restart within the same ms must not reuse (ts, seq) of the previous process
  let seq = Math.floor(Math.random() * 0x10000);
  const tsIdx = pkT.fields.findIndex((f) => f.name === tsField);

  /** @type {Map<number, object>} */
  const schemas = new Map();
  function schemaFor(ym) {
    let s = schemas.get(ym);
    if (!s) {
      const indexes = schema.indexes
        ? Object.fromEntries(Object.entries(schema.indexes).map(([n, spec]) => [`${n}_${ym}`, spec]))
        : undefined;
      s = { ...schema, env, indexes };
      schemas.set(ym, s);
    }
    return s;
  }
  const nameOf = (ym) => `${base}_${ym}`;
  const open = (ym) => db.collection(nameOf(ym), schemaFor(ym));

  /** months recorded in the registry, ascending */
  function months() {
    const out = [];
    for (const { key } of backend.range(reg, { start: regPrefix, end: prefixEnd(regPrefix) })) {
      out.push(Number(key.subarray(regPrefix.length).toString('latin1')));
    }
    return out.sort((a, b) => a - b);
  }

  /** inside a txn: the month's collection, registering the month if new */
  let lastYm = -1, lastCol = null, lastKey = null;
  function bucket(ym) {
    if (ym !== lastYm) {
      // moving on to a newer month: index the old month's lagged tail now, in this txn
      if (lastCol && ym > lastYm && lastCol.flushLagged) lastCol.flushLagged();
      lastYm = ym; lastCol = open(ym); lastKey = regKey(ym);
    }
    if (backend.get(reg, lastKey) === undefined) backend.put(reg, lastKey, EMPTY); // ~0.3 us; survives aborted txns
    return lastCol;
  }

  function prep(rec) {
    const ts = rec[tsField];
    if (typeof ts !== 'number' || !(ts >= 0)) throw new TypeError(`spbt-db bucketed ${base}: record needs a numeric ${tsField}`);
    if (seqField && rec[seqField] === undefined) { rec = { ...rec, [seqField]: seq }; seq = (seq + 1) & 0xffff; }
    return rec;
  }

  function selectMonths(from, to) {
    const lo = from !== undefined ? monthOf(from) : 0;
    const hi = to !== undefined ? monthOf(to - 1) : Infinity;
    return months().filter((ym) => ym >= lo && ym <= hi);
  }

  const ixTuples = Object.fromEntries(Object.entries(schema.indexes ?? {}).map(([n, spec]) => [n, tuple(spec.key)]));
  /**
   * `from`/`to` as key bounds when the queried tuple has tsField right after the `where`
   * fields (event_log: pk `ts seq`, elog_by_chan `gid chan ts seq` with where [gid, chan]):
   * the range then starts and ends exactly at the window and no row is read only to be
   * filtered out. Otherwise the rows are filtered (exact = false).
   */
  function windowed(o) {
    if (o.from === undefined && o.to === undefined) return { q: o, exact: true };
    const t = o.index ? ixTuples[o.index] : pkT;
    const where = o.where ?? o.prefix ?? [];
    const at = t ? t.fields.findIndex((f) => f.name === tsField) : -1;
    if (at < 0 || where.length !== at || o.start || o.end) return { q: o, exact: false };
    const q = { ...o };
    delete q.from; delete q.to;
    if (o.from !== undefined) q.start = [...where, Math.max(0, Math.ceil(o.from))];
    if (o.to !== undefined) q.end = [...where, Math.max(0, Math.ceil(o.to))];
    return { q, exact: true };
  }

  /** k-way merge of the month iterators in key order */
  function* merged(o0) {
    const { q: o, exact } = windowed(o0);
    const ms = selectMonths(o0.from, o0.to);
    if (!ms.length) return;
    const cols = ms.map(open);
    const first = cols[0];
    const ix = o.index ? first.indexes[`${o.index}_${ms[0]}`] : null;
    if (o.index && !ix) throw new Error(`spbt-db bucketed ${base}: no index ${o.index}`);
    const pk = first.pk;
    const desc = !!o.desc;
    const keyOf = (rec) => {
      const p = Buffer.from(pk.encodeRecord(rec));
      if (!ix) return { sk: p, ck: p, cv: null };
      const k = Buffer.from(ix.tuple.encodeRecord(rec));
      return { sk: Buffer.concat([k, p]), ck: k, cv: ix.mode === 'dup' ? p.subarray(ix.shared) : null };
    };
    const inWindow = (rec) => {
      if (exact) return true;
      const ts = rec[tsField];
      return ts === undefined || ((o0.from === undefined || ts >= o0.from) && (o0.to === undefined || ts < o0.to));
    };
    const its = cols.map((c, i) => {
      const bo = { ...o, index: o.index ? `${o.index}_${ms[i]}` : undefined, pageSize: o0.limit !== undefined ? Math.min(256, o0.limit + 1) : 256 };
      delete bo.from; delete bo.to; delete bo.limit;
      return c.iterate(bo);
    });
    const heads = its.map(() => null);
    const advance = (i) => {
      for (;;) {
        const r = its[i].next();
        if (r.done) { heads[i] = null; return; }
        if (!inWindow(r.value)) continue;
        heads[i] = { rec: r.value, ...keyOf(r.value) };
        return;
      }
    };
    try {
      for (let i = 0; i < its.length; i++) advance(i);
      for (;;) {
        let best = -1;
        for (let i = 0; i < heads.length; i++) {
          if (!heads[i]) continue;
          if (best < 0) { best = i; continue; }
          const c = Buffer.compare(heads[i].sk, heads[best].sk);
          if (desc ? c > 0 : c < 0) best = i;
        }
        if (best < 0) return;
        const h = heads[best];
        advance(best);
        yield h;
      }
    } finally {
      for (const it of its) it.return();
    }
  }

  const b = {
    base,
    env,
    nameOf: (ts) => nameOf(monthOf(ts)),
    /** collection for the month of `ts` (opens it; does not register it until a write) */
    collectionFor: (ts) => open(monthOf(ts)),
    /** existing bucket names, oldest first */
    buckets: () => months().map(nameOf),

    /** Route one record by its timestamp. Joins an open txn, else commits its own. */
    append(rec, opts) {
      rec = prep(rec);
      return write(() => bucket(monthOf(rec[tsField])).put(rec, opts));
    },
    /** Many records, ONE txn (may span months; same env, so still atomic). */
    appendMany(recs, opts) {
      write(() => { for (const r0 of recs) { const r = prep(r0); bucket(monthOf(r[tsField])).put(r, opts); } });
      return recs.length;
    },

    /** Point read; the key must contain tsField. */
    get(...k) {
      const i = tsIdx;
      if (i < 0) throw new Error(`spbt-db bucketed ${base}: ${tsField} is not part of the key`);
      const ym = monthOf(Number(k[i]));
      if (backend.get(reg, regKey(ym)) === undefined) return undefined;
      return open(ym).get(...k);
    },

    /**
     * Query across months. Same options as collection.query, plus `from`/`to` (ms on
     * tsField, [from, to)) which pick the months and filter rows. Items come back in key
     * (or index) order across month boundaries; `next` resumes in every month.
     * @returns {{ items: any[], next: string | undefined }}
     */
    query(o = {}) {
      // one month (the common case): the collection's own query - same cursor format, no merge
      const ms = selectMonths(o.from, o.to);
      if (ms.length === 0) return { items: [], next: undefined };
      const { q, exact } = windowed(o);
      if (ms.length === 1 && exact) {
        const one = { ...q, limit: o.limit ?? 1000, index: q.index ? `${q.index}_${ms[0]}` : undefined };
        if (q.index && !open(ms[0]).indexes[one.index]) throw new Error(`spbt-db bucketed ${base}: no index ${q.index}`);
        return open(ms[0]).query(one);
      }
      const limit = o.limit ?? 1000;
      const items = [];
      let last = null, next;
      const it = merged(o);
      for (const h of it) {
        if (items.length === limit) { next = encodeCursor(last.ck, last.cv); break; }
        items.push(h.rec);
        last = h;
      }
      it.return();
      return { items, next };
    },
    /** Lazy, unlimited merged iteration. */
    *iterate(o = {}) { for (const h of merged(o)) yield h.rec; },

    /**
     * Every row of a Discord message, oldest first: the original (k=0, found in the primary key at
     * its snowflake time, so tsField must lead the key) plus edits/deletes from the `elog_by_msg`
     * index of each month since. [] when nothing was logged.
     */
    byMessageId(msgId, index = 'elog_by_msg') {
      if (!ixTuples[index]) throw new Error(`spbt-db bucketed ${base}: no index ${index}`);
      if (tsIdx !== 0) throw new Error(`spbt-db bucketed ${base}: byMessageId needs ${tsField} first in the key`);
      const at = snowflakeTs(msgId), from = monthOf(at), want = String(msgId);
      const out = [], seen = new Set();
      const add = (r) => { const k = `${r[tsField]}/${r.seq}`; if (!seen.has(k)) { seen.add(k); out.push(r); } };
      for (const ym of months()) {
        if (ym < from) continue;
        const col = open(ym);
        if (ym === from) for (const r of col.query({ prefix: [at], limit: 256 }).items) if (String(r.msgId) === want) add(r);
        for (const r of col.query({ index: `${index}_${ym}`, where: [msgId], limit: 256 }).items) add(r);
      }
      return out.sort((a, b) => a[tsField] - b[tsField] || (a.seq ?? 0) - (b.seq ?? 0));
    },

    /** Physical entries across all months. */
    count: () => months().reduce((n, ym) => n + open(ym).count(), 0),

    /**
     * Drop every month that ended before now - retentionDays (whole DBIs, indexes included).
     * @returns {string[]} dropped collection names
     */
    dropExpired(now = clock()) {
      if (!(retentionDays > 0)) throw new Error(`spbt-db bucketed ${base}: no retentionDays`);
      const cutoff = now - retentionDays * DAY;
      const dropped = [];
      for (const ym of months()) {
        if (monthEnd(ym) > cutoff) continue;
        const name = nameOf(ym);
        open(ym);
        // data + indexes + structures + registry entry: one commit (crash-atomic)
        runTxn(backend, () => { db.dropCollection(name); backend.del(reg, regKey(ym)); });
        schemas.delete(ym);
        if (lastYm === ym) { lastYm = -1; lastCol = null; }
        dropped.push(name);
      }
      return dropped;
    },

    /** Coalescing ring buffer in front of appendMany (§7.3 event_log: 5 s / 512 rows / 1 MB). */
    appender(opts = {}) {
      const c = createAppender(backend, (rows) => b.appendMany(rows), { name: base, clock: o.clock, ...opts });
      if (db.coalescers) db.coalescers.add(c);
      return c;
    },
  };

  if (retentionDays > 0 && db.sched && o.schedule !== false) {
    let set = retained.get(db);
    if (!set) {
      set = new Set();
      retained.set(db, set);
      db.sched.on('bucket_drop', (job, ctx) => {
        for (const x of set) x.dropExpired(ctx.now);
        return { reschedule: nextDailyAt(clock()) };
      });
      db.sched.ensure(nextDailyAt(clock()), { kind: 'bucket_drop' });
    }
    set.add(b);
  }
  return b;
}

// SPBT_DB collections (design §3 L1-L4, §4.4): typed primary key, framed values,
// secondary indexes maintained in the same txn, query API, lazy migrations, TTL.
//
// Records are plain objects that contain their key fields:
//   level.put({ gid, uid, xp })      level.get(gid, uid) -> { xp }
// The stored value never repeats the key fields. get() returns the value only
// (the caller already has the key); query()/range() items have key fields merged in.

import { tuple, prefixEnd } from './keys.js';
import { createCodec, frameSchemaId, frameExpiresAt, frameInfo, HAS_TTL, structuresCompatible, packStructures, unpackStructures } from './frame.js';
import { countRange } from './backend.js';

/** @typedef {import('./backend.js').Backend} Backend */
/** @typedef {import('./keys.js').KeyType} KeyType */

/**
 * @typedef {object} IndexSpec
 * @property {string | Array<[string, KeyType]>} key   tuple over record fields, e.g. 'gid:u64 xp:inv32'
 * @property {boolean} [unique]   at most one record per index key; put() throws on conflict
 * @property {(rec: object) => boolean} [filter]  sparse index: only matching records are indexed
 *   (records with a null/undefined index field are never indexed)
 */

/**
 * @typedef {object} CollectionSchema
 * @property {string | Array<[string, KeyType]>} key   primary key tuple, e.g. 'gid:u64 uid:u64'
 * @property {'msgpack'|'varint'|'raw'} [codec='msgpack']
 * @property {Array<string|{name:string,type?:'uint'|'sint'|'bool'}>} [fields]  varint: value fields in order
 *           (append-only: new fields go at the end, old frames read them as 0)
 * @property {string} [rawField='data']  raw: record field holding the bytes
 * @property {boolean | {threshold?: number, level?: number, dictionary?: Buffer}} [compress]  msgpack only
 * @property {number} [schemaId]   current u16 schema version, written into every frame
 * @property {Record<number, (value: any) => any>} [migrate]  migrate[n] upgrades a value from version n to n+1
 * @property {boolean} [mtime]     stamp updatedAt
 * @property {number} [ttl]        default TTL in ms (readers hide expired records immediately)
 * @property {Record<string, IndexSpec>} [indexes]  index DBI name -> spec (names are global per env)
 * @property {'hot'|'cold'} [env='hot']
 * @property {number} [maxSharedStructures]
 * @property {Record<string, Function>} [methods]  extra methods bound to the collection (`this`)
 */

/**
 * @typedef {object} WriteOptions
 * @property {number} [ttl]        ms from now (overrides schema.ttl)
 * @property {number} [expiresAt]  absolute ms; 0 = never expires
 */

/**
 * @typedef {object} QueryOptions
 * @property {string} [index]      query an index instead of the primary key
 * @property {any[]} [where]       equality on the leading fields (of the index, or of the primary key)
 * @property {any[]} [prefix]      alias of `where`
 * @property {any[]} [start]       inclusive lower bound (leading fields, may be partial)
 * @property {any[]} [end]         exclusive upper bound (leading fields, may be partial)
 * @property {number} [limit=1000]
 * @property {boolean} [desc]      descending key order
 * @property {string} [after]      cursor from a previous result's `next`
 * @property {boolean} [covered]   index only: build items from index key + primary key, skip the
 *           primary lookup (no TTL check, only index + key fields are present)
 */

/**
 * Collection-level hooks shared by all collections of a db (extension point for the
 * scheduler/TTL agent). Called inside the write txn.
 * @typedef {object} Hooks
 * @property {(col: Collection, pk: Buffer, expiresAt: number) => void} [onExpiring]
 */

const EMPTY = Buffer.alloc(0);
const DEFAULT_LIMIT = 1000;

/* ------------------------------------------------------------- txn helpers */

// Codecs that persisted new msgpackr shared structures inside a still-open txn.
// If that txn aborts, their in-memory structures are ahead of the store: reset them.
const pendingStructs = new WeakMap();

function markPending(backend, codec) {
  let s = pendingStructs.get(backend);
  if (!s) pendingStructs.set(backend, (s = new Set()));
  s.add(codec);
}
function settle(backend, ok) {
  const s = pendingStructs.get(backend);
  if (!s || !s.size) return;
  if (!ok) for (const c of s) c.reset();
  s.clear();
}

/**
 * Synchronous atomic txn on one backend. Nested calls are savepoints.
 * `{ lazy: true }`: committed on return but not fsynced (backend.txnLazy; falls back to txn).
 * @template T @param {Backend} backend @param {() => T} fn @param {{ lazy?: boolean }} [o] @returns {T}
 */
export function runTxn(backend, fn, o) {
  const outer = !(backend.inTxn && backend.inTxn());
  let r;
  try { r = o && o.lazy && outer && backend.txnLazy ? backend.txnLazy(fn) : backend.txn(fn); } catch (e) { settle(backend, false); throw e; }
  if (outer) settle(backend, true);
  return r;
}

/**
 * Atomic txn whose commit + fsync happen off the main thread (lmdb childTransaction).
 * @template T @param {Backend} backend @param {() => T} fn @returns {Promise<T>}
 */
export function runTxnAsync(backend, fn) {
  if (!backend.txnAsync) return Promise.resolve().then(() => runTxn(backend, fn));
  return backend.txnAsync(fn).then(
    (r) => { settle(backend, true); return r; },
    (e) => { settle(backend, false); throw e; },
  );
}

const write = (backend, fn) => (backend.inTxn && backend.inTxn() ? fn() : runTxn(backend, fn));

/* ----------------------------------------------------------------- helpers */

function copyBuf(b) {
  const c = Buffer.allocUnsafe(b.length);
  c.set(b.subarray(0, b.length));
  return c;
}
/** compare a possibly-volatile buffer (lmdb .length override) with a normal one */
function eqBytes(v, b) {
  const n = v.length;
  if (n !== b.length) return false;
  for (let i = 0; i < n; i++) if (v[i] !== b[i]) return false;
  return true;
}
function cmpBytes(a, b) {
  return Buffer.compare(a.subarray(0, a.length), b.subarray(0, b.length));
}

function encodeCursor(k, v) {
  const b = Buffer.allocUnsafe(2 + k.length + (v ? v.length : 0));
  b.writeUInt16BE(k.length, 0);
  b.set(k, 2);
  if (v) b.set(v.subarray(0, v.length), 2 + k.length); // v may be a volatile lmdb buffer (.length override)
  return b.toString('base64url');
}
function decodeCursor(s) {
  const b = Buffer.from(s, 'base64url');
  const n = b.readUInt16BE(0);
  return [b.subarray(2, 2 + n), b.subarray(2 + n)];
}

/* -------------------------------------------------------------- collection */

/**
 * @typedef {ReturnType<typeof createCollection>} Collection
 */

/**
 * Open (or create) a collection on a backend.
 * @param {{ backend: Backend, name: string, schema: CollectionSchema, hooks?: Hooks }} o
 */
export function createCollection({ backend, name, schema, hooks = {} }) {
  if (!schema || !schema.key) throw new TypeError(`spbt-db: collection ${name} needs schema.key`);
  const pk = tuple(schema.key);
  const pkN = pk.fields.length;
  const kind = schema.codec ?? 'msgpack';
  const rawField = kind === 'raw' ? schema.rawField ?? 'data' : undefined;
  const isKeyField = Object.create(null);
  for (const f of pk.fields) isKeyField[f.name] = true;

  const dbi = backend.openCollection(name, {});
  const metaDbi = backend.openCollection('__meta', {});
  const structKey = Buffer.from(`s:${name}`);

  /** @type {import('./frame.js').FrameCodec} */
  let codec;
  const structures = kind === 'msgpack' ? {
    load() {
      const b = backend.get(metaDbi, structKey);
      return b === undefined ? undefined : unpackStructures(b.subarray(0, b.length));
    },
    save(structs, isCompatible) {
      return write(backend, () => {
        if (!structuresCompatible(this.load(), isCompatible)) return false;
        backend.put(metaDbi, structKey, packStructures(structs));
        if (backend.inTxn && backend.inTxn()) markPending(backend, codec);
        return true;
      });
    },
  } : undefined;
  codec = createCodec({
    codec: kind,
    fields: schema.fields,
    rawField,
    compress: schema.compress,
    schemaId: schema.schemaId,
    mtime: schema.mtime,
    ttl: schema.ttl,
    structures,
    maxSharedStructures: schema.maxSharedStructures,
  });

  const curSid = schema.schemaId ?? 0;
  const migrate = schema.migrate;
  function upgrade(v, sid) {
    if (sid > curSid) throw new Error(`spbt-db: ${name} record has schemaId ${sid} > current ${curSid} (written by newer code)`);
    while (sid < curSid) {
      const f = migrate && migrate[sid];
      if (!f) throw new Error(`spbt-db: ${name} has no migration from schemaId ${sid}`);
      v = f(v);
      sid++;
    }
    return v;
  }
  /** decode a frame, ignoring TTL, applying migrations; reads sid before decode (buffer may be volatile) */
  function decodeFull(raw) {
    const sid = frameSchemaId(raw);
    const v = codec.decodeAny(raw);
    return sid === curSid ? v : upgrade(v, sid);
  }
  const live = (raw, now) => !(raw[0] & HAS_TTL) || frameExpiresAt(raw) > now;

  // value without key fields (msgpack); varint/raw codecs read only their declared field
  function valueOf(rec) {
    if (kind !== 'msgpack') return rec;
    const v = {};
    for (const f in rec) if (isKeyField[f] !== true && rec[f] !== undefined) v[f] = rec[f];
    return v;
  }

  // reusable key buffers for fixed-size keys (zero allocation on get/has/del)
  const fixed = pk.size > 0;
  const pkR = fixed ? Buffer.allocUnsafeSlow(pk.size) : null;
  const pkW = fixed ? Buffer.allocUnsafeSlow(pk.size) : null;
  const pkQ = fixed ? Buffer.allocUnsafeSlow(pk.size) : null;
  const keyR = (vals) => (fixed ? pk.encodeInto(vals, pkR) : pk.encode(vals));
  const keyW = (vals) => (fixed ? pk.encodeInto(vals, pkW) : pk.encode(vals));
  // get/has hot path: key fields straight from the call's arguments into pkR (no rest array)
  const encArgs = pk.encodeArgs;
  const keyOfArgs = fixed && encArgs && pkN <= 4
    ? [null, (a) => encArgs(pkR, a), (a, b) => encArgs(pkR, a, b), (a, b, c) => encArgs(pkR, a, b, c), (a, b, c, d) => encArgs(pkR, a, b, c, d)][pkN]
    : null;
  /** primary key buffer for get-like calls: (argc, a, b, c, d) for keys of <= 4 fields */
  function readKey(argc, a, b, c, d) {
    if (keyOfArgs && argc === pkN) return keyOfArgs(a, b, c, d);
    return keyR([a, b, c, d].slice(0, argc));
  }
  const wide = pkN > 4; // more than 4 key fields: the rest-parameter path
  function liveValue(raw) {
    if (raw === undefined) return undefined;
    if (raw[0] & HAS_TTL && frameExpiresAt(raw) <= Date.now()) return undefined;
    const sid = frameSchemaId(raw);
    const v = codec.decodeAny(raw);
    return sid === curSid ? v : upgrade(v, sid);
  }

  /* ---- indexes */
  if (schema.indexes && kind === 'raw') throw new TypeError(`spbt-db: ${name}: indexes on a raw collection are not supported`);
  const ixs = Object.entries(schema.indexes ?? {}).map(([ixName, spec]) => {
    const t = tuple(spec.key);
    // index key ends with the full fixed-size primary key -> unique by construction, empty value
    let suffix = fixed && !spec.unique && t.fields.length >= pkN;
    for (let i = 0; suffix && i < pkN; i++) {
      const a = t.fields[t.fields.length - pkN + i], b = pk.fields[i];
      suffix = a.name === b.name && a.type === b.type;
    }
    // leading fields shared with the primary key are not repeated in the entry value
    let shared = 0, sharedN = 0;
    for (let i = 0; !suffix && i < Math.min(t.fields.length, pkN); i++) {
      const a = t.fields[i], b = pk.fields[i];
      if (a.name !== b.name || a.type !== b.type || a.size < 0) break;
      shared += a.size;
      sharedN++;
    }
    const mode = suffix ? 'suffix' : spec.unique ? 'unique' : 'dup';
    const lag = spec.lag ?? 0;
    if (lag && (!(Number.isInteger(lag) && lag > 0) || mode === 'unique')) throw new TypeError(`spbt-db: ${name}: index ${ixName}: lag must be a positive integer and the index not unique`);
    return {
      name: ixName,
      tuple: t,
      mode,
      shared,
      sharedN,
      filter: spec.filter,
      dbi: backend.openCollection(ixName, { dupSort: mode === 'dup' }),
      bufO: t.size > 0 ? Buffer.allocUnsafeSlow(t.size) : null,
      bufN: t.size > 0 ? Buffer.allocUnsafeSlow(t.size) : null,
      // lagged index (see "lagged indexes" below): rows with pk > watermark are not in the DBI yet
      lag,
      wKey: lag ? Buffer.from(`w:${ixName}`) : null,
      eKey: lag ? Buffer.from(`e:${ixName}`) : null, // epoch: bumped by every non-append write to a tail row
      w: undefined,      // cached watermark: undefined = not read, null = nothing indexed yet
      tail: null,        // read cache: { w, last, entries, list } of the committed rows > watermark
      pending: 0,        // rows written past the watermark since the last catch-up (approximate after a restart)
    };
  });
  const ixByName = Object.fromEntries(ixs.map((ix) => [ix.name, ix]));
  const lagged = ixs.filter((ix) => ix.lag);

  function ixKey(ix, rec, buf) {
    if (ix.filter && !ix.filter(rec)) return undefined;
    const k = ix.tuple.encodeRecord(rec, buf);
    return k === undefined || buf ? k : copyBuf(k); // variable-size keys live in shared scratch: copy
  }
  const entryVal = (ix, key) => (ix.mode === 'suffix' ? EMPTY : ix.shared ? key.subarray(ix.shared) : key);
  function pkOfEntry(ix, k, v) {
    if (ix.mode === 'suffix') return k.subarray(k.length - pk.size);
    if (!ix.shared) return v;
    const out = fixed ? pkQ : Buffer.allocUnsafe(ix.shared + v.length);
    out.set(k.subarray(0, ix.shared));
    out.set(v.subarray(0, v.length), ix.shared); // v may be volatile (.length override)
    return out;
  }

  // old record with key fields filled in, for computing old index keys
  function oldRecord(raw, keySrc) {
    const old = decodeFull(raw);
    for (let i = 0; i < pkN; i++) old[pk.fields[i].name] = keySrc[i];
    return old;
  }

  /* ---- lagged indexes
   * An index with `lag: n` is not written in every txn. Invariant: its DBI holds exactly the
   * entries of the rows whose pk <= the watermark W (__meta `w:<index>`, written in the same
   * txn as the entries it covers). The rows > W are the "tail": once n rows are past W, ONE
   * catch-up writes their entries into the DBI, sorted, in the same txn as the write that
   * crossed n, and moves W to the last pk. Reads merge the DBI range with the tail's entries.
   * With a time-ordered primary key (event_log `ts seq`) the data stays a pure append while
   * the per-channel index costs ~(active channels x 1 page) per n rows instead of per commit.
   * Rows written at or below W (late, out of order) are indexed at once, like a normal index.
   *
   * The tail is a sorted RAM list built from the committed rows > W and cached per read
   * snapshot (stamp: W, epoch, last pk, row count); new appends extend it incrementally (decode
   * only the new rows). Writes do not touch it, so it never shows uncommitted rows. Every write
   * to the tail that is not an append (overwrite, delete, late row) bumps the epoch
   * (__meta `e:<index>`) in its txn, which invalidates every reader's cache, in any process. */

  const cmpEntry = (a, b) => Buffer.compare(a.k, b.k) || Buffer.compare(a.v, b.v);
  /** first index i with list[i] >= e (or, with byKey, list[i].k >= e.k) */
  function lowerEntry(list, e, byKey) {
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if ((byKey ? Buffer.compare(list[m].k, e.k) : cmpEntry(list[m], e)) < 0) lo = m + 1; else hi = m;
    }
    return lo;
  }
  function lastKey(d) {
    for (const { key } of backend.range(d, { reverse: true, limit: 1 })) return copyBuf(key);
    return null;
  }
  const readW = (ix) => { const b = backend.get(metaDbi, ix.wKey); return b === undefined ? null : copyBuf(b); };
  function watermark(ix) {
    if (ix.w === undefined) ix.w = readW(ix);
    return ix.w;
  }
  const sameKey = (a, b) => (a === null ? b === null : b !== null && eqBytes(a, b));
  // a catch-up inside a txn that aborts leaves ix.w ahead of the store: forget it
  const lagReset = { reset() { for (const ix of lagged) { ix.w = undefined; ix.tail = null; } } };
  /** sorted entries of the rows with pk > `after` (null = all), in the current view */
  function entriesAfter(ix, after) {
    const out = [];
    let rows = 0;
    for (const { key, value } of backend.range(dbi, after ? { start: after, exclusiveStart: true } : {})) {
      rows++;
      const k = ixKey(ix, pk.decodeInto(key, decodeFull(value)), undefined);
      if (k) out.push({ k, v: copyBuf(entryVal(ix, key)) });
    }
    out.rows = rows;
    return out;
  }
  const readE = (ix) => { const b = backend.get(metaDbi, ix.eKey); return b === undefined ? 0 : ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0; };
  function bumpEpoch(ix) {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE((readE(ix) + 1) >>> 0);
    backend.put(metaDbi, ix.eKey, b);
  }
  /** the tail for a read, cached per committed snapshot */
  function tailFor(ix) {
    if (backend.inTxn && backend.inTxn()) return entriesAfter(ix, watermark(ix)).sort(cmpEntry); // sees the open txn: never cached
    // snapshot stamp: watermark, epoch (non-append writes), last pk, row count
    const w = readW(ix), e = readE(ix), last = lastKey(dbi), entries = backend.stat(dbi).entries;
    let t = ix.tail;
    if (t && t.e === e && sameKey(t.w, w) && sameKey(t.last, last) && t.entries === entries) return t.list;
    if (t && t.e === e && sameKey(t.w, w) && t.last && last && Buffer.compare(last, t.last) > 0) {
      const add = entriesAfter(ix, t.last); // only appends since the cached snapshot? (the row count tells)
      if (t.entries + add.rows === entries) {
        for (const x of add.sort(cmpEntry)) t.list.splice(lowerEntry(t.list, x), 0, x);
        t.last = last; t.entries = entries;
        return t.list;
      }
    }
    t = ix.tail = { w, e, last, entries, list: entriesAfter(ix, w).sort(cmpEntry) };
    ix.w = w;
    ix.pending = Math.max(ix.pending, t.list.length);
    return t.list;
  }
  /**
   * Write the tails of lagged indexes into their DBIs and move each W to the last pk (inside a
   * write txn). All of them in ONE pass over the rows: each row is decoded once. A read cache
   * that still describes this txn's view is reused, so only the rows after it are decoded.
   */
  function catchUp(list) {
    const entries = backend.stat(dbi).entries, out = new Map();
    const fresh = [];
    for (const ix of list) {
      const t = ix.tail, w = watermark(ix);
      if (t && t.e === readE(ix) && sameKey(t.w, w)) out.set(ix, { from: t.last ?? w, base: t.list, rows: t.entries });
      else fresh.push(ix);
    }
    // one scan from the lowest starting point; each index takes the rows after its own start
    const starts = [...out.values()].map((x) => x.from).concat(fresh.map((ix) => ix.w));
    const from = starts.some((b) => b === null) ? null : starts.reduce((a, b) => (Buffer.compare(a, b) <= 0 ? a : b));
    const acc = list.map(() => []), counts = list.map(() => 0);
    const startOf = list.map((ix) => (out.has(ix) ? out.get(ix).from : ix.w));
    for (const { key, value } of backend.range(dbi, from ? { start: from, exclusiveStart: true } : {})) {
      let rec = null;
      for (let i = 0; i < list.length; i++) {
        if (startOf[i] && Buffer.compare(key, startOf[i]) <= 0) continue;
        counts[i]++;
        rec ??= pk.decodeInto(key, decodeFull(value));
        const k = ixKey(list[i], rec, undefined);
        if (k) acc[i].push({ k, v: copyBuf(entryVal(list[i], key)) });
      }
    }
    const last = lastKey(dbi);
    for (let i = 0; i < list.length; i++) {
      const ix = list[i], o = out.get(ix);
      // a cached tail is only usable when it plus the rows after it account for every row
      let all = o && o.rows + counts[i] === entries ? o.base.concat(acc[i]) : null;
      if (!all) all = o ? entriesAfter(ix, watermark(ix)) : acc[i];
      all.sort(cmpEntry);
      for (const e of all) backend.put(ix.dbi, e.k, e.v);
      if (last && (!ix.w || Buffer.compare(last, ix.w) > 0)) { backend.put(metaDbi, ix.wKey, last); ix.w = last; }
      ix.pending = 0;
      ix.tail = null;
    }
    markPending(backend, lagReset);
  }
  /** a write of row `key` (old -> new record) for lagged index ix; false = maintain it at once */
  // `late`: a new row whose pk is below the current last pk (not an append)
  function lagWrite(ix, key, oldRec, late) {
    if (watermark(ix) !== null && Buffer.compare(key, ix.w) <= 0) return false;
    if (!oldRec) ix.pending++;
    if (oldRec || late) { bumpEpoch(ix); ix.tail = null; } // every reader's cached tail is stale now
    return true;
  }
  const isLate = (key) => { const last = lagged.length ? lastKey(dbi) : null; return !!last && Buffer.compare(key, last) < 0; };

  /** core write: key must be a stable buffer for the duration of the call */
  function writeFrame(key, rec, frame) {
    if (!ixs.length && !hooks.onExpiring) { backend.put(dbi, key, frame); return; }
    const newKeys = ixs.length ? ixs.map((ix) => ixKey(ix, rec, ix.bufN)) : null;
    write(backend, () => {
      if (ixs.length) {
        for (let i = 0; i < ixs.length; i++) {
          const ix = ixs[i], nk = newKeys[i];
          if (ix.mode !== 'unique' || !nk) continue;
          const cur = backend.get(ix.dbi, nk);
          if (cur !== undefined && !eqBytes(cur, entryVal(ix, key))) throw new Error(`spbt-db: ${name}: unique index ${ix.name} violated`);
        }
        const raw = backend.get(dbi, key);
        const old = raw === undefined ? undefined : oldRecord(raw, pk.fields.map((f) => rec[f.name]));
        const late = !old && isLate(key);
        for (let i = 0; i < ixs.length; i++) {
          const ix = ixs[i], nk = newKeys[i];
          if (ix.lag && lagWrite(ix, key, old, late)) continue;
          const ok = old && ixKey(ix, old, ix.bufO);
          const same = ok && nk && ok.equals(nk);
          if (ok && !same) backend.del(ix.dbi, ok, ix.mode === 'dup' ? entryVal(ix, key) : undefined);
          if (nk && !same) backend.put(ix.dbi, nk, entryVal(ix, key));
        }
      }
      backend.put(dbi, key, frame);
      if (hooks.onExpiring && frame[0] & HAS_TTL) hooks.onExpiring(col, key, frameExpiresAt(frame));
      if (lagged.length && lagged.some((ix) => ix.pending >= ix.lag)) catchUp(lagged); // all of them, one pass
    });
  }

  function removeKey(key, keyVals) {
    return write(backend, () => {
      if (ixs.length) {
        const raw = backend.get(dbi, key);
        if (raw === undefined) return false;
        const old = oldRecord(raw, keyVals);
        for (const ix of ixs) {
          if (ix.lag && lagWrite(ix, key, old, false)) continue;
          const ok = ixKey(ix, old, ix.bufO);
          if (ok) backend.del(ix.dbi, ok, ix.mode === 'dup' ? entryVal(ix, key) : undefined);
        }
      }
      return backend.del(dbi, key);
    });
  }

  /** index entries in a key range: the DBI, plus a lagged index's tail */
  function countIx(ix, ro) {
    let n = countRange(backend, ix.dbi, ro);
    if (ix.lag) { const list = tailFor(ix); const [a, b] = tailWindow(list, ro); n += b - a; }
    return n;
  }

  /* ---- scanning */

  /** [from, to) window of a sorted tail list for backend range options `ro` (ascending positions) */
  function tailWindow(list, ro) {
    const at = (k, after) => { // first i with list[i].k > k (after) or >= k
      let lo = 0, hi = list.length;
      while (lo < hi) { const m = (lo + hi) >>> 1; const c = Buffer.compare(list[m].k, k); if (c < 0 || (after && c === 0)) lo = m + 1; else hi = m; }
      return lo;
    };
    if (!ro.reverse) return [ro.start ? at(ro.start, !!ro.exclusiveStart) : 0, ro.end ? at(ro.end, !!ro.inclusiveEnd) : list.length];
    return [ro.end ? at(ro.end, !ro.inclusiveEnd) : 0, ro.start ? at(ro.start, !ro.exclusiveStart) : list.length];
  }

  /**
   * The read path of query/range/iterate. Calls fn(rec, key, value) for each live item in
   * order and stops when fn returns false. `key` is stable; `value` (the index entry value, or
   * the primary frame) is VOLATILE. No per-entry allocation besides the record itself: values
   * come straight from lmdb's reusable buffer (backend.scan) and are decoded in place.
   */
  function scanEach(o, fn) {
    const ix = o.index ? ixByName[o.index] : null;
    if (o.index && !ix) throw new Error(`spbt-db: ${name} has no index ${o.index}`);
    if (o.covered && !ix) throw new Error('spbt-db: covered queries need an index');
    const t = ix ? ix.tuple : pk;
    const d = ix ? ix.dbi : dbi;
    const pre = o.where ?? o.prefix;
    let lo, hi;
    let preKey;
    if (pre && pre.length) { lo = preKey = t.encode(pre); hi = prefixEnd(lo); }
    if (o.start) lo = t.encode(o.start);
    if (o.end) hi = t.encode(o.end);
    const desc = !!o.desc;
    /** @type {import('./backend.js').RangeOpts} */
    const ro = desc ? { start: hi, end: lo, reverse: true, exclusiveStart: !!hi, inclusiveEnd: !!lo } : { start: lo, end: hi };
    let skipK = null, skipV = null;
    if (o.after) {
      const [ak, av] = decodeCursor(o.after);
      ro.start = ak;
      if (ix && ix.mode === 'dup') { ro.exclusiveStart = false; skipK = ak; skipV = av; } else ro.exclusiveStart = true;
    }
    // fields pinned by `where` are decoded ONCE (from lo) and shared by every item: no per-row
    // BigInt for e.g. gid/chan of a channel range
    // (also with start/end, as long as both stay inside the where-prefix, e.g. a time window of a channel)
    const inPre = (b) => !b || (b.length >= preKey.length && eqBytes(b.subarray(0, preKey.length), preKey));
    const fixedN = preKey && (!o.start || inPre(lo)) && (!o.end || inPre(hi)) ? pre.length : 0;
    const fixedNames = fixedN ? t.fields.slice(0, fixedN).map((f) => f.name) : null;
    const fixedVals = fixedN ? ((kv) => fixedNames.map((n) => kv[n]))(t.decodeInto(preKey, {}, 0, 0, fixedN)) : null;
    const pkSkip = !ix ? fixedN : ix.mode === 'suffix' ? 0 : Math.min(ix.sharedN, fixedN); // leading pk fields among them
    const pin = (rec, n) => { for (let j = 0; j < n; j++) rec[fixedNames[j]] = fixedVals[j]; return rec; };
    const now = Date.now();
    const covered = !!o.covered;
    const copyPk = ix && ix.mode !== 'suffix' && !ix.shared && !covered; // the pk IS the volatile value: copy before get()
    let stopped = false;
    function step(key, value) {
      if (skipK) {
        if (eqBytes(key, skipK)) {
          const c = cmpBytes(value, skipV);
          if (desc ? c >= 0 : c <= 0) return true;
        }
        skipK = null;
      }
      let rec;
      if (!ix) {
        if (!live(value, now)) return true;
        rec = pk.decodeInto(key, pin(decodeFull(value), fixedN), 0, fixedN);
      } else {
        const p = copyPk ? copyBuf(value) : pkOfEntry(ix, key, value);
        if (covered) {
          rec = pk.decodeInto(p, ix.tuple.decodeInto(key, pin({}, fixedN), 0, fixedN), 0, pkSkip);
        } else {
          const raw = backend.get(dbi, p); // overwrites the volatile `value`
          if (raw === undefined || !live(raw, now)) return true;
          rec = pk.decodeInto(p, pin(decodeFull(raw), pkSkip), 0, pkSkip);
          if (ix.mode === 'dup') value = ix.shared ? p.subarray(ix.shared) : p; // the entry value, from our copy
        }
      }
      if (fn(rec, key, value) === false) { stopped = true; return false; }
      return true;
    }
    const each = backend.scan
      ? (cb) => backend.scan(d, ro, cb)
      : (cb) => { for (const e of backend.range(d, ro)) if (cb(e.key, e.value) === false) break; };
    if (!ix || !ix.lag) { each(step); return; }
    // lagged index: merge the DBI range with the RAM tail (both in (key, value) order)
    const list = tailFor(ix);
    const [a, b] = tailWindow(list, ro);
    let i = desc ? b - 1 : a;
    const more = () => (desc ? i >= a : i < b);
    const dupCmp = ix.mode === 'dup';
    each((key, value) => {
      if (more()) value = copyBuf(value); // a tail item's get() would overwrite the volatile value
      while (more()) {
        const e = list[i];
        let c = Buffer.compare(e.k, key);
        if (c === 0 && dupCmp) c = cmpBytes(e.v, value);
        if (desc ? c <= 0 : c >= 0) break; // the DBI entry comes first
        i += desc ? -1 : 1;
        if (!step(e.k, e.v)) return false;
      }
      return step(key, value);
    });
    while (!stopped && more()) { const e = list[i]; i += desc ? -1 : 1; step(e.k, e.v); }
  }

  /* ---- public API */

  const col = {
    name,
    schema,
    backend,
    /** primary key tuple codec */
    pk,
    /** frame codec (encode/decode/info) */
    codec,
    /** index name -> { tuple, mode: 'dup'|'unique'|'suffix', shared } */
    indexes: ixByName,

    /** @returns {any | undefined} value (without key fields) or undefined if absent/expired */
    get: wide ? (...k) => liveValue(backend.get(dbi, keyR(k))) : function get(a, b, c, d) {
      return liveValue(backend.get(dbi, readKey(arguments.length, a, b, c, d)));
    },

    /** @returns {{ value: any, schemaId: number, updatedAt: number, expiresAt: number } | undefined} */
    getMeta(...k) {
      const raw = backend.get(dbi, keyR(k));
      if (raw === undefined || !live(raw, Date.now())) return undefined;
      const { schemaId, updatedAt, expiresAt } = frameInfo(raw);
      return { value: decodeFull(raw), schemaId, updatedAt, expiresAt };
    },

    /** raw codec: zero-copy view of the payload, valid until the next backend call */
    getView(...k) {
      const raw = backend.get(dbi, keyR(k));
      if (raw === undefined || !live(raw, Date.now())) return undefined;
      return codec.payloadView(raw);
    },

    has(...k) {
      const raw = backend.get(dbi, wide || k.length !== pkN || !keyOfArgs ? keyR(k) : keyOfArgs(k[0], k[1], k[2], k[3]));
      return raw !== undefined && live(raw, Date.now());
    },

    /** @param {object} rec record including key fields @param {WriteOptions} [o] */
    put(rec, o) {
      const kb = pk.encodeRecord(rec, pkW);
      if (kb === undefined) throw new TypeError(`spbt-db: ${name}.put: record lacks key field(s) ${pk.fields.map((f) => f.name)}`);
      const key = fixed ? kb : copyBuf(kb);
      writeFrame(key, rec, codec.encode(valueOf(rec), o));
    },

    /**
     * Shallow-merge `partial` into the current value (upsert). Keeps the current
     * expiresAt unless `o` sets ttl/expiresAt. Usage: patch(...key, partial, o?)
     * @returns {any} the new value
     */
    patch(...args) {
      const k = args.slice(0, pkN), partial = args[pkN], o = args[pkN + 1];
      const key = fixed ? pk.encodeInto(k, pkW) : pk.encode(k);
      return write(backend, () => {
        const raw = backend.get(dbi, key);
        const isLive = raw !== undefined && live(raw, Date.now());
        // header first: decoding may load structures and reuse lmdb's volatile buffer
        const keep = isLive && !o && raw[0] & HAS_TTL ? { expiresAt: frameExpiresAt(raw) } : o;
        const cur = isLive ? decodeFull(raw) : undefined;
        const next = Object.assign({}, cur, partial);
        for (let i = 0; i < pkN; i++) next[pk.fields[i].name] = k[i];
        writeFrame(key, next, codec.encode(valueOf(next), keep));
        for (let i = 0; i < pkN; i++) delete next[pk.fields[i].name];
        return next;
      });
    },

    /**
     * Atomic read-modify-write of one numeric field (upsert, missing = 0).
     * Atomic because LMDB has a single writer: the read happens under the write lock.
     * Usage: incr(...key, field, delta = 1, o?) @returns {number} new value
     */
    incr(...args) {
      const k = args.slice(0, pkN), field = args[pkN], delta = args[pkN + 1] ?? 1, o = args[pkN + 2];
      const key = fixed ? pk.encodeInto(k, pkW) : pk.encode(k);
      return write(backend, () => {
        const raw = backend.get(dbi, key);
        const isLive = raw !== undefined && live(raw, Date.now());
        const keep = isLive && !o && raw[0] & HAS_TTL ? { expiresAt: frameExpiresAt(raw) } : o; // expired: fresh TTL
        const cur = isLive ? decodeFull(raw) : {};
        const n = (cur[field] ?? 0) + delta;
        cur[field] = n;
        for (let i = 0; i < pkN; i++) cur[pk.fields[i].name] = k[i];
        writeFrame(key, cur, codec.encode(valueOf(cur), keep));
        return n;
      });
    },

    /** @returns {boolean} true if a record was removed */
    del(...k) {
      const key = fixed ? pk.encodeInto(k, pkW) : pk.encode(k);
      return removeKey(key, k);
    },

    /** Physical entry count (fast; includes expired-but-unswept records). */
    count(...prefix) {
      if (!prefix.length) return backend.stat(dbi).entries;
      const lo = pk.encode(prefix);
      return countRange(backend, dbi, { start: lo, end: prefixEnd(lo) });
    },

    /** Index entries whose key starts with `where` (physical, O(log n + k) without decoding). */
    countIndex(index, ...where) {
      const ix = ixByName[index];
      if (!ix) throw new Error(`spbt-db: ${name} has no index ${index}`);
      if (!where.length) return backend.stat(ix.dbi).entries + (ix.lag ? tailFor(ix).length : 0);
      const lo = ix.tuple.encode(where);
      return countIx(ix, { start: lo, end: prefixEnd(lo) });
    },

    /** Index entries in [start, end) (leading-field tuples, either may be omitted). */
    countIndexRange(index, start, end) {
      const ix = ixByName[index];
      if (!ix) throw new Error(`spbt-db: ${name} has no index ${index}`);
      return countIx(ix, { start: start && ix.tuple.encode(start), end: end && ix.tuple.encode(end) });
    },

    /** Live count: scans and skips expired records. */
    countLive(...prefix) {
      let n = 0;
      const now = Date.now();
      const lo = prefix.length ? pk.encode(prefix) : undefined;
      for (const { value } of backend.range(dbi, { start: lo, end: lo && prefixEnd(lo) })) if (live(value, now)) n++;
      return n;
    },

    /**
     * @param {QueryOptions} [o]
     * @returns {{ items: any[], next: string | undefined }}
     */
    query(o = {}) {
      const limit = o.limit ?? DEFAULT_LIMIT;
      const items = [];
      if (!(limit > 0)) return { items, next: undefined };
      const dup = !!o.index && ixByName[o.index]?.mode === 'dup';
      let next, pend;
      scanEach(o, (rec, key, value) => {
        if (items.length === limit) { next = pend; return false; }
        items.push(rec);
        if (items.length === limit) pend = encodeCursor(key, dup ? value : null); // value is volatile: encode now
        return true;
      });
      return { items, next };
    },

    /** query(...).items */
    range(o = {}) { return col.query(o).items; },

    /** Records whose primary key starts with the given leading values. */
    prefix(...vals) { return col.query({ prefix: vals }).items; },

    /**
     * Lazy, unlimited iteration (same options as query, `limit` ignored): pages of
     * `o.pageSize` (256) items through query() and its cursor, so writes between items are safe.
     */
    *iterate(o = {}) {
      const page = { ...o, limit: o.pageSize ?? 256 };
      for (;;) {
        const { items, next } = col.query(page);
        yield* items;
        if (!next) return;
        page.after = next;
      }
    },

    /* ---- key-level access for other layers (scheduler, TTL sweeper, migrations) */

    /** Encoded primary key (stable copy). */
    keyOf: (...k) => pk.encode(k),
    /** Key fields of an encoded primary key. */
    decodeKey: (buf) => pk.decodeInto(buf, {}),
    /** Raw frame by encoded key (VOLATILE buffer, TTL not applied). */
    getFrame: (buf) => backend.get(dbi, buf),
    /** Delete by encoded key, maintaining indexes. */
    delByKey(buf) {
      const key = copyBuf(buf);
      const kv = pk.decode(key);
      return removeKey(key, kv);
    },

    /** Write the RAM tail of every lagged index into its DBI now (joins an open txn). */
    flushLagged() {
      if (lagged.length) write(backend, () => catchUp(lagged));
    },

    /** Rebuild one or all indexes from the primary data (batched txns). */
    reindex(only, batch = 1000) {
      for (const ix of ixs) {
        if (only && ix.name !== only) continue;
        for (;;) { // clear in bounded batches - never materialise a whole DBI
          const page = [...backend.range(ix.dbi, { limit: batch })];
          if (!page.length) break;
          write(backend, () => { for (const { key, value } of page) backend.del(ix.dbi, key, ix.mode === 'dup' ? value : undefined); });
        }
        let after;
        for (;;) {
          const page = [];
          for (const { key, value } of backend.range(dbi, { start: after, exclusiveStart: !!after, limit: batch })) page.push([key, value]);
          if (!page.length) break;
          write(backend, () => {
            for (const [key, value] of page) {
              const rec = pk.decodeInto(key, decodeFull(value));
              const nk = ixKey(ix, rec, ix.bufN);
              if (nk) backend.put(ix.dbi, nk, entryVal(ix, key));
            }
          });
          after = page[page.length - 1][0];
        }
        if (ix.lag) { // every row is in the DBI now: the watermark is the last pk
          write(backend, () => { const last = lastKey(dbi); if (last) backend.put(metaDbi, ix.wKey, last); else backend.del(metaDbi, ix.wKey); });
          ix.w = undefined; ix.tail = null; ix.pending = 0;
        }
      }
    },

    /** Entries/pages for the data DBI and each index DBI. */
    stat() {
      // plain values: the lmdb backend computes freePages lazily, which must not outlive the env
      const plain = (st) => ({ entries: st.entries, pages: st.pages, freePages: st.freePages });
      const out = { [name]: plain(backend.stat(dbi)) };
      for (const ix of ixs) out[ix.name] = plain(backend.stat(ix.dbi));
      return out;
    },

    /**
     * Drop data, indexes and shared structures (time buckets) in ONE write txn: a crash
     * leaves either the whole collection or none of it. Joins the caller's txn (not a
     * savepoint), so e.g. a bucket registry entry can go in the same commit. The collection
     * object is dead afterwards; open the name again for a fresh, empty one.
     */
    drop() {
      if (!backend.drop) throw new Error('spbt-db: backend does not support drop');
      write(backend, () => {
        for (const ix of ixs) backend.drop(ix.dbi);
        backend.drop(dbi);
        backend.del(metaDbi, structKey);
        for (const ix of lagged) { backend.del(metaDbi, ix.wKey); ix.w = undefined; ix.tail = null; ix.pending = 0; }
      });
      codec.reset();
    },
  };
  if (schema.methods) for (const [m, fn] of Object.entries(schema.methods)) col[m] = fn.bind(col);
  return col;
}

// In-memory Backend: sorted arrays + binary search, undo-log transactions.
// Used by unit tests and by anyone who needs SPBT_DB semantics without disk.
// Matches backend-lmdb.js on everything the conformance test checks
// (ordering, dupSort, range edge cases, txn rollback/savepoints, snapshot iteration).

/** @typedef {import('./backend.js').Backend} Backend */

const cmp = Buffer.compare;

function copy(b) {
  const c = Buffer.allocUnsafe(b.length);
  c.set(b);
  return c;
}
function asBuf(u8) {
  return Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

/**
 * @returns {Backend & { kind: 'memory' }}
 */
export function createMemoryBackend() {
  /** @type {Map<string, any>} */
  const dbis = new Map();
  let depth = 0;
  /** undo log: [d, key, val|undefined, op] tuples flattened (op: see rollbackTo) */
  let log = [];

  // dbi state: keys[] / vals[] sorted by (key, val) for dupSort, by key otherwise.
  // `shared` is set when an iterator holds the arrays: the next write copies them
  // first (copy-on-write), which gives iterators snapshot semantics like lmdb.
  function own(d) {
    if (d.shared) { d.keys = d.keys.slice(); d.vals = d.vals.slice(); d.shared = false; }
  }

  // first index i with (keys[i], vals[i]) >= (k, v); v undefined = lowest value of k
  function lowerBound(d, k, v) {
    const { keys, vals } = d;
    let lo = 0, hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      let c = cmp(keys[mid], k);
      if (c === 0 && v !== undefined && d.dup) c = cmp(vals[mid], v);
      if (c < 0) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  // first index i with keys[i] > k
  function upperBoundKey(d, k) {
    const { keys } = d;
    let lo = 0, hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cmp(keys[mid], k) <= 0) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function rawPut(d, k, v) {
    const i = lowerBound(d, k, d.dup ? v : undefined);
    const hit = i < d.keys.length && cmp(d.keys[i], k) === 0 && (!d.dup || cmp(d.vals[i], v) === 0);
    if (hit && d.dup) return;
    own(d);
    if (hit) {
      if (depth) log.push(d, d.keys[i], d.vals[i], 1);
      d.bytes += v.length - d.vals[i].length;
      d.vals[i] = v;
    } else {
      if (depth) log.push(d, k, v, 0);
      d.keys.splice(i, 0, k);
      d.vals.splice(i, 0, v);
      d.bytes += k.length + v.length;
    }
  }
  function rawDelAt(d, i, n) {
    own(d);
    for (let j = i; j < i + n; j++) {
      if (depth) log.push(d, d.keys[j], d.vals[j], 2);
      d.bytes -= d.keys[j].length + d.vals[j].length;
    }
    d.keys.splice(i, n);
    d.vals.splice(i, n);
  }

  // undo: op 0 = inserted (remove it), 1 = overwritten (restore old val), 2 = deleted (re-insert),
  // 3 = dbi dropped (register it again; its entries come back through their op-2 records)
  function rollbackTo(mark) {
    const saved = depth;
    depth = 0; // don't log the undo itself
    for (let p = log.length - 4; p >= mark; p -= 4) {
      const d = log[p], k = log[p + 1], v = log[p + 2], op = log[p + 3];
      if (op === 3) dbis.set(d.name, d); // dropped dbi: register it again
      else if (op === 0) {
        const i = lowerBound(d, k, d.dup ? v : undefined);
        rawDelAt(d, i, 1);
      } else rawPut(d, k, v); // overwrite back, or re-insert
    }
    log.length = mark;
    depth = saved;
  }

  function bounds(d, o) {
    // returns [from, to) index window in iteration order semantics
    const n = d.keys.length;
    if (!o.reverse) {
      let from = 0, to = n;
      if (o.start) from = o.exclusiveStart ? upperBoundKey(d, o.start) : lowerBound(d, o.start);
      if (o.end) to = o.inclusiveEnd ? upperBoundKey(d, o.end) : lowerBound(d, o.end);
      return [from, to];
    }
    // reverse: start = upper bound, end = lower bound; iterate hi-1 down to lo
    let hi = n, lo = 0;
    if (o.start) hi = o.exclusiveStart ? lowerBound(d, o.start) : upperBoundKey(d, o.start);
    if (o.end) lo = o.inclusiveEnd ? lowerBound(d, o.end) : upperBoundKey(d, o.end);
    return [lo, hi];
  }

  function* iterate(d, o) {
    const [a, b] = bounds(d, o);
    const keys = d.keys, vals = d.vals;
    d.shared = true;
    const limit = o.limit ?? Infinity;
    let count = 0;
    if (!o.reverse) {
      for (let i = a; i < b && count < limit; i++, count++) yield { key: keys[i], value: vals[i] };
    } else {
      for (let i = b - 1; i >= a && count < limit; i--, count++) yield { key: keys[i], value: vals[i] };
    }
  }

  return {
    kind: 'memory',

    openCollection(name, opts = {}) {
      let d = dbis.get(name);
      if (!d) {
        d = { name, dup: !!opts.dupSort, keys: [], vals: [], bytes: 0, shared: false };
        dbis.set(name, d);
      } else if (d.dup !== !!opts.dupSort) throw new Error(`spbt-db memory: ${name} reopened with different dupSort`);
      return d;
    },

    get(d, key) {
      const k = asBuf(key);
      const i = lowerBound(d, k);
      return i < d.keys.length && cmp(d.keys[i], k) === 0 ? d.vals[i] : undefined;
    },

    put(d, key, val) {
      if (!key.length) throw new Error('spbt-db memory: zero-length key');
      rawPut(d, copy(key), copy(val));
    },

    del(d, key, val) {
      const k = asBuf(key);
      if (val !== undefined && d.dup) {
        const v = asBuf(val);
        const i = lowerBound(d, k, v);
        if (i < d.keys.length && cmp(d.keys[i], k) === 0 && cmp(d.vals[i], v) === 0) { rawDelAt(d, i, 1); return true; }
        return false;
      }
      const i = lowerBound(d, k);
      const j = d.dup ? upperBoundKey(d, k) : (i < d.keys.length && cmp(d.keys[i], k) === 0 ? i + 1 : i);
      if (j === i) return false;
      rawDelAt(d, i, j - i);
      return true;
    },

    range(d, o = {}) {
      return iterate(d, { ...o, start: o.start && asBuf(o.start), end: o.end && asBuf(o.end) });
    },

    scan(d, o, fn) {
      for (const e of iterate(d, { ...o, start: o.start && asBuf(o.start), end: o.end && asBuf(o.end) })) if (fn(e.key, e.value) === false) break;
    },

    count(d, o = {}) {
      const [a, b] = bounds(d, { ...o, start: o.start && asBuf(o.start), end: o.end && asBuf(o.end) });
      return Math.max(0, Math.min(b - a, o.limit ?? Infinity));
    },

    txn(fn) {
      const mark = log.length;
      depth++;
      let ok = false;
      try {
        const r = fn();
        if (r && typeof r.then === 'function') throw new TypeError('spbt-db: txn(fn) must be synchronous - use txnAsync');
        ok = true;
        return r;
      } finally {
        if (!ok) rollbackTo(mark);
        depth--;
        if (depth === 0) log = [];
      }
    },

    txnAsync(fn) {
      return Promise.resolve().then(() => this.txn(fn));
    },

    inTxn: () => depth > 0,

    stat(d) {
      if (d) return { entries: d.keys.length, pages: Math.ceil(d.bytes / 4096), freePages: 0 };
      let entries = 0, bytes = 0;
      for (const x of dbis.values()) { entries += x.keys.length; bytes += x.bytes; }
      return { entries, pages: Math.ceil(bytes / 4096), freePages: 0 };
    },

    // inside a txn the entries are deleted through the undo log and the name is unregistered
    // with an undo record (op 3), so an abort restores the dbi; same semantics as lmdb mdb_drop
    drop(d) {
      if (depth > 1) throw new Error('spbt-db memory: drop inside a nested txn (savepoint) is not supported');
      if (depth) {
        if (d.keys.length) rawDelAt(d, 0, d.keys.length);
        if (dbis.get(d.name) === d) { dbis.delete(d.name); log.push(d, null, null, 3); }
        return;
      }
      dbis.delete(d.name);
      d.keys = []; d.vals = []; d.bytes = 0;
    },

    info() {
      let bytes = 0;
      for (const x of dbis.values()) bytes += x.bytes;
      return { kind: 'memory', dbis: dbis.size, bytes };
    },

    flushed: () => Promise.resolve(),
    close: async () => { dbis.clear(); },
  };
}

// SPBT_DB Backend interface (design §2.3).
//
// The storage engine is an ordered, crash-safe `bytes -> bytes` map. Everything
// above it (frames, keys, collections, indexes, TTL) only talks to this interface,
// so swapping lmdb-js for e.g. SQLite (`kv(k BLOB PRIMARY KEY, v BLOB) WITHOUT ROWID`)
// touches nothing else.
//
// Contract (both shipped backends pass test/backend-conformance.test.js):
//
// * Keys are non-empty byte strings, compared with memcmp order (Buffer.compare).
// * Callers may reuse key/value buffers right after a call returns; a backend that
//   retains them must copy.
// * `get` may return a VOLATILE buffer (lmdb getBinaryFast): valid only until the next
//   backend call. Its `.length` is authoritative - always slice with an explicit end.
//   Never retain or mutate it. On a dupSort DBI, `get` returns the first (lowest) value.
// * `put` on a dupSort DBI adds the (key, value) pair (no-op if present).
//   `del(dbi, key)` removes the key (all duplicates); `del(dbi, key, val)` removes one pair.
// * `range` is lazy and runs on a snapshot when called outside a write txn. Entries are
//   stable copies. Semantics follow lmdb-js getRange:
//     forward: start inclusive, end exclusive;  reverse: `start` is the UPPER bound
//     (inclusive), `end` the lower bound (exclusive). `exclusiveStart` / `inclusiveEnd`
//     flip those for the whole key (all its duplicates). Duplicates come in value order,
//     reversed when `reverse`.
// * `txn(fn)` is synchronous and atomic across all DBIs of the backend: if fn throws,
//   every write in it is rolled back and the error rethrown. Nested txn = savepoint
//   (inner throw rolls back only the inner part). Returns fn's result. Writes outside
//   any txn auto-commit individually (each one a durable commit - slow on real disks).
// * `stat()` without a dbi describes the whole environment.

/**
 * Opaque per-collection handle returned by openCollection.
 * @typedef {object} Dbi
 */

/**
 * @typedef {object} RangeOpts
 * @property {Uint8Array} [start]
 * @property {Uint8Array} [end]
 * @property {boolean} [reverse]
 * @property {number} [limit]
 * @property {boolean} [exclusiveStart]
 * @property {boolean} [inclusiveEnd]
 */

/**
 * @typedef {object} Stat
 * @property {number} entries    entries in the dbi (all duplicates counted) or env total
 * @property {number} pages      pages used by the dbi (branch+leaf+overflow) or env (lastPage+1)
 * @property {number} freePages  env-wide free/reusable pages (estimate, see backend docs)
 */

/**
 * The seven required methods.
 * @typedef {object} Backend
 * @property {(name: string, opts?: { dupSort?: boolean }) => Dbi} openCollection
 * @property {(dbi: Dbi, key: Uint8Array) => Buffer | undefined} get       volatile result
 * @property {(dbi: Dbi, key: Uint8Array, val: Uint8Array) => void} put
 * @property {(dbi: Dbi, key: Uint8Array, val?: Uint8Array) => boolean} del  true if something was removed
 * @property {(dbi: Dbi, o: RangeOpts) => Iterable<{ key: Buffer, value: Buffer }>} range
 * @property {<T>(fn: () => T) => T} txn
 * @property {(dbi?: Dbi) => Stat} stat
 *
 * Optional extras. The collection layer has fallbacks for the first three; the rest are
 * lifecycle / ops hooks that callers feature-detect.
 * @property {() => boolean} [inTxn]            true inside txn(); lets callers avoid nesting
 * @property {(dbi: Dbi, o: RangeOpts) => number} [count]   fallback: iterate range
 * @property {(dbi: Dbi, o: RangeOpts, fn: (key: Buffer, value: Buffer) => boolean | void) => void} [scan]
 *           range as a callback, `fn` returns false to stop. key is stable; value is VOLATILE
 *           (valid until the next backend call). The hot read path; fallback: range()
 * @property {<T>(fn: () => T) => Promise<T>} [txnAsync]   atomic like txn, but commit/fsync off the main thread
 * @property {<T>(fn: () => T) => T} [txnLazy]   atomic and committed on return, but not fsynced (flushed later)
 * @property {(dbi: Dbi) => void} [drop]        delete the DBI and free its pages (time buckets, §4.6)
 * @property {() => Promise<void>} [close]
 * @property {() => Promise<unknown>} [flushed] resolves when everything committed is durable
 * @property {() => object} [info]             engine-specific details for db.stats()
 * @property {string} [kind]                    'lmdb' | 'memory' | ...
 */

/** Required method names, for feature checks and the conformance test. */
export const BACKEND_METHODS = Object.freeze(['openCollection', 'get', 'put', 'del', 'range', 'txn', 'stat']);

/** Throws if `b` does not implement the 7 required methods. @param {any} b @returns {Backend} */
export function assertBackend(b) {
  for (const m of BACKEND_METHODS) if (typeof b?.[m] !== 'function') throw new TypeError(`spbt-db: backend lacks ${m}()`);
  return b;
}

/** Count entries in a range using `count` when available, else by iteration. */
export function countRange(backend, dbi, o) {
  if (backend.count) return backend.count(dbi, o);
  let n = 0;
  for (const _ of backend.range(dbi, o)) n++;
  return n;
}

/** Run fn inside a txn unless one is already open (avoids paying for a nested savepoint). */
export function inTxn(backend, fn) {
  return backend.inTxn && backend.inTxn() ? fn() : backend.txn(fn);
}

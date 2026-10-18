// lmdb-js Backend (design §3 L0, Appendix A). One Backend = one LMDB environment.
// SPBT_DB opens two: `hot` (configs, users, levels...) and `cold` (log firehose).
//
// Verified against lmdb@3.5.6 README / index.d.ts / source:
// * getBinaryFast(key): copies the value into a reusable buffer (no allocation);
//   valid until the next read. Its `length` is an own property shorter than the
//   underlying buffer - consumers must slice with an explicit end.
// * putSync/removeSync inside transactionSync run in that txn; outside they
//   auto-commit their own synchronous txn.
// * transactionSync(fn): throw (or return ABORT) aborts; nested call = child txn.
// * childTransaction(fn): queued async txn; a throw aborts only this callback.
//   (Plain transaction(fn) does NOT roll back on throw - verified, so not used.)
// * getRange({ start, end, reverse, limit, exclusiveStart, inclusiveEnd }) with encoding
//   'binary' returns fresh key/value copies made with Uint8Array#slice: a new, unpooled
//   ArrayBuffer per key AND per value. That copy was ~60 % of a range(100) and most of its GC
//   (p99). With a per-DBI `encoder` whose decode() does not copy, read.js hands decode() the
//   same reusable buffer getBinaryFast uses (`decoderCopies`), so values arrive VOLATILE;
//   and `store.readKey` (read.js getRange) is replaced by a pooled copy. range() copies
//   values into pooled Buffers (stable, as the contract says); scan() passes them through.
//   Measured on 100-entry ranges: p50 70 -> 28 us, p99 284 -> 50 us.
// * useVersions stores an 8-byte version prefix in EVERY value and cannot be combined
//   with dupSort; SPBT_DB does not enable it (see README "Deviations").

import { open } from 'lmdb';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

/** @typedef {import('./backend.js').Backend} Backend */

/**
 * Environment profiles from Appendix A. `cache:false`, `encoding:'binary'` and
 * `compression:false` are forced: framing, caching and compression are ours.
 *
 * mapSize is FIXED for both envs (the doc lets lmdb-js grow hot): lmdb-js 3.5.6 grows a full
 * map by remapping at 2x and deliberately never unmaps the old, smaller mappings (lingering
 * readers), so the same resident pages are counted in RSS once per mapping until close -
 * measured 8 mappings / 44 MB "resident" for a 26 MB hot.mdb (bench 03). A fixed map is one
 * mapping. It is virtual address space only: without MDB_WRITEMAP LMDB maps the file
 * PROT_READ/MAP_SHARED and never extends the file to mapSize, and a read-only shared file
 * mapping is not charged to Committed_AS (safe under vm.overcommit_memory=2). Only RLIMIT_AS
 * (ulimit -v) would see it. See mapSizeFor() for growth beyond it.
 */
export const PROFILES = Object.freeze({
  hot: Object.freeze({
    maxDbs: 128,           // Appendix A says 64; §5 lists ~55 hot DBIs (collections + indexes) - see README
    pageSize: 4096,
    mapSize: 2 * 2 ** 30,  // fixed, virtual only: ~5x the §6.3 projection of 420 MB (see above)
    overlappingSync: true,
    safeRestore: true,
    eventTurnBatching: true,
    noReadAhead: true,     // random point lookups, little RAM (§4.5)
  }),
  cold: Object.freeze({
    maxDbs: 64,
    // lmdb-js README: 8192 for DBs larger than RAM with range queries. 4096 was A/B-tested on
    // 2026-10-18 (bench/results-2026-10-18-cold-pagesize.md) and NOT adopted: it failed two of
    // the six pre-set checks (engineering notes, "Decisions taken", item 1). lmdb-js applies
    // pageSize only when it creates cold.mdb; an existing file keeps its own.
    pageSize: 8192,
    mapSize: 8 * 2 ** 30,  // virtual address space, not RSS
    overlappingSync: true,
    safeRestore: false,
    noMemInit: true,
    eventTurnBatching: true,
    // The doc (§4.5) keeps readahead on for cold. Measured (bench 03, panel log views + appends
    // to 400 channels): cold.mdb resident 93-95 MB with readahead, ~20 MB without. lmdb-js says
    // noReadAhead "should not be used" with pages > 4 KiB: with MADV_RANDOM an 8 KiB page can
    // take two 4 KiB faults. Measured cost (bench 02, cold byMessageId after eviction): 1.84
    // major faults and 8.7 KB read per lookup at 8 KiB, against 1.15 and 5.0 KB at 4 KiB.
    noReadAhead: true,
  }),
});

/** smallest power of two >= n */
const pow2ceil = (n) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/**
 * Map size to open with: the configured size, raised at OPEN to the next power of two >= 2x
 * the current file, so a running process never has to grow the map unless the file more than
 * doubles during its lifetime. If it does, lmdb-js grows the map itself (it never returns
 * MDB_MAP_FULL) at the cost of one extra mapping - info().mapGrown reports it, and the next
 * open sizes the map from the file again.
 */
export function mapSizeFor(configured, fileBytes) {
  if (!configured) return configured;
  return fileBytes * 2 > configured ? pow2ceil(fileBytes * 2) : configured;
}

/**
 * @param {object} o
 * @param {string} o.path            env file, e.g. `${dir}/hot.mdb` (a '.' in the name => noSubdir)
 * @param {'hot'|'cold'} [o.profile='hot']
 * @param {object} [o.options]       extra lmdb open() options (override the profile);
 *                                   `mapSize: 0` restores lmdb-js's own growing map (benchmarks only)
 * @returns {Backend & { kind: 'lmdb', env: any }}
 */
export function createLmdbBackend({ path, profile = 'hot', options = {} }) {
  const base = PROFILES[profile];
  if (!base) throw new TypeError(`spbt-db lmdb: unknown profile ${profile}`);
  const openMapSize = mapSizeFor(options.mapSize ?? base.mapSize, fileSize(path));
  const opts = { ...base, ...options, mapSize: openMapSize, encoding: 'binary', compression: false, cache: false, useVersions: false };
  if (!openMapSize) delete opts.mapSize;
  const env = open(path, opts);
  /** @type {Map<string, any>} */
  const dbis = new Map();
  let depth = 0;

  function wrap(fn) {
    return () => {
      depth++;
      try {
        const r = fn();
        if (r && typeof r.then === 'function') throw new TypeError('spbt-db: txn(fn) must be synchronous - use txnAsync');
        return r;
      } finally { depth--; }
    };
  }

  function rangeOpts(o) {
    // only pass defined keys: lmdb checks `'start' in options`
    const r = {};
    if (o.start) r.start = o.start;
    if (o.end) r.end = o.end;
    if (o.reverse) r.reverse = true;
    if (o.limit !== undefined && o.limit !== Infinity) r.limit = o.limit;
    // only with a bound: without `start` lmdb-js substitutes Buffer.from([0]) as the start key,
    // and exclusiveStart would then silently skip a real 0x00 key (caught by the conformance test)
    if (o.exclusiveStart && o.start) r.exclusiveStart = true;
    if (o.inclusiveEnd && o.end) r.inclusiveEnd = true;
    // reverse without `end`: lmdb-js uses [0x00] as an EXCLUSIVE end, dropping a real 0x00 key
    if (o.reverse && !o.end) { r.end = ZERO_KEY; r.inclusiveEnd = true; }
    return r;
  }

  function pagesOf(s) {
    return s.treeBranchPageCount + s.treeLeafPageCount + s.overflowPages;
  }

  return {
    kind: 'lmdb',
    env,

    openCollection(name, opts = {}) {
      let db = dbis.get(name);
      if (!db) {
        db = env.openDB(name, { keyEncoding: 'binary', encoding: 'binary', dupSort: !!opts.dupSort, encoder: VOLATILE_VALUES });
        db.readKey = pooledKey;
        db.tanoName = name;
        db.tanoDup = !!opts.dupSort;
        dbis.set(name, db);
      } else if (db.tanoDup !== !!opts.dupSort) throw new Error(`spbt-db lmdb: ${name} reopened with different dupSort`);
      return db;
    },

    get: (db, key) => db.getBinaryFast(key),

    put(db, key, val) { db.putSync(key, val); },

    del: (db, key, val) => (val === undefined ? db.removeSync(key) : db.removeSync(key, val)),

    range: (db, o = {}) => stable(db.getRange(rangeOpts(o))),

    // fn(key, value): key is a stable copy, value is VOLATILE (valid until the next backend
    // call, a get() included); return false to stop
    scan(db, o, fn) {
      for (const e of db.getRange(rangeOpts(o))) if (fn(e.key, e.value) === false) break;
    },

    count: (db, o = {}) => db.getCount(rangeOpts(o)),

    txn: (fn) => env.transactionSync(wrap(fn)),

    txnAsync: (fn) => env.childTransaction(wrap(fn)),

    // Atomic and committed on return (visible, survives a process crash) but NOT fsynced: the
    // txn is begun with MDB_NOSYNC (0x10000, the flag lmdb-js uses for putSync), so the commit
    // never waits for the disk. Used for the __boot record: the first durable commit after a
    // kill -9 has to flush whatever the dead writer left dirty, which must not block open.
    txnLazy: (fn) => env.transactionSync(wrap(fn), 0x10003),

    inTxn: () => depth > 0,

    stat(db) {
      if (db) {
        const s = db.getStats();
        return { entries: s.entryCount, pages: pagesOf(s), get freePages() { return freePages(); } }; // lazy: walks every DBI
      }
      let entries = 0;
      for (const d of dbis.values()) entries += d.getStats().entryCount;
      const s = env.getStats();
      return { entries, pages: s.lastPageNumber + 1, freePages: freePages() };
    },

    // mdb_drop(del=1) is transactional: the tree's pages go to the freelist and the name
    // leaves the main DB at COMMIT. lmdb-js dropSync() runs it in the CURRENT write txn when
    // one is open (its flags lack the child-txn bit), so several drops + other writes inside
    // one txn() are one atomic commit. The handle is closed at once (mdb_dbi_close), so after
    // an aborted txn the DBI still exists on disk and openCollection() opens a fresh handle.
    // Not inside a savepoint: LMDB closes the handle env-wide, which a child abort cannot undo.
    drop(db) {
      if (depth > 1) throw new Error('spbt-db lmdb: drop inside a nested txn (savepoint) is not supported');
      if (depth) db.dropSync();
      else env.transactionSync(wrap(() => db.dropSync()));
      dbis.delete(db.tanoName);
    },

    /** Engine detail for db.stats(): file size, map size, per-DBI tree shape. */
    info() {
      const s = env.getStats();
      const out = {
        kind: 'lmdb',
        path,
        fileBytes: fileSize(path),
        pageSize: s.pageSize,
        mapSize: s.mapSize,
        mapUsed: +(((s.lastPageNumber + 1) * s.pageSize) / s.mapSize).toFixed(4),
        mapGrown: !!openMapSize && s.mapSize > openMapSize, // lmdb-js remapped at runtime: one extra mapping until close
        lastPage: s.lastPageNumber,
        lastTxnId: s.lastTxnId,
        freePages: freePages(),
        readers: s.numReaders,
        dbis: {},
      };
      for (const [name, d] of dbis) {
        const t = d.getStats();
        out.dbis[name] = { entries: t.entryCount, depth: t.treeDepth, branch: t.treeBranchPageCount, leaf: t.treeLeafPageCount, overflow: t.overflowPages };
      }
      return out;
    },

    flushed: () => env.flushed,

    close: () => env.close(),
  };

  // Free pages = allocated pages - pages reachable from a tree. Exact only when every
  // named DBI of the env has been opened by this process (unopened ones count as free).
  function freePages() {
    const s = env.getStats();
    let used = 2 + pagesOf(s.root) + pagesOf(s.free); // 2 meta pages + main tree + freelist tree
    for (const d of dbis.values()) used += pagesOf(d.getStats());
    return Math.max(0, s.lastPageNumber + 1 - used);
  }
}

const ZERO_KEY = Buffer.from([0]);

/** values pass through on write and come back as lmdb's reusable buffer on read (no copy) */
const VOLATILE_VALUES = { // not frozen: lmdb-js may set fields on its encoder
  encode: (v) => v,
  // the mmap'ed-value path hands a plain Uint8Array view: wrap it, still without copying
  decode: (b) => (Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.length)),
};
/** keys as pooled copies (Buffer.allocUnsafe) instead of one unpooled ArrayBuffer each */
function pooledKey(target, start, end) {
  const b = Buffer.allocUnsafe(end - start);
  target.copy(b, 0, start, end);
  return b;
}
function copyVal(v) {
  const c = Buffer.allocUnsafe(v.length);
  c.set(v.subarray(0, v.length));
  return c;
}
function* stable(it) {
  for (const e of it) yield { key: e.key, value: copyVal(e.value) };
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/**
 * Copy-compaction (§4.6 mechanism 2) of an env file into `dstPath`, run in a SHORT-LIVED CHILD
 * PROCESS: mdb_env_copy2(MDB_CP_COMPACT) reads every live page through the mmap, so in-process the
 * whole live data set becomes resident in the caller (measured +27 MB for a 52 MB hot env, ~215 MB
 * projected at 420 MB). Those pages are clean and reclaimable, but they are the bot's RSS. In a
 * child they are its RSS and vanish with it; the caller's RSS stays flat. The child opens the env
 * read-only next to the live writer (LMDB is multi-process) and copies one consistent snapshot.
 * Swapping the copy in (close, rename, reopen) is the caller's job.
 * @param {string} srcPath  e.g. `${dir}/hot.mdb`
 * @param {string} dstPath
 * @returns {Promise<{ ms: number, bytes: number, childPeakRssMB: number, childFloorRssMB: number }>}  floor = after open, before the copy
 */
export function compactCopy(srcPath, dstPath, { timeoutMs = 600_000 } = {}) {
  const lmdbUrl = import.meta.resolve('lmdb');
  const script = `
    const { open } = await import(${JSON.stringify(lmdbUrl)});
    const fs = await import('node:fs');
    const [src, dst] = process.argv.slice(1);
    const kB = (re) => { const m = re.exec(fs.readFileSync('/proc/self/status', 'utf8')); return m ? +m[1] : null; };
    const env = open(src, { readOnly: true, noSubdir: true, noReadAhead: true, encoding: 'binary', cache: false });
    const floorKB = kB(/VmRSS:\\s+(\\d+)/);
    await env.backup(dst, true);
    await env.close();
    process.stdout.write(JSON.stringify({ floorKB, peakKB: kB(/VmHWM:\\s+(\\d+)/) }));`;
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    execFile(process.execPath, ['--input-type=module', '-e', script, srcPath, dstPath], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`spbt-db compactCopy: ${err.message} ${stderr}`));
      let o = {};
      try { o = JSON.parse(stdout); } catch {}
      const mb = (k) => (k == null ? null : +(k / 1024).toFixed(1));
      resolve({ ms: performance.now() - t0, bytes: fileSize(dstPath), childPeakRssMB: mb(o.peakKB), childFloorRssMB: mb(o.floorKB) });
    });
  });
}

// SPBT_DB blob store (design §10): content-addressed files, metadata + refcounts in the DB.
//
//   import { attachBlobs } from './blobs.js';
//   const blobs = attachBlobs(db, { dir: './data/blobs' });           // -> db.blobs
//   const { hash } = await blobs.put(stream, { mime: 'image/png',     // ref + owning row, one txn:
//     txn: ({ hash }) => db.image.put({ imageId, userId, ext, size, uploadedAt, blobHash: hash }) });
//   blobs.open(hash).pipe(res);   blobs.path(hash) -> for res.sendFile
//   db.txn(() => { blobs.unref(hash); db.image.del(imageId); });
//   await blobs.gc();                                                 // nightly (§10.4)
//
// Layout (§10.2):   <dir>/tmp/<uuid>   while writing
//                   <dir>/ab/cd/<32 hex>   hash = sha256(content)[0:16]
// Blobs of <= inlineMax bytes (§10.5: 1 KB) are stored in the blob_inline DBI instead.
//
// Write protocol (§10.3): stream -> tmp while hashing -> fsync(tmp) -> if the final file
// exists, drop tmp (dedup) else rename + fsync(dir) -> one txn: blob_ref upsert (+1 ref and
// the caller's owning row when `txn`/`ref` is given). Crash windows:
//   * before rename: a tmp file only            -> gc removes tmp files older than tmpGraceMs
//   * after rename, before the txn: a file with no blob_ref row -> gc orphan walk (grace)
//   * after the txn without a ref: refs = 0 row  -> gc after graceMs
// A per-hash in-process lock serialises put and gc on the same hash, so gc can never delete
// a file that a concurrent put has just deduplicated against.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { aiSchemas, DAY } from './ai-schema.js';

const HOUR = 3_600_000;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX2 = /^[0-9a-f]{2}$/;

/** mime u8 codes (append only: the code is stored in blob_ref). Unknown types map to 0. */
export const MIME = Object.freeze([
  'application/octet-stream', 'text/plain', 'text/html', 'application/json', 'application/gzip',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml',
  'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'application/pdf', 'application/zip',
  'text/markdown', 'text/csv',
]);
const MIME_CODE = new Map(MIME.map((m, i) => [m, i]));
/** @param {string|number|undefined} m @returns {number} */
export function mimeCode(m) {
  if (typeof m === 'number') { if ((m & 0xff) !== m) throw new RangeError(`spbt-db blobs: mime code ${m}`); return m; }
  return MIME_CODE.get(String(m ?? '').split(';')[0].trim().toLowerCase()) ?? 0;
}

/** sha256(content)[0:16] */
export function hashOf(bytes) {
  return createHash('sha256').update(bytes).digest().subarray(0, 16);
}

const isBytes = (x) => x instanceof Uint8Array;
const asBuf = (x) => (Buffer.isBuffer(x) ? x : typeof x === 'string' ? Buffer.from(x) : Buffer.from(x.buffer, x.byteOffset, x.byteLength));
const exists = (p) => fsp.stat(p).then(() => true, () => false);
const ignoreENOENT = (e) => { if (e.code !== 'ENOENT') throw e; };

async function fsyncDir(d) {
  const fh = await fsp.open(d, 'r');
  try { await fh.sync(); } finally { await fh.close(); }
}

/**
 * @typedef {object} BlobOptions
 * @property {string} dir                 blob root (created if missing)
 * @property {number} [inlineMax=1024]    blobs up to this size are stored in the DB
 * @property {number} [graceMs=24h]       zero-ref rows / orphan files younger than this are kept
 * @property {number} [tmpGraceMs=1h]     tmp files younger than this are kept (upload in progress)
 * @property {boolean} [fsync=true]       fsync tmp files and directories (tests may turn it off)
 * @property {(point: 'afterTmp'|'afterRename'|'gcBeforeUnlink') => void|Promise<void>} [failpoint]
 *           test hook for crash / race simulation (awaited)
 */

/**
 * @typedef {object} PutResult
 * @property {Buffer} hash     16 bytes
 * @property {string} hex
 * @property {number} size
 * @property {string} mime
 * @property {boolean} deduped the content was already stored
 * @property {boolean} inline  stored in the DB (size <= inlineMax)
 * @property {number} refs     refcount after this put
 * @property {any} [result]    return value of the `txn` hook
 */

/**
 * Attach the blob store to a db: opens blob_ref / blob_inline and sets db.blobs.
 * @param {ReturnType<typeof import('./index.js').openDB>} db
 * @param {BlobOptions} opts
 */
export function attachBlobs(db, opts) {
  if (db.blobs && db.blobs.attached) return db.blobs;
  db.blobs = createBlobStore(db, opts);
  return db.blobs;
}

/** Same as attachBlobs without assigning db.blobs. */
export function createBlobStore(db, opts) {
  if (!opts || !opts.dir) throw new TypeError('spbt-db blobs: { dir } is required');
  const root = opts.dir;
  const tmpDir = join(root, 'tmp');
  const inlineMax = opts.inlineMax ?? 1024;
  const graceMs = opts.graceMs ?? DAY;
  const tmpGraceMs = opts.tmpGraceMs ?? HOUR;
  const doSync = opts.fsync ?? true;
  const failpoint = opts.failpoint ?? (() => {});
  fs.mkdirSync(tmpDir, { recursive: true });

  const refs = db.collection('blob_ref', aiSchemas.blob_ref);
  const inl = db.collection('blob_inline', aiSchemas.blob_inline);
  const be = refs.backend;
  const tx = (fn) => (be.inTxn && be.inTxn() ? fn() : db.txn(fn));

  const pathOf = (hex) => join(root, hex.slice(0, 2), hex.slice(2, 4), hex);
  function toHash(h) {
    if (typeof h === 'string') {
      const s = h.toLowerCase();
      if (!HEX32.test(s)) throw new TypeError(`spbt-db blobs: bad hash ${h}`);
      return Buffer.from(s, 'hex');
    }
    if (isBytes(h) && h.length === 16) return asBuf(h);
    throw new TypeError('spbt-db blobs: hash must be 16 bytes or 32 hex chars');
  }

  /* ---- per-hash locks (put vs gc in this process) */
  /** @type {Map<string, Promise<void>>} */
  const locks = new Map();
  function tryLock(hex) {
    if (locks.has(hex)) return null;
    let release;
    locks.set(hex, new Promise((r) => { release = r; }));
    return () => { locks.delete(hex); release(); };
  }
  async function lock(hex) {
    for (;;) {
      const rel = tryLock(hex);
      if (rel) return rel;
      await locks.get(hex);
    }
  }

  /* ---- tmp files */
  async function writeTmp(chunks) {
    const p = join(tmpDir, randomUUID());
    const fh = await fsp.open(p, 'wx');
    try {
      for (const c of chunks) await fh.write(c);
      if (doSync) await fh.sync();
    } catch (e) {
      await fh.close().catch(() => {});
      await fsp.unlink(p).catch(() => {});
      throw e;
    }
    await fh.close();
    return p;
  }

  /**
   * Read a stream: hash everything, keep it in memory while <= inlineMax, else spool to tmp.
   * @returns {Promise<{ hash: Buffer, size: number, data: Buffer|null, tmp: string|null }>}
   */
  async function spool(src, max) {
    const h = createHash('sha256');
    let size = 0, head = [], fh = null, tmp = null;
    try {
      for await (const chunk of src) {
        const c = asBuf(chunk);
        if (!c.length) continue;
        size += c.length;
        if (size > max) throw new RangeError(`spbt-db blobs: blob exceeds maxBytes ${max}`);
        h.update(c);
        if (fh) { await fh.write(c); continue; }
        head.push(c);
        if (size > inlineMax) {
          tmp = join(tmpDir, randomUUID());
          fh = await fsp.open(tmp, 'wx');
          for (const b of head) await fh.write(b);
          head = null;
        }
      }
      if (fh) {
        if (doSync) await fh.sync();
        await fh.close();
        fh = null;
      }
    } catch (e) {
      if (fh) await fh.close().catch(() => {});
      if (tmp) await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
    return { hash: h.digest().subarray(0, 16), size, data: fh || tmp ? null : Buffer.concat(head ?? [], size), tmp };
  }

  /** blob_ref upsert inside a txn. @returns {number} refs after */
  function touchRow(h, size, mime, add, now) {
    const cur = refs.get(h);
    if (!cur) {
      refs.put({ h, size, mime, refs: add, firstSeen: now, zeroAt: add ? 0 : now });
      return add;
    }
    if (cur.size !== size) throw new Error(`spbt-db blobs: hash ${h.toString('hex')} stored with size ${cur.size}, got ${size}`);
    const r = cur.refs + add;
    // a dedup hit on a zero-ref blob restarts its grace period
    if (add || cur.refs === 0) refs.put({ h, size, mime: cur.mime || mime, refs: r, firstSeen: cur.firstSeen, zeroAt: r ? 0 : now });
    return r;
  }

  const blobs = {
    attached: true,
    dir: root,
    inlineMax,
    MIME,
    refs,

    /**
     * Store a blob.
     * @param {Uint8Array|string|AsyncIterable<Uint8Array|string>|Iterable<Uint8Array|string>} src
     * @param {object} [o]
     * @param {string|number} [o.mime]
     * @param {boolean} [o.ref]        +1 ref in the same txn (without it the blob starts at refs = 0
     *                                 and must be referenced within graceMs, or gc collects it)
     * @param {(info: PutResult) => any} [o.txn]  runs inside the ref txn (implies ref): write the
     *                                 owning row here so the refcount and the reference commit together
     * @param {number} [o.maxBytes]
     * @returns {Promise<PutResult>}
     */
    async put(src, o = {}) {
      const mime = mimeCode(o.mime);
      const add = o.txn || o.ref ? 1 : 0;
      const max = o.maxBytes ?? Infinity;
      let hash, size, data = null, tmp = null;
      if (isBytes(src) || typeof src === 'string') {
        data = asBuf(src);
        size = data.length;
        if (size > max) throw new RangeError(`spbt-db blobs: blob exceeds maxBytes ${max}`);
        hash = hashOf(data);
      } else {
        if (src == null || (typeof src[Symbol.asyncIterator] !== 'function' && typeof src[Symbol.iterator] !== 'function')) throw new TypeError('spbt-db blobs: put() needs bytes, a string or a stream');
        ({ hash, size, data, tmp } = await spool(src, max));
      }
      const hex = hash.toString('hex');
      const inline = size <= inlineMax;
      if (inline && tmp) { await fsp.unlink(tmp).catch(() => {}); tmp = null; } // cannot happen; defensive
      if (tmp) await failpoint('afterTmp');

      const release = await lock(hex);
      try {
        let deduped;
        if (inline) {
          deduped = refs.has(hash);
        } else {
          const final = pathOf(hex);
          deduped = await exists(final);
          if (deduped) {
            if (tmp) await fsp.unlink(tmp).catch(ignoreENOENT);
          } else {
            if (!tmp) { tmp = await writeTmp([data]); await failpoint('afterTmp'); }
            const leaf = dirname(final);
            const created = await fsp.mkdir(leaf, { recursive: true });
            await fsp.rename(tmp, final);
            tmp = null;
            if (doSync) {
              if (created) { await fsyncDir(root); await fsyncDir(dirname(leaf)); }
              await fsyncDir(leaf);
            }
            await failpoint('afterRename');
          }
        }
        const info = { hash, hex, size, mime: MIME[mime] ?? MIME[0], deduped, inline, refs: 0 };
        const now = Date.now();
        try {
          tx(() => {
            if (inline && !inl.has(hash)) inl.put({ h: hash, data });
            info.refs = touchRow(hash, size, mime, add, now);
            if (o.txn) info.result = o.txn(info);
          });
        } catch (e) {
          // the owning txn failed: still record the blob (refs = 0) so gc reclaims it after the grace period
          if (add && !inline) { try { tx(() => touchRow(hash, size, mime, 0, now)); } catch { /* orphan walk will get it */ } }
          throw e;
        }
        return info;
      } finally {
        release();
        if (tmp) await fsp.unlink(tmp).catch(() => {});
      }
    },

    /** Read stream, or undefined if the blob is unknown. */
    open(hash) {
      const h = toHash(hash);
      if (!refs.has(h)) return undefined;
      const v = inl.get(h);
      if (v) return Readable.from([v.data]);
      return fs.createReadStream(pathOf(h.toString('hex')));
    },

    /** Whole blob as a Buffer, or undefined. */
    async read(hash) {
      const h = toHash(hash);
      if (!refs.has(h)) return undefined;
      const v = inl.get(h);
      if (v) return v.data;
      return fsp.readFile(pathOf(h.toString('hex'))).catch((e) => { ignoreENOENT(e); return undefined; });
    },

    /** Filesystem path (for res.sendFile); undefined for unknown or inline blobs. */
    path(hash) {
      const h = toHash(hash);
      if (!refs.has(h) || inl.has(h)) return undefined;
      return pathOf(h.toString('hex'));
    },

    has(hash) { return refs.has(toHash(hash)); },

    /** { size, mime, refs, firstSeen, zeroAt, inline } or undefined. */
    stat(hash) {
      const h = toHash(hash);
      const r = refs.get(h);
      if (!r) return undefined;
      return { size: r.size, mime: MIME[r.mime] ?? MIME[0], refs: r.refs, firstSeen: r.firstSeen, zeroAt: r.zeroAt, inline: inl.has(h) };
    },

    /** +n refs (sync; joins the caller's db.txn). Throws for an unknown blob. @returns {number} refs */
    ref(hash, n = 1) {
      const h = toHash(hash);
      return tx(() => {
        const cur = refs.get(h);
        if (!cur) throw new Error(`spbt-db blobs: ref of unknown blob ${h.toString('hex')}`);
        const r = cur.refs + n;
        if (r < 0) throw new RangeError(`spbt-db blobs: refcount of ${h.toString('hex')} would drop below 0`);
        refs.patch(h, { refs: r, zeroAt: r ? 0 : Date.now() });
        return r;
      });
    },

    /** -n refs; at 0 the blob becomes collectable after graceMs. @returns {number} refs */
    unref(hash, n = 1) { return blobs.ref(hash, -n); },

    /**
     * Delete blobs whose refcount has been 0 for longer than graceMs. Bounded by `limit`;
     * resumable (collected rows leave the blob_gc index, so the next call continues).
     * @returns {Promise<{ removed: number, bytes: number, more: boolean }>}
     */
    async gcRefs(o = {}) {
      const now = o.now ?? Date.now();
      const cutoff = Math.max(0, now - (o.graceMs ?? graceMs));
      const limit = o.limit ?? 10_000, batch = o.batch ?? 256;
      let removed = 0, bytes = 0, more = false;
      for (;;) {
        if (removed >= limit) { more = true; break; }
        const cands = refs.query({ index: 'blob_gc', end: [cutoff], limit: Math.min(batch, limit - removed), covered: true }).items;
        if (!cands.length) break;
        const mine = [];
        for (const c of cands) {
          const rel = tryLock(c.h.toString('hex'));
          if (rel) mine.push([c.h, rel]);
        }
        if (!mine.length) { more = true; break; } // all busy with uploads: next run
        try {
          const dels = tx(() => mine.map(([h]) => {
            const cur = refs.get(h);
            if (!cur || cur.refs !== 0 || cur.zeroAt >= cutoff) return null;
            refs.del(h);
            return { h, size: cur.size, inline: inl.del(h) };
          }));
          // rows are gone and committed; a crash before the unlinks leaves orphans for gcOrphans
          for (const d of dels) {
            if (!d) continue;
            if (!d.inline) {
              await failpoint('gcBeforeUnlink');
              await fsp.unlink(pathOf(d.h.toString('hex'))).catch(ignoreENOENT);
            }
            removed++;
            bytes += d.size;
          }
          if (!dels.some(Boolean)) { more = true; break; }
        } finally {
          for (const [, rel] of mine) rel();
        }
      }
      return { removed, bytes, more };
    },

    /**
     * Remove tmp files older than tmpGraceMs and files without a blob_ref row older than
     * graceMs. Walks the ab/cd tree in order from `cursor`, stopping after `limit` files
     * (finishing the current leaf directory). Pass the returned cursor to resume; it is
     * also remembered in-process. cursor === undefined in the result means the walk finished.
     * @returns {Promise<{ removed: number, removedTmp: number, scanned: number, cursor: string|undefined, done: boolean }>}
     */
    async gcOrphans(o = {}) {
      const now = o.now ?? Date.now();
      const grace = o.graceMs ?? graceMs, tgrace = o.tmpGraceMs ?? tmpGraceMs;
      const limit = o.limit ?? 5000;
      const from = 'cursor' in o ? o.cursor : orphanCursor;
      let removed = 0, removedTmp = 0, scanned = 0, done = true, last;

      for (const name of await fsp.readdir(tmpDir).catch(() => [])) {
        const p = join(tmpDir, name);
        const st = await fsp.stat(p).catch(() => null);
        if (st && st.isFile() && now - st.mtimeMs > tgrace) { await fsp.unlink(p).catch(ignoreENOENT); removedTmp++; }
      }

      const ls = async (d) => (await fsp.readdir(d).catch(() => [])).filter((n) => HEX2.test(n)).sort();
      walk: for (const a of await ls(root)) {
        if (from && a < from.slice(0, 2)) continue;
        for (const b of await ls(join(root, a))) {
          const leaf = `${a}/${b}`;
          if (from && leaf <= from) continue;
          if (scanned >= limit) { done = false; break walk; }
          const dir = join(root, a, b);
          for (const name of await fsp.readdir(dir).catch(() => [])) {
            scanned++;
            if (!HEX32.test(name) || !name.startsWith(a + b)) continue; // not ours: leave it
            const h = Buffer.from(name, 'hex');
            if (refs.has(h)) continue;
            const p = join(dir, name);
            const st = await fsp.stat(p).catch(() => null);
            if (!st || now - st.mtimeMs <= grace) continue;
            const rel = tryLock(name);
            if (!rel) continue;
            try {
              if (!refs.has(h)) { await fsp.unlink(p).catch(ignoreENOENT); removed++; }
            } finally { rel(); }
          }
          last = leaf;
        }
      }
      orphanCursor = done ? undefined : last;
      return { removed, removedTmp, scanned, cursor: orphanCursor, done };
    },

    /** gcRefs then gcOrphans (o.orphans = false skips the walk). */
    async gc(o = {}) {
      const r = await blobs.gcRefs(o);
      const w = o.orphans === false ? null : await blobs.gcOrphans(o);
      return { ...r, orphans: w };
    },
  };
  let orphanCursor;
  return blobs;
}

// SPBT_DB vector store for AI RAG (design §9): int8 + per-vector scale, flat scan, no index.
//
//   import { attachVectors } from './vector.js';
//   const ai = attachVectors(db, { dim: 256 });          // -> db.ai
//   ai.add(gid, chunkId, float32Vec, text, { srcChannelId, srcMsgId, createdAt, tokens });
//   ai.knn(gid, queryVec, 8);                            // -> [{ chunkId, score, text }]
//
// Storage (ai_vec, raw codec, key u64be(gid) || u16be(seg)):
//   seg 0..0xFFFE  one segment of m <= slots vectors, structure-of-arrays so the scan is linear:
//                    [0, m*dim)           int8 codes
//                    [m*dim, +4m)         f32 LE scale     (x ~= code * scale)
//                    [m*dim+4m, +4m)      u32 LE chunkId
//                  Vectors are dense: position p lives in seg p / slots, slot p % slots.
//                  Only the tail segment is partial, and it is stored at its real size.
//   seg 0xFFFF     guild header (16 B): n u32 | gen u32 | nextId u32 | dim u16 | slots u16 (all LE)
//                  `gen` changes on every write; the RAM cache validates against it, which also
//                  makes the cache safe against writes from another process.
//
// Quantisation (§9.2): vectors are L2-normalised (opts.normalize), then code = round(x / scale)
// with scale = max|x| / 127. The query is quantised to int16 with its own scale (asymmetric:
// int8 data x int16 query costs the same as int8 x int8 in the SIMD kernel, and removes the
// query-side rounding error). Dot products accumulate in int32 and are exact.
//
// Kernel: a hand-assembled WebAssembly SIMD function (i16x8.extend + i32x4.dot_i16x8_s,
// 16 MACs per step), ~20x faster than the best scalar JS loop on the dev box. A scalar JS
// kernel with bit-identical results is the fallback (opts.kernel = 'js', or no wasm SIMD).
//
// RAM (§9.6): an LRU of whole guilds, decoded into one contiguous SoA block inside the wasm
// memory, bounded by `cacheBytes` (default 4 MiB = the vecLRU share of §6.2). Guilds that do
// not fit, or reads inside a write txn, scan segment by segment through a 1-segment scratch.

import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { headerSize } from './frame.js';
import { writeU64, prefixEnd } from './keys.js';
import { aiSchemas, DAY } from './ai-schema.js';

const META_SEG = 0xffff;
const MAX_SEGS = 0xffff; // segment indexes 0..0xFFFE
const BLOCK = 1024;      // vectors per kernel call (bounds the output buffer)
const MAX_SLOTS = 1024;
const A = 64;            // alignment of regions inside the kernel memory
const align = (n) => Math.ceil(n / A) * A;
const U32 = 0x100000000;

if (os.endianness() !== 'LE') throw new Error('spbt-db vector: little-endian host required');

/* ------------------------------------------------------------------ kernel */

const uleb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sleb = (n) => { const o = []; for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && b & 0x40)) { o.push(b); return o; } o.push(b | 0x80); } };

/**
 * dots(codes, n, q, out, dim): out[i] = sum_j int8(codes[i*dim + j]) * int16(q[j]) as int32,
 * for i < n. dim must be a multiple of 16. Exported memory "m".
 */
function simdModuleBytes() {
  const sec = (id, body) => [id, ...uleb(body.length), ...body];
  const name = (s) => [...uleb(s.length), ...Buffer.from(s)];
  const V = (op) => [0xfd, ...uleb(op)];
  const get = (i) => [0x20, i], set = (i) => [0x21, i], tee = (i) => [0x22, i];
  const i32 = (n) => [0x41, ...sleb(n)];
  const load = (off) => [...V(0x00), 0, ...uleb(off)]; // v128.load align=1
  const ADD = 0x6a, LT_U = 0x49, EQZ = 0x45, BR_IF = 0x0d, END = 0x0b, BLOCK_ = [0x02, 0x40], LOOP = [0x03, 0x40];
  const EXT_LO = 0x87, EXT_HI = 0x88, DOT = 0xba, I32X4_ADD = 0xae, LANE = 0x1b, CONST = 0x0c;
  // params 0 codes 1 n 2 q 3 out 4 dim | locals 5 i 6 j 7 p 8 qp : i32 | 9 acc 10 v : v128
  const body = [
    ...BLOCK_,
    ...get(1), EQZ, BR_IF, 0,
    ...get(0), ...set(7),
    ...LOOP,
    ...V(CONST), ...new Array(16).fill(0), ...set(9),
    ...i32(0), ...set(6),
    ...get(2), ...set(8),
    ...LOOP,
    ...get(7), ...load(0), ...set(10),
    ...get(9),
    ...get(10), ...V(EXT_LO), ...get(8), ...load(0), ...V(DOT), ...V(I32X4_ADD),
    ...get(10), ...V(EXT_HI), ...get(8), ...load(16), ...V(DOT), ...V(I32X4_ADD),
    ...set(9),
    ...get(7), ...i32(16), ADD, ...set(7),
    ...get(8), ...i32(32), ADD, ...set(8),
    ...get(6), ...i32(16), ADD, ...tee(6), ...get(4), LT_U, BR_IF, 0,
    END,
    ...get(3),
    ...get(9), ...V(LANE), 0, ...get(9), ...V(LANE), 1, ADD, ...get(9), ...V(LANE), 2, ADD, ...get(9), ...V(LANE), 3, ADD,
    0x36, 2, 0, // i32.store align=4
    ...get(3), ...i32(4), ADD, ...set(3),
    ...get(5), ...i32(1), ADD, ...tee(5), ...get(1), LT_U, BR_IF, 0,
    END,
    END,
    END,
  ];
  const fn = [2, 4, 0x7f, 2, 0x7b, ...body];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...sec(1, [1, 0x60, 5, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0]),
    ...sec(3, [1, 0]),
    ...sec(5, [1, 0, 1]),
    ...sec(7, [2, ...name('m'), 2, 0, ...name('dots'), 0, 0]),
    ...sec(10, [1, ...uleb(fn.length), ...fn]),
  ]);
}

let simdModule; // compiled once per process
function simdAvailable() {
  if (simdModule !== undefined) return !!simdModule;
  try {
    const bytes = simdModuleBytes();
    simdModule = typeof WebAssembly === 'object' && WebAssembly.validate(bytes) ? new WebAssembly.Module(bytes) : null;
  } catch { simdModule = null; }
  return !!simdModule;
}

/**
 * Kernel + its memory. Both kernels compute identical int32 results.
 * @param {'auto'|'wasm'|'js'} kind @param {number} bytes
 */
function createKernel(kind, bytes) {
  const pages = Math.ceil(bytes / 65536);
  if (kind !== 'js' && simdAvailable()) {
    const inst = new WebAssembly.Instance(simdModule);
    const mem = inst.exports.m;
    if (pages > 1) mem.grow(pages - 1);
    return { kind: 'wasm', buffer: mem.buffer, dots: inst.exports.dots };
  }
  if (kind === 'wasm') throw new Error('spbt-db vector: WebAssembly SIMD is not available');
  const buffer = new ArrayBuffer(pages * 65536);
  const m8 = new Int8Array(buffer), m16 = new Int16Array(buffer), m32 = new Int32Array(buffer);
  function dots(codes, n, q, out, dim) {
    const qi = q >> 1;
    let o = out >> 2;
    for (let i = 0, p = codes; i < n; i++, p += dim) {
      let a0 = 0, a1 = 0;
      for (let j = 0; j < dim; j += 8) {
        const c = p + j, k = qi + j;
        a0 += m8[c] * m16[k] + m8[c + 1] * m16[k + 1] + m8[c + 2] * m16[k + 2] + m8[c + 3] * m16[k + 3];
        a1 += m8[c + 4] * m16[k + 4] + m8[c + 5] * m16[k + 5] + m8[c + 6] * m16[k + 6] + m8[c + 7] * m16[k + 7];
      }
      m32[o++] = a0 + a1;
    }
  }
  return { kind: 'js', buffer, dots };
}

/* ---------------------------------------------------------------- helpers */

/**
 * Segment slots that fill the LMDB overflow pages a 64-slot segment already occupies
 * (LMDB: pages = floor((16 - 1 + size) / pageSize) + 1). d=256, 4 KiB pages: 77 slots in
 * 5 pages, 266 B/vector on disk instead of 320 B with 64 slots.
 */
export function autoSlots(dim, pageSize = 4096) {
  const rec = dim + 8, frame = 1;
  const pages = Math.floor((15 + frame + 64 * rec) / pageSize) + 1;
  return Math.max(64, Math.min(MAX_SLOTS, Math.floor((pages * pageSize - 16 - frame) / rec)));
}

/**
 * Quantise `vec` (optionally L2-normalised first) into int8 codes at dst[off..off+dim).
 * @returns {number} the scale (0 for an all-zero vector)
 */
export function quantize(vec, dst, off, dim, normalize = true) {
  let ss = 0, mx = 0;
  for (let j = 0; j < dim; j++) {
    const x = vec[j];
    ss += x * x;
    const a = x < 0 ? -x : x;
    if (a > mx) mx = a;
  }
  if (!Number.isFinite(ss)) throw new RangeError('spbt-db vector: vector has a NaN or infinite component');
  const inv = normalize && ss > 0 ? 1 / Math.sqrt(ss) : 1;
  mx *= inv;
  if (mx === 0) { dst.fill(0, off, off + dim); return 0; }
  const k = (127 / mx) * inv;
  for (let j = 0; j < dim; j++) dst[off + j] = Math.round(vec[j] * k); // Buffer stores the low byte: two's complement
  return mx / 127;
}

const today = () => Math.floor(Date.now() / DAY);
const SCOPES = { guild: 0, user: 1 };

/* ------------------------------------------------------------------ attach */

/**
 * @typedef {object} VectorOptions
 * @property {number} [dim=256]           vector dimension (multiple of 16)
 * @property {number|'auto'} [slots='auto']  vectors per segment for NEW guilds ('auto' = fill the
 *           LMDB overflow pages, 77 at d=256; 64 = the doc's layout). Stored per guild.
 * @property {number} [cacheBytes=4 MiB]  RAM budget of the decoded-guild LRU; 0 disables it
 * @property {'auto'|'wasm'|'js'} [kernel='auto']
 * @property {boolean} [normalize=true]   L2-normalise stored and query vectors (score = cosine)
 * @property {number} [chunkTtl]          ms; overrides the ai_chunk schema TTL (90 d) for new chunks
 */

/**
 * Attach the vector store to a db: opens ai_chunk / ai_vec / ai_quota and sets db.ai
 * (returns the existing db.ai if already attached).
 * @param {ReturnType<typeof import('./index.js').openDB>} db
 * @param {VectorOptions} [opts]
 */
export function attachVectors(db, opts = {}) {
  if (db.ai && db.ai.attached) return db.ai;
  db.ai = createVectorStore(db, opts);
  return db.ai;
}

/**
 * A vector store over db without assigning db.ai (several instances may share one db,
 * e.g. a cache-less one for tooling; each keeps its own RAM cache, validated by gen).
 * @param {ReturnType<typeof import('./index.js').openDB>} db
 * @param {VectorOptions} [opts]
 */
export function createVectorStore(db, opts = {}) {
  const dim = opts.dim ?? 256;
  if (!(Number.isInteger(dim) && dim >= 16 && dim % 16 === 0 && dim <= 4096)) throw new RangeError(`spbt-db vector: dim must be a multiple of 16 in [16, 4096], got ${dim}`);
  const chunks = db.collection('ai_chunk', aiSchemas.ai_chunk);
  const vecs = db.collection('ai_vec', aiSchemas.ai_vec);
  const quotaCol = db.collection('ai_quota', aiSchemas.ai_quota);
  const be = vecs.backend;
  const pageSize = (be.info && be.info().pageSize) || 4096;
  const slotsCfg = opts.slots === undefined || opts.slots === 'auto' ? autoSlots(dim, pageSize) : opts.slots;
  if (!(Number.isInteger(slotsCfg) && slotsCfg >= 1 && slotsCfg <= MAX_SLOTS)) throw new RangeError(`spbt-db vector: slots must be in [1, ${MAX_SLOTS}]`);
  const normalize = opts.normalize ?? true;
  const chunkTtl = opts.chunkTtl;
  const rec = dim + 8;
  const qmax = Math.min(32767, Math.floor(2147483647 / (dim * 127))); // int32 accumulator never overflows

  /* kernel memory: [Q int16 x dim][OUT int32 x BLOCK][SCRATCH 1 segment][ARENA cache] */
  const Q = 0;
  const OUT = align(2 * dim);
  const SCR = OUT + align(4 * BLOCK);
  const ARENA = SCR + align(MAX_SLOTS * rec);
  const ARENA_SIZE = Math.floor(Math.max(0, opts.cacheBytes ?? 4 * 2 ** 20) / A) * A;
  const kernel = createKernel(opts.kernel ?? 'auto', ARENA + ARENA_SIZE);
  const dots = kernel.dots;
  const mem = Buffer.from(kernel.buffer);
  const m16 = new Int16Array(kernel.buffer), m32 = new Int32Array(kernel.buffer);
  const f32 = new Float32Array(kernel.buffer), u32 = new Uint32Array(kernel.buffer);

  const tx = (fn) => (be.inTxn && be.inTxn() ? fn() : db.txn(fn));

  /* ---- keys: one reusable key buffer; every op sets the gid first */
  const kb = Buffer.alloc(10);
  const setGid = (gid) => writeU64(kb, 0, gid);
  const setSeg = (s) => { kb[8] = s >>> 8; kb[9] = s & 0xff; return kb; };
  /** volatile frame of segment s (or the header); payload starts at headerSize(f[0]) */
  const frameOf = (s) => vecs.getFrame(setSeg(s));

  function readMeta() {
    const f = frameOf(META_SEG);
    if (f === undefined) return null;
    const p = headerSize(f[0]);
    return { n: f.readUInt32LE(p), gen: f.readUInt32LE(p + 4), nextId: f.readUInt32LE(p + 8), dim: f.readUInt16LE(p + 12), slots: f.readUInt16LE(p + 14) };
  }
  function writeMeta(gid, m) {
    const b = Buffer.allocUnsafe(16);
    b.writeUInt32LE(m.n, 0); b.writeUInt32LE(m.gen, 4); b.writeUInt32LE(m.nextId, 8); b.writeUInt16LE(m.dim, 12); b.writeUInt16LE(m.slots, 14);
    vecs.put({ gid, seg: META_SEG, data: b });
  }
  function checkMeta(m) {
    if (m.dim !== dim) throw new Error(`spbt-db vector: guild stores dim ${m.dim}, this db.ai uses dim ${dim}`);
    if (m.slots < 1 || m.slots > MAX_SLOTS) throw new Error(`spbt-db vector: corrupt guild header (slots ${m.slots})`);
  }
  const segCount = (n, slots) => Math.ceil(n / slots);
  const segLen = (n, slots, s) => Math.min(slots, n - s * slots);

  /** Volatile frame of segment s, checked to hold exactly m vectors. */
  function segFrame(s, m) {
    const f = frameOf(s);
    if (f === undefined) throw new Error(`spbt-db vector: missing segment ${s}`);
    const p = headerSize(f[0]);
    if (f.length - p !== m * rec) throw new Error(`spbt-db vector: segment ${s} holds ${f.length - p} B, expected ${m * rec}`);
    return f;
  }

  /** Decoded copy of segment s (write paths). */
  function loadSeg(s, m, slots) {
    const f = segFrame(s, m), p = headerSize(f[0]);
    const seg = { m, codes: Buffer.allocUnsafe(slots * dim), scales: new Float32Array(slots), ids: new Uint32Array(slots) };
    f.copy(seg.codes, 0, p, p + m * dim);
    for (let i = 0; i < m; i++) {
      seg.scales[i] = f.readFloatLE(p + m * dim + 4 * i);
      seg.ids[i] = f.readUInt32LE(p + m * dim + 4 * m + 4 * i);
    }
    return seg;
  }
  function storeSeg(gid, s, seg, m) {
    const b = Buffer.allocUnsafe(m * rec);
    seg.codes.copy(b, 0, 0, m * dim);
    for (let i = 0; i < m; i++) {
      b.writeFloatLE(seg.scales[i], m * dim + 4 * i);
      b.writeUInt32LE(seg.ids[i], m * dim + 4 * m + 4 * i);
    }
    vecs.put({ gid, seg: s, data: b });
  }

  /** Visit every stored (position, chunkId) of the guild whose header is `m` (kb holds the gid). */
  function forEachId(m, fn) {
    const S = segCount(m.n, m.slots);
    for (let s = 0; s < S; s++) {
      const len = segLen(m.n, m.slots, s);
      const f = segFrame(s, len), p = headerSize(f[0]) + len * dim + 4 * len;
      for (let i = 0; i < len; i++) fn(s * m.slots + i, f.readUInt32LE(p + 4 * i));
    }
  }

  /* ---- RAM cache: LRU of whole guilds inside the kernel memory */
  /** @type {Map<string, { off: number, n: number, gen: number, size: number }>} */
  const cache = new Map();
  let used = 0, bump = 0, hits = 0, misses = 0;
  const forget = (ck) => { const e = cache.get(ck); if (e) { cache.delete(ck); used -= e.size; } };
  function cacheAlloc(size) {
    if (size > ARENA_SIZE) return -1;
    while (used + size > ARENA_SIZE) forget(cache.keys().next().value); // oldest first
    if (bump + size > ARENA_SIZE) { // compact: slide live entries down, in address order
      let p = ARENA;
      for (const e of [...cache.values()].sort((a, b) => a.off - b.off)) {
        if (e.off !== p) mem.copyWithin(p, e.off, e.off + e.size);
        e.off = p;
        p += e.size;
      }
      bump = p - ARENA;
    }
    const off = ARENA + bump;
    bump += size;
    used += size;
    return off;
  }
  /** Decode the whole guild into one SoA block at `off`. */
  function loadGuild(m, off) {
    const S = segCount(m.n, m.slots), sc = off + m.n * dim, id = sc + 4 * m.n;
    for (let s = 0; s < S; s++) {
      const len = segLen(m.n, m.slots, s), pos = s * m.slots;
      const f = segFrame(s, len), p = headerSize(f[0]);
      f.copy(mem, off + pos * dim, p, p + len * dim);
      f.copy(mem, sc + 4 * pos, p + len * dim, p + len * dim + 4 * len);
      f.copy(mem, id + 4 * pos, p + len * dim + 4 * len, p + len * rec);
    }
  }

  /* ---- top-k: min-heap of (score, chunkId) in typed arrays, reused across queries */
  let hs = new Float64Array(64), hi = new Uint32Array(64), hn = 0, hk = 0;
  function heapReset(k) {
    if (hs.length < k) { hs = new Float64Array(k); hi = new Uint32Array(k); }
    hn = 0; hk = k;
  }
  function siftDown(i) {
    const s = hs[i], d = hi[i];
    for (;;) {
      let c = 2 * i + 1;
      if (c >= hn) break;
      if (c + 1 < hn && hs[c + 1] < hs[c]) c++;
      if (hs[c] >= s) break;
      hs[i] = hs[c]; hi[i] = hi[c]; i = c;
    }
    hs[i] = s; hi[i] = d;
  }
  function heapPush(s, id) {
    let i = hn++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hs[p] <= s) break;
      hs[i] = hs[p]; hi[i] = hi[p]; i = p;
    }
    hs[i] = s; hi[i] = id;
  }
  /** Scan m vectors whose codes/scales/ids start at the given byte offsets of kernel memory. */
  function scan(codes, scales, ids, m) {
    const si = scales >> 2, ii = ids >> 2, oi = OUT >> 2;
    for (let b = 0; b < m; b += BLOCK) {
      const cnt = m - b < BLOCK ? m - b : BLOCK;
      dots(codes + b * dim, cnt, Q, OUT, dim);
      for (let i = 0; i < cnt; i++) {
        const s = m32[oi + i] * f32[si + b + i];
        if (hn < hk) heapPush(s, u32[ii + b + i]);
        else if (s > hs[0]) { hs[0] = s; hi[0] = u32[ii + b + i]; siftDown(0); }
      }
    }
  }

  /** Quantise the query into Q. @returns {number} factor turning heap scores into dot products */
  function setQuery(q) {
    if (!q || q.length !== dim) throw new RangeError(`spbt-db vector: query must have ${dim} components`);
    let ss = 0, mx = 0;
    for (let j = 0; j < dim; j++) { const x = q[j]; ss += x * x; const a = x < 0 ? -x : x; if (a > mx) mx = a; }
    if (!Number.isFinite(ss)) throw new RangeError('spbt-db vector: query has a NaN or infinite component');
    const inv = normalize && ss > 0 ? 1 / Math.sqrt(ss) : 1;
    mx *= inv;
    if (mx === 0) { m16.fill(0, Q >> 1, (Q >> 1) + dim); return 0; }
    const k = (qmax / mx) * inv;
    for (let j = 0; j < dim; j++) m16[(Q >> 1) + j] = Math.round(q[j] * k);
    return mx / qmax;
  }

  /** Fill the heap with the best `heapK` vectors of the guild (kb holds the gid). */
  function search(gidKey, m, heapK) {
    heapReset(heapK);
    let e = cache.get(gidKey);
    if (e && (e.gen !== m.gen || e.n !== m.n)) { forget(gidKey); e = undefined; }
    if (e) {
      hits++;
      cache.delete(gidKey); cache.set(gidKey, e); // LRU touch
    } else {
      misses++;
      const size = align(m.n * rec);
      // never cache inside a write txn: that state may still roll back
      const off = !(be.inTxn && be.inTxn()) ? cacheAlloc(size) : -1;
      if (off >= 0) {
        try { loadGuild(m, off); } catch (err) { used -= size; bump -= size; throw err; }
        e = { off, n: m.n, gen: m.gen, size };
        cache.set(gidKey, e);
      }
    }
    if (e) { scan(e.off, e.off + e.n * dim, e.off + e.n * dim + 4 * e.n, e.n); return; }
    const S = segCount(m.n, m.slots);
    for (let s = 0; s < S; s++) { // uncached: one segment at a time through the scratch
      const len = segLen(m.n, m.slots, s);
      const f = segFrame(s, len), p = headerSize(f[0]);
      f.copy(mem, SCR, p, p + len * rec);
      scan(SCR, SCR + len * dim, SCR + len * dim + 4 * len, len);
    }
  }

  /* ---- writes */

  function chunkWriteOpts(it) {
    if (it.expiresAt !== undefined) return { expiresAt: it.expiresAt };
    if (it.ttl !== undefined) return { ttl: it.ttl };
    return chunkTtl !== undefined ? { ttl: chunkTtl } : undefined;
  }

  /**
   * Add or replace many chunks of one guild in one txn. Each touched segment is written once.
   * @param {bigint|string|number} gid
   * @param {Array<{ chunkId?: number, vec: ArrayLike<number>, text?: string, meta?: object, ttl?: number, expiresAt?: number }>} items
   * @returns {number[]} chunk ids (allocated from the guild counter when chunkId is omitted)
   */
  function addMany(gid, items) {
    const ids = new Array(items.length);
    for (const it of items) if (!it.vec || it.vec.length !== dim) throw new RangeError(`spbt-db vector: vector must have ${dim} components`);
    tx(() => {
      setGid(gid);
      const m = readMeta() ?? { n: 0, gen: randomBytes(4).readUInt32LE(0), nextId: 1, dim, slots: slotsCfg };
      checkMeta(m);
      const slots = m.slots;
      /** @type {Map<number, object>} id -> item (last one wins) */
      const byId = new Map();
      for (let i = 0; i < items.length; i++) {
        let id = items[i].chunkId;
        if (id === undefined || id === null) {
          if (m.nextId >= U32) throw new RangeError('spbt-db vector: chunk id space exhausted');
          id = m.nextId++;
        } else {
          if (!(Number.isInteger(id) && id >= 0 && id < U32)) throw new RangeError(`spbt-db vector: chunkId must be a u32, got ${id}`);
          if (id >= m.nextId) m.nextId = Math.min(id + 1, U32 - 1);
        }
        ids[i] = id;
        byId.set(id, items[i]);
      }

      // replacements: chunks that already have a vector are rewritten in place
      /** @type {Map<number, Array<[number, object]>>} seg -> [[slot, item]] */
      const repl = new Map();
      if (m.n) {
        forEachId(m, (pos, id) => {
          const it = byId.get(id);
          if (!it) return;
          const s = Math.floor(pos / slots);
          if (!repl.has(s)) repl.set(s, []);
          repl.get(s).push([pos - s * slots, it]);
        });
      }
      const replaced = new Set();
      for (const [s, list] of repl) {
        const len = segLen(m.n, slots, s);
        const seg = loadSeg(s, len, slots);
        for (const [slot, it] of list) {
          seg.scales[slot] = quantize(it.vec, seg.codes, slot * dim, dim, normalize);
          replaced.add(it);
        }
        storeSeg(gid, s, seg, len);
      }

      // appends: fill the tail segment, then open new ones
      const add = [];
      for (const [id, it] of byId) if (!replaced.has(it)) add.push([id, it]);
      if (segCount(m.n + add.length, slots) > MAX_SEGS) throw new RangeError('spbt-db vector: guild is full');
      for (let k = 0; k < add.length;) {
        const s = Math.floor(m.n / slots), i0 = m.n - s * slots;
        const cnt = Math.min(slots - i0, add.length - k), len = i0 + cnt;
        const seg = i0 ? loadSeg(s, i0, slots) : { codes: Buffer.allocUnsafe(slots * dim), scales: new Float32Array(slots), ids: new Uint32Array(slots) };
        for (let t = 0; t < cnt; t++) {
          const [id, it] = add[k + t];
          seg.scales[i0 + t] = quantize(it.vec, seg.codes, (i0 + t) * dim, dim, normalize);
          seg.ids[i0 + t] = id;
        }
        storeSeg(gid, s, seg, len);
        m.n += cnt;
        k += cnt;
      }

      m.gen = (m.gen + 1) >>> 0;
      writeMeta(gid, m);
      for (const [id, it] of byId) chunks.put({ ...it.meta, gid, chunkId: id, text: it.text ?? '' }, chunkWriteOpts(it));
    });
    forget(String(gid));
    return ids;
  }

  /**
   * Remove vectors (and by default their chunk rows). Holes are filled with vectors moved
   * from the tail, so segments stay dense and only the touched segments plus the tail are
   * rewritten (one remove = at most 2 segment writes).
   * @returns {number} vectors removed
   */
  function removeMany(gid, chunkIds, o = {}) {
    const want = new Set();
    for (const id of chunkIds) want.add(Number(id));
    if (!want.size) return 0;
    const removed = tx(() => {
      if (o.chunks !== false) for (const id of want) rawChunkDel(gid, id);
      setGid(gid);
      const m = readMeta();
      if (!m || !m.n) return 0;
      checkMeta(m);
      const slots = m.slots, n = m.n;
      const holes = [];
      forEachId(m, (pos, id) => { if (want.has(id)) holes.push(pos); });
      if (!holes.length) return 0;
      const n2 = n - holes.length;
      const segs = new Map();
      const seg = (s) => { let x = segs.get(s); if (!x) segs.set(s, (x = loadSeg(s, segLen(n, slots, s), slots))); return x; };
      const holeSet = new Set(holes);
      const dirty = new Set();
      let src = n - 1;
      for (const p of holes) { // ascending
        if (p >= n2) break;
        while (holeSet.has(src)) src--;
        const a = seg(Math.floor(src / slots)), ai = src % slots;
        const ds = Math.floor(p / slots), d = seg(ds), di = p % slots;
        a.codes.copy(d.codes, di * dim, ai * dim, ai * dim + dim);
        d.scales[di] = a.scales[ai];
        d.ids[di] = a.ids[ai];
        dirty.add(ds);
        src--;
      }
      const S = segCount(n, slots), S2 = segCount(n2, slots);
      if (S2 > 0 && segLen(n2, slots, S2 - 1) !== segLen(n, slots, S2 - 1)) { seg(S2 - 1); dirty.add(S2 - 1); }
      for (const s of dirty) if (s < S2) storeSeg(gid, s, segs.get(s), segLen(n2, slots, s));
      for (let s = S2; s < S; s++) vecs.del(gid, s);
      m.n = n2;
      m.gen = (m.gen + 1) >>> 0;
      writeMeta(gid, m);
      return holes.length;
    });
    forget(String(gid));
    return removed;
  }

  /* ---- chunk rows: deleting a chunk (TTL sweeper, manual del) also removes its vector */
  const rawChunkDel = chunks.rawDel ?? chunks.del;
  const rawChunkDelByKey = chunks.rawDelByKey ?? chunks.delByKey;
  if (!chunks.rawDel) {
    chunks.rawDel = rawChunkDel;
    chunks.rawDelByKey = rawChunkDelByKey;
    chunks.del = (gid, chunkId) => tx(() => { const r = rawChunkDel(gid, chunkId); removeMany(gid, [chunkId], { chunks: false }); return r; });
    chunks.delByKey = (buf) => tx(() => {
      const k = chunks.decodeKey(buf);
      const r = rawChunkDelByKey(buf);
      removeMany(k.gid, [k.chunkId], { chunks: false });
      return r;
    });
  }

  /* ---- quota (§5.8): per-scope daily counter, atomic under the LMDB write lock */
  const scopeOf = (scope) => {
    const s = typeof scope === 'string' ? SCOPES[scope] : scope;
    if (s !== 0 && s !== 1) throw new RangeError(`spbt-db ai.quota: scope must be 'guild' | 'user' | 0 | 1, got ${scope}`);
    return s;
  };
  const quota = {
    SCOPES,
    /** Current UTC day ordinal (days since the epoch, fits u16 until 2149). */
    today,
    /**
     * Consume `n` units if that stays within `limit`. Rows expire 2 days after their day starts.
     * @param {'guild'|'user'|0|1} scope @param {bigint|string|number} id @param {number} [day=today()]
     * @param {number} limit @param {number} [n=1]
     * @returns {{ ok: boolean, used: number }}
     */
    use(scope, id, day, limit, n = 1) {
      const sc = scopeOf(scope), d = day ?? today();
      if (!(limit >= 0)) throw new RangeError('spbt-db ai.quota: limit is required');
      return tx(() => {
        const used = quotaCol.get(sc, id, d)?.used ?? 0;
        if (used + n > limit) return { ok: false, used };
        quotaCol.put({ scope: sc, id, day: d, used: used + n }, { expiresAt: (d + 2) * DAY });
        return { ok: true, used: used + n };
      });
    },
    /** Units used so far (0 if none or expired). */
    used(scope, id, day) { return quotaCol.get(scopeOf(scope), id, day ?? today())?.used ?? 0; },
  };

  /* ---- public API */
  const ai = {
    attached: true,
    dim,
    slots: slotsCfg,
    kernel: kernel.kind,
    chunks,
    vecs,
    quota,

    /** Add or replace one chunk. chunkId null/undefined = allocate. @returns {number} chunkId */
    add(gid, chunkId, vec, text, meta) {
      return addMany(gid, [{ chunkId, vec, text, meta }])[0];
    },
    addMany,

    /**
     * k nearest chunks by (cosine, when normalised) similarity, best first.
     * Chunks whose text row is gone (expired, not yet swept) are skipped.
     * @param {object} [o]  { text = true: fetch chunk text; minScore }
     * @returns {Array<{ chunkId: number, score: number, text?: string }>}
     */
    knn(gid, query, k = 8, o = {}) {
      if (!(Number.isInteger(k) && k > 0)) throw new RangeError('spbt-db vector: k must be a positive integer');
      setGid(gid);
      const m = readMeta();
      if (!m || !m.n) return [];
      checkMeta(m);
      const qf = setQuery(query);
      const gidKey = String(gid);
      const withText = o.text !== false;
      for (let heapK = withText ? k + 4 : k; ; heapK *= 4) {
        search(gidKey, m, Math.min(heapK, m.n));
        const n = hn;
        const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => hs[b] - hs[a] || hi[a] - hi[b]);
        const out = [];
        let missing = 0;
        for (const i of order) {
          const score = hs[i] * qf;
          if (o.minScore !== undefined && score < o.minScore) break;
          const r = { chunkId: hi[i], score };
          if (withText) {
            const c = chunks.get(gid, r.chunkId);
            if (!c) { missing++; continue; }
            r.text = c.text;
          }
          out.push(r);
          if (out.length === k) break;
        }
        if (out.length === k || !missing || heapK >= m.n) return out;
        setGid(gid);
      }
    },

    /** Remove one chunk and its vector. @returns {boolean} */
    remove(gid, chunkId) { return removeMany(gid, [chunkId]) > 0; },
    removeMany,

    /** Vectors stored for a guild. */
    count(gid) { setGid(gid); return readMeta()?.n ?? 0; },

    /** Chunk row: { text, srcChannelId, ... } or undefined. */
    chunk(gid, chunkId) { return chunks.get(gid, chunkId); },

    /** Chunk ids in storage order. */
    ids(gid) {
      setGid(gid);
      const m = readMeta();
      const out = [];
      if (m && m.n) forEachId(m, (_, id) => out.push(id));
      return out;
    },

    /** Remove vectors whose chunk row is missing or expired. @returns {number} removed */
    sweep(gid) {
      const dead = ai.ids(gid).filter((id) => !chunks.has(gid, id));
      return dead.length ? removeMany(gid, dead) : 0;
    },

    /** Delete every vector and chunk of a guild. */
    dropGuild(gid) {
      tx(() => {
        setGid(gid);
        const m = readMeta();
        if (m) for (let s = segCount(m.n, m.slots) - 1; s >= 0; s--) vecs.del(gid, s);
        vecs.del(gid, META_SEG);
        const cdbi = chunks.backend.openCollection('ai_chunk', {});
        const lo = chunks.keyOf(gid);
        const keys = [];
        for (const { key } of chunks.backend.range(cdbi, { start: lo, end: prefixEnd(lo) })) keys.push(key);
        for (const key of keys) rawChunkDelByKey(key);
      });
      forget(String(gid));
    },

    /** Drop a guild from the RAM cache (e.g. after writes by another process; gen checks catch those anyway). */
    invalidate(gid) { if (gid === undefined) { cache.clear(); used = 0; bump = 0; } else forget(String(gid)); },

    stats() {
      return { kernel: kernel.kind, dim, slots: slotsCfg, cacheBytes: ARENA_SIZE, cacheUsed: used, cachedGuilds: cache.size, hits, misses };
    },
  };
  return ai;
}

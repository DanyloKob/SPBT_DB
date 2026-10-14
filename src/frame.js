// SPBT_DB record frame (design §4.3).
//
//  byte 0   1..2               ..+6               ..+6               rest
// ┌──────┬───────────────────┬──────────────────┬──────────────────┬─────────┐
// │ HDR  │ schemaId u16 LE ? │ updatedAt u48 LE?│ expiresAt u48 LE?│ PAYLOAD │
// └──────┴───────────────────┴──────────────────┴──────────────────┴─────────┘
// HDR bits 7..5 FRAME_VER (=1), 4 HAS_SCHEMA, 3 HAS_MTIME, 2 HAS_TTL, 1..0 CODEC
//   CODEC 0 msgpackr (shared structures per collection when a store is given)
//         1 deflate-raw(msgpackr)   - see README: lmdb-js only exposes LZ4 as a
//                                     transparent per-DBI option, not as a function
//         2 raw bytes
//         3 varint-packed unsigned/zigzag integers (LEB128, declared field order)
//
// Readers treat a frame whose expiresAt <= now as absent.

import { Packr, RESERVE_START_SPACE, pack as plainPack, unpack as plainUnpack } from 'msgpackr';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const FRAME_VER = 1;
export const HAS_SCHEMA = 0x10;
export const HAS_MTIME = 0x08;
export const HAS_TTL = 0x04;
export const CODEC_MASK = 0x03;
export const CODEC = Object.freeze({ msgpack: 0, deflate: 1, raw: 2, varint: 3 });

const VER_BITS = FRAME_VER << 5;
const U32 = 0x100000000;
const U48_MAX = 0xffffffffffff;

/* ------------------------------------------------------------ header i/o */

/** Header byte length for a given HDR byte. */
export const headerSize = (hdr) => 1 + (hdr & HAS_SCHEMA ? 2 : 0) + (hdr & HAS_MTIME ? 6 : 0) + (hdr & HAS_TTL ? 6 : 0);

function writeU48LE(b, o, n) {
  const lo = n >>> 0, hi = (n / U32) >>> 0;
  b[o] = lo & 0xff; b[o + 1] = (lo >>> 8) & 0xff; b[o + 2] = (lo >>> 16) & 0xff; b[o + 3] = lo >>> 24;
  b[o + 4] = hi & 0xff; b[o + 5] = hi >>> 8;
}
const readU48LE = (b, o) =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000 + (b[o + 4] | (b[o + 5] << 8)) * U32;

function writeHeader(b, hdr, schemaId, updatedAt, expiresAt) {
  b[0] = hdr;
  let o = 1;
  if (hdr & HAS_SCHEMA) { b[1] = schemaId & 0xff; b[2] = schemaId >>> 8; o = 3; }
  if (hdr & HAS_MTIME) { writeU48LE(b, o, updatedAt); o += 6; }
  if (hdr & HAS_TTL) writeU48LE(b, o, expiresAt);
}

function checkFrame(b) {
  if (!b || b.length < 1 || b[0] >> 5 !== FRAME_VER) throw new Error(`spbt-db frame: unknown frame version (hdr=${b && b[0]})`);
}

/** expiresAt in ms, or 0 if the frame has no TTL. */
export function frameExpiresAt(b) {
  const hdr = b[0];
  if (!(hdr & HAS_TTL)) return 0;
  return readU48LE(b, 1 + (hdr & HAS_SCHEMA ? 2 : 0) + (hdr & HAS_MTIME ? 6 : 0));
}

/** True if the frame carries a TTL that is <= now. */
export function isExpired(b, now = Date.now()) {
  return (b[0] & HAS_TTL) !== 0 && frameExpiresAt(b) <= now;
}

/**
 * Parse header fields (allocates one small object - not for the hot path).
 * @param {Uint8Array} b
 * @returns {{ version: number, codec: number, schemaId: number, updatedAt: number, expiresAt: number, payloadOffset: number }}
 */
export function frameInfo(b) {
  checkFrame(b);
  const hdr = b[0];
  let o = 1, schemaId = 0, updatedAt = 0, expiresAt = 0;
  if (hdr & HAS_SCHEMA) { schemaId = b[1] | (b[2] << 8); o = 3; }
  if (hdr & HAS_MTIME) { updatedAt = readU48LE(b, o); o += 6; }
  if (hdr & HAS_TTL) { expiresAt = readU48LE(b, o); o += 6; }
  return { version: hdr >> 5, codec: hdr & CODEC_MASK, schemaId, updatedAt, expiresAt, payloadOffset: o };
}

/** schemaId of a frame (0 when HAS_SCHEMA is unset). */
export const frameSchemaId = (b) => (b[0] & HAS_SCHEMA ? b[1] | (b[2] << 8) : 0);

/* ----------------------------------------------------------------- varint */

/** @typedef {{ name: string, kind: 0|1|2 }} VarField  0 uint, 1 sint (zigzag), 2 bool */

function varintSize(n) {
  let s = 1;
  while (n >= 0x80) { n = n < 0x80000000 ? n >>> 7 : Math.floor(n / 128); s++; }
  return s;
}
function writeVarint(b, o, n) {
  while (n >= 0x80) {
    b[o++] = (n & 0x7f) | 0x80; // & keeps the low 32 bits exactly, low 7 are what we need
    n = n < 0x80000000 ? n >>> 7 : Math.floor(n / 128);
  }
  b[o++] = n;
  return o;
}
function toVarint(f, v) {
  if (f.kind === 2) return v ? 1 : 0;
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || v % 1 !== 0 || !(v <= Number.MAX_SAFE_INTEGER && v >= -Number.MAX_SAFE_INTEGER))
    throw new RangeError(`spbt-db frame: varint field ${f.name}=${v} is not a safe integer`);
  if (f.kind === 1) return v >= 0 ? v * 2 : -v * 2 - 1;
  if (v < 0) throw new RangeError(`spbt-db frame: varint field ${f.name}=${v} is negative (declare it {type:'sint'})`);
  return v;
}

/** @param {Array<string | {name: string, type?: 'uint'|'sint'|'bool'}>} fields */
export function parseVarFields(fields) {
  if (!Array.isArray(fields) || !fields.length) throw new TypeError('spbt-db frame: varint codec needs `fields`');
  return fields.map((f) => {
    if (typeof f === 'string') return { name: f, kind: 0 };
    const kind = { uint: 0, sint: 1, bool: 2 }[f.type ?? 'uint'];
    if (kind === undefined) throw new TypeError(`spbt-db frame: bad varint type ${f.type}`);
    return { name: f.name, kind };
  });
}

/* ------------------------------------------------------------------ codec */

/**
 * Persistence for msgpackr shared structures. `save` must atomically check
 * `isCompatible(existing)` against what is stored and persist only if it passes
 * (use `saveIfCompatible`). Returning false makes msgpackr reload and retry.
 * @typedef {object} StructureStore
 * @property {() => any[] | undefined} load
 * @property {(structures: any[], isCompatible: ((existing: any) => boolean) | number) => boolean} save
 */

/**
 * Helper for StructureStore.save implementations.
 * @param {any[] | undefined} existing  what is currently persisted
 * @param {((existing: any) => boolean) | number} isCompatible  as handed in by msgpackr
 */
export function structuresCompatible(existing, isCompatible) {
  return typeof isCompatible === 'function' ? isCompatible(existing) : !existing || existing.length === isCompatible;
}
export const packStructures = (s) => plainPack(Array.prototype.slice.call(s));
export const unpackStructures = (b) => plainUnpack(b);

/**
 * @typedef {object} CodecOptions
 * @property {'msgpack'|'varint'|'raw'} [codec='msgpack']
 * @property {Array<string|{name:string,type?:'uint'|'sint'|'bool'}>} [fields]  varint: field order
 * @property {boolean | {threshold?: number, level?: number, dictionary?: Buffer}} [compress]
 *           msgpack only: frames whose msgpack payload is >= threshold (default 512 B) are
 *           stored deflated (CODEC 1) when that is smaller
 * @property {number} [schemaId]   u16; when set every frame carries HAS_SCHEMA
 * @property {boolean} [mtime]     stamp updatedAt on every encode
 * @property {number} [ttl]        default time-to-live in ms (per-call ttl/expiresAt override)
 * @property {StructureStore} [structures]  msgpack: enables shared structures
 * @property {number} [maxSharedStructures=32]  msgpack: >32 switches to 2-byte record ids
 * @property {string} [rawField]   raw: if set, encode takes value[rawField] and decode returns { [rawField]: bytes }
 */

/**
 * @typedef {object} EncodeOptions
 * @property {number} [ttl]        ms from now
 * @property {number} [expiresAt]  absolute ms; 0 = never
 * @property {number} [updatedAt]
 * @property {number} [now]
 */

/**
 * @typedef {object} FrameCodec
 * @property {number} codec                    CODEC id written for small payloads
 * @property {VarField[] | null} fields        varint fields
 * @property {(value: any, o?: EncodeOptions) => Buffer} encode
 * @property {(frame: Uint8Array, now?: number) => any} decode     undefined if expired
 * @property {(frame: Uint8Array) => any} decodeAny                 ignores TTL
 * @property {(frame: Uint8Array) => Uint8Array} payloadView        raw codec: volatile view
 * @property {() => void} reset   forget in-memory shared structures (call after a txn that saved them aborted)
 */

/**
 * Build the encoder/decoder for one collection.
 * @param {CodecOptions} [opts]
 * @returns {FrameCodec}
 */
export function createCodec(opts = {}) {
  const kind = opts.codec ?? 'msgpack';
  const codecId = CODEC[kind];
  if (codecId === undefined || codecId === CODEC.deflate) throw new TypeError(`spbt-db frame: codec must be msgpack|varint|raw, got ${kind}`);
  const schemaId = opts.schemaId;
  if (schemaId !== undefined && (schemaId & 0xffff) !== schemaId) throw new RangeError('spbt-db frame: schemaId must be u16');
  const baseHdr = VER_BITS | (schemaId !== undefined ? HAS_SCHEMA : 0) | (opts.mtime ? HAS_MTIME : 0);
  const defaultTtl = opts.ttl ?? 0;
  const fields = kind === 'varint' ? parseVarFields(opts.fields) : null;
  const rawField = opts.rawField;

  let zThreshold = Infinity, zOpts = null, unzOpts = undefined;
  if (opts.compress) {
    if (kind !== 'msgpack') throw new TypeError('spbt-db frame: compress applies to the msgpack codec only');
    const c = opts.compress === true ? {} : opts.compress;
    zThreshold = c.threshold ?? 512;
    zOpts = { level: c.level ?? 6 };
    if (c.dictionary) { zOpts.dictionary = c.dictionary; unzOpts = { dictionary: c.dictionary }; }
  }

  /* msgpack packer: shared structures when a store is provided */
  const store = opts.structures;
  let packr = null;
  function makePackr() {
    if (kind !== 'msgpack') return null;
    if (!store) return new Packr({ useRecords: false, copyBuffers: true });
    return new Packr({
      getStructures: () => store.load(),
      saveStructures: (s, isCompatible) => store.save(s, isCompatible),
      maxSharedStructures: opts.maxSharedStructures ?? 32,
      copyBuffers: true, // frames may come from lmdb's reusable getBinaryFast buffer
    });
  }
  packr = makePackr();
  const unpackOpts = { start: 0, end: 0 }; // reused: no per-decode allocation

  function hdrFor(o, now) {
    let expiresAt = 0;
    if (o) {
      if (o.expiresAt !== undefined) expiresAt = o.expiresAt;
      else if (o.ttl) expiresAt = (o.now ?? now()) + o.ttl;
      else if (defaultTtl) expiresAt = (o.now ?? now()) + defaultTtl;
    } else if (defaultTtl) expiresAt = now() + defaultTtl;
    if (expiresAt && !(expiresAt > 0 && expiresAt <= U48_MAX)) throw new RangeError(`spbt-db frame: bad expiresAt ${expiresAt}`);
    tmpExpires = expiresAt;
    return baseHdr | (expiresAt ? HAS_TTL : 0);
  }
  let tmpExpires = 0;
  const now = Date.now;

  function encode(value, o) {
    let hdr = hdrFor(o, now);
    const expiresAt = tmpExpires;
    const updatedAt = hdr & HAS_MTIME ? (o && o.updatedAt) ?? (o && o.now) ?? now() : 0;
    const hl = headerSize(hdr);
    let out;
    if (codecId === CODEC.msgpack) {
      out = packr.pack(value, RESERVE_START_SPACE | hl); // header bytes reserved in place: no copy
      if (out.length - hl >= zThreshold) {
        const z = deflateRawSync(out.subarray(hl), zOpts);
        if (z.length < out.length - hl) {
          const f = Buffer.allocUnsafe(hl + z.length);
          f.set(z, hl);
          out = f;
          hdr |= CODEC.deflate;
        }
      }
    } else if (codecId === CODEC.varint) {
      let size = hl;
      for (let i = 0; i < fields.length; i++) size += varintSize(toVarint(fields[i], value[fields[i].name]));
      out = Buffer.allocUnsafe(size);
      let p = hl;
      for (let i = 0; i < fields.length; i++) p = writeVarint(out, p, toVarint(fields[i], value[fields[i].name]));
      hdr |= CODEC.varint;
    } else {
      const bytes = rawField ? value[rawField] : value;
      if (!(bytes instanceof Uint8Array)) throw new TypeError('spbt-db frame: raw codec needs a Uint8Array');
      out = Buffer.allocUnsafe(hl + bytes.length);
      out.set(bytes, hl);
      hdr |= CODEC.raw;
    }
    writeHeader(out, hdr, schemaId, updatedAt, expiresAt);
    return out;
  }

  function decodeAny(b) {
    const hdr = b[0];
    if (hdr >> 5 !== FRAME_VER) checkFrame(b);
    const start = headerSize(hdr);
    const end = b.length; // NB: lmdb fast buffers override .length; never rely on subarray(start) alone
    switch (hdr & CODEC_MASK) {
      case 0:
        unpackOpts.start = start; unpackOpts.end = end;
        return (packr || (packr = new Packr({ useRecords: false }))).unpack(b, unpackOpts);
      case 1: {
        const raw = inflateRawSync(b.subarray(start, end), unzOpts);
        return (packr || (packr = new Packr({ useRecords: false }))).unpack(raw);
      }
      case 2: {
        const copy = Buffer.allocUnsafe(end - start);
        copy.set(b.subarray(start, end));
        return rawField ? { [rawField]: copy } : copy;
      }
      default: {
        const fs = fields || [];
        const out = {};
        let p = start;
        for (let i = 0; i < fs.length; i++) {
          let n = 0;
          if (p < end) {
            let mul = 1, byte;
            do { byte = b[p++]; n += (byte & 0x7f) * mul; mul *= 128; } while (byte & 0x80);
          } // missing trailing fields (older, shorter frames) read as 0
          const f = fs[i];
          out[f.name] = f.kind === 0 ? n : f.kind === 1 ? (n % 2 ? -(n + 1) / 2 : n / 2) : n !== 0;
        }
        return out;
      }
    }
  }

  return {
    codec: codecId,
    fields,
    encode,
    decodeAny,
    decode(b, t) {
      if (b[0] & HAS_TTL && frameExpiresAt(b) <= (t ?? now())) return undefined;
      return decodeAny(b);
    },
    payloadView(b) {
      if ((b[0] & CODEC_MASK) !== CODEC.raw) throw new TypeError('spbt-db frame: payloadView needs a raw frame');
      return b.subarray(headerSize(b[0]), b.length);
    },
    reset() { packr = makePackr(); },
  };
}

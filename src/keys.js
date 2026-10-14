// SPBT_DB key codec (design §4.2): order-preserving binary keys.
//
// Invariant: for any two tuples of the same schema, Buffer.compare(enc(a), enc(b))
// has the same sign as the logical comparison of a and b. Therefore everything is
// big-endian and fixed-width; the only variable-width type is `str`, which is
// escaped and terminated so that prefix ordering stays valid.
//
//   u8 u16 u24 u32 u48 u64   unsigned big-endian
//   inv32 inv48              (max - n), gives descending order under an ascending scan
//   str                      UTF-8, 0x00 -> 0x00 0xFF, terminator 0x00 0x00
//   bN (b6, b16, ...)        fixed N raw bytes (hashes, scheme ids)
//
// u64 accepts bigint | decimal string | safe integer number and decodes to bigint;
// `u64s` is the same on disk but decodes to a decimal string (discord.js style ids).
//
// Hot paths write into a reusable scratch buffer and copy exactly once at the end.

const MAX_KEY = 1978; // lmdb-js maxKeySize at pageSize 4096 (README "Keys")
const U32 = 0x100000000;
const U48_MAX = 0xffffffffffff;

/* ------------------------------------------------------------------ writers */
// Every writer: (buf, off, value) -> new offset. No allocation.

function badValue(type, v) {
  return new RangeError(`spbt-db key: ${typeof v} ${String(v)} is not a valid ${type}`);
}

export function writeU8(b, o, n) {
  if ((n & 0xff) !== n) throw badValue('u8', n);
  b[o] = n;
  return o + 1;
}
export function writeU16(b, o, n) {
  if ((n & 0xffff) !== n) throw badValue('u16', n);
  b[o] = n >>> 8; b[o + 1] = n & 0xff;
  return o + 2;
}
export function writeU24(b, o, n) {
  if ((n & 0xffffff) !== n) throw badValue('u24', n);
  b[o] = n >>> 16; b[o + 1] = (n >>> 8) & 0xff; b[o + 2] = n & 0xff;
  return o + 3;
}
export function writeU32(b, o, n) {
  if (n >>> 0 !== n) throw badValue('u32', n);
  b[o] = n >>> 24; b[o + 1] = (n >>> 16) & 0xff; b[o + 2] = (n >>> 8) & 0xff; b[o + 3] = n & 0xff;
  return o + 4;
}
export function writeU48(b, o, n) {
  if (typeof n !== 'number' || !(n >= 0 && n <= U48_MAX) || n % 1 !== 0) throw badValue('u48', n);
  const hi = (n / U32) >>> 0;
  const lo = n >>> 0;
  b[o] = hi >>> 8; b[o + 1] = hi & 0xff;
  b[o + 2] = lo >>> 24; b[o + 3] = (lo >>> 16) & 0xff; b[o + 4] = (lo >>> 8) & 0xff; b[o + 5] = lo & 0xff;
  return o + 6;
}
export function writeInv32(b, o, n) {
  if (n >>> 0 !== n) throw badValue('inv32', n);
  return writeU32(b, o, (0xffffffff - n) >>> 0);
}
export function writeInv48(b, o, n) {
  if (typeof n !== 'number' || !(n >= 0 && n <= U48_MAX) || n % 1 !== 0) throw badValue('inv48', n);
  return writeU48(b, o, U48_MAX - n);
}

// bigint <-> 8 bytes through one module-level DataView: DataView#setBigUint64 is ~4x
// faster than Buffer#writeBigUInt64BE on Node 22, and an 8-byte copy is ~free.
const B8 = new Uint8Array(8);
const DV8 = new DataView(B8.buffer);

function put32(b, o, x) {
  b[o] = x >>> 24; b[o + 1] = (x >>> 16) & 0xff; b[o + 2] = (x >>> 8) & 0xff; b[o + 3] = x & 0xff;
}

/** u64 from bigint | decimal string | non-negative safe integer. */
export function writeU64(b, o, v) {
  switch (typeof v) {
    case 'string': {
      // Decimal -> (hi, lo) in 4-digit chunks: lo * 1e4 < 2^46, so all math stays exact.
      const len = v.length;
      if (len === 0 || len > 20) throw badValue('u64', v);
      let hi = 0, lo = 0, i = 0;
      while (i < len) {
        const end = i + 4 < len ? i + 4 : len;
        let chunk = 0, mul = 1;
        for (; i < end; i++) {
          const c = v.charCodeAt(i) - 48;
          if (c < 0 || c > 9) throw badValue('u64', v);
          chunk = chunk * 10 + c;
          mul *= 10;
        }
        const l = lo * mul + chunk;
        const carry = Math.floor(l / U32);
        lo = l - carry * U32;
        hi = hi * mul + carry;
        if (hi >= U32) throw badValue('u64', v);
      }
      put32(b, o, hi); put32(b, o + 4, lo);
      return o + 8;
    }
    case 'bigint':
      if (v < 0n || v > 0xffffffffffffffffn) throw badValue('u64', v);
      DV8.setBigUint64(0, v);
      b[o] = B8[0]; b[o + 1] = B8[1]; b[o + 2] = B8[2]; b[o + 3] = B8[3];
      b[o + 4] = B8[4]; b[o + 5] = B8[5]; b[o + 6] = B8[6]; b[o + 7] = B8[7];
      return o + 8;
    case 'number':
      if (!(v >= 0 && v <= Number.MAX_SAFE_INTEGER) || v % 1 !== 0) throw badValue('u64', v);
      put32(b, o, (v / U32) >>> 0); put32(b, o + 4, v >>> 0);
      return o + 8;
    default:
      throw badValue('u64', v);
  }
}

/** UTF-8 + escape(0x00 -> 0x00 0xFF) + terminator 0x00 0x00. Needs up to s.length*3+2 bytes. */
export function writeStr(b, o, s) {
  if (typeof s !== 'string') throw badValue('str', s);
  const n = b.utf8Write(s, o);
  if (s.indexOf('\0') !== -1) {
    // UTF-8 only produces 0x00 for U+0000, so escaping is a right-to-left byte shift.
    let zeros = 0;
    for (let i = o; i < o + n; i++) if (b[i] === 0) zeros++;
    let r = o + n - 1, w = r + zeros;
    for (; r >= o; r--) {
      if (b[r] === 0) { b[w--] = 0xff; b[w--] = 0; } else b[w--] = b[r];
    }
    o += n + zeros;
  } else o += n;
  b[o] = 0; b[o + 1] = 0;
  return o + 2;
}

export function writeBytes(b, o, src, n) {
  if (!(src instanceof Uint8Array) || (n !== undefined && src.length !== n)) throw badValue(n ? `b${n}` : 'bytes', src);
  b.set(src, o);
  return o + src.length;
}

/* ------------------------------------------------------------------ readers */

export const readU8 = (b, o) => b[o];
export const readU16 = (b, o) => (b[o] << 8) | b[o + 1];
export const readU24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
export const readU32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
export const readU48 = (b, o) => ((b[o] << 8) | b[o + 1]) * U32 + readU32(b, o + 2);
export const readInv32 = (b, o) => (0xffffffff - readU32(b, o)) >>> 0;
export const readInv48 = (b, o) => U48_MAX - readU48(b, o);
export function readU64(b, o) {
  B8[0] = b[o]; B8[1] = b[o + 1]; B8[2] = b[o + 2]; B8[3] = b[o + 3];
  B8[4] = b[o + 4]; B8[5] = b[o + 5]; B8[6] = b[o + 6]; B8[7] = b[o + 7];
  return DV8.getBigUint64(0);
}
export function readU64s(b, o) {
  const hi = readU32(b, o);
  // below 2^53 a Number round-trips exactly and is cheaper than BigInt
  return hi < 0x200000 ? String(hi * U32 + readU32(b, o + 4)) : readU64(b, o).toString();
}

/** End offset (exclusive, after terminator) of an escaped str starting at o. */
export function strEnd(b, o, end = b.length) {
  for (let i = o; i < end; i++) {
    if (b[i] === 0) {
      if (b[i + 1] === 0) return i + 2;
      i++; // 0x00 0xFF escape
    }
  }
  throw new RangeError('spbt-db key: unterminated str');
}
export function readStr(b, o, end = b.length) {
  const e = strEnd(b, o, end);
  let hasEsc = false;
  for (let i = o; i < e - 2; i++) if (b[i] === 0) { hasEsc = true; break; }
  if (!hasEsc) return b.utf8Slice(o, e - 2);
  const out = Buffer.allocUnsafe(e - 2 - o);
  let w = 0;
  for (let i = o; i < e - 2; i++) { out[w++] = b[i]; if (b[i] === 0) i++; }
  return out.utf8Slice(0, w);
}

/* ------------------------------------------------------------- type table */

/**
 * @typedef {'u8'|'u16'|'u24'|'u32'|'u48'|'u64'|'u64s'|'inv32'|'inv48'|'str'|`b${number}`} KeyType
 * @typedef {{ name: string, type: KeyType, size: number }} KeyField  size = -1 for str
 */

const FIXED = { u8: 1, u16: 2, u24: 3, u32: 4, u48: 6, u64: 8, u64s: 8, inv32: 4, inv48: 6 };
const WRITERS = { u8: writeU8, u16: writeU16, u24: writeU24, u32: writeU32, u48: writeU48, u64: writeU64, u64s: writeU64, inv32: writeInv32, inv48: writeInv48 };
const READERS = { u8: readU8, u16: readU16, u24: readU24, u32: readU32, u48: readU48, u64: readU64, u64s: readU64s, inv32: readInv32, inv48: readInv48 };

/** Byte size of a type, -1 for variable (str). */
export function typeSize(type) {
  if (type in FIXED) return FIXED[type];
  if (type === 'str') return -1;
  const m = /^b(\d+)$/.exec(type);
  if (m && +m[1] > 0 && +m[1] <= 511) return +m[1];
  throw new TypeError(`spbt-db key: unknown type ${type}`);
}

function writeField(b, o, f, v) {
  if (f.size === -1) return writeStr(b, o, v);
  const w = WRITERS[f.type];
  return w ? w(b, o, v) : writeBytes(b, o, v, f.size);
}
function readField(b, o, f) {
  const r = READERS[f.type];
  if (r) return r(b, o);
  if (f.size === -1) return readStr(b, o);
  return Buffer.from(b.subarray(o, o + f.size));
}

/**
 * Straight-line encoders/decoders for an all-fixed-size tuple, generated once per tuple.
 * The generic loop costs ~130 ns for two u64 fields (a dictionary lookup of the writer per
 * field, size hints, a polymorphic call site shared by every tuple); a generated function has
 * its own monomorphic call sites and constant offsets: ~35 ns. Only field NAMES reach the
 * generated source, as JSON string literals, and offsets/arity are numbers.
 */
function compileFixed(fields) {
  const n = fields.length;
  const ws = fields.map((f) => WRITERS[f.type] ?? ((b, o, v) => writeBytes(b, o, v, f.size)));
  const rs = fields.map((f) => READERS[f.type] ?? ((b, o) => Buffer.from(b.subarray(o, o + f.size))));
  const offs = [];
  let off = 0;
  for (const f of fields) { offs.push(off); off += f.size; }
  const args = fields.map((_, i) => `v${i}`).join(', ');
  const wNames = fields.map((_, i) => `w${i}`), rNames = fields.map((_, i) => `r${i}`);
  const put = (src) => fields.map((_, i) => `w${i}(b, ${offs[i]}, ${src(i)});`).join(' ');
  const gen = (body) => new Function(...wNames, ...rNames, `'use strict'; return ${body};`)(...ws, ...rs);
  return {
    /** (b, v0, v1, ...) -> b */
    args: gen(`function encodeArgs(b, ${args}) { ${put((i) => `v${i}`)} return b; }`),
    /** (values, b) -> b */
    arr: gen(`function encodeArr(v, b) { ${put((i) => `v[${i}]`)} return b; }`),
    /** (rec, b) -> b | undefined when a field is null/undefined */
    rec: gen(`function encodeRec(r, b) { ${fields.map((f, i) => `const v${i} = r[${JSON.stringify(f.name)}]; if (v${i} === undefined || v${i} === null) return undefined;`).join(' ')} ${put((i) => `v${i}`)} return b; }`),
    /** (buf, obj, off) -> obj, all fields */
    dec: gen(`function decodeAll(b, o, off) { ${fields.map((f, i) => `o[${JSON.stringify(f.name)}] = r${i}(b, off + ${offs[i]});`).join(' ')} return o; }`),
    n,
  };
}

/* --------------------------------------------------------------- scratch */

let scratch = Buffer.allocUnsafeSlow(4096);
function ensure(n) {
  if (scratch.length < n) {
    const next = Buffer.allocUnsafeSlow(Math.max(n, scratch.length * 2));
    scratch.copy(next); // the builder may be mid-chain
    scratch = next;
  }
  return scratch;
}

/** Copy b[0..n) into a fresh Buffer (one alloc, pooled for small sizes). */
function copyOut(b, n) {
  if (n > MAX_KEY) throw new RangeError(`spbt-db key: ${n} bytes exceeds max key size ${MAX_KEY}`);
  const out = Buffer.allocUnsafe(n);
  b.copy(out, 0, 0, n);
  return out;
}

/* ----------------------------------------------------------------- builder */

/**
 * Fluent key builder over a shared scratch buffer:
 *   key().u64(gid).u64(uid).done()     -> Buffer (copied)
 *   key().u64(gid).view()              -> scratch view, valid until the next key()/tuple call
 * `key()` resets and returns a module singleton - do not nest key() calls inside a chain.
 */
const builder = {
  o: 0,
  u8(n) { this.o = writeU8(ensure(this.o + 1), this.o, n); return this; },
  u16(n) { this.o = writeU16(ensure(this.o + 2), this.o, n); return this; },
  u24(n) { this.o = writeU24(ensure(this.o + 3), this.o, n); return this; },
  u32(n) { this.o = writeU32(ensure(this.o + 4), this.o, n); return this; },
  u48(n) { this.o = writeU48(ensure(this.o + 6), this.o, n); return this; },
  u64(v) { this.o = writeU64(ensure(this.o + 8), this.o, v); return this; },
  inv32(n) { this.o = writeInv32(ensure(this.o + 4), this.o, n); return this; },
  inv48(n) { this.o = writeInv48(ensure(this.o + 6), this.o, n); return this; },
  str(s) { this.o = writeStr(ensure(this.o + s.length * 3 + 2), this.o, s); return this; },
  bytes(buf) { this.o = writeBytes(ensure(this.o + buf.length), this.o, buf); return this; },
  /** @returns {Buffer} */
  done() { return copyOut(scratch, this.o); },
  /** @returns {Buffer} volatile view of the scratch buffer */
  view() { return scratch.subarray(0, this.o); },
  get length() { return this.o; },
};
export function key() { builder.o = 0; return builder; }

/* ------------------------------------------------------------------- tuple */

/**
 * Parse a tuple spec: "gid:u64 uid:u64" or [['gid','u64'], ['uid','u64']].
 * @param {string | Array<[string, KeyType]>} spec
 * @returns {KeyField[]}
 */
export function parseSpec(spec) {
  const pairs = typeof spec === 'string'
    ? spec.trim().split(/[\s,]+/).map((p) => p.split(':'))
    : spec;
  const fields = pairs.map(([name, type]) => {
    if (!name || !type) throw new TypeError(`spbt-db key: bad field spec ${JSON.stringify(spec)}`);
    return { name, type, size: typeSize(type) };
  });
  if (!fields.length) throw new TypeError('spbt-db key: empty tuple spec');
  return fields;
}

/**
 * @typedef {object} Tuple
 * @property {KeyField[]} fields
 * @property {number} size              fixed byte size, or -1 if any field is str
 * @property {(values: any[], n?: number) => Buffer} encode         first n values (prefix), copied
 * @property {(values: any[], buf?: Buffer, n?: number) => Buffer} encodeInto  into buf (or scratch); returns a view
 * @property {(rec: object, buf?: Buffer) => Buffer|undefined} encodeRecord    read fields by name; undefined if any is null/undefined; returns a view
 * @property {(buf: Buffer, off?: number) => any[]} decode
 * @property {(buf: Buffer, obj: object, off?: number, from?: number, to?: number) => object} decodeInto
 *           sets obj[field.name] for fields [from, to) (default: all)
 * @property {(buf: Buffer, off?: number) => number} end             offset just after the tuple
 */

/**
 * Compile a tuple codec. Encoders write into a caller buffer (reused across calls)
 * or the module scratch and return a view; `encode` copies.
 * @param {string | Array<[string, KeyType]>} spec
 * @returns {Tuple}
 */
export function tuple(spec) {
  const fields = parseSpec(spec);
  const n = fields.length;
  let size = 0;
  for (const f of fields) { if (f.size === -1) { size = -1; break; } size += f.size; }

  function sizeHint(values, count) {
    if (size !== -1 && count === n) return size;
    let s = 0;
    for (let i = 0; i < count; i++) {
      const f = fields[i];
      s += f.size === -1 ? String(values[i]).length * 3 + 2 : f.size;
    }
    return s;
  }
  const fast = size !== -1 && size <= MAX_KEY ? compileFixed(fields) : null;
  const sized = (buf) => (buf && buf.length >= size ? buf : ensure(size));
  const exact = (b) => (b.length === size ? b : b.subarray(0, size)); // exact-size caller buffer: no view allocation
  function encodeInto(values, buf, count = n) {
    if (fast && count === n && values.length === n) return exact(fast.arr(values, sized(buf)));
    if (count > n) throw new RangeError(`spbt-db key: ${count} values for a ${n}-field tuple`);
    const need = sizeHint(values, count);
    const b = buf && buf.length >= need ? buf : ensure(need);
    let o = 0;
    for (let i = 0; i < count; i++) o = writeField(b, o, fields[i], values[i]);
    if (o > MAX_KEY) throw new RangeError(`spbt-db key: ${o} bytes exceeds max key size ${MAX_KEY}`);
    return o === b.length ? b : b.subarray(0, o); // exact-size caller buffer: no view allocation
  }
  function encodeRecord(rec, buf) {
    if (fast) { const b = fast.rec(rec, sized(buf)); return b && exact(b); }
    let need = 0;
    for (let i = 0; i < n; i++) {
      const v = rec[fields[i].name];
      if (v === undefined || v === null) return undefined;
      need += fields[i].size === -1 ? v.length * 3 + 2 : fields[i].size;
    }
    const b = buf && buf.length >= need ? buf : ensure(need);
    let o = 0;
    for (let i = 0; i < n; i++) o = writeField(b, o, fields[i], rec[fields[i].name]);
    if (o > MAX_KEY) throw new RangeError(`spbt-db key: ${o} bytes exceeds max key size ${MAX_KEY}`);
    return o === b.length ? b : b.subarray(0, o);
  }
  function end(buf, off = 0) {
    if (size !== -1) return off + size;
    let o = off;
    for (let i = 0; i < n; i++) o = fields[i].size === -1 ? strEnd(buf, o) : o + fields[i].size;
    return o;
  }
  // offset of field `from` when every field before it is fixed-size (-1 otherwise)
  const fixedOff = [0];
  for (let i = 0; i < n; i++) fixedOff.push(fixedOff[i] === -1 || fields[i].size === -1 ? -1 : fixedOff[i] + fields[i].size);
  function decodeInto(buf, obj, off = 0, from = 0, to = n) {
    if (fast && from === 0 && to === n) return fast.dec(buf, obj, off);
    let o = off;
    if (from) {
      if (fixedOff[from] !== -1) o += fixedOff[from];
      else for (let i = 0; i < from; i++) o = fields[i].size === -1 ? strEnd(buf, o) : o + fields[i].size;
    }
    for (let i = from; i < to; i++) {
      const f = fields[i];
      obj[f.name] = readField(buf, o, f);
      o = f.size === -1 ? strEnd(buf, o) : o + f.size;
    }
    return obj;
  }
  function decode(buf, off = 0) {
    const out = new Array(n);
    let o = off;
    for (let i = 0; i < n; i++) {
      const f = fields[i];
      out[i] = readField(buf, o, f);
      o = f.size === -1 ? strEnd(buf, o) : o + f.size;
    }
    return out;
  }
  return {
    fields,
    size,
    encode: (values, count = values.length) => { const v = encodeInto(values, undefined, count); return copyOut(v, v.length); },
    encodeInto,
    encodeRecord,
    decode,
    decodeInto,
    end,
    /** fixed-size tuples only: (buf, v0, v1, ...) -> buf, straight-line (no array, no checks of arity) */
    encodeArgs: fast ? fast.args : null,
  };
}

/* ----------------------------------------------------------------- helpers */

/**
 * Smallest key strictly greater than every key that starts with `prefix`
 * (exclusive upper bound of a prefix scan). undefined if prefix is all 0xFF.
 * @param {Uint8Array} prefix
 * @returns {Buffer | undefined}
 */
export function prefixEnd(prefix) {
  let i = prefix.length - 1;
  while (i >= 0 && prefix[i] === 0xff) i--;
  if (i < 0) return undefined;
  const out = Buffer.allocUnsafe(i + 1);
  out.set(prefix.subarray(0, i + 1));
  out[i]++;
  return out;
}

export const MAX_KEY_SIZE = MAX_KEY;

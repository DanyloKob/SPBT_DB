import { test } from 'node:test';
import assert from 'node:assert/strict';
import { key, tuple, prefixEnd, writeU64, readU64s, readU64, typeSize } from '../src/keys.js';
import { rng } from './util.js';

const TYPES = ['u8', 'u16', 'u24', 'u32', 'u48', 'u64', 'u64s', 'inv32', 'inv48', 'str', 'b3'];
const MAX = { u8: 0xff, u16: 0xffff, u24: 0xffffff, u32: 0xffffffff, u48: 0xffffffffffff, inv32: 0xffffffff, inv48: 0xffffffffffff };
const STR_ALPHABET = ['', 'a', 'b', 'z', '\0', '\u0001', '\u007f', 'é', 'ÿ', 'ї', 'ࠀ', '￿', '😀', '𝔸', 'ab', '\0\0'];

function randValue(r, type) {
  const edge = r.int(8) === 0;
  switch (type) {
    case 'u64': case 'u64s': {
      const v = edge ? [0n, 1n, 2n ** 63n, 2n ** 64n - 1n][r.int(4)] : r.big64();
      // feed all three input forms
      const form = r.int(3);
      return form === 0 ? v : form === 1 ? v.toString() : v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    case 'str': {
      let s = '';
      const n = r.int(5);
      for (let i = 0; i < n; i++) s += STR_ALPHABET[r.int(STR_ALPHABET.length)];
      return s;
    }
    case 'b3': return Buffer.from([r.int(256), r.int(256), r.int(256)]);
    default: {
      const m = MAX[type];
      if (edge) return [0, 1, m - 1, m][r.int(4)];
      return m > 0xffffffff ? Math.floor(r.float() * (m + 1)) : r.int(m + 1);
    }
  }
}

// logical order: Unicode code point order for strings, numeric for ints, reversed for inv*
function cmpStr(a, b) {
  const A = [...a].map((c) => c.codePointAt(0)), B = [...b].map((c) => c.codePointAt(0));
  for (let i = 0; i < Math.min(A.length, B.length); i++) if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1;
  return Math.sign(A.length - B.length);
}
function cmpVal(type, a, b) {
  switch (type) {
    case 'u64': case 'u64s': { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
    case 'str': return cmpStr(a, b);
    case 'b3': return Buffer.compare(a, b);
    case 'inv32': case 'inv48': return Math.sign(b - a);
    default: return Math.sign(a - b);
  }
}
function cmpTuple(types, a, b) {
  for (let i = 0; i < types.length; i++) {
    const c = cmpVal(types[i], a[i], b[i]);
    if (c) return c;
  }
  return 0;
}
const norm = (type, v) => (type === 'u64' ? BigInt(v) : type === 'u64s' ? BigInt(v).toString() : v);

test('tuple byte order == logical order (random tuples, all types)', () => {
  const r = rng(0xC0FFEE);
  for (let round = 0; round < 300; round++) {
    const types = Array.from({ length: 1 + r.int(4) }, () => TYPES[r.int(TYPES.length)]);
    const t = tuple(types.map((ty, i) => [`f${i}`, ty]));
    const rows = Array.from({ length: 40 }, () => types.map((ty) => randValue(r, ty)));
    const enc = rows.map((v) => t.encode(v));
    for (let i = 0; i < rows.length; i++) {
      for (let j = 0; j < rows.length; j++) {
        const logical = cmpTuple(types, rows[i], rows[j]);
        const bytes = Math.sign(Buffer.compare(enc[i], enc[j]));
        if (logical !== bytes) assert.fail(`order mismatch for ${types}: ${JSON.stringify(rows[i], big)} vs ${JSON.stringify(rows[j], big)}`);
      }
      // round trip
      const back = t.decode(enc[i]);
      assert.deepEqual(back, rows[i].map((v, k) => norm(types[k], v)), `round trip ${types}`);
      assert.equal(t.end(enc[i]), enc[i].length);
    }
  }
});
const big = (_, v) => (typeof v === 'bigint' ? `${v}n` : v);

test('prefix of a tuple sorts before/within the full keys, prefixEnd bounds the scan', () => {
  const r = rng(7);
  const t = tuple('a:u64 b:str c:inv32');
  for (let i = 0; i < 500; i++) {
    const v = [r.big64(), randValue(r, 'str'), randValue(r, 'inv32')];
    const full = t.encode(v);
    for (const n of [1, 2]) {
      const p = t.encode(v, n);
      assert.ok(full.subarray(0, p.length).equals(p), 'prefix bytes');
      const end = prefixEnd(p);
      assert.ok(Buffer.compare(p, full) <= 0 && (!end || Buffer.compare(full, end) < 0));
    }
  }
  assert.equal(prefixEnd(Buffer.from([0xff, 0xff])), undefined);
  assert.deepEqual([...prefixEnd(Buffer.from([1, 0xff]))], [2]);
});

test('str escaping: NUL inside strings keeps prefix order', () => {
  const t = tuple('s:str n:u8');
  const vals = ['', '\0', '\0\0', 'a', 'a\0', 'a\0\0', 'a\0b', 'a\u0001', 'ab', 'b'];
  const enc = vals.map((s) => t.encode([s, 0]));
  for (let i = 1; i < vals.length; i++) assert.ok(Buffer.compare(enc[i - 1], enc[i]) < 0, `${JSON.stringify(vals[i - 1])} < ${JSON.stringify(vals[i])}`);
  for (let i = 0; i < vals.length; i++) assert.deepEqual(t.decode(enc[i]), [vals[i], 0]);
  assert.deepEqual([...key().str('a\0').done()], [0x61, 0, 0xff, 0, 0]);
});

test('builder matches tuple encoding and design §4.2 sizes', () => {
  const gid = 1234567890123456789n, uid = '987654321098765432';
  const b = key().u64(gid).u64(uid).done();
  assert.equal(b.length, 16);
  assert.ok(b.equals(tuple('g:u64 u:u64').encode([gid, uid])));
  assert.equal(key().u64(gid).u64(1).u48(Date.now()).u16(3).done().length, 24); // eventLog
  assert.equal(key().u48(1e12).u24(5).done().length, 9); // sched
  assert.equal(key().u64(gid).u8(1).done().length, 9); // featureCfg
  assert.deepEqual([...key().inv32(0).done()], [0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual([...key().u24(0x010203).done()], [1, 2, 3]);
  const v = key().u8(1).view();
  assert.equal(v.length, 1);
  // long strings grow the scratch without losing earlier fields
  const long = 'x'.repeat(600);
  const k = key().u32(7).str(long).done();
  assert.deepEqual(tuple('a:u32 s:str').decode(k), [7, long]);
});

test('u64: string, bigint and number inputs encode identically; decoders', () => {
  const r = rng(99);
  const buf = Buffer.alloc(8), buf2 = Buffer.alloc(8);
  for (let i = 0; i < 2000; i++) {
    const v = i < 4 ? [0n, 1n, 2n ** 53n, 2n ** 64n - 1n][i] : r.big64();
    writeU64(buf, 0, v);
    writeU64(buf2, 0, v.toString());
    assert.ok(buf.equals(buf2), `string ${v}`);
    assert.equal(readU64(buf, 0), v);
    assert.equal(readU64s(buf, 0), v.toString());
    if (v <= BigInt(Number.MAX_SAFE_INTEGER)) { writeU64(buf2, 0, Number(v)); assert.ok(buf.equals(buf2), `number ${v}`); }
  }
});

test('invalid values throw instead of wrapping', () => {
  const bad = [
    () => key().u8(256), () => key().u8(-1), () => key().u8(1.5), () => key().u16(65536),
    () => key().u32(2 ** 32), () => key().u32('5'), () => key().u48(2 ** 48), () => key().u48('1'),
    () => key().u64(-1), () => key().u64(2n ** 64n), () => key().u64('18446744073709551616'),
    () => key().u64('12a'), () => key().u64(''), () => key().u64(1.5), () => key().inv32(-1),
    () => key().str(5), () => tuple('h:b3').encode([Buffer.alloc(2)]),
    () => tuple('a:u8').encode([1, 2]), () => typeSize('u7'), () => key().str('x'.repeat(2000)).done(),
  ];
  for (const f of bad) assert.throws(f);
  assert.equal(writeU64(Buffer.alloc(8), 0, '18446744073709551615'), 8);
});

test('encodeRecord returns undefined when a field is missing (sparse indexes)', () => {
  const t = tuple('a:u8 b:u48');
  assert.equal(t.encodeRecord({ a: 1 }), undefined);
  assert.equal(t.encodeRecord({ a: 1, b: null }), undefined);
  assert.deepEqual(t.decodeInto(t.encodeRecord({ a: 1, b: 5 }), {}), { a: 1, b: 5 });
});

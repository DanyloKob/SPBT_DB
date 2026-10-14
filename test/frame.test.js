import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodec, frameInfo, isExpired, frameExpiresAt, frameSchemaId, headerSize, CODEC, structuresCompatible, packStructures, unpackStructures } from '../src/frame.js';
import { rng } from './util.js';

/** in-memory StructureStore with the same compare-and-save contract as the collection's */
function memStore() {
  let saved;
  return {
    get saved() { return saved; },
    load: () => (saved ? unpackStructures(saved) : undefined),
    save(s, isCompatible) {
      if (!structuresCompatible(this.load(), isCompatible)) return false;
      saved = packStructures(s);
      return true;
    },
  };
}

test('HDR bytes match design §4.3 examples', () => {
  const level = createCodec({ codec: 'varint', fields: ['xp'] });
  const f = level.encode({ xp: 300 });
  assert.equal(f[0], 0x23);
  assert.equal(f.length, 3); // HDR + 2-byte varint: "ВСЬОГО 3–6 B"
  assert.deepEqual(level.decode(f), { xp: 300 });

  const cfg = createCodec({ schemaId: 1, mtime: true, compress: { threshold: 64 } });
  const big = cfg.encode({ text: 'lorem ipsum dolor '.repeat(40), n: 1 });
  assert.equal(big[0], 0x39);
  const info = frameInfo(big);
  assert.equal(info.codec, CODEC.deflate);
  assert.equal(info.schemaId, 1);
  assert.ok(Math.abs(info.updatedAt - Date.now()) < 5000);
  assert.equal(info.payloadOffset, 9);
  assert.deepEqual(cfg.decode(big), { text: 'lorem ipsum dolor '.repeat(40), n: 1 });
});

test('msgpack round trip (plain and shared structures)', () => {
  const values = [
    { a: 1, b: 'x', c: [1, 2, { d: true }], e: null, f: 1.5, g: -7, h: 2n ** 63n, buf: Buffer.from([1, 2, 3]) },
    { plan: 2, since: 1726000000000, username: 'бот', avatar: 'abc' },
    'just a string', 42, [1, 'two'], {},
  ];
  for (const opts of [{}, { structures: memStore() }]) {
    const c = createCodec(opts);
    for (const v of values) {
      const f = c.encode(v);
      assert.equal(f[0] & 3, CODEC.msgpack);
      assert.deepEqual(c.decode(f), v);
    }
  }
});

test('shared structures shrink repeated shapes and survive a fresh codec', () => {
  const store = memStore();
  const a = createCodec({ structures: store });
  const plain = createCodec({});
  const rec = { plan: 1, since: 1726000000000, username: 'someone', avatar: 'ffeeddccbbaa' };
  a.encode(rec); // first encode defines the structure
  const shared = a.encode(rec), unshared = plain.encode(rec);
  assert.ok(shared.length < unshared.length - 20, `shared ${shared.length} vs plain ${unshared.length}`);
  assert.ok(store.saved, 'structures persisted');
  const b = createCodec({ structures: store }); // e.g. after restart
  assert.deepEqual(b.decode(shared), rec);
  // reset() reloads from the store
  a.reset();
  assert.deepEqual(a.decode(shared), rec);
});

test('decode works on a volatile buffer with an overridden length (lmdb getBinaryFast)', () => {
  const c = createCodec({ structures: memStore() });
  const f = c.encode({ x: 1, y: 'two' });
  const big = Buffer.alloc(4096, 0xee);
  f.copy(big);
  Object.defineProperty(big, 'length', { value: f.length, writable: true, configurable: true });
  assert.deepEqual(c.decode(big), { x: 1, y: 'two' });
  const v = createCodec({ codec: 'varint', fields: ['a', 'b'] });
  const fv = v.encode({ a: 1, b: 2 });
  const big2 = Buffer.alloc(64, 0x81); // garbage continuation bytes after the frame
  fv.copy(big2);
  Object.defineProperty(big2, 'length', { value: fv.length, writable: true, configurable: true });
  assert.deepEqual(v.decode(big2), { a: 1, b: 2 });
});

test('compression only above threshold and only when smaller', () => {
  const c = createCodec({ compress: { threshold: 256 } });
  const small = c.encode({ s: 'a'.repeat(100) });
  assert.equal(small[0] & 3, CODEC.msgpack);
  const big = c.encode({ s: 'a'.repeat(5000) });
  assert.equal(big[0] & 3, CODEC.deflate);
  assert.ok(big.length < 200);
  const r = rng(1);
  const noise = Buffer.from(Array.from({ length: 2000 }, () => r.int(256)));
  const incompressible = c.encode({ b: noise });
  assert.equal(incompressible[0] & 3, CODEC.msgpack, 'random bytes stay uncompressed');
  assert.deepEqual(c.decode(incompressible), { b: noise });
  const dict = Buffer.from('"welcome","embed","color","imageUrl","description"');
  const cd = createCodec({ compress: { threshold: 32, dictionary: dict } });
  const v = { welcome: { embed: { color: 5, imageUrl: 'x', description: 'hello '.repeat(20) } } };
  assert.deepEqual(cd.decode(cd.encode(v)), v);
});

test('raw codec copies on decode, payloadView is zero-copy', () => {
  const c = createCodec({ codec: 'raw' });
  const bytes = Buffer.from([9, 8, 7, 6]);
  const f = c.encode(bytes);
  assert.equal(f[0], 0x22);
  const out = c.decode(f);
  assert.deepEqual([...out], [9, 8, 7, 6]);
  out[0] = 0;
  assert.equal(f[1], 9, 'decode result is a copy');
  assert.equal(c.payloadView(f).buffer, f.buffer, 'view shares memory');
  const r = createCodec({ codec: 'raw', rawField: 'data' });
  assert.deepEqual(r.decode(r.encode({ data: bytes })), { data: bytes });
  assert.throws(() => c.encode('nope'));
});

test('varint codec: uint / sint / bool, large values, appended fields', () => {
  const c = createCodec({ codec: 'varint', fields: ['u', { name: 's', type: 'sint' }, { name: 'b', type: 'bool' }] });
  const r = rng(5);
  for (let i = 0; i < 3000; i++) {
    const u = i < 3 ? [0, 127, Number.MAX_SAFE_INTEGER][i] : Math.floor(r.float() * 2 ** (1 + r.int(52)));
    const s = (r.int(2) ? -1 : 1) * Math.floor(r.float() * 2 ** (1 + r.int(51)));
    const v = { u, s: s || 0, b: r.int(2) === 1 }; // -0 normalises to 0
    assert.deepEqual(c.decode(c.encode(v)), v);
  }
  assert.throws(() => c.encode({ u: -1 }));
  assert.throws(() => c.encode({ u: 1.5 }));
  assert.throws(() => c.encode({ u: 2 ** 53 }));
  // schema evolution: a frame written with fewer fields reads the new ones as 0
  const old = createCodec({ codec: 'varint', fields: ['xp'] }).encode({ xp: 5 });
  const neu = createCodec({ codec: 'varint', fields: ['xp', 'msgs'] });
  assert.deepEqual(neu.decode(old), { xp: 5, msgs: 0 });
});

test('TTL: expired frames read as absent; decodeAny ignores TTL', () => {
  const c = createCodec({ codec: 'varint', fields: ['n'], ttl: 1000 });
  const now = 1_700_000_000_000;
  const f = c.encode({ n: 1 }, { now });
  assert.ok(f[0] & 0x04);
  assert.equal(frameExpiresAt(f), now + 1000);
  assert.equal(headerSize(f[0]), 7);
  assert.deepEqual(c.decode(f, now + 999), { n: 1 });
  assert.equal(c.decode(f, now + 1000), undefined);
  assert.ok(isExpired(f, now + 1000));
  assert.deepEqual(c.decodeAny(f), { n: 1 });
  const never = c.encode({ n: 2 }, { expiresAt: 0 });
  assert.equal(never[0] & 0x04, 0);
  assert.equal(frameExpiresAt(never), 0);
  const explicit = createCodec({}).encode({ a: 1 }, { ttl: 50, now });
  assert.equal(frameExpiresAt(explicit), now + 50);
  const all = createCodec({ schemaId: 7, mtime: true, ttl: 10 }).encode({ a: 1 }, { now, updatedAt: now - 5 });
  assert.deepEqual(frameInfo(all), { version: 1, codec: 0, schemaId: 7, updatedAt: now - 5, expiresAt: now + 10, payloadOffset: 15 });
  assert.equal(frameSchemaId(all), 7);
});

test('rejects bad options and unknown frame versions', () => {
  assert.throws(() => createCodec({ codec: 'lz4' }));
  assert.throws(() => createCodec({ codec: 'varint' }));
  assert.throws(() => createCodec({ codec: 'raw', compress: true }));
  assert.throws(() => createCodec({ schemaId: 70000 }));
  assert.throws(() => createCodec({}).decode(Buffer.from([0xe0, 1])));
});

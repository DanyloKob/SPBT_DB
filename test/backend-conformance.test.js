// Every Backend must pass this file. To check a new backend, add a factory to BACKENDS in util.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BACKENDS, rng } from './util.js';
import { BACKEND_METHODS } from '../src/backend.js';

const B = (...x) => Buffer.from(x);
const hex = (b) => Buffer.from(b.subarray(0, b.length)).toString('hex');
const rows = (it) => [...it].map((e) => `${hex(e.key)}:${hex(e.value)}`).join(' ');
const getHex = (be, d, k) => { const v = be.get(d, k); return v === undefined ? undefined : hex(v); };

for (const [name, make] of Object.entries(BACKENDS)) {
  describe(`backend conformance: ${name}`, () => {
    test('implements the 7-method interface', async () => {
      const { backend, cleanup } = make();
      for (const m of BACKEND_METHODS) assert.equal(typeof backend[m], 'function', m);
      await cleanup();
    });

    test('get / put / del / overwrite / empty value / volatile get', async () => {
      const { backend: be, cleanup } = make();
      const d = be.openCollection('a', {});
      assert.equal(be.openCollection('a', {}), d, 'reopen returns the same handle');
      be.txn(() => { be.put(d, B(1, 2), B(9, 9)); be.put(d, B(1), B(8)); be.put(d, B(3), Buffer.alloc(0)); });
      assert.equal(getHex(be, d, B(1, 2)), '0909');
      assert.equal(getHex(be, d, B(3)), '');
      assert.equal(be.get(d, B(7)), undefined);
      // caller may reuse its buffers after put
      const k = B(5), v = B(5, 5);
      be.put(d, k, v);
      k[0] = 6; v[0] = 0;
      assert.equal(getHex(be, d, B(5)), '0505');
      be.put(d, B(1), B(7, 7, 7));
      assert.equal(getHex(be, d, B(1)), '070707');
      assert.equal(be.del(d, B(1)), true);
      assert.equal(be.del(d, B(1)), false);
      assert.equal(be.get(d, B(1)), undefined);
      // a Uint8Array key works like a Buffer
      assert.equal(getHex(be, d, new Uint8Array([1, 2])), '0909');
      assert.throws(() => be.put(d, Buffer.alloc(0), B(1)));
      await cleanup();
    });

    test('dupSort: pairs, first-value get, del one / del all', async () => {
      const { backend: be, cleanup } = make();
      const d = be.openCollection('ix', { dupSort: true });
      be.txn(() => { for (const k of [2, 4]) for (const v of [3, 1, 2]) be.put(d, B(k), B(v)); be.put(d, B(4), B(2)); });
      assert.equal(rows(be.range(d, {})), '02:01 02:02 02:03 04:01 04:02 04:03');
      assert.equal(getHex(be, d, B(4)), '01');
      assert.equal(be.del(d, B(4), B(2)), true);
      assert.equal(be.del(d, B(4), B(9)), false);
      assert.equal(rows(be.range(d, { start: B(4) })), '04:01 04:03');
      assert.equal(be.del(d, B(2)), true);
      assert.equal(rows(be.range(d, {})), '04:01 04:03');
      assert.equal(be.stat(d).entries, 2);
      await cleanup();
    });

    test('range semantics match lmdb-js getRange', async () => {
      const { backend: be, cleanup } = make();
      const a = be.openCollection('a', {});
      const d = be.openCollection('d', { dupSort: true });
      be.txn(() => {
        for (const k of [1, 3, 5, 7]) be.put(a, B(k), B(k));
        for (const k of [2, 4, 6]) for (const v of [1, 2, 3]) be.put(d, B(k), B(v));
      });
      const cases = [
        [a, { start: B(3), end: B(7) }, '03:03 05:05'],
        [a, { start: B(3), end: B(7), exclusiveStart: true, inclusiveEnd: true }, '05:05 07:07'],
        [a, { start: B(2), end: B(6) }, '03:03 05:05'],
        [a, { start: B(7), end: B(3), reverse: true }, '07:07 05:05'],
        [a, { start: B(6), end: B(2), reverse: true }, '05:05 03:03'],
        [a, { start: B(7), end: B(3), reverse: true, exclusiveStart: true, inclusiveEnd: true }, '05:05 03:03'],
        [a, { end: B(3), reverse: true }, '07:07 05:05'],
        [a, { start: B(5), reverse: true }, '05:05 03:03 01:01'],
        [a, { limit: 2 }, '01:01 03:03'],
        [a, { reverse: true, limit: 2 }, '07:07 05:05'],
        [a, { start: B(9) }, ''],
        [d, { reverse: true }, '06:03 06:02 06:01 04:03 04:02 04:01 02:03 02:02 02:01'],
        [d, { start: B(4), exclusiveStart: true }, '06:01 06:02 06:03'],
        [d, { start: B(4), reverse: true, exclusiveStart: true }, '02:03 02:02 02:01'],
        [d, { start: B(4), reverse: true }, '04:03 04:02 04:01 02:03 02:02 02:01'],
        [d, { start: B(6), end: B(4), reverse: true, inclusiveEnd: true }, '06:03 06:02 06:01 04:03 04:02 04:01'],
        [d, { start: B(2), end: B(4), inclusiveEnd: true, limit: 4 }, '02:01 02:02 02:03 04:01'],
      ];
      for (const [db, o, want] of cases) assert.equal(rows(be.range(db, o)), want, JSON.stringify(o, (k, v) => (v && v.type === 'Buffer' ? hex(Buffer.from(v.data)) : v)));
      if (be.count) {
        assert.equal(be.count(d, {}), 9);
        assert.equal(be.count(d, { start: B(2), end: B(5) }), 6);
        assert.equal(be.count(a, { start: B(3) }), 3);
      }
      await cleanup();
    });

    test('randomised differential vs a naive model', async () => {
      const { backend: be, cleanup } = make();
      for (const seed of [11, 1003, 42]) {
      const r = rng(seed);
      for (const dup of [false, true]) {
        const d = be.openCollection(`${dup ? 'rd' : 'rn'}${seed}`, { dupSort: dup });
        /** model: Map<keyHex, Set<valHex>> or Map<keyHex, valHex> */
        const model = new Map();
        const rk = () => Buffer.from(Array.from({ length: 1 + r.int(3) }, () => r.int(4) * 60));
        for (let i = 0; i < 1500; i++) {
          const k = rk(), v = B(r.int(5)), kh = hex(k), vh = hex(v);
          const op = r.int(10);
          if (op < 6) {
            be.put(d, k, v);
            if (dup) { if (!model.has(kh)) model.set(kh, new Set()); model.get(kh).add(vh); } else model.set(kh, vh);
          } else if (op < 8 || !dup) {
            const got = be.del(d, k);
            assert.equal(got, model.delete(kh));
          } else {
            const s = model.get(kh);
            const had = !!s && s.has(vh);
            assert.equal(be.del(d, k, v), had);
            if (had) { s.delete(vh); if (!s.size) model.delete(kh); }
          }
        }
        const flat = [];
        for (const [kh, v] of model) for (const vh of dup ? v : [v]) flat.push([kh, vh]);
        flat.sort((x, y) => Buffer.compare(Buffer.from(x[0], 'hex'), Buffer.from(y[0], 'hex')) || Buffer.compare(Buffer.from(x[1], 'hex'), Buffer.from(y[1], 'hex')));
        assert.equal(be.stat(d).entries, flat.length);
        for (let q = 0; q < 400; q++) {
          const o = {};
          if (r.int(3)) o.start = rk();
          if (r.int(3)) o.end = rk();
          if (r.int(2)) o.reverse = true;
          if (r.int(3) === 0) o.exclusiveStart = true;
          if (r.int(3) === 0) o.inclusiveEnd = true;
          if (r.int(4) === 0) o.limit = r.int(6);
          const c = (kh, b) => Buffer.compare(Buffer.from(kh, 'hex'), b);
          let want = flat.filter(([kh]) => {
            if (!o.reverse) {
              if (o.start && (o.exclusiveStart ? c(kh, o.start) <= 0 : c(kh, o.start) < 0)) return false;
              if (o.end && (o.inclusiveEnd ? c(kh, o.end) > 0 : c(kh, o.end) >= 0)) return false;
            } else {
              if (o.start && (o.exclusiveStart ? c(kh, o.start) >= 0 : c(kh, o.start) > 0)) return false;
              if (o.end && (o.inclusiveEnd ? c(kh, o.end) < 0 : c(kh, o.end) <= 0)) return false;
            }
            return true;
          });
          if (o.reverse) want.reverse();
          if (o.limit !== undefined) want = want.slice(0, o.limit);
          assert.equal(rows(be.range(d, o)), want.map(([k, v]) => `${k}:${v}`).join(' '), `dup=${dup} ${JSON.stringify({ ...o, start: o.start && hex(o.start), end: o.end && hex(o.end) })}`);
          if (be.count && o.limit === undefined) assert.equal(be.count(d, o), want.length);
        }
        for (const [kh, vh] of flat.slice(0, 50)) {
          const first = flat.find(([k]) => k === kh)[1];
          assert.equal(getHex(be, d, Buffer.from(kh, 'hex')), dup ? first : vh);
        }
      }
      }
      await cleanup();
    });

    test('txn: atomic commit, rollback on throw, savepoints, result', async () => {
      const { backend: be, cleanup } = make();
      const a = be.openCollection('a', {});
      const d = be.openCollection('d', { dupSort: true });
      be.txn(() => { be.put(a, B(1), B(1)); be.put(a, B(2), B(2)); be.put(d, B(1), B(1)); });
      const snapshot = () => `${rows(be.range(a, {}))} | ${rows(be.range(d, {}))}`;
      const before = snapshot();
      assert.throws(() => be.txn(() => {
        be.put(a, B(1), B(9)); be.put(a, B(3), B(3)); be.del(a, B(2));
        be.put(d, B(1), B(2)); be.del(d, B(1), B(1)); be.put(d, B(5), B(5));
        assert.equal(getHex(be, a, B(1)), '09', 'reads see own writes');
        throw new Error('boom');
      }), /boom/);
      assert.equal(snapshot(), before, 'rolled back across DBIs');
      if (be.inTxn) assert.equal(be.inTxn(), false);
      const res = be.txn(() => {
        if (be.inTxn) assert.equal(be.inTxn(), true);
        be.put(a, B(10), B(10));
        assert.throws(() => be.txn(() => { be.put(a, B(11), B(11)); be.del(a, B(10)); throw new Error('inner'); }));
        assert.equal(getHex(be, a, B(10)), '0a', 'inner rollback restored outer write');
        be.txn(() => be.put(a, B(12), B(12)));
        return 'ok';
      });
      assert.equal(res, 'ok');
      assert.equal(getHex(be, a, B(10)), '0a');
      assert.equal(be.get(a, B(11)), undefined);
      assert.equal(getHex(be, a, B(12)), '0c');
      assert.throws(() => be.txn(() => Promise.resolve(1)), /synchronous/);
      await cleanup();
    });

    test('txnAsync: commits, rolls back on throw', { skip: false }, async () => {
      const { backend: be, cleanup } = make();
      if (!be.txnAsync) return cleanup();
      const a = be.openCollection('a', {});
      assert.equal(await be.txnAsync(() => { be.put(a, B(1), B(1)); return 7; }), 7);
      await assert.rejects(be.txnAsync(() => { be.put(a, B(2), B(2)); throw new Error('x'); }), /x/);
      assert.equal(getHex(be, a, B(1)), '01');
      assert.equal(be.get(a, B(2)), undefined);
      await cleanup();
    });

    test('range outside a txn iterates a snapshot', async () => {
      const { backend: be, cleanup } = make();
      const a = be.openCollection('a', {});
      be.txn(() => { for (let i = 1; i <= 5; i++) be.put(a, B(i), B(i)); });
      const seen = [];
      for (const { key } of be.range(a, {})) {
        seen.push(key[0]);
        if (key[0] === 2) { be.put(a, B(4, 1), B(0)); be.del(a, B(5)); }
      }
      assert.deepEqual(seen, [1, 2, 3, 4, 5]);
      assert.equal(rows(be.range(a, { start: B(4) })), '04:04 0401:00');
      // deleting while iterating inside a write txn (sweeper pattern)
      be.txn(() => { for (const { key } of be.range(a, { start: B(2) })) be.del(a, key); });
      assert.equal(rows(be.range(a, {})), '01:01');
      await cleanup();
    });

    test('stat / drop', async () => {
      const { backend: be, cleanup } = make();
      const a = be.openCollection('a', {});
      be.txn(() => { for (let i = 0; i < 2000; i++) be.put(a, Buffer.from(String(i).padStart(6, '0')), Buffer.alloc(40, 1)); });
      const s = be.stat(a);
      assert.equal(s.entries, 2000);
      assert.ok(s.pages >= 10, `pages ${s.pages}`);
      assert.ok(s.freePages >= 0);
      const env = be.stat();
      assert.ok(env.entries >= 2000 && env.pages >= s.pages);
      if (be.drop) {
        be.drop(a);
        const a2 = be.openCollection('a', {});
        assert.equal(be.stat(a2).entries, 0);
      }
      await cleanup();
    });
  });
}

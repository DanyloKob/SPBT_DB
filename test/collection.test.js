import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BACKENDS, rng, tmpDir } from './util.js';
import { createCollection, runTxn, runTxnAsync } from '../src/collection.js';
import { openDB } from '../src/index.js';

const hex = (b) => Buffer.from(b.subarray(0, b.length)).toString('hex');

const ITEMS = {
  key: 'gid:u64 id:u32',
  indexes: {
    it_by_owner: { key: 'gid:u64 owner:u64s' },                 // dupSort, gid shared with pk
    it_by_name: { key: 'name:str gid:u64 id:u32' },             // ends with pk -> plain DBI, empty value
    it_by_score: { key: 'score:inv32' },                        // dupSort, no shared prefix
    it_by_slug: { key: 'slug:str', unique: true },              // unique
    it_active: { key: 'gid:u64 tag:u8', filter: (r) => !!r.active }, // sparse
  },
};

/** Recompute every index from the primary data and compare with what is stored. */
function assertConsistent(col) {
  const be = col.backend;
  const data = be.openCollection(col.name, {});
  const expected = Object.fromEntries(Object.keys(col.indexes).map((n) => [n, []]));
  for (const { key, value } of be.range(data, {})) {
    const rec = col.pk.decodeInto(key, col.codec.decodeAny(value));
    for (const [n, ix] of Object.entries(col.indexes)) {
      const spec = col.schema.indexes[n];
      if (spec.filter && !spec.filter(rec)) continue;
      const k = ix.tuple.encodeRecord(rec);
      if (!k) continue;
      const v = ix.mode === 'suffix' ? '' : hex(key.subarray(ix.shared));
      expected[n].push(`${hex(k)}:${v}`);
    }
  }
  for (const [n, ix] of Object.entries(col.indexes)) {
    const d = be.openCollection(n, { dupSort: ix.mode === 'dup' });
    const actual = [...be.range(d, {})].map((e) => `${hex(e.key)}:${hex(e.value)}`).sort();
    assert.deepEqual(actual, expected[n].sort(), `index ${n} out of sync with data`);
  }
}

for (const [bname, make] of Object.entries(BACKENDS)) {
  describe(`collection on ${bname}`, () => {
    test('index <-> data consistency under random put/patch/del/incr and rolled-back txns', async () => {
      const { backend, cleanup } = make();
      const col = createCollection({ backend, name: 'items', schema: ITEMS });
      const r = rng(2024);
      const gids = [1n, 2n, 3n], owners = ['10', '20', '30', '18446744073709551615'], names = ['a', 'b', 'a\0', 'ä', ''];
      const slugTaken = new Map(); // slug -> pk string, to avoid unique violations in the random phase
      const rand = (arr) => arr[r.int(arr.length)];
      for (let round = 0; round < 60; round++) {
        const ops = () => {
          for (let i = 0; i < 25; i++) {
            const gid = rand(gids), id = r.int(30), pks = `${gid}/${id}`;
            const op = r.int(10);
            if (op < 5) {
              const rec = { gid, id, owner: r.int(5) ? rand(owners) : undefined, name: rand(names), score: r.int(50), tag: r.int(3), active: r.int(2) === 1 };
              const slug = r.int(3) ? `s${r.int(40)}` : undefined;
              if (slug && slugTaken.has(slug) && slugTaken.get(slug) !== pks) continue;
              if (slug) { rec.slug = slug; slugTaken.set(slug, pks); }
              col.put(rec);
            } else if (op < 7) {
              col.patch(gid, id, { score: r.int(50), active: r.int(2) === 1, owner: r.int(4) ? rand(owners) : undefined });
            } else if (op < 8) {
              col.incr(gid, id, 'score', r.int(5));
            } else {
              col.del(gid, id);
            }
          }
        };
        if (round % 7 === 3) {
          const before = [...col.iterate()].length;
          const slugs = new Map(slugTaken);
          assert.throws(() => runTxn(backend, () => { ops(); throw new Error('rollback'); }), /rollback/);
          slugTaken.clear(); for (const [k, v] of slugs) slugTaken.set(k, v);
          assert.equal([...col.iterate()].length, before);
        } else if (round % 2) runTxn(backend, ops);
        else ops(); // auto-commit per op
        assertConsistent(col);
      }
      assert.ok(col.count() > 10, 'test did write data');
      await cleanup();
    });

    test('unique index violation throws and changes nothing', async () => {
      const { backend, cleanup } = make();
      const col = createCollection({ backend, name: 'items', schema: ITEMS });
      col.put({ gid: 1n, id: 1, slug: 'x', name: 'n', score: 1 });
      assert.throws(() => col.put({ gid: 1n, id: 2, slug: 'x', name: 'm', score: 2 }), /unique/);
      assert.equal(col.get(1n, 2), undefined);
      col.put({ gid: 1n, id: 1, slug: 'x', name: 'renamed', score: 3 }); // same record may keep its slug
      assertConsistent(col);
      await cleanup();
    });

    test('get / has / count / prefix / range / desc / cursor paging', async () => {
      const { backend, cleanup } = make();
      const col = createCollection({ backend, name: 'items', schema: ITEMS });
      runTxn(backend, () => { for (const gid of [1n, 2n]) for (let id = 0; id < 25; id++) col.put({ gid, id, owner: String(id % 3), name: `n${id % 4}`, score: id % 5, tag: 0 }); });
      assert.deepEqual(col.get(2n, 7), { owner: '1', name: 'n3', score: 2, tag: 0 });
      assert.equal(col.get('2', 7).owner, '1', 'string snowflake input');
      assert.equal(col.has(2n, 7), true);
      assert.equal(col.has(2n, 99), false);
      assert.equal(col.count(), 50);
      assert.equal(col.count(1n), 25);
      assert.equal(col.prefix(2n).length, 25);
      assert.deepEqual(col.range({ start: [1n, 5], end: [1n, 8] }).map((x) => x.id), [5, 6, 7]);
      assert.deepEqual(col.range({ start: [1n, 5], end: [1n, 8], desc: true }).map((x) => x.id), [7, 6, 5]);
      assert.deepEqual(col.range({ prefix: [2n], desc: true, limit: 3 }).map((x) => x.id), [24, 23, 22]);
      const rec = col.range({ prefix: [1n], limit: 1 })[0];
      assert.equal(rec.gid, 1n);
      assert.equal(rec.id, 0);

      const pages = (o) => {
        const all = [];
        let next, n = 0;
        do {
          const p = col.query({ ...o, limit: 4, after: next });
          all.push(...p.items);
          next = p.next;
          assert.ok(++n < 100);
        } while (next);
        return all;
      };
      const ids = (xs) => xs.map((x) => `${x.gid}/${x.id}`);
      for (const desc of [false, true]) {
        assert.deepEqual(ids(pages({ prefix: [1n], desc })), ids(col.query({ prefix: [1n], desc }).items), `primary desc=${desc}`);
        for (const index of ['it_by_owner', 'it_by_name', 'it_by_score']) {
          const where = index === 'it_by_owner' ? [2n, '1'] : index === 'it_by_name' ? ['n1'] : undefined;
          const full = col.query({ index, where, desc }).items;
          assert.ok(full.length > 0);
          assert.deepEqual(ids(pages({ index, where, desc })), ids(full), `${index} desc=${desc}`);
        }
      }
      // index order: inv32 score -> descending score
      const byScore = col.query({ index: 'it_by_score', limit: 50 }).items.map((x) => x.score);
      assert.deepEqual(byScore, [...byScore].sort((a, b) => b - a));
      // covered = same keys, no primary lookups
      const cov = col.query({ index: 'it_by_owner', where: [1n], covered: true }).items;
      const full = col.query({ index: 'it_by_owner', where: [1n] }).items;
      assert.deepEqual(cov.map((x) => [x.gid, x.id, x.owner]), full.map((x) => [x.gid, x.id, x.owner]));
      assert.equal(col.countIndex('it_by_owner', 1n, '0'), 9);
      assert.equal(col.countIndex('it_by_owner'), 50);
      assert.throws(() => col.query({ index: 'nope' }));
      await cleanup();
    });

    test('TTL: expired records are invisible to get/has/query immediately', async () => {
      const { backend, cleanup } = make();
      const seen = [];
      const col = createCollection({ backend, name: 'items', schema: { ...ITEMS, ttl: 60_000 }, hooks: { onExpiring: (c, pk, at) => seen.push([c.name, hex(pk), at]) } });
      const now = Date.now();
      col.put({ gid: 1n, id: 1, name: 'live', score: 1 });
      col.put({ gid: 1n, id: 2, name: 'dead', score: 2 }, { expiresAt: now - 1 });
      col.put({ gid: 1n, id: 3, name: 'forever', score: 3 }, { expiresAt: 0 });
      assert.ok(col.get(1n, 1));
      assert.equal(col.get(1n, 2), undefined);
      assert.equal(col.has(1n, 2), false);
      assert.equal(col.getMeta(1n, 3).expiresAt, 0);
      assert.ok(col.getMeta(1n, 1).expiresAt >= now + 59_000);
      assert.deepEqual(col.prefix(1n).map((x) => x.id), [1, 3]);
      assert.deepEqual(col.query({ index: 'it_by_name' }).items.map((x) => x.name), ['forever', 'live']);
      assert.equal(col.count(1n), 3, 'physical count includes unswept');
      assert.equal(col.countLive(1n), 2);
      // patch keeps the existing expiry
      const exp = col.getMeta(1n, 1).expiresAt;
      col.patch(1n, 1, { score: 9 });
      assert.equal(col.getMeta(1n, 1).expiresAt, exp);
      // hook saw the TTL writes (not the expiresAt:0 one)
      assert.deepEqual(seen.map((s) => s[0]), ['items', 'items', 'items']);
      assert.equal(seen[1][2], now - 1);
      // incr on an expired record starts from scratch and is visible (does not inherit the past expiry)
      col.put({ gid: 1n, id: 5, name: 'gone', score: 40 }, { expiresAt: now - 1 });
      assert.equal(col.incr(1n, 5, 'score', 3), 3);
      assert.equal(col.get(1n, 5).score, 3);
      assert.ok(col.getMeta(1n, 5).expiresAt > now);
      // sweeper path: delete by encoded key keeps indexes consistent
      assert.equal(col.delByKey(col.keyOf(1n, 2)), true);
      assertConsistent(col);
      await cleanup();
    });

    test('lazy on-read migration keyed by schemaId', async () => {
      const { backend, cleanup } = make();
      const v0 = createCollection({ backend, name: 'prof', schema: { key: 'uid:u64' } });
      v0.put({ uid: 1n, nick: 'old' });
      const v1 = createCollection({ backend, name: 'prof', schema: { key: 'uid:u64', schemaId: 1, migrate: { 0: (v) => ({ ...v, nick: undefined, name: v.nick }) } } });
      v1.put({ uid: 2n, name: 'new' });
      const v2 = createCollection({
        backend, name: 'prof',
        schema: { key: 'uid:u64', schemaId: 2, migrate: { 0: (v) => ({ name: v.nick }), 1: (v) => ({ ...v, v: 2 }) } },
      });
      assert.deepEqual(v2.get(1n), { name: 'old', v: 2 });
      assert.deepEqual(v2.get(2n), { name: 'new', v: 2 });
      assert.equal(v2.getMeta(1n).schemaId, 0, 'read does not rewrite');
      v2.patch(1n, { seen: true });
      assert.equal(v2.getMeta(1n).schemaId, 2, 'next write upgrades the stored frame');
      assert.throws(() => v0.get(1n), /newer code/);
      await cleanup();
    });

    test('shared structures: aborted txn does not leave dangling structure ids', async () => {
      const { backend, cleanup } = make();
      const col = createCollection({ backend, name: 'shapes', schema: { key: 'id:u32' } });
      col.put({ id: 1, a: 1, b: 2 });
      assert.throws(() => runTxn(backend, () => {
        col.put({ id: 2, brand: 'new', shape: true }); // defines a new shared structure inside the txn
        throw new Error('abort');
      }));
      col.put({ id: 3, brand: 'again', shape: false }); // must not reuse the rolled-back structure id
      col.put({ id: 4, other: 'shape' });
      const fresh = createCollection({ backend, name: 'shapes', schema: { key: 'id:u32' } }); // e.g. after restart
      assert.deepEqual(fresh.range().map((x) => x.id), [1, 3, 4]);
      assert.deepEqual(fresh.get(3), { brand: 'again', shape: false });
      assert.deepEqual(fresh.get(4), { other: 'shape' });
      await cleanup();
    });

    test('varint + raw codecs, incr, key helpers, reindex, drop', async () => {
      const { backend, cleanup } = make();
      const lvl = createCollection({ backend, name: 'lv', schema: { key: 'gid:u64 uid:u64', codec: 'varint', fields: ['xp'], indexes: { lv_by_xp: { key: 'gid:u64 xp:inv32' } } } });
      for (let i = 0; i < 30; i++) lvl.incr(5n, BigInt(i), 'xp', i * 3);
      assert.equal(lvl.incr(5n, 3n, 'xp', 1000), 1009);
      assert.deepEqual(lvl.get(5n, 3n), { xp: 1009 });
      assert.equal(lvl.indexes.lv_by_xp.mode, 'dup');
      assert.equal(lvl.indexes.lv_by_xp.shared, 8, 'index value is just the uid');
      const top = lvl.query({ index: 'lv_by_xp', where: [5n], limit: 3, covered: true }).items;
      assert.deepEqual(top.map((x) => [x.uid, x.xp]), [[3n, 1009], [29n, 87], [28n, 84]]);
      assertConsistent(lvl);
      // break the index, then rebuild it
      const ixd = backend.openCollection('lv_by_xp', { dupSort: true });
      for (const { key, value } of [...backend.range(ixd, { limit: 10 })]) backend.del(ixd, key, value);
      lvl.reindex('lv_by_xp', 7);
      assertConsistent(lvl);
      assert.deepEqual(lvl.decodeKey(lvl.keyOf(5n, '9')), { gid: 5n, uid: 9n });

      const blob = createCollection({ backend, name: 'blob', schema: { key: 'h:b16', codec: 'raw' } });
      const h = Buffer.alloc(16, 7), bytes = Buffer.from('vector-segment');
      blob.put({ h, data: bytes });
      assert.deepEqual(blob.get(h), { data: bytes });
      assert.equal(blob.getView(h).toString(), 'vector-segment');
      assert.throws(() => createCollection({ backend, name: 'bad', schema: { key: 'a:u8', codec: 'raw', indexes: { x: { key: 'a:u8' } } } }));
      if (backend.drop) {
        lvl.drop();
        const again = createCollection({ backend, name: 'lv', schema: { key: 'gid:u64 uid:u64', codec: 'varint', fields: ['xp'], indexes: { lv_by_xp: { key: 'gid:u64 xp:inv32' } } } });
        assert.equal(again.count(), 0);
        assert.equal(again.countIndex('lv_by_xp'), 0);
      }
      await cleanup();
    });

    test('drop is ONE atomic txn: an abort keeps data + indexes + structures, a commit removes all', async () => {
      const { backend, cleanup } = make();
      if (!backend.drop) return cleanup();
      const schema = { key: 'i:u32', indexes: { dr_by_v: { key: 'v:u32' }, dr_by_t: { key: 't:u32 i:u32' } } };
      let col = createCollection({ backend, name: 'dr', schema });
      runTxn(backend, () => { for (let i = 0; i < 3000; i++) col.put({ i, v: i % 97, t: i % 13, pad: 'x'.repeat(40) }); });
      const lastTxn = () => backend.env?.getStats().lastTxnId;
      // abort after the drop, inside the same txn: everything must still be there
      assert.throws(() => runTxn(backend, () => { col.drop(); throw new Error('crash stand-in'); }), /crash stand-in/);
      col = createCollection({ backend, name: 'dr', schema }); // the old handle is dead after drop()
      assert.equal(col.count(), 3000);
      assert.equal(col.countIndex('dr_by_v'), 3000);
      assert.equal(col.countIndex('dr_by_t'), 3000);
      assert.deepEqual(col.get(5), { v: 5, t: 5, pad: 'x'.repeat(40) }, 'shared structures still decode');
      assertConsistent(col);
      // a savepoint cannot drop (LMDB closes the handle env-wide)
      assert.throws(() => runTxn(backend, () => runTxn(backend, () => col.drop())), /nested/);
      // a real drop: one commit for both indexes, the data and the structures key
      const t0 = lastTxn();
      col.drop();
      if (t0 !== undefined) assert.equal(lastTxn() - t0, 1, 'exactly one commit');
      const meta = backend.openCollection('__meta', {});
      assert.equal(backend.get(meta, Buffer.from('s:dr')), undefined);
      col = createCollection({ backend, name: 'dr', schema });
      assert.equal(col.count(), 0);
      assert.equal(col.countIndex('dr_by_v'), 0);
      assert.equal(col.countIndex('dr_by_t'), 0);
      // drop joins the caller's txn: other writes commit with it
      col.put({ i: 1, v: 1, t: 1 });
      const other = createCollection({ backend, name: 'other', schema: { key: 'k:u8' } });
      const t1 = lastTxn();
      runTxn(backend, () => { col.drop(); other.put({ k: 1, note: 'dropped dr' }); });
      if (t1 !== undefined) assert.equal(lastTxn() - t1, 1);
      assert.deepEqual(other.get(1), { note: 'dropped dr' });
      assert.equal(createCollection({ backend, name: 'dr', schema }).count(), 0);
      await cleanup();
    });

    test('runTxnAsync commits and rolls back', async () => {
      const { backend, cleanup } = make();
      const col = createCollection({ backend, name: 'items', schema: ITEMS });
      await runTxnAsync(backend, () => col.put({ gid: 1n, id: 1, name: 'a', score: 1 }));
      await assert.rejects(runTxnAsync(backend, () => { col.put({ gid: 1n, id: 2, name: 'b', score: 2 }); throw new Error('no'); }));
      assert.ok(col.get(1n, 1));
      assert.equal(col.get(1n, 2), undefined);
      assertConsistent(col);
      await cleanup();
    });
  });
}

describe('openDB', () => {
  for (const backend of ['memory', 'lmdb']) {
    test(`core schemas, level top/rank, stats (${backend})`, async () => {
      const dir = tmpDir('open');
      const db = openDB({ dir, backend });
      const gid = '1100000000000000001';
      db.txn(() => { for (let i = 0; i < 50; i++) db.level.put({ gid, uid: String(2000 + i), xp: (i * 37) % 101 }); });
      const top = db.level.top(gid, 5);
      assert.equal(top.length, 5);
      for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].xp >= top[i].xp);
      assert.equal(typeof top[0].uid, 'bigint');
      assert.equal(db.level.rank(gid, top[0].uid), 1);
      assert.equal(db.featureConfig.codec.codec, 0);
      db.featureConfig.put({ gid, tag: 2, rules: Array.from({ length: 40 }, (_, i) => ({ id: i, text: 'no spam please' })) });
      assert.equal(db.featureConfig.getFrame(db.featureConfig.keyOf(gid, 2))[0], 0x39);
      db.guildFeature.put({ gid, tag: 2, enabled: true, enabledAt: Date.now() });
      assert.equal(db.guildFeature.popularity(2), 1);
      db.guildFeature.patch(gid, 2, { enabled: false });
      assert.equal(db.guildFeature.popularity(2), 0);
      db.user.put({ uid: 1n, plan: 3, username: 'x', planExpiresAt: Date.now() + 1000 });
      assert.deepEqual(db.user.query({ index: 'user_by_expiry' }).items.map((u) => u.uid), [1n]);
      db.news.put({ createdAt: Date.now(), seq: 0, title: 't' });
      db.kv.put({ k: '__boot', cleanShutdown: false });
      const st = db.stats();
      assert.ok(st.hot.entries > 50);
      assert.ok(st.hot.collections.level.entries === 50 && st.hot.collections.level_by_xp.entries === 50);
      if (backend === 'lmdb') assert.ok(st.hot.fileBytes > 0 && st.hot.pageSize === 4096);
      // cold env opens on demand
      const elog = db.collection('event_log_202610', { key: 'gid:u64 chan:u64 ts:u48 seq:u16', env: 'cold' });
      elog.put({ gid, chan: 1n, ts: Date.now(), seq: 0, k: 0, content: 'hi' });
      assert.equal(elog.backend, db.backend('cold'));
      assert.equal(db.stats().cold.collections.event_log_202610.entries, 1);
      if (backend === 'lmdb') assert.equal(db.stats().cold.pageSize, 8192);
      assert.equal(db.dropCollection('event_log_202610'), true);
      await db.close();
      if (backend === 'lmdb') {
        const again = openDB({ dir });
        assert.equal(again.level.count(gid), 50, 'data persisted across reopen');
        assert.deepEqual(again.level.top(gid, 5), top);
        assert.ok(again.featureConfig.get(gid, 2).rules.length === 40);
        await again.close();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
});

describe('lmdb env sizing', () => {
  test('fixed mapSize is virtual only; reopen sizes the map from the file; outgrowing it is not an error', async () => {
    const { mapSizeFor, PROFILES, createLmdbBackend } = await import('../src/backend-lmdb.js');
    const { join } = await import('node:path');
    assert.equal(PROFILES.hot.mapSize, 2 ** 31);
    assert.equal(PROFILES.cold.noReadAhead, true);
    assert.equal(mapSizeFor(2 ** 31, 100 * 2 ** 20), 2 ** 31);
    assert.equal(mapSizeFor(2 ** 31, 1.5 * 2 ** 30), 2 ** 32, 'file > half the map: next power of two >= 2x file');
    assert.equal(mapSizeFor(0, 2 ** 30), 0);
    const dir = tmpDir('mapsize');
    const path = join(dir, 'hot.mdb');
    const mappings = () => fs.readFileSync('/proc/self/maps', 'utf8').split('\n').filter((l) => l.endsWith(path)).length;
    // a 1 MiB map that the data outgrows ~8x: lmdb-js grows it (no MDB_MAP_FULL), info() reports it
    let be = createLmdbBackend({ path, options: { mapSize: 2 ** 20 } });
    const d = be.openCollection('x');
    for (let b = 0; b < 8; b++) be.txn(() => { for (let i = 0; i < 2000; i++) be.put(d, Buffer.from(`${b}:${i}`.padStart(10, '0')), Buffer.alloc(400, b)); });
    let info = be.info();
    assert.equal(be.stat(d).entries, 16000);
    assert.ok(info.mapGrown && info.mapSize > 2 ** 20, 'grown at runtime');
    if (fs.existsSync('/proc/self/maps')) assert.ok(mappings() > 1, 'the grown map leaves the old mapping alive');
    await be.close();
    // reopen with the same small setting: sized from the file, one mapping, file not extended
    const fileBytes = fs.statSync(path).size;
    be = createLmdbBackend({ path, options: { mapSize: 2 ** 20 } });
    info = be.info();
    assert.equal(info.mapSize, mapSizeFor(2 ** 20, fileBytes));
    assert.ok(!info.mapGrown && info.mapUsed <= 0.5);
    if (fs.existsSync('/proc/self/maps')) assert.equal(mappings(), 1);
    await be.close();
    // the default 2 GiB hot map does not grow the file
    be = createLmdbBackend({ path });
    assert.equal(be.info().mapSize, 2 ** 31);
    assert.equal(fs.statSync(path).size, fileBytes);
    await be.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('copy-compaction', () => {
  test('compactCopy copies a consistent, smaller env in a child process while the writer stays open', async () => {
    const { compactCopy } = await import('../src/backend-lmdb.js');
    const { join } = await import('node:path');
    const dir = tmpDir('compact');
    const db = openDB({ dir, boot: false });
    db.txn(() => { for (let i = 0; i < 20000; i++) db.user.put({ uid: BigInt(i + 1), plan: i % 4, username: 'user' + i, bio: 'x'.repeat(100) }); });
    db.txn(() => { for (let i = 0; i < 20000; i += 2) db.user.del(BigInt(i + 1)); });
    const before = fs.statSync(join(dir, 'hot.mdb')).size;
    const r = await compactCopy(join(dir, 'hot.mdb'), join(dir, 'hot.compact.mdb'));
    assert.ok(r.bytes > 0 && r.bytes < before, `compacted ${r.bytes} < ${before}`);
    assert.ok(r.childPeakRssMB > 0);
    db.user.put({ uid: 999999n, plan: 1, username: 'after the copy' }); // the writer was never blocked
    await db.close();
    fs.renameSync(join(dir, 'hot.compact.mdb'), join(dir, 'hot.mdb'));
    const db2 = openDB({ dir, boot: false });
    assert.equal(db2.user.count(), 10000);
    assert.equal(db2.user.countIndex('user_by_plan'), 10000);
    assert.equal(db2.user.get(2n).username, 'user1');
    await db2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

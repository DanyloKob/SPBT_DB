import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rng, tmpDir } from './util.js';
import { openDB, coreSchemas } from '../src/index.js';
import { aiSchemas, DAY } from '../src/ai-schema.js';
import { attachBlobs, hashOf, mimeCode, MIME } from '../src/blobs.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function setup(extra = {}) {
  const dir = tmpDir('blob');
  dirs.push(dir);
  const db = openDB({ dir: join(dir, 'db'), schemas: { ...coreSchemas, ...aiSchemas } });
  const blobs = attachBlobs(db, { dir: join(dir, 'blobs'), fsync: true, ...extra });
  return { dir, db, blobs, root: join(dir, 'blobs') };
}

function bytes(n, seed) {
  const r = rng(seed);
  return Buffer.from(Array.from({ length: n }, () => r.int(256)));
}
/** every file under the ab/cd tree, as 'ab/cd/hex' */
function treeFiles(root) {
  const out = [];
  for (const a of fs.readdirSync(root)) {
    if (a === 'tmp') continue;
    for (const b of fs.readdirSync(join(root, a))) for (const f of fs.readdirSync(join(root, a, b))) out.push(`${a}/${b}/${f}`);
  }
  return out.sort();
}
const tmpFiles = (root) => fs.readdirSync(join(root, 'tmp'));
async function drain(stream) {
  const parts = [];
  for await (const c of stream) parts.push(c);
  return Buffer.concat(parts);
}
const chunked = (buf, size) => Readable.from(Array.from({ length: Math.ceil(buf.length / size) }, (_, i) => buf.subarray(i * size, (i + 1) * size)));

describe('blob store', () => {
  test('content addressing, dedup across buffers and streams, read paths', async () => {
    const { db, blobs, root } = setup();
    const data = bytes(70_000, 1);
    const a = await blobs.put(data, { mime: 'image/png' });
    assert.equal(a.size, 70_000);
    assert.equal(a.inline, false);
    assert.equal(a.deduped, false);
    assert.equal(a.hex, hashOf(data).toString('hex'));
    assert.equal(a.hash.length, 16);
    assert.deepEqual(treeFiles(root), [`${a.hex.slice(0, 2)}/${a.hex.slice(2, 4)}/${a.hex}`]);
    assert.ok(fs.readFileSync(blobs.path(a.hash)).equals(data));

    const b = await blobs.put(chunked(data, 4096), { mime: 'image/png' });
    assert.equal(b.deduped, true);
    assert.equal(b.hex, a.hex);
    const c = await blobs.put(new Uint8Array(data), {});
    assert.equal(c.deduped, true);
    assert.equal(treeFiles(root).length, 1);
    assert.deepEqual(tmpFiles(root), []);

    assert.ok((await drain(blobs.open(a.hex))).equals(data));
    assert.ok((await blobs.read(a.hash)).equals(data));
    assert.deepEqual(blobs.stat(a.hash), { size: 70_000, mime: 'image/png', refs: 0, firstSeen: blobs.stat(a.hash).firstSeen, zeroAt: blobs.stat(a.hash).zeroAt, inline: false });
    assert.equal(blobs.open(Buffer.alloc(16)), undefined);
    assert.equal(await blobs.read('00'.repeat(16)), undefined);
    assert.throws(() => blobs.has('xyz'), /bad hash/);
    assert.equal(mimeCode('Image/JPEG; q=1'), MIME.indexOf('image/jpeg'));
    assert.equal(mimeCode('application/x-unknown'), 0);
    await db.close();
  });

  test('inline threshold: <= 1 KB lives in the DB, > 1 KB on disk', async () => {
    const { db, blobs, root } = setup();
    const small = bytes(1024, 2), big = bytes(1025, 3);
    const s = await blobs.put(small, { mime: 'text/plain' });
    const s2 = await blobs.put(chunked(small, 100));
    const e = await blobs.put(Buffer.alloc(0));
    assert.equal(s.inline, true);
    assert.equal(s2.deduped, true);
    assert.equal(e.inline, true);
    assert.deepEqual(treeFiles(root), []);
    assert.equal(blobs.path(s.hash), undefined);
    assert.ok((await blobs.read(s.hash)).equals(small));
    assert.ok((await drain(blobs.open(s.hash))).equals(small));
    assert.equal((await blobs.read(e.hash)).length, 0);
    assert.equal(blobs.stat(s.hash).inline, true);
    const b = await blobs.put(chunked(big, 100));
    assert.equal(b.inline, false);
    assert.equal(treeFiles(root).length, 1);
    assert.deepEqual(tmpFiles(root), []);
    await db.close();
  });

  test('refcounts: ref/unref, txn hook commits with the owning row, rollbacks', async () => {
    const { db, blobs } = setup();
    const img = bytes(5000, 4);
    const imageId = Buffer.alloc(16, 7);
    const p = await blobs.put(img, {
      mime: 'image/webp',
      txn: (info) => db.image.put({ imageId, userId: 555n, ext: 1, size: info.size, uploadedAt: 1000, blobHash: info.hash }),
    });
    assert.equal(p.refs, 1);
    assert.deepEqual(db.image.get(imageId).blobHash, p.hash);
    assert.deepEqual(db.image.byUser(555n).map((x) => x.imageId), [imageId]);
    assert.equal(blobs.ref(p.hash), 2);
    assert.equal(blobs.unref(p.hash), 1);
    // a failing hook rolls back the ref and the owning row; the blob is left at refs 0 for gc
    const img2 = bytes(5000, 5);
    await assert.rejects(blobs.put(img2, { txn: () => { db.image.put({ imageId: Buffer.alloc(16, 8), userId: 555n, ext: 1, size: 1, uploadedAt: 2000, blobHash: Buffer.alloc(16) }); throw new Error('hook'); } }), /hook/);
    assert.equal(db.image.get(Buffer.alloc(16, 8)), undefined);
    assert.equal(blobs.stat(hashOf(img2)).refs, 0);
    // ref/unref join an outer txn and roll back with it
    assert.throws(() => db.txn(() => { blobs.unref(p.hash); db.image.del(imageId); throw new Error('x'); }), /x/);
    assert.equal(blobs.stat(p.hash).refs, 1);
    assert.ok(db.image.get(imageId));
    db.txn(() => { blobs.unref(p.hash); db.image.del(imageId); });
    assert.equal(blobs.stat(p.hash).refs, 0);
    assert.ok(blobs.stat(p.hash).zeroAt > 0);
    assert.throws(() => blobs.unref(p.hash), /below 0/);
    assert.throws(() => blobs.ref(Buffer.alloc(16, 1)), /unknown blob/);
    // concurrent puts of the same content: one file, every ref counted
    const same = bytes(9000, 6);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => blobs.put(i % 2 ? same : chunked(same, 1000), { ref: true })));
    assert.equal(rs.filter((r) => !r.deduped).length, 1);
    assert.equal(blobs.stat(hashOf(same)).refs, 6);
    await db.close();
  });

  test('gc: zero-ref blobs go after the grace period, referenced ones stay; bounded and resumable', async () => {
    const { db, blobs, root } = setup();
    const now = Date.now();
    const keep = await blobs.put(bytes(3000, 10), { ref: true });
    const zero = [];
    for (let i = 0; i < 5; i++) zero.push(await blobs.put(bytes(2000 + i, 20 + i)));
    const tiny = await blobs.put(bytes(10, 30)); // inline, zero refs
    assert.deepEqual(await blobs.gcRefs({ now }), { removed: 0, bytes: 0, more: false }); // inside the grace period
    const later = now + DAY + 1000;
    const r1 = await blobs.gcRefs({ now: later, limit: 2 });
    assert.deepEqual([r1.removed, r1.more], [2, true]);
    const r2 = await blobs.gcRefs({ now: later });
    assert.deepEqual([r2.removed, r2.more], [4, false]);
    assert.equal(r1.bytes + r2.bytes, zero.reduce((s, z) => s + z.size, 0) + 10);
    for (const z of [...zero, tiny]) assert.equal(blobs.has(z.hash), false);
    assert.equal(db.blobInline.count(), 0);
    assert.deepEqual(treeFiles(root), [`${keep.hex.slice(0, 2)}/${keep.hex.slice(2, 4)}/${keep.hex}`]);
    assert.equal(blobs.stat(keep.hash).refs, 1);
    // unref -> grace restarts from the unref time, not from firstSeen
    blobs.unref(keep.hash);
    assert.equal((await blobs.gcRefs({ now: Date.now() + DAY - 60_000 })).removed, 0);
    // re-uploading a zero-ref blob restarts its grace period too
    const again = bytes(4000, 40);
    const g = await blobs.put(again);
    db.blobRef.patch(g.hash, { zeroAt: now - 2 * DAY }); // pretend it went to zero long ago
    await blobs.put(again);
    assert.equal((await blobs.gcRefs({ now: Date.now() + 1000 })).removed, 0);
    assert.ok(blobs.has(g.hash));
    await db.close();
  });

  test('gc and put racing on the same hash never leave a row without its file', async () => {
    // gc pauses between deleting the row and unlinking the file: without the per-hash lock,
    // put would dedup against the doomed file and end with a row whose file is gone
    const { db, blobs } = setup({ failpoint: (p) => (p === 'gcBeforeUnlink' ? new Promise((r) => setTimeout(r, 5)) : undefined) });
    const r = rng(77);
    for (let round = 0; round < 20; round++) {
      const data = bytes(3000, 100 + round);
      const p = await blobs.put(data);
      db.blobRef.patch(p.hash, { zeroAt: 1 });
      const [, res] = await Promise.all([blobs.gcRefs({ now: Date.now() }), r.int(2) ? blobs.put(data, { ref: true }) : blobs.put(chunked(data, 512), { ref: true })]);
      assert.equal(res.refs, 1);
      assert.ok(fs.existsSync(blobs.path(p.hash)), `round ${round}: row without file`);
    }
    await db.close();
  });

  test('crash between tmp write and rename leaves only a tmp file, which gc removes', async () => {
    const { dir, db, blobs, root } = setup();
    await db.close();
    const script = join(dir, 'crash.mjs');
    fs.writeFileSync(script, `
      import { openDB, coreSchemas } from ${JSON.stringify(SRC + 'index.js')};
      import { aiSchemas } from ${JSON.stringify(SRC + 'ai-schema.js')};
      import { attachBlobs } from ${JSON.stringify(SRC + 'blobs.js')};
      import { Readable } from 'node:stream';
      const [dir, point, mode] = process.argv.slice(2);
      const db = openDB({ dir: dir + '/db', schemas: { ...coreSchemas, ...aiSchemas } });
      const blobs = attachBlobs(db, { dir: dir + '/blobs', failpoint: (p) => { if (p === point) process.kill(process.pid, 'SIGKILL'); } });
      const data = Buffer.alloc(50000, point.length);
      await blobs.put(mode === 'stream' ? Readable.from([data.subarray(0, 20000), data.subarray(20000)]) : data, { ref: true });
      console.log('not killed');
    `);
    for (const mode of ['buffer', 'stream']) {
      const res = spawnSync(process.execPath, [script, dir, 'afterTmp', mode], { encoding: 'utf8' });
      assert.equal(res.signal, 'SIGKILL', res.stderr);
    }
    assert.equal(tmpFiles(root).length, 2);
    assert.deepEqual(treeFiles(root), []);
    const res2 = spawnSync(process.execPath, [script, dir, 'afterRename', 'buffer'], { encoding: 'utf8' });
    assert.equal(res2.signal, 'SIGKILL', res2.stderr);
    const orphan = treeFiles(root);
    assert.equal(orphan.length, 1); // renamed into place, but the ref txn never ran

    const db2 = openDB({ dir: join(dir, 'db'), schemas: { ...coreSchemas, ...aiSchemas } });
    const b2 = attachBlobs(db2, { dir: root });
    const hex = orphan[0].split('/')[2];
    assert.equal(b2.has(hex), false);
    assert.equal(db2.blobRef.count(), 0);
    // fresh files are protected by the grace periods
    let w = await b2.gcOrphans();
    assert.deepEqual([w.removed, w.removedTmp], [0, 0]);
    assert.equal(tmpFiles(root).length, 2);
    w = await b2.gc({ now: Date.now() + 2 * 3_600_000 });               // past tmpGrace (1 h), inside grace (24 h)
    assert.deepEqual([w.orphans.removed, w.orphans.removedTmp, w.orphans.done], [0, 2, true]);
    assert.deepEqual(tmpFiles(root), []);
    assert.equal(treeFiles(root).length, 1);
    w = await b2.gc({ now: Date.now() + DAY + 60_000 });
    assert.equal(w.orphans.removed, 1);
    assert.deepEqual(treeFiles(root), []);
    // the store still works
    const p = await b2.put(Buffer.alloc(50000, 8), { ref: true });
    assert.equal(p.deduped, false);
    assert.equal(b2.stat(p.hash).refs, 1);
    await db2.close();
    void blobs;
  });

  test('orphan walk is bounded and resumable by cursor', async () => {
    const { db, blobs, root } = setup({ fsync: false });
    const live = await blobs.put(bytes(2000, 50), { ref: true });
    const orphans = [];
    for (let i = 0; i < 12; i++) {
      const hex = hashOf(Buffer.from(`orphan ${i}`)).toString('hex');
      const d = join(root, hex.slice(0, 2), hex.slice(2, 4));
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(join(d, hex), 'x');
      orphans.push(hex);
    }
    fs.writeFileSync(join(root, live.hex.slice(0, 2), live.hex.slice(2, 4), 'README'), 'not a blob'); // foreign files are left alone
    const future = Date.now() + 2 * DAY;
    let removed = 0, calls = 0, res;
    do {
      res = await blobs.gcOrphans({ now: future, limit: 3 });
      removed += res.removed;
      calls++;
      assert.ok(res.scanned <= 3 + 2, `scanned ${res.scanned}`); // stops after the leaf that crosses the limit
    } while (!res.done && calls < 50);
    assert.equal(removed, 12);
    assert.ok(calls >= 4, `${calls} calls`);
    assert.equal(res.cursor, undefined);
    assert.ok(fs.existsSync(blobs.path(live.hash)));
    assert.equal(treeFiles(root).length, 2); // the live blob + README
    await db.close();
  });

  test('maxBytes and bad input leave nothing behind', async () => {
    const { db, blobs, root } = setup();
    await assert.rejects(blobs.put(chunked(bytes(10_000, 60), 1000), { maxBytes: 5000 }), /maxBytes/);
    await assert.rejects(blobs.put(bytes(10_000, 61), { maxBytes: 5000 }), /maxBytes/);
    await assert.rejects(blobs.put(42), /needs bytes/);
    assert.deepEqual(tmpFiles(root), []);
    assert.deepEqual(treeFiles(root), []);
    assert.equal(db.blobRef.count(), 0);
    await db.close();
  });
});

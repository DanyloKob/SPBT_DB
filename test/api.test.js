// The public entry points of the package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as spbt from 'spbt-db';

test('open, openDB and openTanoDB are the same function', () => {
  assert.equal(typeof spbt.openDB, 'function');
  assert.equal(spbt.open, spbt.openDB);
  assert.equal(spbt.openTanoDB, spbt.openDB);
});

test('open() on the memory backend works without a directory', async () => {
  const db = spbt.open({ backend: 'memory' });
  db.level.put({ gid: 1n, uid: 2n, xp: 3 });
  assert.deepEqual(db.level.get(1n, 2n), { xp: 3 });
  await db.close();
});

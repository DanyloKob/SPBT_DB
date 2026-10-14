// The README "Quick start", run through the package's own exports map (self-reference by name).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpDir } from './util.js';
import { openDB, coreSchemas, eventLogSchema, DISCORD_EPOCH } from 'spbt-db';
import { aiSchemas } from 'spbt-db/ai-schema';
import { attachVectors } from 'spbt-db/vector';
import { attachBlobs } from 'spbt-db/blobs';

test('README quick start: open + level + sched + bucketed event_log + vectors + blobs', async () => {
  const dir = tmpDir('quickstart');
  const db = openDB({ dir, schemas: { ...coreSchemas, ...aiSchemas }, sched: true, ttl: true });
  attachVectors(db);
  attachBlobs(db, { dir: `${dir}/blobs` });
  const elog = db.bucketed('event_log', eventLogSchema, { retentionDays: 30 });
  const logBuf = elog.appender();

  const gid = '1200000000000000001', uid = '1200000000000000002', chan = '1200000000000000003';
  const createdTimestamp = Date.now() - 1000;
  const msgId = String((BigInt(createdTimestamp - DISCORD_EPOCH) << 22n) | 7n);

  assert.equal(db.level.get(gid, uid), undefined);
  db.level.bump(gid, uid, 15);
  logBuf.append({ gid, chan, ts: createdTimestamp, k: 0, msgId: BigInt(msgId), authorId: BigInt(uid), content: 'hi' });
  logBuf.append({ gid, chan, ts: Date.now(), k: 2, msgId: BigInt(msgId), authorId: BigInt(uid) });

  let unbanned = null;
  db.sched.on('unban', async (job) => { unbanned = job.subject; });
  db.txn(() => {
    db.kv.put({ k: `case:${gid}:1`, target: uid, reason: 'spam' });
    db.sched.at(Date.now() - 1, { kind: 'unban', gid, subject: uid, catchUp: 'run' });
  });

  const id = db.ai.add(gid, null, new Float32Array(256).fill(0.1), 'the server rules are pinned in #rules');
  const hits = db.ai.knn(gid, new Float32Array(256).fill(0.1), 3);
  const { hash } = await db.blobs.put(Buffer.from('png bytes'), { mime: 'image/png', ref: true });

  await logBuf.flush();
  await db.level.bumps.flush();
  await db.sched.runDue();
  assert.deepEqual(db.level.top(gid, 10).map((r) => r.xp), [15]);
  assert.deepEqual(elog.byMessageId(msgId).map((r) => r.k), [0, 2]);
  assert.equal(elog.query({ index: 'elog_by_chan', where: [gid, chan], desc: true, limit: 50 }).items[0].k, 2);
  assert.equal(hits[0].chunkId, id);
  assert.equal(db.blobs.has(hash), true);
  assert.equal(String(unbanned), uid);
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

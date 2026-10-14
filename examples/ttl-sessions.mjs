// Web-panel sessions with a TTL.
//   node examples/ttl-sessions.mjs
//
// The expiry is stored in the record itself: a read after it returns undefined at once, with no
// timer and no cleanup pass. The sweeper only gives the disk space back, in bounded batches.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { open } from 'spbt-db';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spbt-db-sessions-'));
const db = open({ dir, ttl: { schedule: false } }); // ttl: the sweeper; schedule: false = run it by hand here
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sessions = db.collection('session', {
  key: 'sid:b16',                 // 16 random bytes
  ttl: 1_000,                     // default lifetime (a real panel would use days)
  indexes: { session_by_user: { key: 'uid:u64 sid:b16' } }, // "log out everywhere"
});

const uid = '300000000000000001';
const sids = [];
for (let i = 0; i < 3; i++) {
  const sid = randomBytes(16);
  sessions.put({ sid, uid, createdAt: Date.now(), lastSeenAt: Date.now() });
  sids.push(sid);
}
console.log(`3 sessions for ${uid}: ${sessions.countIndex('session_by_user', uid)} in the index`);

// a request keeps a session alive: patch with a fresh ttl (without one, patch keeps the expiry)
await sleep(600);
sessions.patch(sids[0], { lastSeenAt: Date.now() }, { ttl: 1_000 });

await sleep(600); // sessions 1 and 2 are now past their expiry, session 0 is not
for (const [i, sid] of sids.entries()) console.log(`  session ${i}: ${sessions.get(sid) ? 'valid' : 'expired'}`);
console.log(`on disk: ${sessions.count()} rows (expired rows stay until the sweeper runs), live: ${sessions.countLive()}`);

const r = await db.ttl.sweep(); // in production a daily scheduler job does this
console.log(`sweep: scanned ${r.scanned}, deleted ${r.deleted} in ${r.txns} txn(s); on disk now: ${sessions.count()}`);

// log out everywhere: the index gives the user's session ids without reading the sessions
const mine = sessions.query({ index: 'session_by_user', where: [uid], covered: true }).items;
db.txn(() => { for (const s of mine) sessions.del(s.sid); });
console.log(`logged out everywhere: ${mine.length} session(s) removed, ${sessions.count()} left`);

await db.close();
fs.rmSync(dir, { recursive: true, force: true });

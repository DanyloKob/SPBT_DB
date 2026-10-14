// Temporary bans with the durable scheduler.
//   node examples/tempban-scheduler.mjs
//
// A tempban is two writes that must not come apart: the moderation case and the job that lifts
// the ban. They go in ONE txn. The job is a row on disk, so it survives a restart, and a job that
// came due while the bot was down runs as soon as it starts again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open } from 'spbt-db';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spbt-db-tempban-'));
const guildId = '1100000000000000001';
const alice = '300000000000000001', bob = '300000000000000002';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start() {
  const db = open({ dir, sched: true });
  // handlers must be idempotent: delivery is at-least-once (a crash between the Discord call and
  // the commit that deletes the job runs it again)
  db.sched.on('unban', async (job, { lagMs }) => {
    // here: await guild.bans.remove(String(job.subject)).catch(ignoreUnknownBan)
    console.log(`  unban ${job.subject} in ${job.gid} (case #${job.caseNo}, ${lagMs} ms late)`);
  });
  return db;
}

function tempban(db, uid, caseNo, ms, reason) {
  db.txn(() => {
    db.kv.put({ k: `case:${guildId}:${caseNo}`, type: 'tempban', target: uid, reason, at: Date.now() });
    db.sched.at(Date.now() + ms, { kind: 'unban', gid: guildId, subject: uid, caseNo, catchUp: 'run' });
  });
  console.log(`tempban ${uid} for ${ms} ms (case #${caseNo})`);
}

let db = start();
tempban(db, alice, 1, 300, 'spam');
tempban(db, bob, 2, 1_000, 'raid');
console.log(`jobs waiting: ${db.sched.count()}; bob's: ${db.sched.find(guildId, 'unban', bob).length}`);

await sleep(500); // alice's ban runs out while the bot is up

console.log('stopping the bot before bob\'s ban runs out');
await db.close();
await sleep(800); // bob's unban comes due while nothing is running

console.log('starting again');
db = start(); // the overdue job runs on the next tick
await sleep(100);
await db.sched.idle();

// /unban before the time is up: cancel through the (gid, kind, subject) index, no scan
tempban(db, alice, 3, 60 * 60_000, 'again');
console.log(`/unban ${alice}: cancelled ${db.sched.cancel(guildId, 'unban', alice)} job(s)`);
console.log(`jobs waiting: ${db.sched.count()}`);

await db.close();
fs.rmSync(dir, { recursive: true, force: true });

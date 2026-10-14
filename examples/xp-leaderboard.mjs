// Discord-bot-style XP and a leaderboard.
//   node examples/xp-leaderboard.mjs
//
// The shape of a messageCreate handler: read the guild's level settings, give XP with a per-member
// cooldown, notice when a member crosses a reward, and show a top 10. No discord.js needed here:
// the messages are simulated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open } from 'spbt-db';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spbt-db-xp-'));
const db = open({ dir }); // core collections: guild, guild_feature, feature_config, user, news, level, kv

const LEVELS = 8; // feature tags are u8 numbers; the app keeps its own name -> tag table
const guildId = '1100000000000000001'; // ids may be strings (discord.js), bigints or safe integers
const members = Array.from({ length: 300 }, (_, i) => String(300000000000000000n + BigInt(i)));

// per-guild settings: one durable write, then read on every message
db.guildFeature.put({ gid: guildId, tag: LEVELS, enabled: true, enabledAt: Date.now() });
db.featureConfig.put({ gid: guildId, tag: LEVELS, cooldownMs: 60_000, rewards: [{ xp: 50, role: 'Regular' }, { xp: 150, role: 'Veteran' }] });

const lastXpAt = new Map(); // the cooldown lives in RAM: it is shorter than a flush, no point storing it

function onMessage(gid, uid, now) {
  if (!db.guildFeature.get(gid, LEVELS)?.enabled) return;
  const cfg = db.featureConfig.get(gid, LEVELS);
  const key = `${gid}:${uid}`;
  if (now - (lastXpAt.get(key) ?? 0) < cfg.cooldownMs) return;
  lastXpAt.set(key, now);

  const before = (db.level.get(gid, uid)?.xp ?? 0) + (db.level.bumps?.peek(gid, uid) ?? 0);
  const gain = 15 + Math.floor(Math.random() * 11);
  // RAM only (~0.2 µs). One txn every 30 s or 2 000 members writes all of it, off the main thread.
  db.level.bump(gid, uid, gain);
  const reward = cfg.rewards.find((r) => before < r.xp && before + gain >= r.xp);
  if (reward) console.log(`  member …${uid.slice(-3)} reached ${reward.xp} XP: give them the "${reward.role}" role`);
}

// 20 000 messages over ~3 simulated hours
let now = Date.now();
for (let i = 0; i < 20_000; i++) {
  const uid = members[Math.floor(Math.random() ** 2 * members.length)]; // a few members talk a lot
  onMessage(guildId, uid, (now += 500));
}

await db.level.bumps.flush(); // a /top command can also flush first so it shows the latest XP

console.log('\nTop 10 (a covered index range, no full scan, no sort):');
for (const [i, row] of db.level.top(guildId, 10).entries()) {
  console.log(`  ${String(i + 1).padStart(2)}. member …${String(row.uid).slice(-3)}  ${row.xp} XP`);
}
const me = members[150];
console.log(`\nMember …${me.slice(-3)}: ${db.level.get(guildId, me)?.xp ?? 0} XP, rank #${db.level.rank(guildId, me) ?? '-'}`);

await db.close(); // flushes every buffer and marks the shutdown clean
fs.rmSync(dir, { recursive: true, force: true });

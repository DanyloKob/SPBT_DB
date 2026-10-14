// TANO v26's JSON files against SPBT_DB, on the storage patterns the bot actually runs.
//
//   node bench/json-vs-spbtdb.mjs [--dir DIR] [--sizes 1000,10000,100000] [--seconds 2]
//                                 [--kills 100] [--crash-sizes 10000,100000] [--tag x] [--keep]
//   -> bench/results-<date>-json-vs-spbtdb[-tag].json + .md
//
// DIR defaults to $SPBTDB_BENCH_DIR or ~/.cache/spbtdb-bench. It must be a real disk: on tmpfs an
// fsync costs nothing. The script deletes its data when it is done unless --keep is given.
//
// The v26 side is bench/v26-stores.mjs: the v26 code, ported to ESM and otherwise unchanged
// (readFileSync + JSON.parse of the whole file on every read, writeFileSync of the whole file,
// pretty-printed, on every write, never an fsync). The SPBT_DB side is what TANO v27 does for the
// same event. Every (store, size) pair runs in its own child process, so RSS is not shared.
//
// Scenarios (one op = one call of the bot's code path):
//   user.get        v26 users.get(id)                        db.user.get(id)
//   user.set        v26 users.set(id, {plan, planExpiresAt}) db.user.patch(...): one durable commit
//                   (+ SPBT_DB with 100 sets per txn, for throughput)
//   message.xp      v26 levels messageCreate: general.json + levels.json read, XP bump in RAM
//                   v27: guild_feature + feature_config get, level.get + bump into the coalescer
//   xp.flush        bytes written per XP update and main-thread ms per flush, at 50 msg/s:
//                   v26 rewrites levels_data.json every 2 min; SPBT_DB commits every 30 s
//                   (also measured at the same 2 min interval)
//   config.read     per-guild moderation config: isFeatureEnabled + getFeatureConfig (4.4 KB)
//   audit.append    v26 sd.appendLog (read, filter, cap 100, rewrite) vs an audit_YYYYMM bucket:
//                   write-through (one durable commit per row) and through the 5 s appender
//   audit.view      latest 50 entries of a guild's audit log
//   top10           leaderboard. v26 has none; the JSON column is the obvious implementation
//                   over its data, a sort of the in-RAM XP map (no file read: its best case)
//   rss             RSS after the workload and a gc: total, anonymous, file-backed
//   crash           kill -9 during a v26 users.set loop vs during SPBT_DB user txns
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { v26Users, v26ServerData, v26Levels } from './v26-stores.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const DAY = 86_400_000;

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    o[k] = v;
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
const num = (v, d) => (v === undefined || v === true ? d : Number(v));
const list = (v, d) => (v === undefined || v === true ? d : String(v).split(',').map(Number));

/* ----------------------------------------------------------- shared data */

// synthetic snowflakes (strings, as discord.js hands them over)
const GUILD0 = 1100000000000000000n;
const gidOf = (i) => String(GUILD0 + BigInt(i) * 7919n);
const uidOf = (i) => String(300000000000000000n + BigInt(i) * 104729n);
const chanOf = (i) => String(900000000000000000n + BigInt(i));
const GUILDS = 500; // design doc §5: 500 guilds
const AUDIT_GUILDS = 50;
const FEATURES = ['ai', 'music', 'private_vc', 'welcome', 'logging', 'moderation', 'tickets', 'levels', 'roles'];
const TAG = Object.fromEntries(FEATURES.map((f, i) => [f, i + 1]));

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// config shapes calibrated on the v26 production data (sizes from docs/engineering-notes and §0)
function levelsConfig() {
  return {
    cooldown: 60,
    notification: { enabled: true, channelId: chanOf(1), message: '{user} отримав роль **{role}**! ({xp} очок)' },
    rewards: [10, 50, 100, 250, 500].map((xp, i) => ({ xp, roleId: chanOf(100 + i) })),
    ignoredChannels: [chanOf(7), chanOf(8)],
    ignoredRoles: [],
  };
}
function moderationConfig() { // ~4.4 KB pretty-printed, like the real moderation.json (12 commands x 7 fields)
  const commands = {};
  for (const c of ['warn', 'mute', 'unmute', 'kick', 'ban', 'unban', 'tempban', 'clear', 'slowmode', 'lock', 'unlock', 'history']) {
    commands[c] = {
      enabled: true,
      allowedRoles: [chanOf(200), chanOf(201)],
      logChannelId: chanOf(300),
      dmUser: c !== 'clear',
      requireReason: c === 'ban' || c === 'tempban',
      defaultDuration: c.includes('mute') || c === 'tempban' ? 3_600_000 : null,
      message: `Користувача {user} покарано командою /${c}. Причина: {reason}`,
    };
  }
  return { enabled: true, logChannelId: chanOf(300), commands };
}
const generalJson = () => ({ features: Object.fromEntries(FEATURES.map((f) => [f, { enabled: true, enabledAt: '2026-05-01' }])) });
const auditEntry = (r, ts) => ({
  timestamp: new Date(ts).toISOString(),
  action: 'Оновлено налаштування модерації',
  details: `Панель #${1 + Math.floor(r() * 3)}`,
  user: { id: uidOf(Math.floor(r() * 1000)), username: 'moderator_' + Math.floor(r() * 1000), avatar: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' },
});

/* --------------------------------------------------------------- metering */

function procStatus() {
  const s = fs.readFileSync('/proc/self/status', 'utf8');
  const kb = (k) => { const m = new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(s); return m ? +m[1] : 0; };
  const mb = (k) => +(kb(k) / 1024).toFixed(1);
  return { rssMB: mb('VmRSS'), anonMB: mb('RssAnon'), fileMB: mb('RssFile'), shmemMB: mb('RssShmem'), hwmMB: mb('VmHWM') };
}
/** bytes this process handed to write()/pwrite() so far (all threads, lmdb's write thread included) */
function wchar() {
  const m = /^wchar:\s+(\d+)/m.exec(fs.readFileSync('/proc/self/io', 'utf8'));
  return m ? +m[1] : 0;
}
const tick = () => new Promise((r) => setImmediate(r));
const gc = async () => { if (global.gc) { for (let i = 0; i < 3; i++) { global.gc(); await tick(); } } };

function stats(lat, n) {
  const s = Float64Array.from(lat.subarray(0, n)).sort();
  const q = (p) => s[Math.min(n - 1, Math.floor(p * (n - 1)))];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += s[i];
  return { p50us: +(q(0.5) * 1000).toFixed(2), p99us: +(q(0.99) * 1000).toFixed(2), meanUs: +((sum / n) * 1000).toFixed(2), maxUs: +(s[n - 1] * 1000).toFixed(1) };
}

/**
 * Time `op(i)` (sync, or returning a promise). Runs in chunks with an event-loop turn between
 * them, inside the wall clock: deferred work (a coalescer's txn callback, lmdb commits) runs and
 * is paid for. ops/s = ops / wall seconds; latency percentiles are per call.
 */
async function measure(op, { seconds, maxIters = 1_000_000, minIters = 5, chunk = 200 }) {
  const warmEnd = performance.now() + Math.min(300, seconds * 100);
  let warm = 0;
  for (; warm < 200 && (warm < 1 || performance.now() < warmEnd); warm++) { const r = op(-1 - warm); if (r && r.then) await r; }
  const lat = new Float64Array(maxIters);
  let n = 0;
  const t0 = performance.now(), deadline = t0 + seconds * 1000;
  outer: while (n < maxIters) {
    for (let k = 0; k < chunk && n < maxIters; k++) {
      const a = performance.now();
      const r = op(n);
      if (r && r.then) await r;
      const b = performance.now();
      lat[n++] = b - a;
      if (b > deadline && n >= minIters) break outer;
    }
    await tick();
  }
  const wall = performance.now() - t0;
  return { ops: n, warmOps: warm, opsPerSec: +(n / (wall / 1000)).toFixed(1), ...stats(lat, n) };
}

/* ============================================================ child: suite */

/**
 * RSS of a fresh process that opens the data a suite left behind and runs a light bot-like
 * workload: 20 000 messages (XP path), 50 user reads, 1 000 config reads, 100 audit views, the XP
 * flush. The benchmark's own garbage (latency arrays, a million test rows) is not in it.
 */
async function rssChild({ store, n, dir }) {
  const r = rng(n * 13 + 5);
  const pick = (k) => Math.floor(r() * k);
  const g0 = gidOf(0), chan = chanOf(42);
  await gc();
  const before = procStatus();
  if (store === 'json') {
    const data = path.join(dir, 'data');
    const users = v26Users(data), sd = v26ServerData(data), levels = v26Levels(sd);
    let vnow = Date.now();
    for (let i = 0; i < 20_000; i++) levels.onMessage(g0, chan, uidOf(pick(n)), (vnow += 61_000));
    for (let i = 0; i < 50; i++) users.get(uidOf(pick(n)));
    for (let i = 0; i < 1000; i++) { const g = gidOf(pick(GUILDS)); if (sd.isFeatureEnabled(g, 'moderation')) sd.getFeatureConfig(g, 'moderation'); }
    for (let i = 0; i < 100; i++) sd.getLog(gidOf(pick(AUDIT_GUILDS)));
    levels.flushAll();
    await gc();
    const after = procStatus();
    return { store, n, bare: before, rss: after, guildsInRam: levels.guildData.size };
  }
  const { openDB } = await import('../src/index.js');
  const db = openDB({ dir, coalesce: { level: { flushMs: 1e9, maxEntries: 1e9, cap: 1e9 } } });
  const audit = db.bucketed('audit', { key: 'gid:u64 ts:u48 seq:u16', env: 'cold' }, { retentionDays: 90 });
  for (let i = 0; i < 20_000; i++) {
    const uid = uidOf(pick(n));
    if (!db.guildFeature.get(g0, TAG.levels)?.enabled) continue;
    const cfg = db.featureConfig.get(g0, TAG.levels);
    if (cfg.ignoredChannels?.includes(chan)) continue;
    db.level.get(g0, uid);
    db.level.bump(g0, uid, 1);
  }
  for (let i = 0; i < 50; i++) db.user.get(uidOf(pick(n)));
  for (let i = 0; i < 1000; i++) { const g = gidOf(pick(GUILDS)); if (db.guildFeature.get(g, TAG.moderation)?.enabled) db.featureConfig.get(g, TAG.moderation); }
  for (let i = 0; i < 100; i++) audit.query({ where: [gidOf(pick(AUDIT_GUILDS))], desc: true, limit: 50 });
  await db.level.bumps.flush();
  await gc();
  const after = procStatus();
  await db.close();
  return { store, n, bare: before, rss: after };
}

async function suite({ store, n, dir, seconds }) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const log = (m) => process.stderr.write(`  [${store} N=${n}] ${m}\n`);
  const r = rng(n * 7 + (store === 'json' ? 1 : 2));
  const pick = (k) => Math.floor(r() * k);
  const out = { store, n, scenarios: {} };
  const t0 = performance.now();
  const S = (name, v) => { out.scenarios[name] = v; log(`${name}: ${JSON.stringify(v)}`); };

  if (store === 'json') {
    /* ---- v26 data directory */
    const data = path.join(dir, 'data');
    const sdDir = path.join(data, 'server_data');
    fs.mkdirSync(sdDir, { recursive: true });
    const now0 = Date.now();
    const allUsers = {};
    for (let i = 0; i < n; i++) allUsers[uidOf(i)] = { plan: 'normal', since: now0 - pick(365) * DAY };
    fs.writeFileSync(path.join(data, 'users.json'), JSON.stringify(allUsers, null, 2));
    const pretty = (o) => JSON.stringify(o, null, 2);
    for (let g = 0; g < GUILDS; g++) {
      const d = path.join(sdDir, gidOf(g));
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'general.json'), pretty(generalJson()));
      fs.writeFileSync(path.join(d, 'levels.json'), pretty(levelsConfig()));
      fs.writeFileSync(path.join(d, 'moderation.json'), pretty(moderationConfig()));
      if (g < AUDIT_GUILDS) {
        const entries = [];
        for (let i = 0; i < 100; i++) entries.push(auditEntry(r, now0 - (100 - i) * 60_000));
        fs.writeFileSync(path.join(d, 'activity_log.json'), pretty(entries));
      }
    }
    const members = {};
    for (let i = 0; i < n; i++) members[uidOf(i)] = { xp: pick(2000), lastMsg: now0 - DAY };
    fs.writeFileSync(path.join(sdDir, gidOf(0), 'levels_data.json'), pretty(members));
    out.setupMs = Math.round(performance.now() - t0);
    out.files = {
      usersJsonBytes: fs.statSync(path.join(data, 'users.json')).size,
      levelsDataBytes: fs.statSync(path.join(sdDir, gidOf(0), 'levels_data.json')).size,
      moderationJsonBytes: fs.statSync(path.join(sdDir, gidOf(0), 'moderation.json')).size,
      activityLogBytes: fs.statSync(path.join(sdDir, gidOf(0), 'activity_log.json')).size,
      generalJsonBytes: fs.statSync(path.join(sdDir, gidOf(0), 'general.json')).size,
      levelsJsonBytes: fs.statSync(path.join(sdDir, gidOf(0), 'levels.json')).size,
    };
    await gc();
    out.rssLoaded = procStatus();

    const users = v26Users(data);
    const sd = v26ServerData(data);
    const levels = v26Levels(sd);

    S('user.get', await measure(() => users.get(uidOf(pick(n))), { seconds }));

    let w0 = wchar();
    const set = await measure(() => users.set(uidOf(pick(n)), { plan: 'premium', planExpiresAt: Date.now() + 30 * DAY }), { seconds });
    set.bytesPerOp = Math.round((wchar() - w0) / (set.ops + set.warmOps));
    set.durable = false;
    S('user.set', set);

    let vnow = Date.now();
    const g0 = gidOf(0), chan = chanOf(42);
    // every message earns XP: v26 reads `cooldown || 60`, so the virtual clock moves 61 s per message
    S('message.xp', await measure(() => levels.onMessage(g0, chan, uidOf(pick(n)), (vnow += 61_000)), { seconds }));

    // xp.flush: 50 msg/s for 2 min = 6 000 XP updates, then the 2-min flushAll(), 3 rounds
    const rounds = [];
    for (let k = 0; k < 3; k++) {
      for (let i = 0; i < 6000; i++) levels.onMessage(g0, chan, uidOf(pick(n)), (vnow += 61_000));
      w0 = wchar();
      const a = performance.now();
      levels.flushAll();
      rounds.push({ ms: performance.now() - a, bytes: wchar() - w0 });
    }
    rounds.sort((x, y) => x.ms - y.ms);
    const mid = rounds[1];
    S('xp.flush', { intervalS: 120, updatesPerFlush: 6000, flushMainThreadMs: +mid.ms.toFixed(2), bytesPerFlush: mid.bytes, bytesPerUpdate: +(mid.bytes / 6000).toFixed(1), durable: false });

    S('config.read', await measure(() => { const g = gidOf(pick(GUILDS)); return sd.isFeatureEnabled(g, 'moderation') && sd.getFeatureConfig(g, 'moderation'); }, { seconds }));

    w0 = wchar();
    const actor = { id: uidOf(5), username: 'moderator_5', avatar: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' };
    const ap = await measure(() => sd.appendLog(gidOf(pick(AUDIT_GUILDS)), 'Оновлено налаштування модерації', 'Панель #2', actor), { seconds });
    ap.bytesPerOp = Math.round((wchar() - w0) / (ap.ops + ap.warmOps));
    ap.durable = false;
    S('audit.append', ap);

    S('audit.view', await measure(() => sd.getLog(gidOf(pick(AUDIT_GUILDS))).slice(-50).reverse(), { seconds }));

    // leaderboard over the in-RAM XP map (levels.getGuild keeps it loaded, as the v26 bot does)
    const gd = levels.getGuild(g0);
    S('top10', await measure(() => Object.entries(gd.users).sort((a, b) => b[1].xp - a[1].xp).slice(0, 10), { seconds }));
    await gc();
    out.rss = procStatus();
    out.guildsInRam = levels.guildData.size; // keeps the map reachable until here
  } else {
    /* ---- SPBT_DB, the v27 schemas */
    const { openDB, coreSchemas } = await import('../src/index.js');
    // the level coalescer flushes only when told to: its cost is measured in xp.flush, like v26's flushAll
    const db = openDB({ dir, schemas: coreSchemas, coalesce: { level: { flushMs: 1e9, maxEntries: 1e9, cap: 1e9 } } });
    const now0 = Date.now();
    const BATCH = 1000;
    for (let i = 0; i < n; i += BATCH) {
      db.txn(() => { for (let j = i; j < Math.min(n, i + BATCH); j++) db.user.put({ uid: uidOf(j), plan: 0, since: now0 - pick(365) * DAY }); });
    }
    db.txn(() => {
      for (let g = 0; g < GUILDS; g++) {
        for (const f of FEATURES) db.guildFeature.put({ gid: gidOf(g), tag: TAG[f], enabled: true, enabledAt: now0 - 30 * DAY });
        db.featureConfig.put({ gid: gidOf(g), tag: TAG.levels, ...levelsConfig() });
        db.featureConfig.put({ gid: gidOf(g), tag: TAG.moderation, ...moderationConfig() });
      }
    });
    for (let i = 0; i < n; i += BATCH) {
      db.txn(() => { for (let j = i; j < Math.min(n, i + BATCH); j++) db.level.put({ gid: gidOf(0), uid: uidOf(j), xp: pick(2000) }); });
    }
    const audit = db.bucketed('audit', { key: 'gid:u64 ts:u48 seq:u16', env: 'cold' }, { retentionDays: 90 });
    db.coldTxn(() => {
      for (let g = 0; g < AUDIT_GUILDS; g++) {
        for (let i = 0; i < 100; i++) audit.append({ gid: gidOf(g), ts: now0 - (100 - i) * 60_000, action: 7, actorId: BigInt(uidOf(pick(1000))), details: `Панель #${1 + pick(3)}` });
      }
    });
    out.setupMs = Math.round(performance.now() - t0);
    const fileBytes = (f) => { try { return fs.statSync(path.join(dir, f)).size; } catch { return 0; } };
    out.files = { hotMdbBytes: fileBytes('hot.mdb'), coldMdbBytes: fileBytes('cold.mdb') };
    await gc();
    out.rssLoaded = procStatus();

    S('user.get', await measure(() => db.user.get(uidOf(pick(n))), { seconds }));

    let w0 = wchar();
    const set = await measure(() => db.user.patch(uidOf(pick(n)), { plan: 1, planExpiresAt: Date.now() + 30 * DAY }), { seconds });
    set.bytesPerOp = Math.round((wchar() - w0) / (set.ops + set.warmOps));
    set.durable = true;
    S('user.set', set);

    w0 = wchar();
    const setB = await measure(() => db.txn(() => { for (let k = 0; k < 100; k++) db.user.patch(uidOf(pick(n)), { plan: 1, planExpiresAt: Date.now() + 30 * DAY }); }), { seconds });
    S('user.set.batch100', { txns: setB.ops, opsPerSec: +(setB.opsPerSec * 100).toFixed(1), txnP50us: setB.p50us, txnP99us: setB.p99us, bytesPerOp: Math.round((wchar() - w0) / ((setB.ops + setB.warmOps) * 100)), durable: true });

    const g0 = gidOf(0), chan = chanOf(42);
    const crossed = (rewards, prev, next) => rewards.find((x) => prev < x.xp && next >= x.xp) || null;
    const onMessage = (uid) => {
      const f = db.guildFeature.get(g0, TAG.levels);
      if (!f || !f.enabled) return null;
      const cfg = db.featureConfig.get(g0, TAG.levels);
      if (cfg.ignoredChannels?.includes(chan)) return null;
      const prev = (db.level.get(g0, uid)?.xp ?? 0) + (db.level.bumps ? db.level.bumps.peek(g0, uid) : 0);
      db.level.bump(g0, uid, 1);
      return crossed(cfg.rewards, prev, prev + 1);
    };
    const mx = await measure(() => onMessage(uidOf(pick(n))), { seconds });
    await db.level.bumps.flush();
    S('message.xp', mx);

    // xp.flush at 50 msg/s: 1 500 updates per 30 s flush (the default), and 6 000 per 2 min
    const flushAt = async (updates) => {
      const rounds = [];
      for (let k = 0; k < 3; k++) {
        for (let i = 0; i < updates; i++) db.level.bump(g0, uidOf(pick(n)), 1);
        w0 = wchar();
        const a = performance.now();
        await db.level.bumps.flush();
        const m = db.level.bumps.metrics();
        rounds.push({ ms: performance.now() - a, apply: m.lastApplyMs, bytes: wchar() - w0 });
      }
      rounds.sort((x, y) => x.ms - y.ms);
      const mid = rounds[1];
      return { updatesPerFlush: updates, flushMainThreadMs: +mid.apply.toFixed(2), flushWallMs: +mid.ms.toFixed(2), bytesPerFlush: mid.bytes, bytesPerUpdate: +(mid.bytes / updates).toFixed(1), durable: true };
    };
    S('xp.flush', { intervalS: 30, ...(await flushAt(1500)) });
    S('xp.flush.2min', { intervalS: 120, ...(await flushAt(6000)) });

    S('config.read', await measure(() => { const g = gidOf(pick(GUILDS)); const f = db.guildFeature.get(g, TAG.moderation); return f && f.enabled && db.featureConfig.get(g, TAG.moderation); }, { seconds }));

    w0 = wchar();
    const ap = await measure(() => audit.append({ gid: gidOf(pick(AUDIT_GUILDS)), ts: Date.now(), action: 7, actorId: 300000000000523645n, details: 'Панель #2' }), { seconds });
    ap.bytesPerOp = Math.round((wchar() - w0) / (ap.ops + ap.warmOps));
    ap.durable = true;
    S('audit.append', ap);

    // The ring holds 4 096 rows. Appending a million rows a second would overflow it and drop
    // rows (the bot logs ~50/s), so the loop waits for a flush every 512 rows: ops/s is then the
    // throughput the commits sustain, and every row counted reached the disk.
    const app = audit.appender();
    w0 = wchar();
    const apc = await measure(async () => {
      app.append({ gid: gidOf(pick(AUDIT_GUILDS)), ts: Date.now(), action: 7, actorId: 300000000000523645n, details: 'Панель #2' });
      if (app.pending >= 512) await app.flush();
    }, { seconds });
    await app.flush();
    apc.dropped = app.metrics().dropped;
    if (apc.dropped) throw new Error(`audit appender dropped ${apc.dropped} rows`);
    apc.bytesPerOp = Math.round((wchar() - w0) / (apc.ops + apc.warmOps));
    apc.durable = 'after the 5 s flush';
    S('audit.append.coalesced', apc);

    S('audit.view', await measure(() => audit.query({ where: [gidOf(pick(AUDIT_GUILDS))], desc: true, limit: 50 }).items, { seconds }));

    S('top10', await measure(() => db.level.top(g0, 10), { seconds }));
    out.dbStats = db.stats();
    await gc();
    out.rss = procStatus();
    await db.close();
  }
  out.totalMs = Math.round(performance.now() - t0);
  if (!out.rss) { await gc(); out.rss = procStatus(); }
  return out;
}

/* =========================================================== child: crash */

/** v26 users.set in a loop: each call adds a new user and rewrites users.json. Acks on fd 1. */
function crashWriterJson({ dir, n }) {
  const users = v26Users(dir);
  let i = 0;
  fs.writeSync(1, 'R\n');
  for (;;) {
    users.set(uidOf(n + i), { plan: 'premium', since: Date.now() });
    i++;
    fs.writeSync(1, `${i}\n`);
  }
}

/** SPBT_DB: txns of 1..200 new users plus a kv counter, each a durable commit. Acks on fd 1. */
async function crashWriterSpbt({ dir, n }) {
  const { openDB } = await import('../src/index.js');
  const db = openDB({ dir });
  let next = db.kv.get('next')?.v ?? 0;
  const r = rng(process.pid);
  fs.writeSync(1, 'R\n');
  for (;;) {
    const k = 1 + Math.floor(r() * 200);
    db.txn(() => {
      for (let j = 0; j < k; j++) db.user.put({ uid: uidOf(n + next + j), plan: 1, since: Date.now(), planExpiresAt: Date.now() + 30 * DAY });
      db.kv.put({ k: 'next', v: next + k });
    });
    next += k;
    fs.writeSync(1, `${next}\n`);
  }
}

async function crashVerifySpbt({ dir, n }) {
  const { openDB } = await import('../src/index.js');
  const t0 = performance.now();
  const db = openDB({ dir }); // the env open plus the __boot write, as at a bot restart
  const openMs = performance.now() - t0;
  const next = db.kv.get('next')?.v ?? 0;
  const users = db.user.count();
  const byPlan = db.user.countIndex('user_by_plan');
  const byExpiry = db.user.countIndex('user_by_expiry');
  const premium = db.user.countIndex('user_by_plan', 1);
  let missing = 0;
  for (let i = Math.max(0, next - 300); i < next; i++) if (!db.user.has(uidOf(n + i))) missing++;
  const extra = db.user.has(uidOf(n + next)) ? 1 : 0;
  const clean = db.bootInfo().lastShutdownClean;
  await db.close();
  return { openMs: +openMs.toFixed(2), next, users, byPlan, byExpiry, premium, missing, extra, lastShutdownClean: clean };
}

/* ================================================================== parent */

function runChild(mode, opts) {
  const argv = ['--expose-gc', SELF, '--child', mode];
  for (const [k, v] of Object.entries(opts)) argv.push(`--${k}`, String(v));
  const res = spawnSync(process.execPath, argv, { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'inherit'] });
  if (res.status !== 0) throw new Error(`child ${mode} ${JSON.stringify(opts)} exited ${res.status} ${res.signal ?? ''}`);
  const lines = res.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

/** spawn a writer, wait for 'R', let it run `ms`, SIGKILL it; returns the last acked count */
function killAfter(mode, opts, ms) {
  return new Promise((resolve, reject) => {
    const argv = [SELF, '--child', mode];
    for (const [k, v] of Object.entries(opts)) argv.push(`--${k}`, String(v));
    const ch = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '', ready = false, timer = null;
    ch.stdout.on('data', (d) => {
      buf += d;
      if (!ready && buf.includes('R\n')) { ready = true; timer = setTimeout(() => ch.kill('SIGKILL'), ms); }
      if (buf.length > 1 << 16) buf = buf.slice(-4096);
    });
    ch.on('error', reject);
    ch.on('exit', (code, sig) => {
      clearTimeout(timer);
      if (sig !== 'SIGKILL') return reject(new Error(`${mode} exited on its own: ${code} ${sig}`));
      const acks = buf.split('\n').filter((l) => /^\d+$/.test(l));
      resolve(acks.length ? +acks[acks.length - 1] : 0);
    });
  });
}

async function crashJson(root, n, kills) {
  const dir = path.join(root, `crash-json-${n}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const r = rng(n);
  const all = {};
  for (let i = 0; i < n; i++) all[uidOf(i)] = { plan: 'normal', since: Date.now() - Math.floor(r() * 365) * DAY };
  const pristine = JSON.stringify(all, null, 2);
  const file = path.join(dir, 'users.json');
  const res = { n, fileBytes: Buffer.byteLength(pristine), kills: 0, corrupt: 0, emptyFile: 0, truncatedBytes: [], lostAcked: 0, usersLostOnCorrupt: 0, ackedWrites: 0 };
  for (let k = 0; k < kills; k++) {
    fs.writeFileSync(file, pristine);
    const acked = await killAfter('crash-writer-json', { dir, n }, 50 + Math.floor(r() * 450));
    res.kills++;
    res.ackedWrites += acked;
    const text = fs.readFileSync(file, 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    if (!parsed) {
      res.corrupt++;
      if (text.length === 0) res.emptyFile++;
      res.truncatedBytes.push(text.length);
      // what v26 does next: users.load() catches the parse error and returns {}, so every user is gone
      res.usersLostOnCorrupt += n + acked;
    } else if (Object.keys(parsed).length < n + acked) res.lostAcked++;
    process.stderr.write(`  [crash json N=${n}] kill ${k + 1}/${kills}: acked ${acked}, ${parsed ? 'ok' : `CORRUPT (${text.length} of ~${res.fileBytes} B)`}\n`);
  }
  res.truncatedBytes = res.truncatedBytes.slice(0, 20);
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

async function crashSpbt(root, n, kills) {
  const dir = path.join(root, `crash-spbt-${n}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  { // seed N users once; every trial continues on the same env, like a bot restarting after each crash
    const { openDB } = await import('../src/index.js');
    const db = openDB({ dir });
    for (let i = 0; i < n; i += 1000) db.txn(() => { for (let j = i; j < Math.min(n, i + 1000); j++) db.user.put({ uid: uidOf(j), plan: 0, since: Date.now() }); });
    await db.close();
  }
  const r = rng(n + 1);
  const res = { n, kills: 0, openFailed: 0, corrupt: 0, lostAcked: 0, partialTxn: 0, indexMismatch: 0, dirtyBootDetected: 0, ackedTxnsTotal: 0, openMs: [] };
  let prevNext = 0;
  for (let k = 0; k < kills; k++) {
    const acked = await killAfter('crash-writer-spbt', { dir, n }, 50 + Math.floor(r() * 450));
    res.kills++;
    let v;
    try { v = runChild('crash-verify-spbt', { dir, n }); } catch (e) { res.openFailed++; process.stderr.write(`  [crash spbt] verify failed: ${e.message}\n`); continue; }
    res.openMs.push(v.openMs);
    const lost = v.next < acked;
    const partial = v.users !== n + v.next; // a txn committed only in part
    const ixBad = v.byPlan !== v.users || v.byExpiry !== v.next || v.premium !== v.next || v.missing > 0 || v.extra > 0;
    if (lost) res.lostAcked++;
    if (partial) res.partialTxn++;
    if (ixBad) res.indexMismatch++;
    if (lost || partial || ixBad) res.corrupt++;
    if (v.lastShutdownClean === false) res.dirtyBootDetected++;
    res.ackedTxnsTotal += v.next - prevNext;
    prevNext = v.next;
    process.stderr.write(`  [crash spbt N=${n}] kill ${k + 1}/${kills}: acked ${acked}, on disk ${v.next}, users ${v.users}, open ${v.openMs} ms${lost || partial || ixBad ? ' CORRUPT' : ''}\n`);
  }
  const o = [...res.openMs].sort((a, b) => a - b);
  res.openMsP50 = o[Math.floor(0.5 * (o.length - 1))];
  res.openMsP99 = o[Math.floor(0.99 * (o.length - 1))];
  res.openMsMax = o[o.length - 1];
  delete res.openMs;
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

function machine(dir) {
  const cpu = os.cpus()[0]?.model ?? '?';
  let fsLine = '';
  try {
    const mounts = fs.readFileSync('/proc/mounts', 'utf8').trim().split('\n').map((l) => l.split(' '));
    const real = fs.realpathSync(dir);
    let best = null;
    for (const m of mounts) if ((real === m[1] || real.startsWith(m[1].endsWith('/') ? m[1] : m[1] + '/')) && (!best || m[1].length > best[1].length)) best = m;
    if (best) fsLine = `${best[2]} (${best[3].split(',').filter((x) => /^compress|^ssd|^discard|^data=|^noatime|^relatime/.test(x)).join(',')}) on ${best[0]}`;
  } catch {}
  let lmdbVersion = '?';
  try { lmdbVersion = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'node_modules', 'lmdb', 'package.json'), 'utf8')).version; } catch {}
  return {
    cpu, cores: os.cpus().length, ramMB: Math.round(os.totalmem() / 2 ** 20), node: process.version,
    lmdb: lmdbVersion, kernel: os.release(), fs: fsLine,
  };
}

const fmtN = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e4 ? `${Math.round(x / 1e3)}k` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : x >= 100 ? `${Math.round(x)}` : x >= 10 ? x.toFixed(1) : x.toFixed(2));
const fmtUs = (us) => (us >= 1e6 ? `${(us / 1e6).toFixed(2)} s` : us >= 1e3 ? `${(us / 1e3).toFixed(us >= 1e5 ? 0 : 1)} ms` : us >= 10 ? `${Math.round(us)} µs` : `${us.toFixed(1)} µs`);
const fmtB = (b) => (b >= 1 << 20 ? `${(b / 2 ** 20).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${Math.round(b)} B`);
const ratio = (a, b) => { const x = a / b; return x >= 10 ? `${Math.round(x)}×` : `${x.toFixed(1)}×`; };

function report(res) {
  const L = [];
  const m = res.machine;
  L.push(`# v26 JSON files vs SPBT_DB (${res.date})`);
  L.push('');
  L.push(`Machine: ${m.cpu}, ${m.cores} threads, ${m.ramMB} MB RAM, Node ${m.node}, lmdb ${m.lmdb}, Linux ${m.kernel}. Data on ${m.fs || 'a local disk'}. Warm page cache for both stores. ${res.seconds} s per scenario. Each (store, size) ran in its own process.`);
  L.push('');
  L.push('`bench/json-vs-spbtdb.mjs` produced this file. The v26 side is the v26 code (`bench/v26-stores.mjs`); it never fsyncs, so its writes are not durable. Every SPBT_DB write below is a durable commit (fsync) unless the row says coalesced.');
  L.push('');
  const by = (store, n) => res.suites.find((s) => s.store === store && s.n === n);
  const rows = [
    ['user.get', 'read one user (v26 `users.get`)'],
    ['user.set', 'change one user\'s plan (v26 `users.set`)'],
    ['message.xp', 'messageCreate XP path: feature flag + levels config + XP bump'],
    ['config.read', 'per-guild moderation config read (4.4 KB JSON)'],
    ['audit.append', 'audit-log append (v26 `appendLog`), SPBT_DB write-through'],
    ['audit.view', 'audit-log view: latest 50 entries of a guild'],
    ['top10', 'top-10 leaderboard of a guild with N members'],
  ];
  L.push('## Throughput and latency');
  L.push('');
  L.push('| scenario | N users | v26 JSON ops/s | SPBT_DB ops/s | SPBT_DB / JSON | JSON p50 / p99 | SPBT_DB p50 / p99 |');
  L.push('|---|---:|---:|---:|---:|---|---|');
  for (const [key, label] of rows) {
    for (const n of res.sizes) {
      const j = by('json', n)?.scenarios[key], s = by('spbt', n)?.scenarios[key];
      if (!j || !s) continue;
      L.push(`| ${label} | ${fmtN(n)} | ${fmtN(j.opsPerSec)} | ${fmtN(s.opsPerSec)} | **${ratio(s.opsPerSec, j.opsPerSec)}** | ${fmtUs(j.p50us)} / ${fmtUs(j.p99us)} | ${fmtUs(s.p50us)} / ${fmtUs(s.p99us)} |`);
    }
  }
  L.push('');
  L.push('Extra SPBT_DB rows (no v26 equivalent):');
  L.push('');
  L.push('| scenario | N users | ops/s | p50 / p99 |');
  L.push('|---|---:|---:|---|');
  for (const n of res.sizes) {
    const s = by('spbt', n)?.scenarios;
    if (!s) continue;
    if (s['user.set.batch100']) L.push(`| user.set, 100 per txn (durable) | ${fmtN(n)} | ${fmtN(s['user.set.batch100'].opsPerSec)} | ${fmtUs(s['user.set.batch100'].txnP50us)} / ${fmtUs(s['user.set.batch100'].txnP99us)} per txn |`);
    if (s['audit.append.coalesced']) L.push(`| audit.append through the appender (one commit per 512 rows) | ${fmtN(n)} | ${fmtN(s['audit.append.coalesced'].opsPerSec)} | ${fmtUs(s['audit.append.coalesced'].p50us)} / ${fmtUs(s['audit.append.coalesced'].p99us)} |`);
  }
  L.push('');
  L.push('## Bytes written to disk per update');
  L.push('');
  L.push('Bytes handed to write()/pwrite() (`/proc/self/io` wchar), divided by updates. For SPBT_DB this is whole 4 KiB B+tree pages (data, indexes, the meta page). btrfs compression is applied after this point.');
  L.push('');
  L.push('| update | N users | v26 JSON | SPBT_DB |');
  L.push('|---|---:|---:|---:|');
  for (const n of res.sizes) {
    const j = by('json', n)?.scenarios, s = by('spbt', n)?.scenarios;
    if (!j || !s) continue;
    L.push(`| user.set (one per commit) | ${fmtN(n)} | ${fmtB(j['user.set'].bytesPerOp)} | ${fmtB(s['user.set'].bytesPerOp)} |`);
    L.push(`| user.set, 100 per txn | ${fmtN(n)} | – | ${fmtB(s['user.set.batch100'].bytesPerOp)} |`);
    L.push(`| XP update, v26 2-min flush vs SPBT_DB 30 s flush (50 msg/s) | ${fmtN(n)} | ${fmtB(j['xp.flush'].bytesPerUpdate)} | ${fmtB(s['xp.flush'].bytesPerUpdate)} |`);
    L.push(`| XP update, both flushed every 2 min | ${fmtN(n)} | ${fmtB(j['xp.flush'].bytesPerUpdate)} | ${fmtB(s['xp.flush.2min'].bytesPerUpdate)} |`);
    L.push(`| audit-log append (write-through) | ${fmtN(n)} | ${fmtB(j['audit.append'].bytesPerOp)} | ${fmtB(s['audit.append'].bytesPerOp)} |`);
    L.push(`| audit-log append (SPBT_DB appender, 512 rows per commit) | ${fmtN(n)} | ${fmtB(j['audit.append'].bytesPerOp)} | ${fmtB(s['audit.append.coalesced'].bytesPerOp)} |`);
  }
  L.push('');
  L.push('## Main thread blocked by an XP flush');
  L.push('');
  L.push('| N members | v26: `flushAll()` every 2 min (stringify + write, blocking) | SPBT_DB: flush every 30 s, main-thread part (commit + fsync run off-thread) | SPBT_DB wall time per flush |');
  L.push('|---:|---:|---:|---:|');
  for (const n of res.sizes) {
    const j = by('json', n)?.scenarios['xp.flush'], s = by('spbt', n)?.scenarios['xp.flush'];
    if (j && s) L.push(`| ${fmtN(n)} | ${j.flushMainThreadMs} ms | ${s.flushMainThreadMs} ms | ${s.flushWallMs} ms |`);
  }
  L.push('');
  L.push('## RSS');
  L.push('');
  L.push('A fresh process opens the data the suite left behind and runs a light bot-like workload (20 000 messages through the XP path, 50 user reads, 1 000 config reads, 100 audit-log views, one XP flush), then a gc. v26 keeps the XP map of every guild that has talked in RAM for the life of the process, as the bot does. "Before" is the same process right after start, before it opened anything: Node plus this script.');
  L.push('');
  L.push('| N users | before (Node) | v26 JSON total / anon / file | SPBT_DB total / anon / file | data on disk (v26 users.json + levels_data.json / SPBT_DB hot.mdb + cold.mdb) |');
  L.push('|---:|---|---|---|---|');
  for (const n of res.sizes) {
    const j = by('json', n), s = by('spbt', n);
    if (!j || !s) continue;
    const jr = j.rssWorking.rss, sr = s.rssWorking.rss;
    L.push(`| ${fmtN(n)} | ${j.rssWorking.bare.rssMB} MB | ${jr.rssMB} / ${jr.anonMB} / ${jr.fileMB} MB | ${sr.rssMB} / ${sr.anonMB} / ${sr.fileMB} MB | ${fmtB(j.files.usersJsonBytes + j.files.levelsDataBytes)} / ${fmtB(s.files.hotMdbBytes + s.files.coldMdbBytes)} |`);
  }
  L.push('');
  L.push('## Crash safety: kill -9 in the middle of writing');
  L.push('');
  L.push('v26: a child process loops `users.set()` (every call rewrites users.json) and is killed with SIGKILL after a random 50–500 ms; then users.json is parsed. SPBT_DB: a child commits txns of 1–200 new users plus a counter, is killed the same way, and a fresh process opens the database and checks it. kill -9 keeps the page cache, so this tests process crashes, not power loss.');
  L.push('');
  L.push('| store | N users | kills | file/db unreadable after the kill | acknowledged writes lost | partial txns | index ≠ data |');
  L.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const c of res.crash.json) L.push(`| v26 JSON (${fmtB(c.fileBytes)} file) | ${fmtN(c.n)} | ${c.kills} | **${c.corrupt}** (${c.emptyFile} empty) | ${c.lostAcked} | – | – |`);
  for (const c of res.crash.spbt) L.push(`| SPBT_DB | ${fmtN(c.n)} | ${c.kills} | **${c.openFailed + c.corrupt}** | ${c.lostAcked} | ${c.partialTxn} | ${c.indexMismatch} |`);
  L.push('');
  for (const c of res.crash.json) if (c.corrupt) L.push(`* v26, N=${fmtN(c.n)}: a corrupt users.json makes \`load()\` return \`{}\` (its \`catch\`), so the next start sees no users at all, and the next \`set()\` overwrites the file with that one user. That is ${fmtN(c.usersLostOnCorrupt / c.corrupt)} users lost per corrupt file.`);
  for (const c of res.crash.spbt) L.push(`* SPBT_DB, N=${fmtN(c.n)}: ${c.ackedTxnsTotal} users committed across the kills; every reopen found the last acknowledged txn; ${c.dirtyBootDetected}/${c.kills} reopens reported \`lastShutdownClean: false\`. Open after kill -9: p50 ${c.openMsP50} ms, p99 ${c.openMsP99} ms, max ${c.openMsMax} ms.`);
  L.push('');
  return L.join('\n');
}

async function main() {
  if (args.child) {
    const o = { dir: args.dir, n: num(args.n, 1000), store: args.store, seconds: num(args.seconds, 2) };
    let out;
    if (args.child === 'suite') out = await suite(o);
    else if (args.child === 'crash-writer-json') return crashWriterJson(o);
    else if (args.child === 'crash-writer-spbt') return crashWriterSpbt(o);
    else if (args.child === 'crash-verify-spbt') out = await crashVerifySpbt(o);
    else if (args.child === 'rss') out = await rssChild(o);
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }
  const root = path.resolve(String(args.dir && args.dir !== true ? args.dir : process.env.SPBTDB_BENCH_DIR ?? path.join(os.homedir(), '.cache', 'spbtdb-bench')));
  fs.mkdirSync(root, { recursive: true });
  const sizes = list(args.sizes, [1000, 10_000, 100_000]);
  const seconds = num(args.seconds, 2);
  const kills = num(args.kills, 100);
  const crashSizes = list(args['crash-sizes'], [10_000, 100_000]);
  const mach = machine(root);
  if (/^tmpfs|^ramfs/.test(mach.fs)) console.error('WARNING: the data directory is on tmpfs: fsync is free and the numbers say nothing about a disk');
  console.error(`json-vs-spbtdb: ${root} (${mach.fs}), sizes ${sizes}, ${seconds} s per scenario, ${kills} kills per crash test`);
  const res = { date: new Date().toISOString().slice(0, 10), machine: mach, sizes, seconds, suites: [], crash: { json: [], spbt: [] } };
  for (const n of sizes) {
    for (const store of ['json', 'spbt']) {
      console.error(`suite ${store} N=${n}`);
      const dir = path.join(root, `${store}-${n}`);
      const s = runChild('suite', { store, n, seconds, dir });
      s.rssWorking = runChild('rss', { store, n, dir });
      res.suites.push(s);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  if (kills > 0) {
    for (const n of crashSizes) res.crash.json.push(await crashJson(root, n, kills));
    res.crash.spbt.push(await crashSpbt(root, Math.max(...crashSizes), kills));
  }
  const tag = args.tag && args.tag !== true ? `-${args.tag}` : '';
  const base = path.join(HERE, `results-${res.date}-json-vs-spbtdb${tag}`);
  const home = os.homedir();
  const scrub = (s) => s.split(home).join('~');
  res.dir = scrub(root);
  fs.writeFileSync(`${base}.json`, scrub(JSON.stringify(res, null, 2)) + '\n');
  fs.writeFileSync(`${base}.md`, scrub(report(res)) + '\n');
  console.error(`wrote ${path.relative(process.cwd(), base)}.{json,md}`);
  if (!args.keep) fs.rmSync(root, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });

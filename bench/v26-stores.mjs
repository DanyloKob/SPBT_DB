// The TANO v26 JSON-file storage, ported for the benchmark (bench/json-vs-spbtdb.mjs).
//
// The bodies are the v26 code: CommonJS -> ESM, and the data directory is a parameter instead of
// `path.join(__dirname, '..', 'data')`. Nothing else is changed: every read is readFileSync +
// JSON.parse of the whole file, every write is writeFileSync of the whole file pretty-printed with
// 2-space indents, with no temp file, no rename and no fsync.
//
//   users        <- TANO v26 stores/users.js
//   serverData   <- TANO v26 stores/server_data.js (the functions the bot calls per event)
//   levels       <- TANO v26 bot/features/levels/index.js (the messageCreate hot path and flush)
import fs from 'node:fs';
import path from 'node:path';

/** stores/users.js */
export function v26Users(dataDir) {
  const FILE = path.join(dataDir, 'users.json');

  function load() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch { return {}; }
  }

  function save(data) {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  }

  // Apply expiry to a single record. Mutates record if expired. Returns true if changed.
  function applyExpiry(rec) {
    if (rec && rec.planExpiresAt && rec.plan !== 'normal' && rec.planExpiresAt <= Date.now()) {
      rec.plan = 'normal';
      delete rec.planExpiresAt;
      return true;
    }
    return false;
  }

  return {
    FILE,
    get(id) {
      const all = load();
      let dirty = false;
      if (!all[id]) {
        all[id] = { plan: 'normal', since: Date.now() };
        dirty = true;
      }
      if (applyExpiry(all[id])) dirty = true;
      if (dirty) save(all);
      return all[id];
    },
    set(id, data) {
      const all = load();
      all[id] = { ...(all[id] || {}), ...data };
      // Allow explicit null to clear planExpiresAt (forever plan)
      if (data && data.planExpiresAt === null) delete all[id].planExpiresAt;
      save(all);
      return all[id];
    },
  };
}

/** stores/server_data.js */
export function v26ServerData(dataDir) {
  const BASE = path.join(dataDir, 'server_data');

  function assertSafeId(id) {
    if (!/^\d{17,20}$/.test(String(id))) throw new Error(`Invalid guild ID: ${id}`);
  }

  function dir(guildId) {
    const d = path.join(BASE, guildId);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    return d;
  }

  function read(guildId, file) {
    try {
      return JSON.parse(fs.readFileSync(path.join(BASE, guildId, file), 'utf8'));
    } catch { return null; }
  }

  function write(guildId, file, data) {
    fs.writeFileSync(path.join(dir(guildId), file), JSON.stringify(data, null, 2));
  }

  function getGeneral(guildId) {
    assertSafeId(guildId);
    return read(guildId, 'general.json') || { features: {} };
  }

  function isFeatureEnabled(guildId, feature) {
    assertSafeId(guildId);
    const g = getGeneral(guildId);
    return !!(g.features[feature]?.enabled);
  }

  function getFeatureConfig(guildId, feature) {
    assertSafeId(guildId);
    return read(guildId, `${feature}.json`);
  }

  function setFeatureConfig(guildId, feature, config) {
    assertSafeId(guildId);
    write(guildId, `${feature}.json`, config);
  }

  const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  function appendLog(guildId, action, details, user) {
    assertSafeId(guildId);
    let log = read(guildId, 'activity_log.json') || [];
    log.push({
      timestamp: new Date().toISOString(),
      action,
      details: details || '',
      user: user ? { id: user.id, username: user.username, avatar: user.avatar } : null,
    });
    // Purge entries older than 7 days
    const cutoff = Date.now() - LOG_MAX_AGE_MS;
    log = log.filter(e => new Date(e.timestamp).getTime() > cutoff);
    if (log.length > 100) log.splice(0, log.length - 100);
    write(guildId, 'activity_log.json', log);
  }

  function getLog(guildId) {
    assertSafeId(guildId);
    return read(guildId, 'activity_log.json') || [];
  }

  return { BASE, getGeneral, isFeatureEnabled, getFeatureConfig, setFeatureConfig, appendLog, getLog };
}

/** bot/features/levels/index.js: the messageCreate path and the periodic flush */
export function v26Levels(sd) {
  const guildData = new Map(); // guildId -> { users: { userId: { xp, lastMsg } }, dirty }

  function getGuild(guildId) {
    if (guildData.has(guildId)) return guildData.get(guildId);
    const saved = sd.getFeatureConfig(guildId, 'levels_data') || {};
    const entry = { users: saved, dirty: false };
    guildData.set(guildId, entry);
    return entry;
  }

  function flushAll() {
    for (const [guildId, g] of guildData) {
      if (g.dirty) {
        sd.setFeatureConfig(guildId, 'levels_data', g.users);
        g.dirty = false;
      }
    }
  }

  function getConfig(guildId) {
    if (!sd.isFeatureEnabled(guildId, 'levels')) return null;
    return sd.getFeatureConfig(guildId, 'levels');
  }

  /** Find the reward the user just crossed into */
  function getNewReward(rewards, prevXp, newXp) {
    if (!rewards?.length) return null;
    const sorted = [...rewards].sort((a, b) => a.xp - b.xp);
    return sorted.find(r => prevXp < r.xp && newXp >= r.xp) || null;
  }

  /**
   * The synchronous part of the v26 messageCreate handler (the role grant and the notification
   * that follow a reward crossing are Discord API calls, not storage). Returns the crossed reward.
   */
  function onMessage(guildId, channelId, userId, now = Date.now()) {
    const cfg = getConfig(guildId);
    if (!cfg) return null;
    if (cfg.ignoredChannels?.includes(channelId)) return null;
    const g = getGuild(guildId);
    const user = g.users[userId] || { xp: 0, lastMsg: 0 };
    const cooldown = (cfg.cooldown || 60) * 1000; // NB: v26 reads `|| 60`, so cooldown 0 means 60 s
    if (now - user.lastMsg < cooldown) return null;
    const prevXp = user.xp;
    user.xp += 1;
    user.lastMsg = now;
    g.users[userId] = user;
    g.dirty = true;
    return getNewReward(cfg.rewards, prevXp, user.xp);
  }

  return { guildData, getGuild, flushAll, getConfig, onMessage };
}

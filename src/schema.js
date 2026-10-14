// Core collection schemas (design §5.1 + §5.4 `level`).
//
// Extension point: other layers add their own schema maps and pass them to
// openDB({ schemas: { ...coreSchemas, ...schedSchemas } }) or open them later
// with db.collection(name, schema). Time-bucketed collections (event_log_YYYYMM)
// reuse one schema object under many names: db.collection(`event_log_${ym}`, eventLogSchema).
// Index DBI names share one namespace per env - keep them unique.

/** @typedef {import('./collection.js').CollectionSchema} CollectionSchema */

/** @type {Record<string, CollectionSchema>} */
export const coreSchemas = {
  // §5.1 guild: { name, icon, ownerId, memberCount, joinedAt, locale, flags, lastSeenAt }
  guild: {
    key: 'gid:u64',
  },

  // §5.1 guild_feature: enabled flag per (guild, feature tag); popularity via feature_enabled
  guild_feature: {
    key: 'gid:u64 tag:u8',
    codec: 'varint',
    fields: [{ name: 'enabled', type: 'bool' }, 'enabledAt'],
    indexes: {
      feature_enabled: { key: 'tag:u8 gid:u64', filter: (r) => !!r.enabled },
    },
    methods: {
      /** number of guilds with feature `tag` enabled - O(k) index range count */
      popularity(tag) { return this.countIndex('feature_enabled', tag); },
    },
  },

  // §5.1 feature_config: schemaless JSON-ish config blob, validated at L4 on read.
  // HDR 0x39 when compressed: v1 | schema | mtime | codec 1.
  feature_config: {
    key: 'gid:u64 tag:u8',
    compress: { threshold: 512 },
    schemaId: 1,
    mtime: true,
    maxSharedStructures: 64, // configs have many nested shapes
  },

  // §5.1 user: { plan, since, planExpiresAt?, username, avatarHash, seenAt }
  user: {
    key: 'uid:u64',
    indexes: {
      user_by_plan: { key: 'plan:u8 uid:u64' },
      user_by_expiry: { key: 'planExpiresAt:u48 uid:u64' }, // sparse: only users with an expiry
    },
  },

  // §5.1 news: { title, body, tags[], authorId, pinned }
  news: {
    key: 'createdAt:u48 seq:u16',
  },

  // §5.4 level: xp as a 1-5 byte varint frame; leaderboard index stores only uid (gid is shared prefix)
  level: {
    key: 'gid:u64 uid:u64',
    codec: 'varint',
    fields: ['xp'],
    indexes: {
      level_by_xp: { key: 'gid:u64 xp:inv32' },
    },
    methods: {
      /** Top n by xp in a guild: covered index range, no primary lookups. @returns {Array<{gid: bigint, uid: bigint, xp: number}>} */
      top(gid, n = 10) {
        return this.query({ index: 'level_by_xp', where: [gid], limit: n, covered: true }).items;
      },
      /** 1-based rank of a member (counts index entries ahead of it). */
      rank(gid, uid) {
        const cur = this.get(gid, uid);
        if (!cur) return undefined;
        return this.countIndexRange('level_by_xp', [gid], [gid, cur.xp]) + 1;
      },
    },
  },

  // §5.9 kv: small system values (__boot, __schema_version, __lease/*, ...)
  kv: {
    key: 'k:str',
  },
};

// §5.3 / §8.1 scheduler. Opened by src/sched.js when openDB({ sched }) is set, not by default.
// Rows are hand-packed raw frames (see sched.js encodeJob); the dupSort index
// `sched_by_subject` (gid:u64 kind:u8 subject:u64 -> dueAt||seq) is maintained by sched.js
// in the same txn, because the collection layer does not index raw-codec rows.
/** @type {Record<string, CollectionSchema>} */
export const schedSchemas = {
  sched: {
    key: 'dueAt:u48 seq:u24',
    codec: 'raw',
  },
};

// §5.7 event_log, one collection per UTC month through db.bucketed (src/buckets.js):
//   const elog = db.bucketed('event_log', eventLogSchema, { retentionDays: 30 });
//   const logBuf = elog.appender();
//   logBuf.append({ gid, chan, ts: msg.createdTimestamp, k: 0, msgId, authorId, content });  // seq is filled in
//   elog.query({ index: 'elog_by_chan', where: [gid, chan], desc: true, limit: 50 });     // latest 50 of a channel
//   elog.byMessageId(msgId);                        // edit / delete lookups: the original row, then edits/deletes
//
// Deviation from §4.2/§5.7 (README "event_log key"): the primary key is TIME-ordered (`ts seq`),
// not `gid chan ts seq`. With ~80 active channels every 5 s flush dirtied ~1 leaf per channel:
// measured write amplification 13x (512 rows/commit) to 23x (250). Appends in time order touch
// only the tail leaf (1.5x). Per-channel reads go through `elog_by_chan`, a LAGGED index
// (src/collection.js): its entries are written once per `lag` rows, sorted, so the per-channel
// cost is paid once per 8192 rows instead of once per flush; newer rows are merged in from RAM.
// Edit/delete lookups (byMessageId): a message row (k=0) logged with ts = message.createdTimestamp
// sits at its snowflake's time in the primary key, so it needs no index entry at all. Only the
// other rows - edits and deletes (~15 %), or a k=0 row logged with another ts - go into
// `elog_by_msg` (msgId ts seq, 0-byte values, lagged like elog_by_chan: an edit's msgId points up
// to minutes back, which would scatter writes).
/** @type {CollectionSchema} */
export const eventLogSchema = {
  key: 'ts:u48 seq:u16',
  env: 'cold',
  indexes: {
    elog_by_chan: { key: 'gid:u64 chan:u64 ts:u48 seq:u16', lag: 8192 },
    elog_by_msg: { key: 'msgId:u64 ts:u48 seq:u16', lag: 8192, filter: (r) => r.msgId != null && ((r.k ?? 0) !== 0 || r.ts !== snowflakeTs(r.msgId)) },
  },
};

/** Optional per-author index (§5.7: off by default): `{ ...eventLogSchema, indexes: { ...eventLogSchema.indexes, elog_by_author: elogByAuthor } }` */
export const elogByAuthor = Object.freeze({ key: 'gid:u64 authorId:u64 ts:u48 seq:u16', lag: 8192 });

/** Discord snowflake -> creation time in ms. */
export const DISCORD_EPOCH = 1420070400000;
export const snowflakeTs = (id) => Number(BigInt(id) >> 22n) + DISCORD_EPOCH;

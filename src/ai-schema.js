// Collection schemas for the AI and blob layers (design §5.8, §5.9, §9, §10).
//
//   import { coreSchemas } from './schema.js';
//   import { aiSchemas } from './ai-schema.js';
//   const db = openDB({ dir, schemas: { ...coreSchemas, ...aiSchemas } });
//   attachVectors(db);  attachBlobs(db, { dir: `${dir}/blobs` });
//
// attachVectors / attachBlobs also open these collections themselves (db.collection
// returns the already-open one), so passing them in `schemas` is optional; it only
// adds the db.aiChunk / db.blobRef / ... shortcuts up front.
//
// DBI names (all hot env): ai_chunk ai_vec ai_quota blob_ref blob_gc blob_inline image image_by_user

export const DAY = 86_400_000;

/** @typedef {import('./collection.js').CollectionSchema} CollectionSchema */

/** @type {Record<string, CollectionSchema>} */
export const aiSchemas = {
  // §5.8 ai_chunk: chunk text + provenance; 90-day TTL. msgpack with shared structures.
  // value: { text (<=600 B), srcChannelId?: u64, srcMsgId?: u64, createdAt?: ms, tokens?: number }
  // Deleting a row (TTL sweeper's delByKey, or del) also removes its vector: see vector.js.
  ai_chunk: {
    key: 'gid:u64 chunkId:u32',
    ttl: 90 * DAY,
    ttlSweep: 'job', // src/ttl.js: one EXPIRE job per chunk instead of daily scans of ~70 MB of cold pages
  },

  // §5.8 / §9.4 ai_vec: raw segments of quantised vectors, SoA layout (see src/vector.js).
  //   seg 0..0xFFFE   m x (int8[dim]) | m x f32 scale | m x u32 chunkId   (m <= slots)
  //   seg 0xFFFF      guild header: n u32 | gen u32 | nextId u32 | dim u16 | slots u16
  ai_vec: {
    key: 'gid:u64 seg:u16',
    codec: 'raw',
  },

  // §5.8 ai_quota: per-scope daily counter. scope 0 = guild, 1 = user (fixes the v26 bug
  // where premium was counted globally). Each row expires 2 days after its day starts.
  ai_quota: {
    key: 'scope:u8 id:u64 day:u16',
    codec: 'varint',
    fields: ['used'],
    ttl: 2 * DAY,
  },

  // §5.9 blob_ref: one row per stored blob (filesystem or inline).
  //   size u32, mime u8 (MIME table in blobs.js), refs, firstSeen ms,
  //   zeroAt ms: when refs last dropped to 0 (or the upload time); 0 while referenced.
  // blob_gc is a sparse index over the zero-ref rows ordered by zeroAt, so GC is a
  // bounded range scan instead of a pass over all 650k rows (§10.4).
  blob_ref: {
    key: 'h:b16',
    codec: 'varint',
    fields: ['size', 'mime', 'refs', 'firstSeen', 'zeroAt'],
    indexes: {
      blob_gc: { key: 'zeroAt:u48 h:b16', filter: (r) => r.refs === 0 },
    },
  },

  // §10.5 blobs <= inlineMax (1 KB) live here instead of on the filesystem.
  blob_inline: {
    key: 'h:b16',
    codec: 'raw',
  },

  // §5.9 image: hosted images. value { userId: u64, ext: u8, size, uploadedAt: ms, blobHash: 16 B }
  // image_by_user ends with the primary key, so it is a plain DBI with empty values:
  // FIFO eviction of a user's oldest images is a reverse range scan.
  image: {
    key: 'imageId:b16',
    indexes: {
      image_by_user: { key: 'userId:u64 uploadedAt:inv48 imageId:b16' },
    },
    methods: {
      /** Newest first: [{ userId, uploadedAt, imageId }] (covered index scan, no value reads). */
      byUser(userId, limit = 50) {
        return this.query({ index: 'image_by_user', where: [userId], limit, covered: true }).items;
      },
      /** Oldest first, for FIFO eviction. */
      oldestByUser(userId, limit = 1) {
        return this.query({ index: 'image_by_user', where: [userId], limit, covered: true, desc: true }).items;
      },
      countByUser(userId) { return this.countIndex('image_by_user', userId); },
    },
  },
};

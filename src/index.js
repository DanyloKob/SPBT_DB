// SPBT_DB entry point.
//
//   import { openDB } from 'spbt-db';
//   const db = openDB({ dir: './data' });            // lmdb: data/hot.mdb (+ cold.mdb on demand)
//   db.level.put({ gid, uid, xp: 120 });
//   db.level.top(gid, 10);
//   db.txn(() => { ... });                                // sync, atomic (hot env)
//   await db.close();

import fs from 'node:fs';
import { join } from 'node:path';
import { createCollection, runTxn, runTxnAsync } from './collection.js';
import { createMemoryBackend } from './backend-memory.js';
import { createLmdbBackend } from './backend-lmdb.js';
import { assertBackend } from './backend.js';
import { coreSchemas } from './schema.js';
import { createScheduler } from './sched.js';
import { createSweeper } from './ttl.js';
import { createCounter, createCoalescer } from './coalesce.js';
import { createBucketed } from './buckets.js';
import { markBoot, markCleanShutdown } from './boot.js';

export { coreSchemas, schedSchemas, eventLogSchema, elogByAuthor, snowflakeTs, DISCORD_EPOCH } from './schema.js';
export { createScheduler, KIND, CATCH_UP, MAX_SLEEP_MS, MAX_TIMER_MS } from './sched.js';
export { createSweeper } from './ttl.js';
export { createCounter, createCoalescer, createAppender, flushAllPending, DEFAULTS as COALESCE_DEFAULTS } from './coalesce.js';
export { createBucketed, monthOf, monthStart, monthEnd, nextDailyAt } from './buckets.js';
export { markBoot, markCleanShutdown, BOOT_KEY } from './boot.js';
export { createCollection, runTxn, runTxnAsync } from './collection.js';
export { createMemoryBackend } from './backend-memory.js';
export { createLmdbBackend, PROFILES, compactCopy, mapSizeFor } from './backend-lmdb.js';
export { BACKEND_METHODS, assertBackend } from './backend.js';
export * as keys from './keys.js';
export * as frame from './frame.js';
export { key, tuple, prefixEnd } from './keys.js';

const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/**
 * @typedef {object} OpenOptions
 * @property {string} [dir]                         data directory (lmdb)
 * @property {'lmdb'|'memory'} [backend='lmdb']
 * @property {Record<string, import('./collection.js').CollectionSchema>} [schemas=coreSchemas]
 *           opened eagerly and exposed as db[camelCase(name)]
 * @property {{ hot?: object, cold?: object }} [lmdb]  extra lmdb open() options per env
 * @property {{ hot?: import('./backend.js').Backend, cold?: import('./backend.js').Backend }} [backends]
 *           bring your own Backend instances (e.g. a future SqliteBackend)
 */

/**
 * Open a SPBT_DB instance (synchronous).
 * @param {OpenOptions} [o]
 */
export function openDB(o = {}) {
  const kind = o.backend ?? 'lmdb';
  if (kind !== 'lmdb' && kind !== 'memory') throw new TypeError(`spbt-db: unknown backend ${kind}`);
  if (kind === 'lmdb' && !o.backends?.hot) {
    if (!o.dir) throw new TypeError('spbt-db: openDB({ dir }) is required for the lmdb backend');
    fs.mkdirSync(o.dir, { recursive: true });
  }

  /** @type {Record<'hot'|'cold', import('./backend.js').Backend | undefined>} */
  const envs = { hot: o.backends?.hot, cold: o.backends?.cold };
  function backendFor(name) {
    if (envs[name]) return envs[name];
    if (kind === 'memory') envs[name] = createMemoryBackend();
    else {
      envs[name] = createLmdbBackend({ path: join(o.dir, `${name}.mdb`), profile: name, options: o.lmdb?.[name] });
    }
    return assertBackend(envs[name]);
  }

  /** @type {Map<string, ReturnType<typeof createCollection>>} */
  const collections = new Map();
  /** @type {import('./collection.js').Hooks} */
  const hooks = {};

  const db = {
    /** Shared hooks (extension point: scheduler sets hooks.onExpiring). */
    hooks,
    collections,

    /** The Backend for an env ('hot' | 'cold'); opens it on first use. */
    backend: backendFor,

    /**
     * Open or return a collection. Re-opening an existing name returns the same object.
     * @param {string} name
     * @param {import('./collection.js').CollectionSchema} schema
     */
    collection(name, schema) {
      let c = collections.get(name);
      if (!c) {
        if (!schema) throw new Error(`spbt-db: unknown collection ${name}`);
        c = createCollection({ backend: backendFor(schema.env ?? 'hot'), name, schema, hooks });
        collections.set(name, c);
      }
      return c;
    },

    /** Drop a collection with its indexes (time buckets). */
    dropCollection(name) {
      const c = collections.get(name);
      if (!c) return false;
      c.drop();
      collections.delete(name);
      if (db[camel(name)] === c) delete db[camel(name)];
      return true;
    },

    /** Synchronous atomic txn on the hot env (nested = savepoint). Durable on return. */
    txn: (fn) => runTxn(backendFor('hot'), fn),
    /** Same on the cold env. A txn never spans both envs. */
    coldTxn: (fn) => runTxn(backendFor('cold'), fn),
    /** Atomic txn on the hot env whose commit/fsync runs off the main thread. */
    txnAsync: (fn) => runTxnAsync(backendFor('hot'), fn),

    /** Small stats snapshot per env: entries, pages, freePages, file size, per-collection counts. */
    stats() {
      const out = {};
      for (const [name, b] of Object.entries(envs)) {
        if (!b) continue;
        const s = b.stat();
        const info = b.info ? b.info() : {};
        const cols = {};
        for (const [cn, c] of collections) if (c.backend === b) Object.assign(cols, c.stat());
        out[name] = { entries: s.entries, pages: s.pages, freePages: s.freePages, fileBytes: info.fileBytes ?? 0, pageSize: info.pageSize, mapSize: info.mapSize, collections: cols };
      }
      return out;
    },

    /** Resolves when all committed writes are durable. */
    flushed: () => Promise.all(Object.values(envs).map((b) => b && b.flushed && b.flushed())),

    async close() {
      // scheduler/sweeper stop, coalescer buffers flush, then __boot is marked clean
      if (db.sched && db.sched.stop) await db.sched.stop();
      if (db.ttl) await db.ttl.stop();
      for (const c of db.coalescers ?? []) await c.close();
      if (db.bootInfo && db.bootInfo()) markCleanShutdown(db, db.bootInfo(), { clock: o.clock });
      for (const b of Object.values(envs)) if (b && b.close) await b.close();
      collections.clear();
    },
  };

  for (const [name, schema] of Object.entries(o.schemas ?? coreSchemas)) db[camel(name)] = db.collection(name, schema);

  // Scheduler, TTL sweeper, coalescers, time buckets, __boot (sched.js ttl.js coalesce.js buckets.js boot.js).
  // o.sched / o.ttl: true | options (off by default); o.boot: false to skip the __boot record;
  // o.clock / o.timers: injectable for tests; o.coalesce.level: options for level.bump.
  const ext = { clock: o.clock, timers: o.timers };
  const track = (c) => { db.coalescers.add(c); return c; };
  db.coalescers = new Set();
  db.counter = (col, field, opts) => track(createCounter(col, field, { ...ext, ...opts }));
  db.coalescer = (col, mergeFn, opts) => track(createCoalescer(col, mergeFn, { ...ext, ...opts }));
  db.coalesceMetrics = () => [...db.coalescers].map((c) => c.metrics());
  db.bucketed = (base, schema, opts) => createBucketed(db, base, schema, { clock: o.clock, ...opts });
  if (db.level) {
    db.level.bump = (gid, uid, delta) => { // the coalescer is created on first use, then bump is its own fast path
      const c = db.counter(db.level, 'xp', o.coalesce?.level);
      db.level.bumps = c;
      db.level.bump = c.bump;
      return c.bump(gid, uid, delta);
    };
  }
  const boot = o.boot === false ? null : markBoot(db, { clock: o.clock });
  db.bootInfo = () => boot;
  if (o.sched) db.sched = createScheduler(db, { ...ext, ...(o.sched === true ? {} : o.sched) });
  if (o.ttl) db.ttl = createSweeper(db, { clock: o.clock, ...(o.ttl === true ? {} : o.ttl) });
  if (db.sched && o.sched.autoStart !== false) db.sched.start();
  return db;
}

/**
 * Aliases: `open` is the short name; `openTanoDB` is the name this function had inside TANO v27,
 * kept so code written against it keeps working.
 */
export { openDB as open, openDB as openTanoDB };

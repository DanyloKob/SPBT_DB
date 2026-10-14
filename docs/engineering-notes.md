# Engineering notes (from TANO v27)

> This is the engineering log written while the database was built inside the TANO v27 Discord
> bot, where it was called TanoDB. It is kept as written, with the product name updated. Section
> references such as §4.2 or "Appendix A" point to the TANO v27 design document, which is not part
> of this repository. "The target" and "the box" mean the production VPS the bot runs on: an
> Oracle Cloud VM.Standard.E2.1.Micro (AMD EPYC 7551, Zen 1, 2.0 GHz burstable, 952 MB RAM).
> The bench result files in `bench/results-2026-10-14-*` were produced under the old name.
> For the user-facing documentation, see the [README](../README.md).


The embedded database for TANO v27, built to the design in `../docs/01-database.md`.
lmdb-js 3.5.6 supplies one thing: an ordered, crash-safe, mmap'ed `bytes -> bytes` map.
Everything above it is in this package: the key codec, the record frames, the collections,
the indexes, TTL, migrations, the scheduler, the coalescers, time buckets, vectors and blobs.

## Quick start

```js
import { openDB, coreSchemas, eventLogSchema } from 'spbt-db';
import { aiSchemas } from 'spbt-db/ai-schema';
import { attachVectors } from 'spbt-db/vector';
import { attachBlobs } from 'spbt-db/blobs';

const db = openDB({ dir: './data', schemas: { ...coreSchemas, ...aiSchemas }, sched: true, ttl: true });
attachVectors(db);                                   // db.ai: int8 KNN per guild (§9)
attachBlobs(db, { dir: './data/blobs' });            // db.blobs: content-addressed files (§10)
const elog = db.bucketed('event_log', eventLogSchema, { retentionDays: 30 }); // a cold DBI per month
const logBuf = elog.appender();                      // one commit per 5 s / 512 rows (§7.3)

// messageCreate: gets are ~1 µs; writes are buffered and committed off the main thread
db.level.get(gid, uid);                              // ids: bigint, decimal string or safe int
db.level.bump(gid, uid, 15);                         // XP in RAM, one txn per 30 s / 2 000 keys
logBuf.append({ gid, chan, ts: msg.createdTimestamp, k: 0, msgId: msg.id, authorId, content });

// messageUpdate / messageDelete: every logged version of the message, oldest first
elog.byMessageId(msg.id);

// a ban and its unban: one durable commit
db.txn(() => {
  db.kv.put({ k: `case:${gid}:${n}`, target: uid, reason });
  db.sched.at(Date.now() + 7 * DAY, { kind: 'unban', gid, subject: uid, catchUp: 'run' });
});
db.sched.on('unban', async (job) => guild.bans.remove(String(job.subject)));

// panels
db.level.top(gid, 10);                                                         // covered index range
elog.query({ index: 'elog_by_chan', where: [gid, chan], desc: true, limit: 50 }); // latest 50 of a channel

// AI memory and uploads
db.ai.add(gid, null, embedding, text);  db.ai.knn(gid, queryEmbedding, 8);
const { hash } = await db.blobs.put(buffer, { mime: 'image/png', ref: true });

await db.close();                                    // stop timers, flush buffers, mark __boot clean
```

`test/quickstart.test.js` runs exactly this flow through the package's `exports` map
(`spbt-db`, `/keys`, `/frame`, `/schema`, `/collection`, `/backend*`, `/sched`, `/ttl`,
`/coalesce`, `/buckets`, `/boot`, `/vector`, `/blobs`, `/ai-schema`).

Plain ESM with JSDoc types and no build step. It depends on `lmdb@3.5.6` and on
`msgpackr@1.12.1`, which is the copy lmdb already brings in, pinned so we can import it directly.
About 3,650 lines of code (comments excluded), 1,700 of them the core below.

```
src/keys.js            order-preserving key codec (§4.2): builder, tuple codecs, prefixEnd
src/frame.js           record frame (§4.3): HDR, schemaId, updatedAt, expiresAt, 4 codecs
src/backend.js         the Backend interface (§2.3): JSDoc typedef and contract
src/backend-lmdb.js    lmdb-js Backend, one per env; profiles from Appendix A; compactCopy()
src/backend-memory.js  sorted-array Backend with undo-log txns (tests, tooling)
src/collection.js      collections, indexes (§4.4), lagged indexes, query, TTL, migrations (L1-L4)
src/schema.js          core schemas (guild, guild_feature, feature_config, user, news, level, kv),
                       eventLogSchema (§5.7), snowflakeTs
src/index.js           openDB()
src/sched.js           scheduler (§5.3, §8): one timer, 60 s ceiling, sched_by_subject, catchUp
src/ttl.js             TTL sweeper (§8.6): bounded range-scan (default) or per-record expire jobs
src/coalesce.js        write coalescers (§7.3): counter (level.bump), record merge, append ring
src/buckets.js         time-bucketed monthly collections (§4.6): append, merged query, dropExpired
src/boot.js            __boot record (§4.5): was the last shutdown clean?
test/*.test.js         node:test suites   (npm test)
bench/run.mjs          the §13 bench suite (npm run bench:suite); bench/quick.mjs micro-benchmark (npm run bench)
```

## Usage

```js
import { openDB } from './db/src/index.js';

const db = openDB({ dir: './data' });       // or { backend: 'memory' }
db.level.put({ gid, uid, xp: 120 });             // gid/uid: bigint, decimal string or safe int
db.level.get(gid, uid);                          // -> { xp: 120 } | undefined
db.level.incr(gid, uid, 'xp', 15);               // atomic read-modify-write -> 135
db.level.top(gid, 10);                           // -> [{ gid, uid, xp }] via level_by_xp (covered)
db.txn(() => { for (const r of batch) db.level.put(r); });   // one atomic, durable commit
await db.close();
```

## Public API

`openDB({ dir, backend = 'lmdb' | 'memory', schemas = coreSchemas, lmdb: { hot, cold }, backends })` is
synchronous and returns `db`:

| member | |
|---|---|
| `db[camelName]` | each schema in `schemas`, e.g. `db.level`, `db.featureConfig`, `db.guildFeature` |
| `db.collection(name, schema)` | opens a collection, or returns the one already open under that name |
| `db.dropCollection(name)` | drops the data, the indexes and the shared structures in ONE write txn (joins an open txn of that env) |
| `db.txn(fn)` / `db.coldTxn(fn)` | synchronous and atomic within one env; a nested call is a savepoint; durable on return |
| `db.txnAsync(fn)` | atomic, but commit and fsync run off the main thread (lmdb `childTransaction`) |
| `db.stats()` | `{ hot: { entries, pages, freePages, fileBytes, pageSize, mapSize, collections: { name: { entries, pages, freePages } } }, cold? }` |
| `db.flushed()`, `db.close()` | |
| `db.backend('hot'\|'cold')` | the Backend for that env; the cold env is opened on first use |
| `db.hooks` | shared hooks; `hooks.onExpiring(col, pkBuf, expiresAt)` runs inside the write txn |

A collection `c` (`k...` stands for the key fields in schema order; each one may be a bigint,
decimal string or number):

| method | |
|---|---|
| `c.get(...k)` | returns the value without its key fields, or `undefined` if absent or expired |
| `c.getMeta(...k)` | `{ value, schemaId, updatedAt, expiresAt }` |
| `c.has(...k)` | |
| `c.put(record, { ttl?, expiresAt? }?)` | `record` includes its key fields |
| `c.patch(...k, partial, opts?)` | shallow-merge upsert that keeps the current expiry; returns the new value |
| `c.incr(...k, field, delta = 1, opts?)` | atomic upsert; returns the new number |
| `c.del(...k)` | returns a boolean |
| `c.count(...prefix)` | physical count; expired records not yet swept are included |
| `c.countLive(...prefix)` | scans the range and skips expired records |
| `c.countIndex(ix, ...where)` / `c.countIndexRange(ix, start?, end?)` | |
| `c.query({ index?, where?/prefix?, start?, end?, limit = 1000, desc?, after?, covered? })` | returns `{ items, next }`, where `next` is an opaque cursor |
| `c.range(opts)` / `c.prefix(...vals)` / `c.iterate(opts)` | items only, or a lazy generator with no limit |
| `c.keyOf(...k)` / `c.decodeKey(buf)` / `c.getFrame(buf)` / `c.delByKey(buf)` | key-level access for the scheduler and sweeper |
| `c.getView(...k)` | zero-copy payload of a raw-codec record; volatile (valid until the next backend call) |
| `c.reindex(name?)`, `c.stat()`, `c.drop()` | `drop` is one atomic txn and kills the object; open the name again |
| `c.flushLagged()` | writes the RAM tail of every lagged index into its DBI now (joins an open txn) |
| `c.pk`, `c.codec`, `c.indexes` | the compiled key tuple, the frame codec and the index descriptors |

Items returned by `query` and `range` have their key fields merged in. `where`, `start` and `end`
are leading-field tuples of the index, or of the primary key when no index is given. `start` is
inclusive, `end` is exclusive, and `desc` reverses the order. With `covered: true`, items are
built from the index key plus the primary key alone, so no primary lookup happens and TTL is not
checked.

Lower layers are exported for other agents: `keys` (`key()`, `tuple()`, `prefixEnd`, the
`readU*`/`writeU*` functions), `frame` (`createCodec`, `frameInfo`, `isExpired`, …),
`createCollection`, `runTxn` / `runTxnAsync`, `createMemoryBackend`, `createLmdbBackend`,
`PROFILES`, `mapSizeFor`, `compactCopy` and `assertBackend`.

`compactCopy(src, dst)` is copy-compaction (§4.6 mechanism 2): `mdb_env_copy2(MDB_CP_COMPACT)` run
in a short-lived child process while the writer stays open. In-process the copy reads every live
page through the mmap, so the whole live data set became the bot's RSS (+27 MB at 52 MB, ~215 MB
projected at 420 MB); in a child it costs the bot +0.25 MB. Closing, renaming and reopening is the
caller's job (see `bench/08-compaction.mjs`).

### Key codec

`key().u64(gid).u64(uid).done()` builds a key. The builder is a singleton over a shared scratch
buffer, so do not nest `key()` calls inside one chain. `.view()` returns the bytes without copying.

`tuple('gid:u64 xp:inv32')` compiles a schema-driven codec with `encode` / `encodeInto` /
`encodeRecord` / `decode` / `decodeInto`.

The types are `u8 u16 u24 u32 u48 u64 u64s inv32 inv48 str bN`. `u64` decodes to a bigint and
`u64s` to a decimal string; their on-disk bytes are identical.

### Frame

The header is `HDR [schemaId u16 LE] [updatedAt u48 LE] [expiresAt u48 LE] payload`. The level row
from §4.3 comes out as `0x23 + varint`, 2–6 B in total. A compressed `feature_config` gets HDR `0x39`.

Codecs:

* **0 msgpackr.** Uses shared structures per collection, persisted in the `__meta` DBI under the key `s:<name>`.
* **1 deflate-raw(msgpackr).** Applied only when the msgpack payload is at least `compress.threshold` (512 B by default) and deflating actually makes it smaller.
* **2 raw bytes.**
* **3 varint.** LEB128 fields in declared order. `uint`, `sint` (zigzag) and `bool` are supported. To evolve the schema, append fields: a missing trailing field reads as 0.

## The Backend interface (§2.3)

```js
/** @typedef {{
 *   openCollection(name, { dupSort? }): Dbi,
 *   get(dbi, key): Buffer | undefined,        // VOLATILE: valid until the next backend call
 *   put(dbi, key, val): void,                 // dupSort: adds the (key, val) pair
 *   del(dbi, key, val?): boolean,             // dupSort with val: removes one pair
 *   range(dbi, { start, end, reverse, limit, exclusiveStart, inclusiveEnd }): Iterable<{ key, value }>,
 *   txn(fn): T,                               // synchronous, atomic, nested = savepoint
 *   stat(dbi?): { entries, pages, freePages },
 *   // optional: inTxn(), count(dbi, o), txnAsync(fn), drop(dbi), close(), flushed(), info(), kind
 * }} Backend */
```

The full contract, including the range-bound semantics, which follow lmdb `getRange`, is
written out in `src/backend.js`. `test/backend-conformance.test.js` checks it with fixed cases
and with a randomised differential run against a naive model. To bring up a new backend
(SqliteBackend, for example), add a factory to `BACKENDS` in `test/util.js` and run `npm test`.

## Extension points (for the scheduler/TTL, vector/blob and bench agents)

* **New collections with an index.** Define a schema and either pass it in `schemas` or call `db.collection(name, schema)`:

  ```js
  export const schedSchemas = {
    sched: {
      key: 'dueAt:u48 seq:u24',
      indexes: { sched_by_subject: { key: 'gid:u64 kind:u8 subject:u64' } },   // dupSort -> pk
    },
  };
  const db = openDB({ dir, schemas: { ...coreSchemas, ...schedSchemas } });   // db.sched
  ```

  Index options:

  * `unique: true` gives a plain DBI and makes `put` throw on a conflict.
  * `filter: rec => bool` makes the index sparse. A record whose index field is `null` or `undefined` is never indexed.
  * `lag: n` makes it a **lagged index**, for append-mostly collections with a time-ordered key.
    * The DBI holds exactly the entries of the rows at or below a watermark `W` (`__meta w:<index>`,
      written in the same txn as the entries it covers).
    * Rows after `W` are the tail. Once `n` of them have accumulated, ONE catch-up writes their
      entries, sorted, inside the txn of the write that crossed `n`, and moves `W` to the last pk.
      So the per-key scatter (e.g. one leaf per active channel) is paid once per `n` rows, not
      once per commit.
    * Reads merge the DBI range with the tail: a sorted RAM list built from the committed rows
      after `W`, cached per snapshot and extended incrementally on appends. It never shows
      uncommitted rows, and it is correct across processes. Overwrites, deletes and out-of-order
      rows after `W` bump an epoch (`__meta e:<index>`) that invalidates every reader's cache.
    * Rows written at or below `W` are indexed at once, as normal indexes are.
    * After a restart the tail is rebuilt from disk, which means decoding up to ~`n` rows once.
    * Not with `unique`.

  The storage mode is chosen automatically:

  * If the index key ends with the primary key, the index uses a plain DBI with an empty value.
  * Otherwise it is dupSort, and the entry value is the primary key minus any leading fields it shares with the index key. For `level_by_xp` that means the value is just `uid`, 8 B, as §5.4 specifies.

  All index DBI names share one namespace per env.

* **Extra methods.** Pass `schema.methods` and they are bound to the collection. See `level.top` and `level.rank`.
* **TTL / scheduler.**
  * Readers already hide expired frames.
  * Set `db.hooks.onExpiring = (col, pk, expiresAt) => …` to enqueue an `EXPIRE` job in the same txn. `pk` is a reused buffer, so copy it if you keep it.
  * The sweeper deletes with `col.delByKey(pk)`, which also maintains the indexes.
* **Time buckets.**
  * Use `db.bucketed(base, schema, opts)` (see "Time buckets" below), or open a bucket by hand with `db.collection(\`event_log_${yyyymm}\`, { ...schema, env: 'cold' })`.
  * Retention is `db.dropCollection(name)`: `mdb_drop` of the data and index DBIs plus the structures key in one write txn, so all of the bucket's pages go back to the freelist at once.
* **Blobs / vectors.**
  * Store vectors with `codec: 'raw'` and a key such as `'gid:u64 seg:u16'` or `'h:b16'`.
  * `getView` returns a zero-copy payload view. It is valid until the next DB call, so a KNN scan should consume each segment before reading the next.
* **Migrations.**
  * `schemaId` plus `migrate: { [n]: v => v' }` upgrades values lazily on read. Nothing is written back; the next write stores the current `schemaId`.
  * The bulk `spbt-db migrate --resume` tool is not built yet. It can be put together from `iterate()` and batched `db.txn` calls.
* **Benchmarks / ops.** Use `db.stats()`, `backend.info()` (per-DBI tree depth and page counts) and `backend.env` (the raw lmdb root, for `backup`/`copy`).

## Measured numbers

These come from `npm run bench` with N=100k `level` rows across 500 guilds, 1M random gets and
1000 puts per txn, on Node 22.23.1. Every put also maintains the `level_by_xp` index.

The machine was this dev box: a Ryzen 5 7535HS with btrfs on NVMe. It is not the Zen 1 EPYC
target, which the design (§7.2) puts at roughly 2× slower per core. The bench agent should
re-run on the target box.

The lmdb native module that loads is the N-API prebuild, with `v8AccelerationEnabled = false`.
That is the same binding Node 24 will load: the package ships only ABI 115/127 builds plus N-API.

| | real disk (btrfs/NVMe), 2 runs | tmpfs |
|---|---|---|
| put, batched, with index | 45.5k–47.9k ops/s (~21 ms per 1000-row txn) | 171k ops/s (5.9 ms/txn) |
| incr, batched (index entry moves) | 24.4k–25.2k ops/s | 92k ops/s |
| get, bigint keys | **1.06M–1.16M ops/s** | 1.03M ops/s |
| get, string snowflakes | 0.83M–0.99M ops/s | 0.91M ops/s |
| get latency p50 / p99 / p99.9 | **0.80–0.97 µs / 1.6–2.0 µs / 3.9–5.8 µs** | 0.88 / 1.8 / 5.2 µs |
| `level.top(gid, 10)` | 61k–69k ops/s | 65k ops/s |

* **Size on disk, per `level` record.** The frame is 4 B (HDR plus a 3-byte varint xp). The B+tree pages cost 43.3 B/rec for the data and another 43.3 B/rec for `level_by_xp`.
* **File size.** The file comes to 21.3 MB, or 212.7 B/rec, because the put and incr phases left 3,064 free pages behind through copy-on-write churn. Those pages are reused by later writes.
* **Process RSS.** It was about 182 MB, but that is mostly the bench's own 100k row objects and its 1M-entry latency arrays. It is not a DB footprint figure.
* **Where get time goes.** In a separate profile, lmdb's bare `getBinaryFast` with a prebuilt key cost about 615 ns per op, and `level.get` cost about 756 ns. Our layer, meaning the key encode and the frame decode, adds roughly 140 ns.
* **The fsync cost.** A synchronous commit costs **~5 ms** on this disk no matter what `overlappingSync` or `NO_SYNC_FLUSH` are set to, which I verified. Every write outside `db.txn` pays that cost. Hot paths have to batch, which is the job of the coalescers in §7.3, or use `db.txnAsync`, which moves the commit and the fsync off the main thread.

## Deviations from the design doc

1. **`useVersions` is off (Appendix A sets it to true).**
   * In lmdb-js it prefixes every value with an 8-byte version, which would turn the 4-byte level frame into 12 bytes.
   * It cannot be combined with `dupSort`.
   * Its `ifVersion` only applies to the async batched puts.
   * SPBT_DB's write txns are synchronous and LMDB has a single writer, so the read inside `incr`/`patch` already runs under the write lock. That makes them atomic without versions, across processes too. Version stamps can be turned on per collection later if they are ever needed.
2. **Codec 1 is deflate-raw (`node:zlib`), not LZ4.**
   * lmdb 3.5.6 exposes LZ4 only as a transparent per-DBI `compression` option. Its native `compress` export is an internal write-path hook, not a usable function.
   * Using it would also make the on-disk bytes depend on the backend, which breaks the SqliteBackend fallback.
   * Deflate is applied only above the threshold and only when it makes the payload smaller. Reads are synchronous `inflateRawSync`. An optional zlib `dictionary` is supported.
3. **`maxDbs` is 128 for hot (Appendix A says 64).** §5 lists about 55 hot DBIs (collections plus indexes) before other agents add theirs. Cold stays at 64.
4. **Indexes whose key already ends with the primary key use a plain DBI with an empty value** instead of dupSort. `user_by_plan` and `user_by_expiry` are examples. This is smaller and faster, with the same semantics.
5. **Transactions.**
   * `db.txn` is per env. A txn never spans hot and cold, because LMDB atomicity is per env.
   * `txnAsync` is extra. It uses `childTransaction`, because I verified that plain lmdb `transaction()` does not roll back when its callback throws.
6. **lmdb-js quirks handled in the adapter.** The differential test found both of these:
   * Without `start`, lmdb uses `[0x00]` as the start key, and `exclusiveStart` then skips a real `0x00` key.
   * A reverse scan without `end` uses `[0x00]` as an exclusive end, so it misses a `0x00` key.
   * The adapter now passes explicit bounds in both cases.
7. **No CacheBudget.** The `__boot` record, the coalescers and `level.bump` are now built; see "Scheduler, TTL sweeper, coalescers, time buckets, `__boot`" below.
8. **Feature tags are numeric `u8`.** Appendix B's `featureConfig.get(gid, 'moderation')` needs a name→tag registry, and that registry belongs to the features layer.
9. **The hot env has a FIXED `mapSize` of 2 GiB (§4.5 and Appendix A let lmdb-js grow it).**
   * lmdb-js 3.5.6 grows a full map by remapping at 2× and deliberately never unmaps the old mappings, because lingering readers may still use them. The same resident pages then count once per mapping until close: 8 mappings and 44 MB "resident" for a 26 MB file.
   * A fixed map is one mapping. It is virtual address space only. Without `MDB_WRITEMAP`, LMDB maps the file read-only and shared and never extends the file to `mapSize`. A read-only shared mapping is not charged to `Committed_AS`, so it is safe under `vm.overcommit_memory=2`. Only `ulimit -v` would see it.
   * 2 GiB is ~5× the §6.3 projection of 420 MB. At open, `mapSizeFor()` raises it to the next power of two ≥ 2× the file, so a running process only outgrows its map if the file more than doubles during its lifetime.
   * If that happens, lmdb-js grows the map itself; it never returns `MDB_MAP_FULL`. The cost is one extra mapping until the next open, and `backend.info().mapGrown` reports it. The real failure mode is a full disk (ENOSPC), which surfaces as a thrown write error.
   * Measured with bench 03: see item 10.
10. **The cold env runs with `noReadAhead` (§4.5 keeps readahead on for cold).**
    * Measured with bench 03 (scale 0.1: panel log views plus appends over 2 000 channels): cold.mdb resident fell from 77–95 MB to 20–29 MB, and all `.mdb` resident from 92–111 MB to 32–43 MB, under the ≤ 53 MB of §6.3.
    * The same flag cut the RSS spike of a month `dropCollection` from 8.1 to 1.2 MB at 500k rows. Readahead was pulling ~32 KB around every branch page that `mdb_drop` visits.
    * The cost: lmdb-js warns against `noReadAhead` with pages over 4 KiB, because a cold read of an 8 KiB page can take two 4 KiB faults instead of one.
    * See "Decisions for the owner" for the 4 KiB cold page option.
11. **event_log's primary key is time-ordered (`ts seq`), not `gid chan ts seq` (§4.2, §5.7).** Per-channel reads go through a lagged index instead.
    * With the doc's key, ~80 active channels dirty about one 8 KiB leaf each per flush. That measured **10× write amplification at 512 rows per commit and 20× at 250**, against a threshold of 1.6×.
    * Measured alternatives (bench 01 shape, 80 channels, 512 rows per commit):

      | primary key / per-channel index | WA |
      |---|---|
      | `gid chan ts seq` (doc), 8 KiB pages / 4 KiB pages | 13.0× / 8.7× |
      | `gid ts seq` plus a `gid chan ts seq` index | 14.0× |
      | `ts seq` plus a `gid chan ts seq` index in the same txn: the entries are tiny, but every channel still dirties a leaf | 9.6× |
      | `gid chan ts seq`, appender buffering per channel (flush at 32 rows or 60 s) | 4.7× |
      | **`ts seq` plus lagged `elog_by_chan` and `elog_by_msg` (lag 8192), as shipped** | **2.4× (250/commit: 2.9×)** |
      | the same with lag 16 384 | 2.15× (catch-up commit p99 93 ms) |
      | `ts seq` alone, no channel index (the floor) | 1.52× |

    * No layout with a per-channel order maintained on every commit gets near 1.6×. A COW B+tree pays at least one page per distinct key range per commit.
    * On-pages size per row fell from 368 B to 273 B, indexes included.
    * What the lag costs:
      * **RAM.** A read caches the tail of the month it touches, at most `lag` entries per index (~1 MB each, built on first read).
      * **Main thread.** The txn that crosses the lag writes 8 192 entries per index. bench 05 measured 39–56 ms of main-thread time in that one txn callback, against ~5 ms for a plain 512-row append. That is once per 8 192 rows: about every 2.7 min at 50 msg/s.
      * **The knob.** WA ≈ 1.5 + (active channels × page size) / (lag × row bytes). The bench's lag 16 384 gives 2.15× with a ~95 ms catch-up.
    * The read paths:
      * **Latest N of a channel:** `query({ index: 'elog_by_chan', where: [gid, chan], desc: true })`.
      * **By author:** add `elogByAuthor`, which is lagged the same way.
      * **Edit/delete lookups by message id:** `byMessageId(id)`. The message row (k=0, logged with `ts = createdTimestamp`) sits at its snowflake time in the primary key, so it needs no index entry. Edits and deletes (~15 %) go into `elog_by_msg`.
12. **The `__boot` record is committed without an fsync** (backend `txnLazy`: `MDB_NOSYNC`, the flag lmdb-js uses for `putSync`). Opening the db no longer waits for the disk. See "Post-crash open time" under Benchmarks for what that did and did not fix.
13. **`dropCollection` is one write txn.** It covers the data DBI, the index DBIs, the structures key and, for buckets, the registry entry. `mdb_drop` is transactional: lmdb-js `dropSync()` runs it inside the current write txn. It is not allowed inside a savepoint, because LMDB closes the handle env-wide.
14. **Range reads hand out lmdb's reusable value buffer** (`backend.scan`).
    * Each DBI is opened with a pass-through `encoder`, which makes lmdb-js give `decode()` its reusable buffer instead of an unpooled copy per value. Keys are pooled copies.
    * `backend.range()` still returns stable copies.
    * See items 4 and 5 of the r2 table for the effect.

## Tests

`npm test` runs `node --test test/*.test.js`. After r2 it reports **144 pass, 1 skip, 0 fail** in about 8 s (r1: 134 + 1 skip). `test/sched.test.js` alone: 6 runs, 1.7–2.1 s each, no hang. The core suites cover:

* **Key codec properties.** The byte order of random tuples must equal their logical order, for every type, including `inv*` and NUL-escaped strings. The suite also checks round trips, prefix bounds, the agreement of the three u64 input forms, and that invalid values are rejected.
* **Frame round trips** for every codec, plus the HDR constants from §4.3, TTL expiry, the shared-structures persistence and reset, and decoding from lmdb-style volatile buffers.
* **Backend conformance** for both the memory and the lmdb backend: fixed cases plus a randomised differential run against a naive model with 3 seeds.
* **Collections on both backends.** After random put/patch/del/incr sequences, including rolled-back txns, every index is recomputed from the data and compared with what is stored.

  The collection suite also covers:
  * unique violations
  * cursor paging in both directions, and covered queries
  * TTL visibility and the hook
  * lazy migrations
  * shared structures surviving an aborted txn
  * the raw and varint codecs
  * reindex and drop
  * reopening and persistence

  A mutation check confirmed these tests fail when the structure reset or the index deletes are removed.
* **Drop atomicity (r2).** An abort after `drop()` inside the same txn keeps the data, both indexes and the structures. A real drop is exactly one commit, and a drop inside a savepoint is refused.
* **Lagged indexes (r2, `test/lagged.test.js`, both backends).**
  * Random appends, late rows below the watermark, overwrites and deletes, in sync and async txns, some of them aborted.
  * Every query (asc/desc, paged in steps of 7, covered) and every count must equal a model, read through the writer's collection and through a second collection object that stands in for another process.
  * The DBI must hold exactly the rows at or below the watermark, with the tail bounded by the lag.
  * Also covered: `flushLagged`, `reindex`, a reopen that rebuilds the tail from disk, and the event_log defaults: `byMessageId` across a month boundary, a windowed channel read, paging the whole log.
  * Mutation-checked: dropping the epoch bump fails it, and so does indexing rows below the watermark lazily.
* **Env sizing and compaction (r2, lmdb).** A 1 MiB map outgrown 8× is grown by lmdb-js, not failed, and `mapGrown` reports it. A reopen sizes the map from the file. `compactCopy` produces a smaller env in a child process while the writer stays open.
* **Quick start (r2, `test/quickstart.test.js`).** The README flow, run through the `exports` map.

A kill -9 crash test is not included; that one belongs to the bench agent.

## AI vectors, quota and blobs (`src/vector.js`, `src/blobs.js`, `src/ai-schema.js`)

These implement design §9 (vector store), §10 (blobs) and the `ai_chunk`, `ai_vec`, `ai_quota`, `blob_ref` and `image` collections from §5.8 and §5.9. They attach to a db, so `index.js` does not change:

```js
import { openDB, coreSchemas } from './db/src/index.js';
import { aiSchemas } from './db/src/ai-schema.js';
import { attachVectors } from './db/src/vector.js';
import { attachBlobs } from './db/src/blobs.js';

const db = openDB({ dir: './data', schemas: { ...coreSchemas, ...aiSchemas } });
attachVectors(db);                          // -> db.ai   (opts: dim=256, slots, cacheBytes=4 MiB, kernel, normalize, chunkTtl)
attachBlobs(db, { dir: './data/blobs' });   // -> db.blobs (opts: inlineMax=1024, graceMs=24h, tmpGraceMs=1h, fsync)
```

Passing `aiSchemas` is optional because both functions open their collections themselves. Passing them only adds the `db.aiChunk`, `db.blobRef`, `db.image`, … shortcuts. `createVectorStore` and `createBlobStore` return an instance without assigning it to `db`.

### `db.ai`

| method | |
|---|---|
| `add(gid, chunkId, vec, text, meta?)` | Quantises `vec` (`Float32Array`/array of `dim`), stores the chunk row, and returns `chunkId`. A `null` id allocates one from the guild counter; an existing id is replaced in place. |
| `addMany(gid, [{ chunkId?, vec, text, meta?, ttl? }])` | One txn, and each touched segment is written once. Use this for ingestion. |
| `knn(gid, vec, k = 8, { text = true, minScore }?)` | Returns `[{ chunkId, score, text }]`, best first. `score` is the cosine similarity. Chunks whose row expired are skipped. |
| `remove(gid, id)` / `removeMany(gid, ids)` | Drops the vectors and their chunk rows. |
| `sweep(gid)`, `dropGuild(gid)`, `count(gid)`, `ids(gid)`, `chunk(gid, id)`, `invalidate(gid?)`, `stats()` | |
| `quota.use(scope, id, day?, limit, n = 1)` | Returns `{ ok, used }`. `scope` is `'guild'` or `'user'` (0/1); `day` defaults to `quota.today()`. Also `quota.used(scope, id, day?)`. |

* **Storage.** Each `ai_vec` row (key `u64be(gid) ‖ u16be(seg)`, raw codec) is one structure-of-arrays segment: `m × int8[dim]`, then `m × f32 scale`, then `m × u32 chunkId`. Vectors stay dense, so only the tail segment is partial, and it is stored at its real size.
* **Guild header.** `seg = 0xFFFF` holds a 16 B header: `n | gen | nextId | dim | slots`. `gen` changes on every write, and the RAM cache checks it on every query, so a write from another process is never served stale.
* **Remove.** Each hole is filled with a vector moved from the tail. One remove rewrites at most 2 segments, and the segments never need a separate compaction pass.
* **Quantisation.** Stored vectors are L2-normalised and quantised to int8 with a per-vector scale (§9.2). The query is quantised to int16 instead of int8. In the kernel this costs the same, and it removes the query-side rounding error. Dot products are exact int32.
* **Kernel.** It is a hand-assembled WebAssembly SIMD function: a 219-byte module built at load, using `i16x8.extend` and `i32x4.dot_i16x8_s` for 16 MACs per step. It measured 0.041 ns/MAC here, against 0.75 ns/MAC for the best unrolled JS loop. The scalar JS kernel is the fallback, and its results are bit-identical, which the test checks.
* **Top-k.** A typed-array min-heap. No allocations happen per vector.
* **RAM.** An LRU of whole guilds is decoded into the wasm memory, within the `cacheBytes` byte budget. That is 4 MiB by default, which is the vecLRU share in §6.2 and holds 30 guilds × 400 chunks = 3.2 MB.
  * A guild larger than the budget, or a query inside a write txn, is scanned one segment at a time through a scratch buffer.
* **TTL coupling.** Deleting an `ai_chunk` row also removes its vector. This covers the TTL sweeper's `delByKey` as well as `del`. `ai_chunk` uses `ttlSweep: 'job'`, and `ai_quota` rows expire at `(day + 2) × 24 h`.

### `db.blobs`

| method | |
|---|---|
| `await put(bufOrStringOrStream, { mime, ref?, txn?, maxBytes? })` | Returns `{ hash, hex, size, mime, deduped, inline, refs, result }`, where `hash` is `sha256[0:16]`. `txn: (info) => …` runs inside the txn that adds the ref, so put the owning row (`image.blobHash`, …) there. Without `ref`/`txn` the blob starts at `refs = 0` and must be referenced within `graceMs`. |
| `open(hash)` / `await read(hash)` / `path(hash)` / `stat(hash)` / `has(hash)` | `open` returns a read stream. `path` is for `res.sendFile` and is `undefined` for inline blobs. `hash` is 16 bytes or 32 hex characters. |
| `ref(hash, n = 1)` / `unref(hash, n = 1)` | Synchronous, and joins the caller's `db.txn`. They throw on an unknown blob or on a count below 0. |
| `await gc({ now?, limit?, orphans? })` | Runs `gcRefs`, then `gcOrphans`. |
| `await gcRefs({ now?, graceMs?, limit = 10000 })` | Deletes zero-ref blobs older than the grace period, through the sparse index `blob_gc (zeroAt, h)`. Bounded by `limit` and resumable. |
| `await gcOrphans({ now?, limit = 5000, cursor? })` | Removes tmp files older than 1 h and tree files without a row older than 24 h. The walk is bounded, and the cursor is returned. |

* **Layout.** Blobs live at `blobs/ab/cd/<32 hex>`, with in-progress writes at `blobs/tmp/<uuid>`. Blobs of up to `inlineMax` (1 KB, §10.5) go into the `blob_inline` DBI instead.
* **`blob_ref` row.** It uses the varint codec and holds `size, mime u8, refs, firstSeen, zeroAt` in about 12–18 B.
* **Write order.** The stream is written to tmp while being hashed, then fsync(tmp). If the target already exists, tmp is dropped (dedup); otherwise it is renamed and the directory fsynced. After that, one txn upserts the ref row together with the owning row.
* **Crash windows.**
  * A crash before the rename leaves only a tmp file.
  * A crash between the rename and the txn leaves a file without a row.

  `gc` cleans up both after their grace periods.
* **Per-hash lock.** An in-process lock serialises `put` and `gc` on the same hash, so `gc` cannot unlink a file that a concurrent `put` just deduplicated against.

### Measured (dev box: Ryzen 5 7535HS, Node 22.23.1, lmdb on btrfs/NVMe)

`npm test` prints these figures from `test/vector.test.js`. Latency is `knn` with k=8 including the text fetch for the 8 results (~1 µs per chunk row). Each figure is p50 / p99 over 300 queries:

| N per guild | wasm + LRU | wasm, uncached | JS kernel, uncached | §9.5 estimate for Zen 1 |
|---|---|---|---|---|
| 400 | 29–40 / 90–104 µs | 30–32 / 95–155 µs | 136 / 187–217 µs | 350–500 µs |
| 2 000 | 46–48 / 69–78 µs | 73–75 / 124–128 µs | 632 / 690–750 µs | 1.7–2.5 ms |
| 5 000 | 89 / 124–137 µs | 156–158 / 170–254 µs | 1.57–1.59 / 1.8–2.1 ms | 4–6 ms |
| 20 000 | 597–599 / 774–904 µs ¹ | 600–609 / 702–818 µs | 6.4 / 7.2–7.5 ms | 17–25 ms |

¹ A 20 000-vector guild (5.3 MB) does not fit the 4 MiB LRU, so this column is effectively uncached. With a 16 MB budget it measured 306 / 466 µs (294 / 401 µs without the text fetch). Without the text fetch, N=400 takes 14 µs, and about a third of that is the kernel.

* **Recall@10 against fp32 brute force.** On synthetic clustered data (200 queries each), recall was 0.977–0.992 across N = 2 000 and 5 000 and clusters at cos ≈ 0.9 / 0.7 / 0.45 to their centre. Bench 06 requires ≥ 0.95.
* **Size on disk.**
  * **ai_vec: 267 B/vector.** That is 1 788 pages for 27 400 vectors, against an ideal of 264 B (256 + 4 + 4).
  * With the doc's 64-slot segments it is 329 B/vector.
  * **ai_chunk:** about 375 B per chunk with 300 B of text.
* These are dev-box figures. The bench agent should re-run them on the target (§13 bench 06).

### Deviations from the design doc

1. **The default segment holds 77 vectors at d=256, not 64.**
   * LMDB stores a 64 × 264 B segment in 5 overflow pages (20 480 B), so 64 slots waste 17 %.
   * `slots: 'auto'` fills those same 5 pages. Disk use goes from 329 to 267 B/vector, and each query does 17 % fewer gets.
   * `slots: 64` gives the documented layout.
   * The slot count is stored per guild, so changing the default never breaks existing data.
   * Note that the doc's 16 704 B (§5.8) and 16 896 B (§9.4) disagree; 64 × 264 = 16 896.
2. **WebAssembly SIMD instead of an unrolled JS loop (§9.5).** It is about 10–20× faster here. It is still zero-dependency, and `kernel: 'js'` forces the fallback.
3. **The query is quantised to int16 (asymmetric) rather than int8.** This removes the query's rounding error and costs nothing.
4. **No binary Hamming prefilter at more than 20 000 chunks (§9.2).** An exact scan of 20 000 vectors takes about 0.3–0.6 ms, so a prefilter would only cost recall.
5. **`blob_ref` gained a `zeroAt` field and the sparse `blob_gc` index.**
   * GC is a range scan over the zero-ref rows only, not over all 650k rows.
   * The grace period runs from the moment refs reached 0, or from the latest re-upload, not from `firstSeen`. Otherwise a blob that was unreferenced after a year would be deleted with no grace at all.
6. **Blob files are named `<hex>` without the `.bin` extension**, as the task asked.
7. **The put/gc lock is in-process only.** Two writer processes sharing one blob directory would need a lease (§11).

### Tests

* **`test/vector.test.js`: 17 tests, on both backends.**
  * Random add/replace/remove sequences are checked against a model; every vector must find itself, and every id must appear exactly once.
  * The wasm and JS kernels, cached and uncached, must return identical results.
  * The LRU budget is enforced, and the `gen` check catches writes from another instance.
  * A txn rollback leaves the data and the cache untouched.
  * Expired chunks are skipped and swept, and `delByKey`/`del` remove the vector.
  * Argument checks.
  * Quota tests cover the limit, scope independence, the 2-day expiry and rollback.
  * Recall at or above 0.95, plus the latency table above with the §13 thresholds asserted.
* **`test/blobs.test.js`: 8 tests.**
  * Dedup across buffers and streams, and the inline boundary at 1024 / 1025 B.
  * Refcounts with the txn hook and rollbacks.
  * Concurrent puts.
  * The GC grace period, bounds and resumption.
  * A gc/put race on one hash.
  * Real `kill -9` crashes in a child process, after the tmp write and after the rename, each cleaned up by gc.
  * The bounded orphan walk with a cursor.
  * `maxBytes`.
* **Mutation checks.** Each of these was confirmed to fail its test:
  * dropping the per-hash lock in gc,
  * dropping the dirty-segment write in remove,
  * dropping the `gen` check from the cache.

## Scheduler, TTL sweeper, coalescers, time buckets, `__boot`

`src/sched.js`, `src/ttl.js`, `src/coalesce.js`, `src/buckets.js` and `src/boot.js` add about 1,000 lines of code (comments excluded). Design: §4.5, §4.6, §5.3, §7.3, §8.

```js
const db = openDB({ dir: './data', sched: true, ttl: true });   // both off by default; __boot is on

// scheduler (§8): joins the caller's txn, so the case and its unban commit together
db.txn(() => {
  db.modCase.put(c);
  db.sched.at(Date.now() + 7 * DAY, { kind: 'unban', gid, subject: userId, caseNo, catchUp: 'run' });
});
db.sched.on('unban', async (job, { lagMs }) => { await guild.bans.remove(job.subject).catch(ignoreUnknownBan); });
db.sched.cancel(gid, 'unban', userId);           // /unban: through sched_by_subject, no scan

// coalescers (§7.3)
db.level.bump(gid, uid, 15);                     // ~130 ns, RAM only; one txn every 30 s / 2000 keys
const rooms = db.coalescer(db.collection('pvc_room', pvcSchema), undefined, { flushMs: 500 });
rooms.add({ chan, isPublic: true });             // last write wins per field, one txn per 500 ms

// time buckets (§4.6)
const elog = db.bucketed('event_log', eventLogSchema, { env: 'cold', retentionDays: 30 });
const logBuf = elog.appender();                  // 5 s / 512 rows / 1 MB, ring cap 4096
logBuf.append({ gid, chan, ts: Date.now(), seq, k: 0, msgId, authorId, content });
elog.query({ where: [gid, chan], from: Date.now() - 7 * DAY });   // merges the month cursors

db.bootInfo().lastShutdownClean;                 // false => last process died with buffers in RAM
await db.close();                                // stop timer, flush every buffer, mark __boot clean
```

### `openDB` options added

| option | |
|---|---|
| `sched: true \| SchedOptions` | opens `sched` + `sched_by_subject` and starts the timer. `{ autoStart: false }` defers `db.sched.start()`. |
| `ttl: true \| SweepOptions` | the sweeper, `db.ttl`. With `sched` it also registers the daily `expire_range` job. |
| `boot: false` | skips the `__boot` record. It is written by default: one commit at open, one at close. |
| `coalesce: { level: CoalesceOptions }` | options for `level.bump`. |
| `clock`, `timers` | injectable `() => ms` and `{ setTimeout, clearTimeout }`, used by the tests |

### `db.sched`

| member | |
|---|---|
| `at(dueAt, { kind, gid?, subject?, object?, caseNo?, payload?, catchUp?, maxLagMs?, indexed?, replace? })` | Returns `{ id, dueAt, seq }`. It joins an open `db.txn`; otherwise it commits its own txn, which is one fsync. |
| `cancel(gid, kind?, subject?)` | Removes jobs through the index and returns how many it removed. Leaving out the trailing arguments cancels by prefix, for example every job of a guild. |
| `cancelRef(ref \| id)`, `find(gid, kind?, subject?)`, `next()`, `list({ limit, from, to })`, `count()` | |
| `on(kind, handler, { inTxn? })`, `off(kind)` | A handler may return `{ reschedule: dueAt, payload? }`, which makes the job recurring. |
| `ensure(dueAt, spec)` | Inserts the job only if none exists for `(gid, kind, subject)`. Used for the maintenance jobs. |
| `defineKind(name, id)` | Registers an app kind. Ids 100–255 are free; `KIND` lists the built-in ones (§5.3). |
| `runDue()`, `idle()`, `start()`, `stop()`, `stats()` | `stats()`: wakes, fired, skipped, failed, retried, rescheduled, unhandled, commits, last and max lag, lastWakeUs, pending, nextWakeInMs |

* **Row format.** The key is `u48be(dueAt) ‖ u24be(seq)`. The value is a raw frame, not msgpack: `0x22 kind flags gid:u64 subject:u64 [object:u64] [caseNo:u32] [maxLagMs:u32] [attempt:u8] [payload: msgpack]`, 19 B minimum. `catchUp` takes 2 bits of `flags`.
* **The index.** `sched_by_subject` maps `gid:u64 ‖ kind:u8 ‖ subject:u64` to the 9-byte sched key. It is a dupSort DBI written in the same txn by `sched.js`, because the core does not index raw rows. `seq` is checked for uniqueness against rows left by earlier processes.
* **The wake loop (§8.2).**
  * There is one timer. `wait = clamp(head.dueAt - now, 0, maxSleepMs)`, with `maxSleepMs` at 60 000 by default.
  * Values above `2^31-1` are rejected when the scheduler is constructed. A NaN or Infinity wait becomes the ceiling, so the 24.85-day `setTimeout` overflow cannot happen.
  * Every wake compares against `clock()`. Forward clock jumps run whatever is due at the next wake; backward jumps run nothing early.
* **Delivery is at-least-once.**
  * A wake reads up to `batch` (500) due jobs, running those within `fireEarlyMs` (50) of being due.
  * Async handlers run outside any write txn, 8 at a time.
  * **One** txn then deletes the whole batch idempotently: a job cancelled in the meantime is skipped. The same txn runs the `inTxn` handlers, each in its own savepoint, and inserts the retries and reschedules.
  * A crash between a handler and that commit re-runs the job, so handlers must be idempotent (§8.5).
  * `inTxn: true` handlers are synchronous and DB-only. Their writes commit atomically with the job's deletion.
* **catchUp.**
  * `run` always runs.
  * `skip` drops the job when it is more than `graceMs` (60 s) late.
  * `runIfWithin` runs it only if `now - dueAt <= maxLagMs`.
* **Failures.** A throwing handler is retried at `retryBaseMs · 2^attempt` (1 s, 2 s, 4 s and so on, capped at 1 h). After `maxAttempts` (5) the job is dropped and `onError(err, job, { final: true })` is called.
* **Unhandled kinds.** Due jobs whose kind has no handler are left in place, and the loop re-checks them every `stallMs` (1 s) instead of spinning. Calling `on()` re-arms the timer immediately.

### TTL sweeper (`db.ttl`): a bounded scan by default, per-record jobs as an opt-in

Readers already hide expired frames, so the sweeper only frees pages. The mode is set per collection with `schema.ttlSweep`.

* **`'scan'` (the default): EXPIRE_RANGE.**
  * One recurring `expire_range` sched job, daily by default (`intervalMs`), walks every TTL collection with a resumable cursor.
  * Each step reads at most `scanBudget` (2000) entries, deletes at most `batch` (500) per write txn, and yields to the event loop between steps.
  * Each delete is re-checked under the write lock and goes through `delByKey`, so the indexes are maintained.
* **`'job'`: EXPIRE.** The write txn that stores a TTL frame also inserts an un-indexed `expire` job at `expiresAt`, through `db.hooks.onExpiring`. The job deletes the record only if it is still expired when it fires.
  * This is hot env only.
  * A `'job'` collection in the cold env, or with no scheduler, falls back to `'scan'`.
  * `ai_chunk` uses this mode (`src/ai-schema.js`).
* **`false`** never sweeps.

**Why scan is the default.** The §5 TTL collections that are rewritten constantly would pay a sched row plus a stale job on every rewrite under `'job'`: `session` every 30 s, `music_session` every 3 s, `ai_quota` on every reply, `link_cooldown`. An `expiresAt` index, which the doc's EXPIRE_RANGE assumes, would add an index move to every refresh. Both would put extra writes on the hot path to save a few milliseconds of scanning a day on collections of at most 5.5k rows. `'job'` is the right choice for large, write-once, long-TTL collections, where a full scan would fault cold pages into a 952 MB box.

Scan targets are open collections that have `schema.ttl` or `ttlSweep: 'scan'`, plus any collection seen writing a TTL frame. Seen collections are persisted in kv `__ttl`, so they are still swept after a restart. `sweep({ now?, collections? })` returns `{ scanned, deleted, txns, maxPerTxn }`.

### Coalescers

* **`db.counter(col, field, opts)`.**
  * `bump(...key, delta)` adds into nested Maps keyed by the normalized bigint ids, so bigint, string and number ids share one entry.
  * A flush applies every key that does not net to 0 with `col.incr`, in key order, in one txn. Index maintenance included.
  * `level.bump` is this, created on first use. `db.level.bumps` exposes `flush`, `metrics` and `peek`.
* **`db.coalescer(col, mergeFn?, opts)`.**
  * `add(rec)` folds into the buffered record with `mergeFn(prev, next)`. The default merge is a shallow patch: last write wins per field.
  * A flush writes `mergeFn(stored, buffered)` per key.
  * `{ blind: true }` skips reading the stored value; `{ put: { ttl } }` sets the write options.
* **`createAppender(backend, sink, opts)` / `bucketed.appender()`.** An append-only ring. When it is full the oldest rows are dropped and counted in `dropped`.
* **Triggers.**
  * A flush runs `flushMs` after the first buffered op, so the oldest op waits at most `flushMs`, or when `maxEntries` keys are buffered.
  * It also runs on `flush()`, `db.close()`, or the process `'beforeExit'` event (one listener for all coalescers, `flushAllPending()`).
  * A flush that has nothing to write opens no txn.
* **Commits.**
  * By default the commit goes through `txnAsync`, so commit and fsync run off the main thread. The txn callback, meaning the `incr` calls, still runs on the main thread; `lastApplyMs` reports it.
  * If a commit fails, the batch is merged back into the buffer and retried.
* **SIGTERM is not hooked.** Installing a handler would change the process's default exit. The app's SIGTERM handler should `await db.close()`.
* **Defaults (§7.3).**

  | coalescer | flushMs | maxEntries | cap | other |
  |---|---|---|---|---|
  | level | 30 s | 2000 | 20 000 | |
  | event_log | 5 s | 512 | 4096 | `maxBytes` 1 MB |
  | generic | 1 s | 1000 | | |

* **Metrics.** `metrics()` returns: pending, `oldestAgeMs` (the current lag, which is what a kill -9 would lose), ops, flushes, commits, written, `lastFlushMs`, `lastApplyMs`, `lastAgeMs`, `maxAgeMs`, errors, overCap, dropped. `db.coalesceMetrics()` lists every coalescer.
* **What kill -9 loses.**
  * It loses exactly what is still buffered: at most `flushMs` worth of updates, which is ≤ 30 s of XP or ≤ 5 s of logs.
  * Nothing that was committed is lost.
  * The loss is detectable, because only `db.close()` marks `__boot` clean. `test/coalesce.test.js` checks this with a real `SIGKILL` of a child process.

### `__boot` (§4.5)

The record is `kv['__boot'] = { bootId, startedAt, cleanShutdown, writerPid, dirtyBoots, stoppedAt? }`.

* **On open.** The previous record is read, then the new one is written with `cleanShutdown: false`. It is committed without waiting for an fsync (`txnLazy`), so open never blocks on the disk: a kill -9 keeps it, and a power loss may roll it back together with the other unflushed txns.
* **On close.** After the timer stops and the buffers flush, `cleanShutdown` is set to `true`. If another writer has replaced the record, it is left alone.
* **`db.bootInfo()`.** It returns `{ current, previous, lastShutdownClean, dirtyBoots }`. `lastShutdownClean` is `null` on the first open of a data dir. `dirtyBoots` is the all-time count for `spbtdb_dirty_boot_total`.

### Time buckets: `db.bucketed(base, schema, { env = 'cold', retentionDays, tsField = 'ts', seqField?, schedule? })`

The shipped event_log schema is `eventLogSchema` in `src/schema.js`. It has primary key `ts:u48 seq:u16`, plus `elog_by_chan` (`gid chan ts seq`) and `elog_by_msg` (`msgId ts seq`, holding only rows that are not at their snowflake time), both lagged by 8192 rows. Deviation 11 above explains why.

* **Storage.**
  * Every UTC month is its own collection, `${base}_YYYYMM`.
  * Index names get the same suffix, because index DBI names are global per env; queries keep using the schema's index name.
  * The months that exist are recorded in a tiny `__buckets` DBI in the same env, written in the same txn as a month's first row. That is how `dropExpired` finds months this process never opened.
* **Writes.** `append(rec)` routes by `rec[tsField]`. `appendMany(recs)` is one txn, even when the rows span months, because they share an env.
  * `seqField` defaults to `'seq'` when the key has a `seq` field. It is a rolling u16 that starts at a random value, so a restart within the same ms cannot reuse `(ts, seq)`.
  * When the first row of a newer month arrives, the previous month's lagged tails are written in that same txn.
* **Reads.**
  * `get(...key)` needs `tsField` to be part of the key.
  * `query({ where/prefix, start, end, index, desc, limit, after, covered, from, to })` runs a k-way merge of the month iterators in primary-key order, or in (index key, pk) order for an index query.
  * Its `next` cursor resumes in every month.
  * `from` and `to` (`[from, to)` in ms) choose which months are read. When `tsField` comes right after the `where` fields of the queried tuple, as in the shipped event_log (pk `ts seq`, or `elog_by_chan` with `where: [gid, chan]`), they become range bounds. Otherwise the rows are filtered.
  * A query that touches a single month is that month's own `query()`. The cursor format is the same, and nothing is merged.
  * `byMessageId(id)` returns every row of a Discord message, oldest first.
  * `iterate(o)` is the lazy form.
* **Retention.**
  * `dropExpired(now)` drops every month that ended at least `retentionDays` before `now`. Its DBI, its indexes and its registry entry go in one txn per month.
  * With `db.sched`, a daily `bucket_drop` job at **04:17 UTC** runs it for every bucketed set.

### Measured (dev box: Ryzen 5 7535HS, Node 22.23.1, lmdb on btrfs/NVMe, 2 runs)

| | |
|---|---|
| `level.bump` into the coalescer, 1M bumps over 20k active keys | **134 ns/op = 7.5M ops/s** with bigint ids; 248 ns = 4.0M ops/s with string ids. The first version, keyed by `${gid}:${uid}` strings, took 558 ns. |
| flush of 2000 keys into a 100k-row `level` (with `level_by_xp`), one commit | 63–65 ms p50 wall = **~31k entries/s, ≤ 15 flush commits/s**. 13.6 ms of it is main-thread apply (6.8 µs per `incr`); the commit and fsync of the ~2000 dirty pages run off-thread. A sync flush takes 50–51 ms, all of it blocking. |
| commits per flush | **exactly 1**, asserted in the tests. At the §7.3 defaults that is 2 fsync/min for XP. |
| scheduler, one idle wake with 50k rows in the tree (head lookup + re-arm) | **4.4–4.7 µs wall**, 3–8 µs CPU. The head scan alone is 0.8 µs. At one wake per 60 s that is < 10 ms CPU/day. |
| scheduler, firing 500 due jobs | 9.2–9.3 ms including the single commit (~18.5 µs/job) |
| `sched.at`, batched 1000 per txn | ~45k jobs/s |
| **on-disk bytes per sched row**, 50k jobs with a realistic kind mix | The value averages 28.2 B (19 B minimum) and the key is 9 B. In B+tree pages that is **71.4–71.9 B/row** for `sched` plus **49.2 B/row** for `sched_by_subject`, ≈ **121 B/row**, so 50k jobs take ≈ 6 MB. |

* **Method.** The numbers come from a one-off script: `level` with 100k rows over 500 guilds, then each step above.
* **Target box.** The Zen 1 box (§7.2) should be about 2× slower per core. Flush wall time is dominated by the commit and fsync of dirty pages (§7.1: 2000 random members touch about one leaf per member in both `level` and `level_by_xp`), so it depends on the disk. The bench agent should re-run there.

### Deviations from the design doc

1. **sched values are hand-packed raw frames, not msgpack.** This is smaller and needs no shared-structure state. `sched_by_subject` is maintained by `sched.js`, because the core does not index raw rows.
2. **Batch commit instead of one txn per job (§8.2's sketch).** That sketch commits once per fired job, which costs about 5 ms each. Here one commit covers up to 500. Retries with backoff and `inTxn` handlers were added; the doc does not cover failure handling.
3. **`skip` needs a lateness threshold, which the doc does not define.** `graceMs` is 60 s by default, one wake ceiling.
4. **TTL is a scan by default, with no `expiresAt` index.** Per-record `EXPIRE` jobs are an opt-in, and they are un-indexed. The job payload carries the collection *name*, because no `collection:u8` registry exists.
5. **The reward-crossing immediate flush (§7.3) is left to the feature layer.** It can call `db.level.bumps.flush()`; `peek()` gives the buffered delta.
6. **`sched` and `ttl` are opt-in options**, so other users of `openDB` (benchmarks, tools) pay nothing. `__boot` is on by default.
7. **`__buckets` registry DBI and per-month index name suffixes.** The doc does not mention either.

### Tests (both backends unless noted)

`test/sched.test.js` has 20 tests, `test/ttl.test.js` 9, `test/coalesce.test.js` 16 and `test/buckets.test.js` 13, one of which is lmdb-only. Shared helpers are in `test/ext-util.js`:

* **Fake clock and timers.** Timers are monotonic and `jump()` steps only the wall clock.
* **Commit-counting backend wrappers.**

The suites cover:

* **The overflow case.** A job 2^31+5 s out and a 90-day job never reach `setTimeout` with more than 60 000 ms: over 129k wakes are simulated with no real waiting. Both jobs fire on time.
* **Clock jumps.** A wall clock 6 days forward, then 3 days back.
* **catchUp.** All three policies.
* **At-least-once.** The row still exists while its handler runs, and 1200 jobs take exactly 3 commits.
* **Failures.** Retry and backoff, then drop. A failing `inTxn` savepoint rolls back only its own writes.
* **Recurring and unhandled jobs.** Reschedule works, and unhandled kinds do not spin.
* **Index operations.** Cancel by exact key, by prefix and by ref, with no stale index entries.
* **Restart recovery (lmdb).** Overdue jobs run within ~10 ms of reopening, in dueAt order, with their catchUp policies applied.
* **TTL.** At most `batch` deletes per txn and one commit per batch, with indexes maintained. Collections seen at runtime are remembered across reopen. Job mode, including a refreshed record that must survive its stale job and the cold-env fallback. The recurring `expire_range` job, registered exactly once across reopens.
* **Coalescers.**
  * ONE commit per flush (20k bumps over 500 keys).
  * Flushes triggered by `maxEntries`.
  * No txn for a no-op flush.
  * Lag bounded by `flushMs`.
  * Patch and associative merges.
  * Batch restored after an injected commit failure.
  * `flushAllPending` and `close()`.
  * Appender ring cap.
* **`__boot`.** A clean close/reopen cycle, and a real **kill -9** of a child process: flushed XP survives, buffered XP is lost, and the next open reports `lastShutdownClean: false` with `dirtyBoots: 1`.
* **Buckets.**
  * Month routing.
  * One commit across months.
  * The merged query compared with a model: ascending, descending, paged in steps of 7 across month boundaries, the dupSort index, and `from`/`to`.
  * `dropExpired`, both after reopen and for months the process never opened.
  * The appender.
  * The daily 04:17 UTC job.

**Mutation checks.** Each of these was confirmed to fail its tests:

* removing the 60 s ceiling (6 failures),
* deleting jobs before their handlers run (8),
* concatenating months instead of merging them (2).

## Benchmarks (`bench/`)

> **These thresholds are for the TARGET, not for this machine.** The target is the Oracle
> VM.Standard.E2.1.Micro (EPYC 7551 Zen 1 at 2.0 GHz, burstable, 952 MB). Every number below was
> measured on the dev box: a **Ryzen 5 7535HS (Zen 3+) with btrfs (zstd:1) on NVMe**, Node 22.23.1,
> lmdb 3.5.6, kernel 7.1. A PASS here proves nothing about the box until `00-calibrate.mjs
> --save-target` has been run there; until then the projection factors are ASSUMED. The doc
> requires 03 to run with Lavalink playing, which is not possible here.

```
node bench/run.mjs --dir <dir on a REAL disk> [--scale 0.1] [--iterations 200] [--seconds 60] [--only 01,04] [--tag x]
                   -> bench/results-<date>[-tag].json + .md (the table)
node bench/00-calibrate.mjs --save-target   # once, ON THE TARGET: writes bench/target-host.json
```

Each `NN-*.mjs` runs on its own as well. It prints one JSON document on stdout and exits 1 if a
threshold fails.

**Never point `--dir` at tmpfs.** On tmpfs fsync costs nothing, the page cache cannot be evicted,
and an mmap counts as shmem rather than file-backed memory. The default is
`$SPBTDB_BENCH_DIR`, or `$TMPDIR/spbt-db-bench` when that is unset. The datasets never go into the repo.

| file | what it measures | method |
|---|---|---|
| `00-calibrate` | single-core CPU score (key encode, Buffer compare, msgpackr, JSON, sort), memcpy, sequential write, random 4 KiB sync writes, fdatasync, 1-row SPBT_DB commit | prints `factors` = how many times slower the target is. CPU ×2.4 is assumed: Zen1→Zen3 IPC ~1.37 × clock 4.4/2.55. Disk assumes a balanced 47 GB volume: 22.5 MB/s, ~2 ms fdatasync. |
| `01-write-throughput` | batched puts into `level` and into event_log-shaped buckets; dirty pages, bytes per commit and write amplification (WA); fsync/s at 50 msg/s | lmdb-js runs without writemap, so `/proc/self/io` `wchar` around a commit gives the exact bytes it wrote. fdatasync calls per commit are counted with `strace -c`. The 50 msg/s case uses the real `src/coalesce.js`. |
| `02-read-latency` | p50/p99/p999 for get + decode, index lookup, range(100); event-paced reads; cold reads | Cold = close, `dd iflag=nocache` (fadvise DONTNEED, no root needed), `fincore` = 0, then a fresh process. Each first touch is then a real major fault. |
| `03-rss-at-scale` | RSS split into anonymous and file-backed, resident MB per `.mdb` mapping, VmSwap, slope, bytes/record | Generated in a child (`--scale`), then a mix in a child started with `--max-old-space-size=200 --max-semi-space-size=8`. The page cache is evicted in between. `--hot-mapsize 0` and `--cold-readahead` reproduce the pre-r2 env settings: run.mjs runs both. |
| `04-crash-safety` | 200 × kill -9 at random moments; open, consistent prefix, index↔data, open time, the first durable commit after the crash; plus kill -9 during `dropCollection` | A deterministic txn sequence (70 % sync, 30 % `txnAsync`, 2 % overflow values) runs over 5 index kinds. Full contents are compared with a model after txns 1..L. A **negative control** injects corruption and requires the verifier to catch it. |
| `05-hotpaths` | `level.bump` ns/op (bigint and string ids), a 2 000-key coalescer flush (wall and main-thread time), on-disk bytes per sched row, the idle scheduler wake, firing 500 due jobs, and the main-thread cost of an event_log lagged-index catch-up | This folds in the scheduler agent's one-off `measure.mjs`. Everything is informational: the doc's §13 bench 05 is scheduler drift over months, which needs the target and libfaketime. |
| `08-compaction` | `dropCollection` of a month bucket; copy-compaction with `compactCopy` (in a child process), and in-process for comparison | Both run in a fresh process after page-cache eviction. The RSS peak comes from VmHWM after a `clear_refs` reset. |
| `09-multiprocess` | cross-process visibility; 2 processes × 10 000 `incr`; a writer killed while holding the write lock | Timestamps come from CLOCK_MONOTONIC. A non-atomic get+put control must lose updates, which shows the test is sensitive. |

### r2: the optimisation round (2026-10-14, full table: `bench/results-2026-10-14-nvme-r2.md`)

Same dev box, `bench/run.mjs --scale 0.1`. "A/B" means the r1 code (a copy of the pre-r2 `src/`) and the r2 code were measured alternately in one session, because run-to-run noise on this laptop is about ±10 %.

| # | item | r1 (before) | r2 (after) | threshold / verdict |
|---|---|---|---|---|
| 1 | `dropCollection` under kill -9: buckets left with index ≠ data | 1–3 of 60 kills | **0 of 60** (suite) + 0 of 200 + 0 of 60 standalone | == 0: **PASS** |
| 2 | 03 file-backed `.mdb` resident (scale 0.1) | 111 MB (r1 run); 97 MB with the pre-r2 env, same session | **41 MB** (hot 14, cold 27) | ≤ 53 MB: **PASS** |
| 2 | 03 RSS peak, Node + SPBT_DB | 228 MB; 214 MB with the pre-r2 env | **162 MB** | ≤ 270 MB: PASS |
| 3 | event_log WA, 80 channels, 512 / 250 rows per commit | 10.1× / 20.5× | **2.40× / 2.88×** | ≤ 1.6×: **FAIL**, ~5–7× better |
| 3 | event_log WA, single stream | 1.52× (data only) | 1.77× (data + 2 lagged indexes) | ≤ 1.6×: FAIL |
| 3 | event_log bytes per row on pages, indexes included | 368 B | **273 B** | (size) |
| 4 | range(100) `level.top` covered, p99 (bench 02) | 275 µs → 660 projected | **114 µs → 275** | ≤ 200 projected: FAIL (2.4× better) |
| 4 | range(100) event_log p50 / p99, A/B with the same key (`gid chan ts seq` prefix range) | 155 / 526–560 µs | **92 / 159–173 µs** | (A/B) |
| 4 | bare lmdb range(100) with values, A/B | 71 / 277 µs | **43 / 82–93 µs** | (A/B) |
| 4 | range(100) event_log as shipped: the latest 100 of a channel through the lagged index plus 100 primary gets (bench 02) | 453 µs p99 (contiguous range, old key) | 346 µs p99, 191 µs p50 → 830 / 460 projected | ≤ 200: **FAIL** |
| 5 | hot `level.get` p50, bench 02 | 1.03 µs (r1 run) | 1.20–1.28 µs (3 r2 runs) | ≤ 2 projected: **FAIL** (~3.0) |
| 5 | `level.get` p50, A/B on a 200k-row env | 1.26–1.34 µs | 1.16–1.30 µs | |
| 5 | layer cost above lmdb `getBinaryFast` (0.70–0.75 µs) | ~0.45 µs | ~0.2 µs | |
| 6 | RSS spike, drop of a 500k-row bucket | 8.57 MB → 83 projected | **1.2 MB → 8.8** | ≤ 40: **PASS** |
| 6 | RSS spike, copy-compaction (bot process) | 27.9 MB → 215 projected | **0.27 MB → 0.8** (the copy runs in a child: peak 97 MB, of which 70 MB is node + lmdb, ~290 MB projected, transient) | ≤ 40: **PASS** |
| 7 | open after kill -9, p50 / p99 | 4.7 / 1 688 ms | 5.0 / 1 690 ms; first durable commit p99 6.9 ms | ≤ 50: **FAIL**, host stall, see below |
| 8 | bench 05: bump, flush, sched bytes/row, idle wake, fire 500, catch-up | (one-off script) | 209 ns, 47 ms (13 ms main thread), 113 B, 4.4 µs, 11.9 ms, 39–59 ms | info |

**Item 4, what changed.** lmdb-js `getRange` with `encoding: 'binary'` copies every key and every value into a new, unpooled ArrayBuffer (`Uint8Array#slice`). In the profile that was ~60 % of a range and most of its GC. The changes:

* **Values.** The backend now opens each DBI with a pass-through `encoder`, so lmdb-js hands values over in its reusable buffer.
* **Keys.** Keys are pooled copies.
* **`backend.scan()`.** It feeds that straight into the decoders. The query loop builds no per-entry wrapper object and no generator step, and `iterate()` pages through `query()`.
* **Pinned fields.** Fields fixed by `where` are decoded once per query rather than once per row, which saves e.g. two BigInts per event_log row.

What remains is lmdb's own cursor step (~0.2 µs per entry) and msgpack decoding of ~190 B rows. That is the reason event_log ranges miss the 200 µs.

**Item 5, what changed.** The changes:

* **Generated key codecs.** Fixed-size tuples get straight-line generated encoders and decoders. Two u64 fields encode in 40–48 ns instead of 47–54 ns, and decode in 27 ns instead of 55 ns.
* **No rest-array allocation.** `get`/`has` take the key fields as arguments.
* **The floor.** It is lmdb-js's N-API `getBinaryFast` (the V8 fast path only loads for Node 16–18), plus cache and TLB misses on a 120 MB env: 0.70–0.75 µs. On the ×2.4 projection the 2 µs p50 is out of reach for any layer on top.
* **String parsing.** Decimal-string ids cost 44 ns each to parse. BigInt() and split parsing were both slower.

**Item 7, post-crash open time: a host stall, not SPBT_DB.**

* **The probe.** It killed the writer 400 times and timed each phase of the next open (scratchpad `openprobe.mjs`). It found 5 opens of more than 50 ms.
* **What the slow cases show.**
  * In 4 of the 5, the SIGKILLed writer itself took **1.3–3.3 s just to exit**: it was stuck in uninterruptible I/O.
  * The new process stalled 1.5–1.7 s in the lmdb env open itself (3 cases), or 1.0–1.7 s in the `__boot` commit (2 cases).
  * That `__boot` commit is no longer fsynced. A non-fsynced commit that blocks for 1.7 s is waiting for the kernel, not for LMDB.
* **The likely mechanism.** btrfs with zstd keeps pages stable during compressed writeback. A process that touches LMDB's meta pages (rewritten on every commit) while the dead writer's flush is still in flight waits for that flush.
* **The rest of the open is fast.** The first durable commit after a crash takes p99 6.9 ms.
* **What r2 changed.** The `__boot` write no longer fsyncs (`txnLazy`), so open never waits on a flush of its own. Nothing in `src/` can avoid the stall itself.
* **What has to happen next.** Measure on the target's ext4, where pages are not held stable during writeback unless the device demands it.

**Item 3, the read-side price.** The latest 100 of a channel now costs an index range plus 100 point gets: p50 ~190 µs. On the old key it was one contiguous range, p50 ~92 µs (A/B, same code). Panel log views are human-paced, and appends run all day.

### r1: results before the optimisation round (2026-10-14, scale 0.1 for 03/08, full table: `bench/results-2026-10-14-nvme.md`)

The table lists `local value → projected to target`, then the threshold. Ranges cover 4 full runs
plus standalone reruns.

* One run's 01 was disturbed by host I/O (10.5k put/s; a rerun gave 32.8k) and is excluded.
* `results-2026-10-14-tmpfs.*` is the same suite on the tmpfs scratchpad at scale 0.03. Use it for
  comparison only: no fsync, no eviction, and the mmap is shmem.

| | measured | threshold | verdict |
|---|---|---|---|
| level put/s, batch 1000, with index | 30.7k–32.8k → ~19k | ≥ 15 000 | PASS |
| event_log put/s, batch 512 | 67k–74k → ~40k | ≥ 15 000 | PASS |
| WA, single-stream append | 1.52× | ≤ 1.6× | PASS |
| WA, event_log with 80 active channels, 512 rows/commit | **10.1×** (121 dirty 8 KiB pages per commit) | ≤ 1.6× | **FAIL** |
| WA, same, 250 rows/commit (50 msg/s × 5 s) | **20.5×** | ≤ 1.6× | **FAIL** |
| dirty pages per 2 000-incr `level` flush, 500 guilds | **2 606** (10.7 MB written) | §7.2 says ~300 | doc estimate off by ~9× |
| fsync/s at 50 msg/s (`src/coalesce.js`) | 0.26 (1 fdatasync + 1 O_DSYNC meta write per commit) | ≤ 4 | PASS |
| hot `level.get` p50 / p99 | 1.15 µs → 2.8 / 1.9 µs → 4.6 | ≤ 2 / ≤ 10 µs | **FAIL** (p50, projected) / PASS |
| hot `user.get` p50 / p99 | 1.35 µs → 3.2 / 2.3 µs → 5.6 | ≤ 2 / ≤ 10 µs | **FAIL** (p50, projected) / PASS |
| `feature_config.get` (700 B, deflate) p50 | 9.5 µs | (configLRU is meant to cover it) | info |
| range(100) event_log p99 | **419–533 µs** → 1.0–1.3 ms; bare lmdb `getRange` alone 244 µs | ≤ 200 µs | **FAIL** |
| range(100) `level.top` covered p99 | **259–313 µs** → 620–750 µs | ≤ 200 µs | **FAIL** |
| first get after a 20 ms idle event turn p50 | **32–55 µs** | (no threshold) | info |
| cold get (page cache evicted, NVMe) p99 | 194–215 µs | §6.5 assumes 400–600 µs on the target | info |
| RSS / anonymous, Node + SPBT_DB only | 232 / 70 MB | ≤ 270 / ≤ 200 | PASS |
| .mdb resident, as shipped | **114 MB** (cold.mdb 93–95) | ≤ 53 MB | **FAIL** |
| .mdb resident, hot `mapSize` 2 GiB + cold `noReadAhead` | 33–34 MB | ≤ 53 MB | PASS |
| crash: corrupt iterations / lost committed txns | **0 / 0** in 1 400 kills on NVMe (~38 000 txns) + 100 on tmpfs (~29 500 txns) | 0 / ≤ 1 | PASS |
| crash: open time p50 / p99 | 4.7 ms / 10–17 ms in 4 runs; **1.4–1.7 s** in 3 of 5 full-suite runs | ≤ 50 ms | **FAIL** (tail, see point 1) |
| crash: kill -9 during `dropCollection` of an indexed collection | **1–3 of 60 kills** leave rows with no index | 0 | **FAIL** (bug, see below) |
| drop 500k-row bucket (cold cache) | 68–77 ms → ~1.8 s at 5M | ≤ 2 s | PASS (barely) |
| RSS spike during drop | 8.6 MB → ~83 MB at 5M (file-backed) | ≤ +40 MB | **FAIL** |
| copy-compaction | 52 MB → 26 MB in 0.6 s; target ≥ 18.7 s for 420 MB (writes only) | ≤ 30 s | PASS (lower bound) |
| RSS spike during copy-compaction | 27.5 MB → ~215 MB at 420 MB (file-backed) | ≤ +40 MB | **FAIL** |
| cross-process visibility p99 | 1.06 ms | ≤ 600 ms | PASS |
| lost increments, 2 processes × 10 000 | 0 (control: 649 of 2 000 lost) | 0 | PASS |
| writer kill -9 while holding the write lock | the next writer gets the lock in 10.5 ms; killed txn invisible; reader stall ≤ 1.6 ms | not hung | PASS |

### What the r1 numbers said (before r2)

The claims split into three groups:

* **Holds:** crash safety of the txn path, small on disk, and writes are cheap per fsync.
* **Does not hold as written:** "ULTRA-FAST" for ranges, and the write-amplification and RSS estimates.

1. **Crash safety is real for transactions.** Across 1 500 kills during ~67 000 transactions there was 0 corruption, 0 lost commits and 0 index↔data mismatches. The negative control shows the checker would have caught one.
   * The exception is `dropCollection`, which is **not atomic**. See the bug below.
   * **There is an unexplained open-time tail.** In 3 of 5 full-suite runs, 1–4 of 200 post-kill opens took 1.1–1.9 s.
     * The lmdb env open itself takes 1.4 ms. It is the **first write txn** (the `__boot` commit from `boot.js`) that blocks.
     * An fdatasync probe on a small file taken at that moment costs 1–2 ms.
     * Standalone (`scratchpad` repro, 300 kills), 2 hits came back to back: the killed child had not managed to commit in its 0–400 ms either, so the writers stalled across processes.
     * It does not reproduce on tmpfs (100 iterations) or under strace (300 kills).
     * Suspects: a btrfs fdatasync stall on the aged `hot.mdb`, or an lmdb-js lock-recovery path.
     * It needs a run on the target's ext4 before anything is concluded. Until then the ≤ 50 ms open is **not proven**.
2. **Point reads are fast, but not ~1 µs per messageCreate.**
   * Back-to-back hot gets cost 1.2–1.4 µs, which projects to ~3 µs on Zen 1. The 2 µs p50 target is missed on the projection.
   * A handler that wakes up every 20 ms pays **30–55 µs for its first DB read**. Behind that are the read-txn renewal after an event turn and cold CPU caches; even a JS `Map.get` costs 3.6 µs after idle.
   * The per-message read cost is therefore ~60–100 µs on this box, not the "4–8 µs" of §7.2. That is still well under v26's 300–800 µs, but it is ~5×, not ~100×.
3. **Ranges miss the 200 µs p99** on this box even before the ×2.4.
   * lmdb-js `getRange` alone costs 244 µs p99 for 100 entries; it copies every key and value, which brings GC.
   * SPBT_DB's decode (msgpack plus BigInt keys) doubles that.
   * Fix options: decode lazily, keep u64s as strings or numbers in covered scans, and pass `limit` to the backend range.
4. **Write amplification for event_log is ~10–20×, not ~1.5×.** Only a single append stream reaches 1.5×.
   * 80 active channels means about 80–120 dirty leaves per commit, whatever the batch size (§7.1 predicts exactly this).
   * Bigger, rarer flushes help (512 → 10×, 250 → 20×). So does a key that puts `ts` before `chan`, at the cost of per-channel range scans.
   * fsync/s remains far inside budget (0.26/s), and 1 MB per commit is fine for a 22 MB/s volume, so this is a disk-bytes concern, not a latency one.
5. **The RSS budget holds only with two config changes.** Neither change is in `src/`; both are proposals.
   * **hot `mapSize`:** lmdb-js grows the map and keeps the old, smaller mappings alive, so the same pages count in RSS 2–3 times (8 mappings and 44 MB "resident" for a 26 MB file). A fixed `mapSize` (virtual only) gives one mapping.
   * **cold `noReadAhead`:** §4.5 says readahead helps cold. Measured with panel log views plus appends to 400 channels, it makes cold.mdb resident 49–95 MB instead of ~20 MB.
   * Anonymous memory (70 MB including the Node floor) is well within budget.
6. **Small on disk:**

   | collection | B/record on pages | §5 logical estimate |
   |---|---|---|
   | level (with level_by_xp) | 44 (71) | 6 |
   | user (with 2 indexes) | 107 (135) | 60 |
   | event_log | 341 | 200 (167 B mean frame here) |
   | mod_case (with 3 indexes) | 106 (214) | 150 |
   | feature_config | 770 | 700 |

   * Interleaved appends leave event_log pages about 60 % full: space amplification is 1.61×, against the doc's 1.35×.
   * Copy-compaction halves a 40 %-deleted env.
7. **Host artefact to know about:** on kernel 7.x with btrfs, freshly written file data sits in large folios, and one read fault maps the whole folio. Without evicting the page cache this inflated mapped RSS 4–5×. 03 therefore evicts before the mix.

### The r1 bug, fixed in r2

`dropCollection` was not crash-atomic: each index DBI, the data DBI and the meta key were dropped in separate commits, and 1–3 of 60 kill -9s left "N rows, 0 index entries". It is now one write txn (core deviation 13), and `node bench/04-crash-safety.mjs --iterations 0 --drop-kills 60` reports 0.

### Decisions for the owner

1. **Cold page size: 4 KiB instead of 8 KiB.** The page size can only be set while `cold.mdb` does not exist, which is now.
   * Measured with bench 01 before `elog_by_msg` was filtered: event_log WA 2.91× instead of 3.28× at 512 rows per commit, and 3.18× instead of 3.77× at 250.
   * Bytes per row on pages went up 3 %.
   * It would make cold's `noReadAhead` the setting lmdb-js recommends.
   * The cost is twice the branch pages for the same rows: §6.1 puts event_log at 5.7 MB at 8 KiB.
2. **The event_log lag: 8 192 (shipped) or 16 384.** At 16 384 the WA is 2.15× instead of 2.40×, but the once-per-lag catch-up stalls the main thread ~95 ms instead of 39–59 ms, and the read cache doubles to ~2 MB per index.
3. **The 1.6× WA threshold for event_log.** Without a per-channel structure the floor is 1.52× for data alone, which passes. With any per-channel order kept on a COW B+tree, the cost is at least (active channels × 1 page) per maintenance step.
   * Option A: accept ~2.4–2.9× as shipped (reads ~2× slower than the r1 key).
   * Option B: drop `elog_by_chan` and read channel logs by time scans.
   * Option C: go back to the r1 key and accept 10–20×.
4. **byMessageId relies on `ts = message.createdTimestamp` for k=0 rows.** A row logged with another `ts` still works, because the `elog_by_msg` filter sends it into the index. It just costs an index entry.
5. **The ×2.4 projections for get p50, range(100) and open time.** They are assumptions until `00-calibrate.mjs --save-target` and the suite run on the EPYC box with ext4. The open-time tail especially is a btrfs host effect and has to be re-measured there.

### Not measured here, and why

* **Anything on the target box,** including Lavalink running alongside (03, 10, 12, 13). There is no access to it, and the factors are assumptions.
* **Power loss (dm-flakey in 04).** That needs root and device-mapper. kill -9 only proves process-crash safety; the page cache survives it.
* **Memory pressure and the §6.5 degradation curve (bench 12).** There is no cgroup or `memory.max` without root. On this 15 GB box residency is trivially 100 %.
* **`mincore()` of the whole page cache.** Node has no binding. Per-mapping RSS from `/proc/self/smaps` and `fincore` are used instead.
* **The 30 min mix and the 15 min RSS slope.** Runs here are 60 s, where the slope is still warm-up, so it is informational.
* **05 scheduler drift, 06 vectors, 07 blobs and 10–14** belong to other agents or need the target.
* **Lease takeover (09).** There is no lease implementation in `src/` yet.
* **Datasets at full §13 scale** for 03 and 08: the defaults are scale 0.1. `--scale 1` works (about 1.5 GB of disk) but was not run here.

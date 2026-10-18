# SPBT_DB

[Українською](README.uk.md)

SPBT_DB is an embedded database for one kind of program: a Node.js bot or small service that runs
as one process on a small VPS and has outgrown its JSON files. It runs inside your process, keeps
the data in LMDB files through [lmdb-js](https://github.com/kriszyp/lmdb-js), and adds only what
such a program needs: typed keys, indexes, expiry, a scheduler that survives restarts, and buffered
writes for counters that change on every message. It was written for the TANO Discord bot, whose
server has 1 GB of RAM.

## What it is not

Each of these is left out on purpose. Every feature costs code, memory and something to operate,
and the program SPBT_DB is for does not need them.

* **Not a server.** No port, no daemon, no connection string. It is a library and lives in your
  process.
* **No query language.** No SQL, joins, aggregations or ad-hoc filters. You read by key and by the
  indexes you declared in the schema.
* **No admin UI or shell.** You look at the data from your own code; `db.stats()` reports sizes
  and page counts.
* **No migration tool.** Records carry a schema id, and your `migrate` functions upgrade old
  records when they are read. There is no bulk migrate command.
* **One writer at a time.** LMDB serialises writes. Several processes on one machine can share the
  files; several machines cannot.
* **No replication and no point-in-time recovery.** `compactCopy` writes a consistent copy of a
  live database; where the copy goes is up to you.
* **No browser, edge or serverless runtime.** It needs lmdb's native module.

If you need any of that, use SQLite (`node:sqlite`, `better-sqlite3`) or Postgres. If your data is
a few kilobytes that rarely change, a JSON file written to a temp file and renamed into place is
simpler and fast enough.

What is left is small:

* about 3 700 lines of JavaScript (comments excluded), two dependencies (`lmdb`, `msgpackr`) and a
  93 KB package;
* small records: one member's XP takes 43 B on disk, B+tree pages included;
* records are read from the memory-mapped file on demand, not loaded into the JS heap, and the
  kernel can drop those pages under memory pressure. From 10k to 100k users the bot-like
  process's anonymous memory stayed at 49–53 MB, while the JSON version's grew from 23–24 MB to
  82–84 MB.

The fixed costs: loading the lmdb native module adds about 18 MB of RSS, and its prebuild is 15 MB
of the 20 MB installed.

## Numbers

Measured on an AMD Ryzen 5 7535HS laptop (Zen 3+), Linux 7.1, btrfs (zstd) on NVMe, Node
22.23.1, warm page cache. The comparison is against TANO v26's storage code, run unchanged
(`bench/v26-stores.mjs`). Full tables: [`bench/results-2026-10-14-json-vs-spbtdb.md`](bench/results-2026-10-14-json-vs-spbtdb.md).

| | v26 JSON files | SPBT_DB | |
|---|---:|---:|---|
| read one user, 100k users | 50 ms | 0.8 µs | v26 parses an 8 MB file on every read |
| read one user, 1k users | 367 µs | 0.6 µs | |
| top-10 leaderboard, guild of 100k members | 64.5 ms | 6.5 µs | v26 had no leaderboard; this is a sort of its in-RAM XP map |
| messageCreate XP path (feature flag, level settings, XP bump) | 18 µs | 3.4 µs | 5× |
| per-guild config read (4.4 KB of JSON) | 29 µs | 13 µs | 2× |
| change one user's plan, 100k users | 116 ms | 3.8 ms | SPBT_DB includes an fsync; v26 never fsyncs |
| change one user's plan, 1k users | **1.2 ms** | 2.9 ms | **v26 is faster**: rewriting a 100 KB file costs less than an fsync |
| append one audit-log row | **0.32 ms** | 3.0 ms | **v26 is faster** per row; through the appender SPBT_DB takes 0.5 µs per row |
| kill -9 while writing, 100 kills | file emptied 2–11 times (10k users), 0–8 times (100k) | 0 corrupt, 0 lost commits | in each of two runs; an emptied file means v26 starts with no users |
| RSS with 1k / 100k users | 64 / 129–131 MB | 86 / 122–126 MB | **SPBT_DB uses more RAM on small data**: loading lmdb costs 18 MB |
| package / installed size | – | 93 KB / 20 MB | the lmdb native prebuild is 15 MB of the 20 |

Reads that v26 answered by parsing a whole file are 35× to 55 000× faster, and the gap grows with
the data. The per-message hot path is about 5× faster, config reads 2×. Single durable writes are
slower than v26's unsafe rewrites while the files are small, and the process uses 20–35 MB more
RAM until the data grows. None of it has been measured on the production server yet.

## Quick start

SPBT_DB is not on the npm registry yet. Install it from GitHub:

```sh
npm install github:DanyloKob/SPBT_DB    # Node 22 or newer
```

```js
import { open } from 'spbt-db';

const db = open({ dir: './data' });            // creates data/hot.mdb; { backend: 'memory' } for tests

// the core collections are opened for you: guild, guild_feature, feature_config, user, news, level, kv
db.level.put({ gid: '1100000000000000001', uid: '300000000000000001', xp: 120 }); // ids: string, bigint or number
db.level.get('1100000000000000001', '300000000000000001');      // -> { xp: 120 }
db.level.top('1100000000000000001', 10);                         // -> [{ gid, uid, xp }], from an index

// your own collection, with an index
const tickets = db.collection('ticket', {
  key: 'gid:u64 no:u32',
  indexes: { ticket_by_user: { key: 'gid:u64 uid:u64 no:u32' } },
});
db.txn(() => {                                  // atomic; committed when it returns
  tickets.put({ gid: 1n, no: 7, uid: 42n, subject: 'refund' });
  db.kv.put({ k: 'ticket_counter:1', n: 7 });
});
tickets.query({ index: 'ticket_by_user', where: [1n, 42n] }).items;

await db.close();                               // flushes buffers, marks the shutdown clean
```

`examples/` has three runnable programs: XP and a leaderboard (`xp-leaderboard.mjs`), temporary
bans with the scheduler (`tempban-scheduler.mjs`) and sessions with a TTL (`ttl-sessions.mjs`).

## Concepts

**Environments.** Data lives in up to two LMDB files: `hot.mdb` (4 KiB pages) for small records
read on every event, and `cold.mdb` (8 KiB pages, opened on first use) for logs. A transaction
never spans both.

**Collections and keys.** A collection is a schema with a key: `'gid:u64 uid:u64'`. Keys are
encoded big-endian and fixed-width, so byte order equals logical order and every range query is a
B+tree range. Types: `u8 u16 u24 u32 u48 u64 u64s inv32 inv48 str bN`. `u64` takes Discord ids as
a bigint, a decimal string or a safe integer, and decodes to a bigint (`u64s` decodes to a string).
`inv32`/`inv48` store `max - n`, which gives descending order (the leaderboard uses it).

**Records.** The stored value never repeats the key. It is a small header (optional schema id,
update time, expiry) and a payload in one of three codecs: msgpack with structures shared per
collection, varint (`level` stores XP in 2–6 bytes), or raw bytes. msgpack payloads of 512 B or
more are deflated when that makes them smaller. `schemaId` and `migrate` upgrade old records on
read.

**Indexes.** Declared in the schema and written in the same transaction as the record. `unique`,
`filter` (sparse) and `covered` queries (answered from the index alone) are supported. A `lag: n`
index writes its entries once per `n` rows instead of in every transaction, for append-only data
with a time-ordered key; reads merge the unwritten tail from RAM.

**Transactions.** `db.txn(fn)` is synchronous and atomic, and a nested call is a savepoint.
`db.txnAsync(fn)` runs the commit and the fsync off the main thread. LMDB has one writer at a
time, so read-modify-write (`incr`, `patch`) is atomic even across processes.

**TTL.** The expiry is part of the record: a read after it returns `undefined` immediately. A
sweeper only frees the space, by a bounded daily scan (default) or by one scheduler job per record.

**Scheduler.** `db.sched.at(when, { kind, gid, subject, payload })` writes a job row keyed by due
time; inside your transaction, the ban and its unban commit together. One timer per process,
never longer than 60 s. Delivery is at-least-once, with retries and backoff, three catch-up
policies for jobs that came due while the process was down, and cancel by `(gid, kind, subject)`
through an index.

**Coalescers.** Hot writes are buffered in RAM and committed in one transaction: `db.level.bump()`
adds XP in about 0.2 µs and the buffer is written every 30 s or 2 000 members. A kill -9 loses at
most that window, and the next start can tell (`db.bootInfo().lastShutdownClean`). An entry that
cannot be written is dropped on its own instead of blocking the batch.

**Time buckets.** `db.bucketed('event_log', schema, { retentionDays: 30 })` stores each UTC month in
its own collection. Queries merge the months; retention drops whole months in one transaction.

**Vectors and blobs** (optional). `attachVectors(db)` from `spbt-db/vector` adds int8 vectors per
guild, scanned exactly with a small WebAssembly SIMD kernel: k-NN over 5 000 vectors takes about
0.1–0.2 ms here. `attachBlobs(db, { dir })` from `spbt-db/blobs` stores files by content hash with
reference counts in the database, keeps blobs under 1 KB inline, and garbage-collects after a grace
period.

**Backends.** Everything above talks to a seven-method `Backend` interface. `lmdb` is the real one;
`memory` is for tests. `test/backend-conformance.test.js` checks both against the same contract.

The design, the deviations from it and every measurement round are in
[`docs/engineering-notes.md`](docs/engineering-notes.md).

## Guarantees

* **Atomic transactions.** A `db.txn()` either commits whole or leaves nothing behind. When it
  returns, the commit is visible to every reader, in this process and in others.
* **Process crashes do not corrupt the database.** In this repository's crash test a writer was
  killed with SIGKILL 100 times in each of two recorded runs while committing transactions of up
  to 200 users: every reopen succeeded, no acknowledged commit was missing, no transaction was half
  applied, and every index matched its data. The suite from TANO v27 (`bench/04-crash-safety.mjs`)
  killed writers about 1 500 times during some 67 000 transactions with the same result, and its
  checker was shown to catch injected corruption.
* **Power loss is not tested.** kill -9 keeps the page cache. Each commit here costs about 3 ms,
  which is an fsync; `await db.flushed()` resolves once the OS reports every commit flushed.
* **Coalesced writes** are durable after their flush. A crash loses at most `flushMs` of them (30 s
  of XP, 5 s of logs) and the next open reports `lastShutdownClean: false`.
* **Several processes** can open the same files. Readers see a commit within about 1 ms, and a
  writer killed while holding the write lock does not block the next one.

## Limits

* **Not measured on the production server yet.** The bot runs on an Oracle Cloud
  VM.Standard.E2.1.Micro (AMD EPYC 7551, Zen 1, 2 GHz burstable, 952 MB RAM, ext4). Every number
  here comes from a laptop several times faster per core, with a different file system. Until the
  benchmarks run there, the projections below are assumptions.
* **Targets that still fail**, from the last full suite run (`bench/results-2026-10-14-nvme-r2.md`)
  and the 2026-10-18 page-size runs (`bench/results-2026-10-18-cold-pagesize.md`):

  | check | target | measured here | projected for the server |
  |---|---|---|---|
  | hot `level.get` / `user.get` p50 | ≤ 2 µs | 1.25 / 1.40 µs | ~3.0 / ~3.4 µs |
  | latest 100 rows of a channel's log, p99 | ≤ 200 µs | 346 µs | ~830 µs |
  | leaderboard range of 100, p99 | ≤ 200 µs | 114 µs | ~275 µs |
  | `.mdb` pages resident under a mixed load | ≤ 53 MB | 41 MB at 0.1 of full data size; 63–66 MB at 0.3 | higher at full size; the kernel can drop these pages, but the server's budget counts them |
  | open after kill -9, p99 | ≤ 50 ms | 1.69 s in the suite (200 kills); 23–27 ms in the two JSON-comparison runs (100 kills each), with one 1.6 s outlier | most likely btrfs writeback stalls (see the notes); unmeasured on ext4 |

  The projection multiplies by an assumed 2.4× for the slower CPU; `bench/00-calibrate.mjs
  --save-target` replaces the assumption once it runs on the server.

  The event log missed the design's 1.6× write-amplification target and now has its own. A plain
  append stream still has to stay under 1.6×, and reaches 1.50× on its data alone. The log, with its
  channel and message indexes and 80 active channels, writes 2.4× at 512 rows per commit and 2.9×
  at 250, against new limits of 3.0× and 3.5×. Any layout that keeps a per-channel order costs
  more. At the design peak of 50 messages a second that is 23–28 KB/s written (see the
  engineering notes).

* **One writer at a time.** Every durable commit waits for the disk, about 3 ms here, so a single
  writer manages about 300 durable commits per second. Batch writes in one `db.txn()` (100 user
  updates per transaction gave 8 000–22 000 per second) or use a coalescer.
* **Small writes are not small.** A copy-on-write B+tree rewrites whole pages: one durable update
  of one user writes 32–57 KB (data, two indexes, the free list, the meta page). With the default
  30 s flush, one XP update writes 74 B to 3.6 KB depending on how many members there are, 3–6×
  what v26's 2-minute file rewrite wrote; at the same 2-minute interval they are about equal.
* **More RAM on small data.** With 1 000 users the bot-like process used 86 MB against v26's
  64 MB. Loading the library is most of that: a bare Node process takes 53 MB, and importing
  SPBT_DB brings it to 71 MB before any data is opened. The gap closes at 100 000 users (122–126
  against 129–131 MB). Part of SPBT_DB's figure is mapped database pages, which the kernel can
  drop under memory pressure; v26's is all heap.
* **Values over about 2 KB take whole pages.** LMDB moves a value that does not fit half a page
  into overflow pages, so a 2 KB news post costs 4.1 KB on disk. Keep hot records small, or split
  them.
* **Linux x64 only, so far.** lmdb-js ships builds for macOS and Windows; nobody has run these
  tests there.
* **0.1.0, one user.** It was written for the TANO bot and has not yet run on that bot's
  production server. The blob store's put/gc lock works inside one process only.

## Benchmarks

```sh
npm run bench:json -- --dir ~/.cache/spbtdb-bench   # v26 JSON files vs SPBT_DB (about 8 minutes)
npm run bench:size                                   # lines of code, package size, RAM, bytes per record
npm run bench:suite -- --dir ~/.cache/spbtdb-bench  # the full suite from TANO v27 (bench/run.mjs)
npm run bench                                        # a quick get/put micro-benchmark (bench/quick.mjs)
```

Point `--dir` at a real disk. On tmpfs an fsync costs nothing and the numbers mean nothing.

**JSON vs SPBT_DB** (`bench/json-vs-spbtdb.mjs`). Each store and size runs in its own process. The
v26 side is the v26 code: every read is `readFileSync` + `JSON.parse` of the whole file, every write
is `writeFileSync` of the whole file, pretty-printed, with no fsync. The SPBT_DB side does what the
new bot does for the same event. Results: [`bench/results-2026-10-14-json-vs-spbtdb.md`](bench/results-2026-10-14-json-vs-spbtdb.md),
and a second run, [`-run2`](bench/results-2026-10-14-json-vs-spbtdb-run2.md), which agreed within
12 % on every throughput figure.

| scenario | users | v26 JSON | SPBT_DB | ratio |
|---|---:|---:|---:|---:|
| read one user | 1k / 10k / 100k | 2.6k / 238 / 19.8 ops/s | 1.30M / 1.27M / 1.10M ops/s | 494× / 5 346× / 55 599× |
| change one user's plan | 1k / 10k / 100k | 833 / 98 / 8.4 ops/s | 334 / 318 / 258 ops/s | **0.4×** / 3.2× / 31× |
| messageCreate XP path | 1k / 10k / 100k | 53k / 53k / 52k ops/s | 282k / 278k / 242k ops/s | 5.3× / 5.2× / 4.7× |
| per-guild config read | any | 33k ops/s | 67k–75k ops/s | 2.0–2.2× |
| audit-log append, durable | any | 3.0k ops/s | 316–323 ops/s | **0.1×** |
| audit-log append, through the appender | any | 3.0k ops/s | 66k–69k ops/s | 22× |
| audit-log view, latest 50 | any | 9.8k ops/s | 26k–27k ops/s | 2.6× |
| top-10 leaderboard | 1k / 10k / 100k | 3.9k / 241 / 14.6 ops/s | 138k / 132k / 134k ops/s | 35× / 548× / 9 184× |

**Size** (`bench/size-facts.mjs`, [`bench/results-2026-10-14-size-facts.md`](bench/results-2026-10-14-size-facts.md)):
3 718 lines of code in `src/` (5 445 with comments and blank lines), 2 820 in `test/`; a 93 KB
package; 20 MB installed, 14.9 MB of it the lmdb native prebuild for linux-x64. A bare Node
process takes 53 MB RSS; importing SPBT_DB and opening an empty database takes it to 72 MB.

Bytes per record on disk, inserted in random key order, B+tree pages included:

| collection | value | on disk | with its indexes |
|---|---:|---:|---:|
| `level` (XP per member) | 3 B | 43 B | 87 B (`level_by_xp`) |
| `guild_feature` | 8 B | 41 B | 70 B (`feature_enabled`) |
| `kv` | 7 B | 50 B | – |
| `user` | 52 B | 105 B | 139 B (`user_by_plan`, `user_by_expiry`) |
| `sched` (a job) | 39 B | 87 B | 136 B (`sched_by_subject`) |
| `guild` | 102 B | 179 B | – |
| `feature_config`, 0.5 KB of JSON | 223 B | 379 B | – |
| `feature_config`, 4.4 KB of JSON (deflated) | 399 B | 682 B | – |
| `event_log` row, cold env (time order) | 245 B | 485 B | 536 B (two lagged indexes) |
| `news` post, 2 KB | 2 054 B | 4 137 B | – |

## Where it comes from

TANO is a Discord bot with a web panel, run as one Node.js process on a small cloud VM. Up to v26
it kept everything in JSON files: about 8–12 synchronous file reads for every message, and a
whole-file rewrite, with no rename and no fsync, for every change. A crash in the middle of a write
could empty a file, and the bot then started with no data for it. For v27 the storage was
redesigned around the server's real limits (1 GB of RAM, already swapping, a slow burstable CPU),
and this database was written to that design. Inside the bot it was called TanoDB. SPBT_DB is the
same code, published on its own after a review that fixed 11 correctness bugs (see
[CHANGELOG.md](CHANGELOG.md)).

## License

[MIT](LICENSE) © 2026 DanyloKob

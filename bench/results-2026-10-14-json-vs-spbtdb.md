# v26 JSON files vs SPBT_DB (2026-10-14)

Machine: AMD Ryzen 5 7535HS with Radeon Graphics, 12 threads, 15277 MB RAM, Node v22.23.1, lmdb 3.5.6, Linux 7.1.5-201.fc44.x86_64. Data on btrfs (relatime,compress=zstd:1,ssd,discard=async) on /dev/nvme0n1p3. Warm page cache for both stores. 2 s per scenario. Each (store, size) ran in its own process.

`bench/json-vs-spbtdb.mjs` produced this file. The v26 side is the v26 code (`bench/v26-stores.mjs`); it never fsyncs, so its writes are not durable. Every SPBT_DB write below is a durable commit (fsync) unless the row says coalesced.

## Throughput and latency

| scenario | N users | v26 JSON ops/s | SPBT_DB ops/s | SPBT_DB / JSON | JSON p50 / p99 | SPBT_DB p50 / p99 |
|---|---:|---:|---:|---:|---|---|
| read one user (v26 `users.get`) | 1.0k | 2.6k | 1.30M | **494×** | 367 µs / 592 µs | 0.6 µs / 1.3 µs |
| read one user (v26 `users.get`) | 10k | 238 | 1.27M | **5346×** | 4.1 ms / 4.5 ms | 0.7 µs / 1.1 µs |
| read one user (v26 `users.get`) | 100k | 19.8 | 1.10M | **55599×** | 50.1 ms / 53.6 ms | 0.8 µs / 1.4 µs |
| change one user's plan (v26 `users.set`) | 1.0k | 833 | 334 | **0.4×** | 1.2 ms / 1.8 ms | 2.9 ms / 3.8 ms |
| change one user's plan (v26 `users.set`) | 10k | 98.0 | 318 | **3.2×** | 9.9 ms / 12.9 ms | 3.1 ms / 3.9 ms |
| change one user's plan (v26 `users.set`) | 100k | 8.40 | 258 | **31×** | 116 ms / 120 ms | 3.8 ms / 4.9 ms |
| messageCreate XP path: feature flag + levels config + XP bump | 1.0k | 53k | 282k | **5.3×** | 18 µs / 31 µs | 3.3 µs / 7.0 µs |
| messageCreate XP path: feature flag + levels config + XP bump | 10k | 53k | 278k | **5.2×** | 18 µs / 25 µs | 3.4 µs / 7.2 µs |
| messageCreate XP path: feature flag + levels config + XP bump | 100k | 52k | 242k | **4.7×** | 19 µs / 27 µs | 3.8 µs / 7.9 µs |
| per-guild moderation config read (4.4 KB JSON) | 1.0k | 33k | 69k | **2.1×** | 29 µs / 52 µs | 13 µs / 29 µs |
| per-guild moderation config read (4.4 KB JSON) | 10k | 33k | 67k | **2.0×** | 29 µs / 41 µs | 13 µs / 29 µs |
| per-guild moderation config read (4.4 KB JSON) | 100k | 33k | 75k | **2.2×** | 29 µs / 36 µs | 12 µs / 24 µs |
| audit-log append (v26 `appendLog`), SPBT_DB write-through | 1.0k | 3.0k | 322 | **0.1×** | 322 µs / 528 µs | 3.0 ms / 4.1 ms |
| audit-log append (v26 `appendLog`), SPBT_DB write-through | 10k | 3.0k | 323 | **0.1×** | 320 µs / 523 µs | 3.0 ms / 3.6 ms |
| audit-log append (v26 `appendLog`), SPBT_DB write-through | 100k | 2.9k | 316 | **0.1×** | 321 µs / 639 µs | 3.1 ms / 3.9 ms |
| audit-log view: latest 50 entries of a guild | 1.0k | 10k | 27k | **2.6×** | 96 µs / 178 µs | 34 µs / 69 µs |
| audit-log view: latest 50 entries of a guild | 10k | 9.8k | 26k | **2.6×** | 100 µs / 174 µs | 36 µs / 69 µs |
| audit-log view: latest 50 entries of a guild | 100k | 9.8k | 27k | **2.7×** | 99 µs / 121 µs | 34 µs / 68 µs |
| top-10 leaderboard of a guild with N members | 1.0k | 3.9k | 138k | **35×** | 248 µs / 438 µs | 6.3 µs / 12 µs |
| top-10 leaderboard of a guild with N members | 10k | 241 | 132k | **548×** | 4.0 ms / 5.4 ms | 6.6 µs / 12 µs |
| top-10 leaderboard of a guild with N members | 100k | 14.6 | 134k | **9184×** | 64.5 ms / 109 ms | 6.5 µs / 12 µs |

Extra SPBT_DB rows (no v26 equivalent):

| scenario | N users | ops/s | p50 / p99 |
|---|---:|---:|---|
| user.set, 100 per txn (durable) | 1.0k | 22k | 4.5 ms / 5.3 ms per txn |
| audit.append through the appender (one commit per 512 rows) | 1.0k | 69k | 0.5 µs / 2.9 µs |
| user.set, 100 per txn (durable) | 10k | 12k | 8.3 ms / 13.3 ms per txn |
| audit.append through the appender (one commit per 512 rows) | 10k | 67k | 0.5 µs / 1.2 µs |
| user.set, 100 per txn (durable) | 100k | 8.2k | 12.0 ms / 16.0 ms per txn |
| audit.append through the appender (one commit per 512 rows) | 100k | 66k | 0.5 µs / 1.2 µs |

## Bytes written to disk per update

Bytes handed to write()/pwrite() (`/proc/self/io` wchar), divided by updates. For SPBT_DB this is whole 4 KiB B+tree pages (data, indexes, the meta page). btrfs compression is applied after this point.

| update | N users | v26 JSON | SPBT_DB |
|---|---:|---:|---:|
| user.set (one per commit) | 1.0k | 97.9 KB | 32.2 KB |
| user.set, 100 per txn | 1.0k | – | 1.4 KB |
| XP update, v26 2-min flush vs SPBT_DB 30 s flush (50 msg/s) | 1.0k | 13 B | 74 B |
| XP update, both flushed every 2 min | 1.0k | 13 B | 19 B |
| audit-log append (write-through) | 1.0k | 29.8 KB | 32.6 KB |
| audit-log append (SPBT_DB appender, 512 rows per commit) | 1.0k | 29.8 KB | 997 B |
| user.set (one per commit) | 10k | 785.1 KB | 35.4 KB |
| user.set, 100 per txn | 10k | – | 6.8 KB |
| XP update, v26 2-min flush vs SPBT_DB 30 s flush (50 msg/s) | 10k | 126 B | 519 B |
| XP update, both flushed every 2 min | 10k | 126 B | 130 B |
| audit-log append (write-through) | 10k | 29.8 KB | 32.6 KB |
| audit-log append (SPBT_DB appender, 512 rows per commit) | 10k | 29.8 KB | 1006 B |
| user.set (one per commit) | 100k | 7.6 MB | 57.2 KB |
| user.set, 100 per txn | 100k | – | 10.3 KB |
| XP update, v26 2-min flush vs SPBT_DB 30 s flush (50 msg/s) | 100k | 1.2 KB | 3.6 KB |
| XP update, both flushed every 2 min | 100k | 1.2 KB | 1.0 KB |
| audit-log append (write-through) | 100k | 29.8 KB | 32.6 KB |
| audit-log append (SPBT_DB appender, 512 rows per commit) | 100k | 29.8 KB | 996 B |

## Main thread blocked by an XP flush

| N members | v26: `flushAll()` every 2 min (stringify + write, blocking) | SPBT_DB: flush every 30 s, main-thread part (commit + fsync run off-thread) | SPBT_DB wall time per flush |
|---:|---:|---:|---:|
| 1.0k | 0.82 ms | 3.9 ms | 7.53 ms |
| 10k | 5.68 ms | 6.19 ms | 15.17 ms |
| 100k | 66.58 ms | 11.18 ms | 40.56 ms |

## RSS

A fresh process opens the data the suite left behind and runs a light bot-like workload (20 000 messages through the XP path, 50 user reads, 1 000 config reads, 100 audit-log views, one XP flush), then a gc. v26 keeps the XP map of every guild that has talked in RAM for the life of the process, as the bot does. "Before" is the same process right after start, before it opened anything: Node plus this script.

| N users | before (Node) | v26 JSON total / anon / file | SPBT_DB total / anon / file | data on disk (v26 users.json + levels_data.json / SPBT_DB hot.mdb + cold.mdb) |
|---:|---|---|---|---|
| 1.0k | 53.8 MB | 64 / 16.9 / 47.2 MB | 86.1 / 33.7 / 52.5 MB | 151.8 KB / 1.1 MB |
| 10k | 53.8 MB | 70.7 / 23.4 / 47.3 MB | 104.4 / 49.2 / 55.2 MB | 1.5 MB / 2.9 MB |
| 100k | 53.7 MB | 128.9 / 81.8 / 47.2 MB | 121.6 / 50 / 71.6 MB | 14.8 MB / 15.7 MB |

## Crash safety: kill -9 in the middle of writing

v26: a child process loops `users.set()` (every call rewrites users.json) and is killed with SIGKILL after a random 50–500 ms; then users.json is parsed. SPBT_DB: a child commits txns of 1–200 new users plus a counter, is killed the same way, and a fresh process opens the database and checks it. kill -9 keeps the page cache, so this tests process crashes, not power loss.

| store | N users | kills | file/db unreadable after the kill | acknowledged writes lost | partial txns | index ≠ data |
|---|---:|---:|---:|---:|---:|---:|
| v26 JSON (781.3 KB file) | 10k | 100 | **11** (11 empty) | 0 | – | – |
| v26 JSON (7.6 MB file) | 100k | 100 | **0** (0 empty) | 0 | – | – |
| SPBT_DB | 100k | 100 | **0** | 0 | 0 | 0 |

* v26, N=10k: a corrupt users.json makes `load()` return `{}` (its `catch`), so the next start sees no users at all, and the next `set()` overwrites the file with that one user. That is 10k users lost per corrupt file.
* SPBT_DB, N=100k: 587840 users committed across the kills; every reopen found the last acknowledged txn; 100/100 reopens reported `lastShutdownClean: false`. Open after kill -9: p50 20.77 ms, p99 26.64 ms, max 1618.33 ms.


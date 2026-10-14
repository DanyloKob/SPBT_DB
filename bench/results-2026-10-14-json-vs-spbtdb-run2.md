# v26 JSON files vs SPBT_DB (2026-10-14)

Machine: AMD Ryzen 5 7535HS with Radeon Graphics, 12 threads, 15277 MB RAM, Node v22.23.1, lmdb 3.5.6, Linux 7.1.5-201.fc44.x86_64. Data on btrfs (relatime,compress=zstd:1,ssd,discard=async) on /dev/nvme0n1p3. Warm page cache for both stores. 2 s per scenario. Each (store, size) ran in its own process.

`bench/json-vs-spbtdb.mjs` produced this file. The v26 side is the v26 code (`bench/v26-stores.mjs`); it never fsyncs, so its writes are not durable. Every SPBT_DB write below is a durable commit (fsync) unless the row says coalesced.

## Throughput and latency

| scenario | N users | v26 JSON ops/s | SPBT_DB ops/s | SPBT_DB / JSON | JSON p50 / p99 | SPBT_DB p50 / p99 |
|---|---:|---:|---:|---:|---|---|
| read one user (v26 `users.get`) | 1.0k | 2.7k | 1.36M | **502×** | 362 µs / 481 µs | 0.6 µs / 1.1 µs |
| read one user (v26 `users.get`) | 10k | 224 | 1.27M | **5693×** | 4.3 ms / 7.7 ms | 0.7 µs / 1.2 µs |
| read one user (v26 `users.get`) | 100k | 19.4 | 1.09M | **56010×** | 50.8 ms / 57.2 ms | 0.8 µs / 1.5 µs |
| change one user's plan (v26 `users.set`) | 1.0k | 889 | 333 | **0.4×** | 1.1 ms / 1.4 ms | 3.0 ms / 3.7 ms |
| change one user's plan (v26 `users.set`) | 10k | 96.3 | 321 | **3.3×** | 10.1 ms / 12.9 ms | 3.1 ms / 4.0 ms |
| change one user's plan (v26 `users.set`) | 100k | 8.30 | 260 | **31×** | 118 ms / 128 ms | 3.8 ms / 4.7 ms |
| messageCreate XP path: feature flag + levels config + XP bump | 1.0k | 53k | 283k | **5.4×** | 18 µs / 27 µs | 3.3 µs / 6.6 µs |
| messageCreate XP path: feature flag + levels config + XP bump | 10k | 52k | 268k | **5.2×** | 19 µs / 27 µs | 3.4 µs / 7.2 µs |
| messageCreate XP path: feature flag + levels config + XP bump | 100k | 52k | 231k | **4.4×** | 18 µs / 27 µs | 3.9 µs / 8.3 µs |
| per-guild moderation config read (4.4 KB JSON) | 1.0k | 32k | 74k | **2.3×** | 30 µs / 42 µs | 12 µs / 24 µs |
| per-guild moderation config read (4.4 KB JSON) | 10k | 33k | 66k | **2.0×** | 30 µs / 41 µs | 13 µs / 31 µs |
| per-guild moderation config read (4.4 KB JSON) | 100k | 33k | 73k | **2.2×** | 30 µs / 44 µs | 12 µs / 25 µs |
| audit-log append (v26 `appendLog`), SPBT_DB write-through | 1.0k | 3.0k | 324 | **0.1×** | 320 µs / 501 µs | 3.0 ms / 4.0 ms |
| audit-log append (v26 `appendLog`), SPBT_DB write-through | 10k | 3.0k | 315 | **0.1×** | 328 µs / 539 µs | 3.1 ms / 3.9 ms |
| audit-log append (v26 `appendLog`), SPBT_DB write-through | 100k | 3.0k | 319 | **0.1×** | 323 µs / 612 µs | 3.1 ms / 3.9 ms |
| audit-log view: latest 50 entries of a guild | 1.0k | 9.6k | 25k | **2.6×** | 101 µs / 150 µs | 36 µs / 73 µs |
| audit-log view: latest 50 entries of a guild | 10k | 9.7k | 25k | **2.6×** | 101 µs / 137 µs | 35 µs / 71 µs |
| audit-log view: latest 50 entries of a guild | 100k | 9.6k | 26k | **2.7×** | 100 µs / 168 µs | 35 µs / 72 µs |
| top-10 leaderboard of a guild with N members | 1.0k | 4.0k | 134k | **33×** | 244 µs / 290 µs | 6.4 µs / 13 µs |
| top-10 leaderboard of a guild with N members | 10k | 243 | 130k | **538×** | 4.0 ms / 5.4 ms | 6.6 µs / 14 µs |
| top-10 leaderboard of a guild with N members | 100k | 13.0 | 132k | **10180×** | 72.2 ms / 111 ms | 6.5 µs / 13 µs |

Extra SPBT_DB rows (no v26 equivalent):

| scenario | N users | ops/s | p50 / p99 |
|---|---:|---:|---|
| user.set, 100 per txn (durable) | 1.0k | 22k | 4.4 ms / 5.2 ms per txn |
| audit.append through the appender (one commit per 512 rows) | 1.0k | 69k | 0.5 µs / 2.3 µs |
| user.set, 100 per txn (durable) | 10k | 12k | 8.3 ms / 9.4 ms per txn |
| audit.append through the appender (one commit per 512 rows) | 10k | 65k | 0.5 µs / 1.3 µs |
| user.set, 100 per txn (durable) | 100k | 8.3k | 11.8 ms / 17.1 ms per txn |
| audit.append through the appender (one commit per 512 rows) | 100k | 66k | 0.5 µs / 1.2 µs |

## Bytes written to disk per update

Bytes handed to write()/pwrite() (`/proc/self/io` wchar), divided by updates. For SPBT_DB this is whole 4 KiB B+tree pages (data, indexes, the meta page). btrfs compression is applied after this point.

| update | N users | v26 JSON | SPBT_DB |
|---|---:|---:|---:|
| user.set (one per commit) | 1.0k | 98.5 KB | 32.2 KB |
| user.set, 100 per txn | 1.0k | – | 1.4 KB |
| XP update, v26 2-min flush vs SPBT_DB 30 s flush (50 msg/s) | 1.0k | 13 B | 74 B |
| XP update, both flushed every 2 min | 1.0k | 13 B | 19 B |
| audit-log append (write-through) | 1.0k | 29.8 KB | 32.6 KB |
| audit-log append (SPBT_DB appender, 512 rows per commit) | 1.0k | 29.8 KB | 998 B |
| user.set (one per commit) | 10k | 785.1 KB | 35.4 KB |
| user.set, 100 per txn | 10k | – | 6.8 KB |
| XP update, v26 2-min flush vs SPBT_DB 30 s flush (50 msg/s) | 10k | 126 B | 519 B |
| XP update, both flushed every 2 min | 10k | 126 B | 130 B |
| audit-log append (write-through) | 10k | 29.8 KB | 32.6 KB |
| audit-log append (SPBT_DB appender, 512 rows per commit) | 10k | 29.8 KB | 994 B |
| user.set (one per commit) | 100k | 7.6 MB | 57.2 KB |
| user.set, 100 per txn | 100k | – | 10.3 KB |
| XP update, v26 2-min flush vs SPBT_DB 30 s flush (50 msg/s) | 100k | 1.2 KB | 3.6 KB |
| XP update, both flushed every 2 min | 100k | 1.2 KB | 1.0 KB |
| audit-log append (write-through) | 100k | 29.8 KB | 32.6 KB |
| audit-log append (SPBT_DB appender, 512 rows per commit) | 100k | 29.8 KB | 995 B |

## Main thread blocked by an XP flush

| N members | v26: `flushAll()` every 2 min (stringify + write, blocking) | SPBT_DB: flush every 30 s, main-thread part (commit + fsync run off-thread) | SPBT_DB wall time per flush |
|---:|---:|---:|---:|
| 1.0k | 0.85 ms | 3.74 ms | 7.94 ms |
| 10k | 6.18 ms | 6.41 ms | 14.95 ms |
| 100k | 68.09 ms | 10.33 ms | 39.87 ms |

## RSS

A fresh process opens the data the suite left behind and runs a light bot-like workload (20 000 messages through the XP path, 50 user reads, 1 000 config reads, 100 audit-log views, one XP flush), then a gc. v26 keeps the XP map of every guild that has talked in RAM for the life of the process, as the bot does. "Before" is the same process right after start, before it opened anything: Node plus this script.

| N users | before (Node) | v26 JSON total / anon / file | SPBT_DB total / anon / file | data on disk (v26 users.json + levels_data.json / SPBT_DB hot.mdb + cold.mdb) |
|---:|---|---|---|---|
| 1.0k | 53.6 MB | 64.1 / 16.9 / 47.2 MB | 85.5 / 33.1 / 52.4 MB | 151.8 KB / 1.1 MB |
| 10k | 53.7 MB | 70.8 / 23.6 / 47.2 MB | 106.2 / 51.1 / 55.2 MB | 1.5 MB / 2.9 MB |
| 100k | 53.7 MB | 130.7 / 83.5 / 47.2 MB | 126.1 / 53.1 / 73 MB | 14.8 MB / 15.7 MB |

## Crash safety: kill -9 in the middle of writing

v26: a child process loops `users.set()` (every call rewrites users.json) and is killed with SIGKILL after a random 50–500 ms; then users.json is parsed. SPBT_DB: a child commits txns of 1–200 new users plus a counter, is killed the same way, and a fresh process opens the database and checks it. kill -9 keeps the page cache, so this tests process crashes, not power loss.

| store | N users | kills | file/db unreadable after the kill | acknowledged writes lost | partial txns | index ≠ data |
|---|---:|---:|---:|---:|---:|---:|
| v26 JSON (781.3 KB file) | 10k | 100 | **2** (2 empty) | 0 | – | – |
| v26 JSON (7.6 MB file) | 100k | 100 | **8** (8 empty) | 0 | – | – |
| SPBT_DB | 100k | 100 | **0** | 0 | 0 | 0 |

* v26, N=10k: a corrupt users.json makes `load()` return `{}` (its `catch`), so the next start sees no users at all, and the next `set()` overwrites the file with that one user. That is 10k users lost per corrupt file.
* v26, N=100k: a corrupt users.json makes `load()` return `{}` (its `catch`), so the next start sees no users at all, and the next `set()` overwrites the file with that one user. That is 100k users lost per corrupt file.
* SPBT_DB, N=100k: 594163 users committed across the kills; every reopen found the last acknowledged txn; 100/100 reopens reported `lastShutdownClean: false`. Open after kill -9: p50 20.74 ms, p99 22.73 ms, max 29.78 ms.


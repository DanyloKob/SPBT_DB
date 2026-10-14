# TanoDB bench results 2026-10-14, r2 (after the optimisation round)

Host: AMD Ryzen 5 7535HS with Radeon Graphics, 12 threads, 15277 MB RAM, node v22.23.1, lmdb 3.5.6, kernel 7.1.5-201.fc44.x86_64.
Dataset dir: ~/.cache/tanodb-bench/r2-suite (btrfs, compress=zstd:1). Scale for 03/08: 0.1.
Target projection factors (00-calibrate; ASSUMED unless bench/target-host.json exists): cpu ×2.4, fsync ×1.453, seq write ×26.929.
Thresholds are for the target (EPYC 7551 Zen 1, E2.1.Micro); "projected" is the local value scaled to it, and the verdict uses it when present.

| bench | check | local | projected | threshold | verdict |
|---|---|---:|---:|---:|---|
| 00-calibrate | informational only | | | | info |
| 01-write-throughput | level put/s, batched 1000, +index | 30,606 put/s | 18,696 | >= 15,000 put/s | PASS |
| 01-write-throughput | level dirty pages per 2000-incr flush (p50) | 2,607 pages | – | <= 300 pages | info |
| 01-write-throughput | event_log put/s, batched 512 (80 channels) | 46,657 put/s | 22,348 | >= 15,000 put/s | PASS |
| 01-write-throughput | write amplification, append-key single stream (512/commit) | 1.77 x | – | <= 1.6 x | **FAIL** |
| 01-write-throughput | write amplification, event_log 80 channels, 512/commit | 2.4 x | – | <= 1.6 x | **FAIL** |
| 01-write-throughput | write amplification, event_log 80 channels, 250/commit (50 msg/s x 5 s) | 2.88 x | – | <= 1.6 x | **FAIL** |
| 01-write-throughput | write amplification, 80 channels, 512/commit, pre-r2 key gid chan ts seq | 10.06 x | – | <= 1.6 x | info |
| 01-write-throughput | write amplification, 80 channels, 250/commit, pre-r2 key gid chan ts seq | 20.47 x | – | <= 1.6 x | info |
| 01-write-throughput | fsync/s under synthetic 50 msg/s (src/coalesce.js) | 0.257 fsync/s | – | <= 4 fsync/s | PASS |
| 01-write-throughput | main-thread share at 50 msg/s (6 gets + append + bump; commits are off-thread) | 0.004 share | 0.0096 | <= 1 share | info |
| 02-read-latency | hot level.get p50 | 1.252 µs | 3.005 | <= 2 µs | **FAIL** |
| 02-read-latency | hot level.get p99 | 2.235 µs | 5.364 | <= 10 µs | PASS |
| 02-read-latency | hot user.get p50 (msgpack) | 1.403 µs | 3.367 | <= 2 µs | **FAIL** |
| 02-read-latency | hot user.get p99 (msgpack) | 2.766 µs | 6.638 | <= 10 µs | PASS |
| 02-read-latency | hot feature_config.get p50 (~700 B, deflate) | 9.698 µs | 23.28 | <= 2 µs | info |
| 02-read-latency | hot feature_config.get p99 | 19.71 µs | 47.3 | <= 10 µs | info |
| 02-read-latency | event-paced first get after 20 ms idle p50 (50 msg/s handler) | 51.37 µs | 123.3 | <= 2 µs | info |
| 02-read-latency | event-paced following gets p50 (avg of user + feature_config + level) | 60.09 µs | 144.2 | <= 10 µs | info |
| 02-read-latency | index lookup case_by_target (limit 10, +primary) p99 | 24.28 µs | 58.26 | <= 200 µs | info |
| 02-read-latency | range(100) event_log p99 (latest 100 of a channel, full rows) | 345.8 µs | 829.9 | <= 200 µs | **FAIL** |
| 02-read-latency | range(100) event_log p50 | 191.5 µs | 459.6 | <= 200 µs | info |
| 02-read-latency | range(100) level.top covered p99 | 114.4 µs | 274.5 | <= 200 µs | **FAIL** |
| 02-read-latency | range(100) bare lmdb event_log p99 (index range + 100 gets, engine floor, no decode) | 220.8 µs | 529.8 | <= 200 µs | info |
| 02-read-latency | event_log byMessageId p99 (edit/delete lookup) | 11.68 µs | 28.04 | <= 10 µs | info |
| 02-read-latency | cold level.get p50 (first touch) | 4.1 µs | – | <= 600 µs | info |
| 02-read-latency | cold level.get p99 | 1,105 µs | – | <= 600 µs | info |
| 03-rss-at-scale (as shipped) | RSS peak (Node + TanoDB only) <= 270 MB | 162 MB | – | <= 270 MB | PASS |
| 03-rss-at-scale (as shipped) | anonymous peak <= 200 MB | 72 MB | – | <= 200 MB | PASS |
| 03-rss-at-scale (as shipped) | VmSwap == 0 | 0 MB | – | <= 0 MB | PASS |
| 03-rss-at-scale (as shipped) | RSS slope, second half of mix | 34.19 MB/min | – | <= 0.5 MB/min | info |
| 03-rss-at-scale (as shipped) | anonymous end (after gc) <= 88 MB (§6.4 Node floor 42 + TanoDB JS 10 + lmdb native 14 + GC 22) | 71.29 MB | – | <= 88 MB | PASS |
| 03-rss-at-scale (as shipped) | file-backed .mdb resident <= 53 MB (§6.3 hot 35 + cold 18) | 41.38 MB | – | <= 53 MB | PASS |
| 03-rss-at-scale (as shipped) | hot.mdb resident <= 35 MB | 14.13 MB | – | <= 35 MB | info |
| 03-rss-at-scale (as shipped) | cold.mdb resident <= 18 MB | 27.25 MB | – | <= 18 MB | info |
| 03-rss-at-scale (as shipped) | mix errors | 0  | – | == 0  | PASS |
| 03-rss-at-scale (pre-r2 env: growing hot map + cold readahead) | RSS peak (Node + TanoDB only) <= 270 MB | 214.5 MB | – | <= 270 MB | PASS |
| 03-rss-at-scale (pre-r2 env: growing hot map + cold readahead) | anonymous peak <= 200 MB | 72.87 MB | – | <= 200 MB | PASS |
| 03-rss-at-scale (pre-r2 env: growing hot map + cold readahead) | VmSwap == 0 | 0 MB | – | <= 0 MB | PASS |
| 03-rss-at-scale (pre-r2 env: growing hot map + cold readahead) | RSS slope, second half of mix | 41.03 MB/min | – | <= 0.5 MB/min | info |
| 03-rss-at-scale (pre-r2 env: growing hot map + cold readahead) | anonymous end (after gc) <= 88 MB (§6.4 Node floor 42 + TanoDB JS 10 + lmdb native 14 + GC 22) | 68.7 MB | – | <= 88 MB | PASS |
| 03-rss-at-scale (pre-r2 env: growing hot map + cold readahead) | file-backed .mdb resident <= 53 MB (§6.3 hot 35 + cold 18) | 97.05 MB | – | <= 53 MB | **FAIL** |
| 03-rss-at-scale (pre-r2 env: growing hot map + cold readahead) | hot.mdb resident <= 35 MB | 22.29 MB | – | <= 35 MB | info |
| 03-rss-at-scale (pre-r2 env: growing hot map + cold readahead) | cold.mdb resident <= 18 MB | 74.76 MB | – | <= 18 MB | info |
| 03-rss-at-scale (pre-r2 env: growing hot map + cold readahead) | mix errors | 0  | – | == 0  | PASS |
| 04-crash-safety | dropCollection under kill -9: buckets left with index != data (60 kills) | 0  | – | == 0  | PASS |
| 04-crash-safety | verifier negative control (detects injected corruption, reindex repairs) | 1 bool | – | == 1 bool | PASS |
| 04-crash-safety | corrupt iterations (open / prefix / index<->data) | 0  | – | == 0  | PASS |
| 04-crash-safety | committed txns lost after kill -9 (max) | 0 txns | – | <= 0 txns | PASS |
| 04-crash-safety | child processes that died on their own | 0  | – | == 0  | PASS |
| 04-crash-safety | open time after crash p99 | 1,690 ms | 4,056 | <= 50 ms | **FAIL** |
| 04-crash-safety | open time after crash max | 1,749 ms | – | <= 50 ms | info |
| 04-crash-safety | first durable commit after crash p99 (flushes what the killed writer left dirty) | 6.88 ms | – | <= 50 ms | info |
| 04-crash-safety | first durable commit after crash max | 7.26 ms | – | <= 50 ms | info |
| 05-hotpaths | level.bump into the coalescer, bigint ids | 209 ns/op | 501.6 | <= 1,000 ns/op | info |
| 05-hotpaths | level.bump into the coalescer, string ids | 276 ns/op | 662.4 | <= 1,000 ns/op | info |
| 05-hotpaths | coalescer flush of 2000 keys (txnAsync, sorted): wall p50 | 46.99 ms | – | <= 1,000 ms | info |
| 05-hotpaths | coalescer flush of 2000 keys: main-thread apply p50 | 13.23 ms | 31.75 | <= 100 ms | info |
| 05-hotpaths | on-disk bytes per sched row (sched + sched_by_subject) | 113.3 B | – | <= 200 B | info |
| 05-hotpaths | scheduler idle wake (50k rows, nothing due) | 4.4 µs | 10.56 | <= 1,000 µs | info |
| 05-hotpaths | scheduler: fire 500 due jobs + one commit | 11.9 ms | – | <= 1,000 ms | info |
| 05-hotpaths | event_log lagged catch-up: main-thread ms of that txn (512 rows + 8192-row tail, 2 indexes) | 58.67 ms | 140.8 | <= 50 ms | info |
| 08-compaction | dropCollection of a 499997-row month bucket (cold cache) | 0.02387 s | 0.5728 | <= 2 s | PASS |
| 08-compaction | RSS spike during drop | 1.2 MB | 8.77 | <= 40 MB | PASS |
| 08-compaction | next month reuses the dropped pages (file growth on refill) | 0 MB | – | <= 1 MB | info |
| 08-compaction | copy-compaction of the 420 MB hot env | 5.756 s | 18.67 | <= 30 s | PASS |
| 08-compaction | RSS spike during copy-compaction (bot process, compactCopy in a child) | 0.27 MB | 0.7782 | <= 40 MB | PASS |
| 08-compaction | RSS spike, copy-compaction IN the bot process (pre-r2 way) | 27.35 MB | 215.5 | <= 40 MB | info |
| 08-compaction | compaction child peak RSS (transient, exits) | 96.8 MB | 291.8 | <= 40 MB | info |
| 08-compaction | compacted env reopens with identical counts | 1 bool | – | == 1 bool | PASS |
| 09-multiprocess | cross-process visibility p99 (writer commit -> reader sees) | 1.076 ms | – | <= 600 ms | PASS |
| 09-multiprocess | cross-process visibility max | 1.106 ms | – | <= 600 ms | PASS |
| 09-multiprocess | non-yielding reader stays on its snapshot until resetReadTxn() | 1 bool | – | == 1 bool | info |
| 09-multiprocess | lost increments, 2 processes x 10000 incr | 0 ops | – | == 0 ops | PASS |
| 09-multiprocess | control (non-atomic get+put) does lose updates - test is sensitive | 1 bool | – | == 1 bool | PASS |
| 09-multiprocess | reader + new writer not hung after writer kill -9 (robust mutex) | 1 bool | – | == 1 bool | PASS |
| 09-multiprocess | killed txn writes invisible | 1 bool | – | == 1 bool | PASS |
| 09-multiprocess | max read stall while lock held / after kill | 1.805 ms | – | <= 50 ms | info |

03 was rerun on its own (`run.mjs --only 03`) after a fix, and its rows were spliced in. The first suite run crashed while serialising `db.stats()` after close, because of the lazy `freePages` getter; `collection.stat()` now returns plain values.

## Before → after

Same dev box, `bench/run.mjs --scale 0.1`. "A/B" means the r1 code (a copy of the pre-r2 `src/`) and the r2 code were measured alternately in one session, because run-to-run noise on this laptop is about ±10 %.

| # | item | r1 (before) | r2 (after) | threshold / verdict |
|---|---|---|---|---|
| 1 | `dropCollection` under kill -9: buckets left with index ≠ data | 1–3 of 60 kills | **0 of 60** (suite) + 0 of 200 + 0 of 60 standalone | == 0: **PASS** |
| 2 | 03 file-backed `.mdb` resident (scale 0.1) | 111 MB (r1 run); 97 MB with the pre-r2 env, same session | **41 MB** (hot 14, cold 27) | ≤ 53 MB: **PASS** |
| 2 | 03 RSS peak, Node + TanoDB | 228 MB; 214 MB with the pre-r2 env | **162 MB** | ≤ 270 MB: PASS |
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

**Item 7, post-crash open time: a host stall, not TanoDB.**

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

## Decisions for the owner

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

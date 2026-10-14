# TanoDB bench results 2026-10-14

Host: AMD Ryzen 5 7535HS with Radeon Graphics, 12 threads, 15277 MB RAM, node v22.23.1, lmdb 3.5.6, kernel 7.1.5-201.fc44.x86_64.
Dataset dir: ~/.cache/tanodb-bench (btrfs, compress=zstd:1). Scale for 03/08: 0.1.
Target projection factors (00-calibrate; ASSUMED unless bench/target-host.json exists): cpu ×2.4, fsync ×1.462, seq write ×25.302.
Thresholds are for the target (EPYC 7551 Zen 1, E2.1.Micro); "projected" is the local value scaled to it, and the verdict uses it when present.

| bench | check | local | projected | threshold | verdict |
|---|---|---:|---:|---:|---|
| 00-calibrate | informational only | | | | info |
| 01-write-throughput | level put/s, batched 1000, +index | 31,329 put/s | 19,117 | >= 15,000 put/s | PASS |
| 01-write-throughput | level dirty pages per 2000-incr flush (p50) | 2,606 pages | – | <= 300 pages | info |
| 01-write-throughput | event_log put/s, batched 512 (80 channels) | 71,056 put/s | 42,793 | >= 15,000 put/s | PASS |
| 01-write-throughput | write amplification, append-key single stream (512/commit) | 1.52 x | – | <= 1.6 x | PASS |
| 01-write-throughput | write amplification, event_log 80 channels, 512/commit | 10.1 x | – | <= 1.6 x | **FAIL** |
| 01-write-throughput | write amplification, event_log 80 channels, 250/commit (50 msg/s x 5 s) | 20.48 x | – | <= 1.6 x | **FAIL** |
| 01-write-throughput | fsync/s under synthetic 50 msg/s (src/coalesce.js) | 0.257 fsync/s | – | <= 4 fsync/s | PASS |
| 01-write-throughput | main-thread share at 50 msg/s (6 gets + append + bump; commits are off-thread) | 0.004 share | 0.0096 | <= 1 share | info |
| 02-read-latency | hot level.get p50 | 1.032 µs | 2.477 | <= 2 µs | **FAIL** |
| 02-read-latency | hot level.get p99 | 1.833 µs | 4.399 | <= 10 µs | PASS |
| 02-read-latency | hot user.get p50 (msgpack) | 1.243 µs | 2.983 | <= 2 µs | **FAIL** |
| 02-read-latency | hot user.get p99 (msgpack) | 2.234 µs | 5.362 | <= 10 µs | PASS |
| 02-read-latency | hot feature_config.get p50 (~700 B, deflate) | 9.438 µs | 22.65 | <= 2 µs | info |
| 02-read-latency | hot feature_config.get p99 | 17.72 µs | 42.54 | <= 10 µs | info |
| 02-read-latency | event-paced first get after 20 ms idle p50 (50 msg/s handler) | 55.44 µs | 133.1 | <= 2 µs | info |
| 02-read-latency | event-paced following gets p50 (avg of user + feature_config + level) | 49.76 µs | 119.4 | <= 10 µs | info |
| 02-read-latency | index lookup case_by_target (limit 10, +primary) p99 | 34.95 µs | 83.87 | <= 200 µs | info |
| 02-read-latency | range(100) event_log p99 | 453.5 µs | 1,088 | <= 200 µs | **FAIL** |
| 02-read-latency | range(100) level.top covered p99 | 275.1 µs | 660.2 | <= 200 µs | **FAIL** |
| 02-read-latency | range(100) bare lmdb getRange event_log p99 (engine floor, no decode) | 255.6 µs | 613.5 | <= 200 µs | info |
| 02-read-latency | cold level.get p50 (first touch) | 3 µs | – | <= 600 µs | info |
| 02-read-latency | cold level.get p99 | 192.8 µs | – | <= 600 µs | info |
| 03-rss-at-scale (as shipped) | RSS peak (Node + TanoDB only) <= 270 MB | 228.1 MB | – | <= 270 MB | PASS |
| 03-rss-at-scale (as shipped) | anonymous peak <= 200 MB | 69.66 MB | – | <= 200 MB | PASS |
| 03-rss-at-scale (as shipped) | VmSwap == 0 | 0 MB | – | <= 0 MB | PASS |
| 03-rss-at-scale (as shipped) | RSS slope, second half of mix | 22.82 MB/min | – | <= 0.5 MB/min | info |
| 03-rss-at-scale (as shipped) | anonymous end (after gc) <= 88 MB (§6.4 Node floor 42 + TanoDB JS 10 + lmdb native 14 + GC 22) | 69.61 MB | – | <= 88 MB | PASS |
| 03-rss-at-scale (as shipped) | file-backed .mdb resident <= 53 MB (§6.3 hot 35 + cold 18) | 111.3 MB | – | <= 53 MB | **FAIL** |
| 03-rss-at-scale (as shipped) | hot.mdb resident <= 35 MB | 16.21 MB | – | <= 35 MB | info |
| 03-rss-at-scale (as shipped) | cold.mdb resident <= 18 MB | 95.13 MB | – | <= 18 MB | info |
| 03-rss-at-scale (as shipped) | mix errors | 0  | – | == 0  | PASS |
| 03-rss-at-scale (proposed: hot mapSize 2 GiB + cold noReadAhead) | RSS peak (Node + TanoDB only) <= 270 MB | 147.2 MB | – | <= 270 MB | PASS |
| 03-rss-at-scale (proposed: hot mapSize 2 GiB + cold noReadAhead) | anonymous peak <= 200 MB | 66.2 MB | – | <= 200 MB | PASS |
| 03-rss-at-scale (proposed: hot mapSize 2 GiB + cold noReadAhead) | VmSwap == 0 | 0 MB | – | <= 0 MB | PASS |
| 03-rss-at-scale (proposed: hot mapSize 2 GiB + cold noReadAhead) | RSS slope, second half of mix | 12.15 MB/min | – | <= 0.5 MB/min | info |
| 03-rss-at-scale (proposed: hot mapSize 2 GiB + cold noReadAhead) | anonymous end (after gc) <= 88 MB (§6.4 Node floor 42 + TanoDB JS 10 + lmdb native 14 + GC 22) | 66.2 MB | – | <= 88 MB | PASS |
| 03-rss-at-scale (proposed: hot mapSize 2 GiB + cold noReadAhead) | file-backed .mdb resident <= 53 MB (§6.3 hot 35 + cold 18) | 32.37 MB | – | <= 53 MB | PASS |
| 03-rss-at-scale (proposed: hot mapSize 2 GiB + cold noReadAhead) | hot.mdb resident <= 35 MB | 11.96 MB | – | <= 35 MB | info |
| 03-rss-at-scale (proposed: hot mapSize 2 GiB + cold noReadAhead) | cold.mdb resident <= 18 MB | 20.41 MB | – | <= 18 MB | info |
| 03-rss-at-scale (proposed: hot mapSize 2 GiB + cold noReadAhead) | mix errors | 0  | – | == 0  | PASS |
| 04-crash-safety | dropCollection under kill -9: buckets left with index != data (60 kills) | 2  | – | == 0  | **FAIL** |
| 04-crash-safety | verifier negative control (detects injected corruption, reindex repairs) | 1 bool | – | == 1 bool | PASS |
| 04-crash-safety | corrupt iterations (open / prefix / index<->data) | 0  | – | == 0  | PASS |
| 04-crash-safety | committed txns lost after kill -9 (max) | 0 txns | – | <= 0 txns | PASS |
| 04-crash-safety | child processes that died on their own | 0  | – | == 0  | PASS |
| 04-crash-safety | open time after crash p99 | 1,688 ms | 4,051 | <= 50 ms | **FAIL** |
| 08-compaction | dropCollection of a 500000-row month bucket (cold cache) | 0.06549 s | 1.572 | <= 2 s | PASS |
| 08-compaction | RSS spike during drop | 8.57 MB | 83 | <= 40 MB | **FAIL** |
| 08-compaction | next month reuses the dropped pages (file growth on refill) | 0 MB | – | <= 1 MB | info |
| 08-compaction | copy-compaction of the 420 MB hot env | 4.677 s | 18.67 | <= 30 s | PASS |
| 08-compaction | RSS spike during copy-compaction | 27.92 MB | 215.5 | <= 40 MB | **FAIL** |
| 08-compaction | compacted env reopens with identical counts | 1 bool | – | == 1 bool | PASS |
| 09-multiprocess | cross-process visibility p99 (writer commit -> reader sees) | 1.07 ms | – | <= 600 ms | PASS |
| 09-multiprocess | cross-process visibility max | 1.135 ms | – | <= 600 ms | PASS |
| 09-multiprocess | non-yielding reader stays on its snapshot until resetReadTxn() | 1 bool | – | == 1 bool | info |
| 09-multiprocess | lost increments, 2 processes x 10000 incr | 0 ops | – | == 0 ops | PASS |
| 09-multiprocess | control (non-atomic get+put) does lose updates - test is sensitive | 1 bool | – | == 1 bool | PASS |
| 09-multiprocess | reader + new writer not hung after writer kill -9 (robust mutex) | 1 bool | – | == 1 bool | PASS |
| 09-multiprocess | killed txn writes invisible | 1 bool | – | == 1 bool | PASS |
| 09-multiprocess | max read stall while lock held / after kill | 1.56 ms | – | <= 50 ms | info |

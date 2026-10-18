# Cold page size A/B: 8 KiB (shipped) vs 4 KiB, 2026-10-18

Machine: AMD Ryzen 5 7535HS (12 threads), 15 GB RAM, Linux 7.1.5-201.fc44, Node v22.23.1, lmdb-js 3.5.6, swap zram0. Other desktop load was present (load average 2.6-6.5 during the runs), so absolute times are noisy; byte counts are not.
File system: `btrfs /dev/nvme0n1p3[/home] rw,nosuid,nodev,relatime,seclabel,compress=zstd:1,ssd,discard=async,space_cache=v2,subvol=/home`, data dir `~/.cache/spbtdb-bench/cold-ps`.
Order: 8192, 4096, 8192, 4096 (round 1 and round 2). 03 and 08 ran once per variant, in round 1. No calibration (`SPBTDB_BENCH_CAL` unset): "projected" uses the assumed target factor cpu x2.4 and, for the RSS spike, the bench's own file-backed x 1/scale rule.
Each run asserts `db.stats().cold.pageSize == --cold-page-size` (8192 / 4096 confirmed in every JSON). Raw values: `results-2026-10-18-cold-pagesize.json` (`out` = extracted, `raw` = every full bench document).

Write amplification and bytes per commit are deterministic (identical in both runs of a variant); only times vary.

## 01 write throughput (eventLog)

| metric | 8 KiB r1 | 8 KiB r2 | 8 KiB median | 4 KiB r1 | 4 KiB r2 | 4 KiB median | 4 KiB vs 8 KiB |
|---|---|---|---|---|---|---|---|
| WA 80ch / 512 | 2.40 | 2.40 | 2.40 | 2.06 | 2.06 | 2.06 | -14.2 % |
| WA 80ch / 250 | 2.88 | 2.88 | 2.88 | 2.32 | 2.32 | 2.32 | -19.4 % |
| WA single stream (with 2 indexes) | 1.77 | 1.77 | 1.77 | 1.62 | 1.62 | 1.62 | -8.5 % |
| bytes/commit 512 | 236 809 | 236 809 | 236 809 | 202 893 | 202 893 | 202 893 | -14.3 % |
| bytes/commit 250 | 139 059 | 139 059 | 139 059 | 111 898 | 111 898 | 111 898 | -19.5 % |
| bytes/commit single | 174 208 | 174 208 | 174 208 | 159 475 | 159 475 | 159 475 | -8.5 % |
| dirty pages p99, 512 / 250 / single | 198 / 187 / 72 | same | 198 / 187 / 72 | 305 / 297 / 137 | same | 305 / 297 / 137 | pages are half size |
| ms/commit p99, 512 | 52.9 | 53.4 | 53.1 | 54.1 | 43.4 | 48.8 | -8 % (noise) |
| ms/commit p99, 250 | 47.7 | 45.8 | 46.7 | 51.5 | 42.8 | 47.2 | +1 % |
| ms/commit p99, single | 45.9 | 47.7 | 46.8 | 60.6 | 47.3 | 54.0 | +15 % (noise) |
| ops/s 512 | 46 878 | 48 637 | 47 758 | 45 194 | 51 178 | 48 186 | +1 % |
| ops/s 250 | 35 285 | 37 158 | 36 222 | 33 398 | 37 344 | 35 371 | -2 % |
| ops/s single | 48 591 | 48 786 | 48 689 | 43 996 | 47 262 | 45 629 | -6 % |
| bytesPerRowOnPages | 213.0 | 213.0 | 213.0 | 223.1 | 223.1 | 223.1 | +4.7 % |
| bytesPerRowWithIndexes | 272.8 | 272.8 | 272.8 | 284.1 | 284.1 | 284.1 | +4.1 % |

## 02 read latency (scale 1)

Warm (hotUs), µs:

| metric | 8 KiB r1 | 8 KiB r2 | 4 KiB r1 | 4 KiB r2 |
|---|---|---|---|---|
| eventLogRange100 p50 / p99 | 191.9 / 451.0 | 188.4 / 413.9 | 198.1 / 442.1 | 187.8 / 411.7 |
| eventLogByMessageId p50 / p99 | 3.77 / 9.38 | 3.93 / 9.81 | 4.37 / 16.38 | 3.76 / 9.97 |
| build.coldFileMB | 87.1 | 87.1 | 87.8 | 87.8 |

Cold event_log after eviction (fincore of cold.mdb: 8 KiB 81.9 / 91.3 MB -> 0; 4 KiB 92.0 / 92.0 MB -> 0; hot.mdb also evicted to 0). Isolated runs = one query type in a fresh process after a fresh eviction (the combined child runs byMessageId on pages the channel queries already loaded). Latency in µs.

| query | variant | run | p50 | p99 | max | major faults/query | read_bytes/query | total faults | total read_bytes |
|---|---|---|---|---|---|---|---|---|---|
| latest 100 of channel (300 q), isolated | 8 KiB | r1 | 436.9 | 15 356 | 20 548 | 9.783 | 40 073 | 2 935 | 12 021 760 |
| | 8 KiB | r2 | 394.8 | 17 261 | 23 649 | 9.783 | 40 073 | 2 935 | 12 021 760 |
| | 4 KiB | r1 | 556.0 | 13 192 | 21 822 | 9.860 | 40 387 | 2 958 | 12 115 968 |
| | 4 KiB | r2 | 525.1 | 9 312 | 14 789 | 9.860 | 40 387 | 2 958 | 12 115 968 |
| byMessageId (1000 q), isolated | 8 KiB | r1 | 201.4 | 649.5 | 4 186 | 1.835 | 8 692 | 1 835 | 8 691 712 |
| | 8 KiB | r2 | 232.4 | 531.1 | 2 949 | 1.835 | 8 704 | 1 835 | 8 704 000 |
| | 4 KiB | r1 | 120.5 | 543.1 | 4 499 | 1.149 | 4 706 | 1 149 | 4 706 304 |
| | 4 KiB | r2 | 118.4 | 387.8 | 4 557 | 1.145 | 5 218 | 1 145 | 5 218 304 |
| latest 100, combined child | 8 KiB | r1/r2 | 434.1 / 429.9 | 15 421 / 17 708 | 19 989 / 22 346 | 9.783 | 40 073 | 2 935 | 12 021 760 |
| | 4 KiB | r1/r2 | 492.7 / 500.0 | 9 948 / 9 909 | 14 950 / 14 439 | 9.860 | 40 387 | 2 958 | 12 115 968 |
| byMessageId, combined child | 8 KiB | r1/r2 | 174.9 / 201.0 | 505.9 / 524.7 | 1 975 / 3 215 | 1.505 | 7 340 / 7 352 | 1 505 | 7 340 032 / 7 352 320 |
| | 4 KiB | r1/r2 | 114.5 / 109.9 | 283.8 / 373.2 | 2 324 / 1 092 | 0.954 / 0.950 | 3 908 / 4 420 | 954 / 950 | 3 907 584 / 4 419 584 |

Medians (isolated): channel p99 8 KiB 16 308, 4 KiB 11 252 (-31 %); channel read_bytes/query 40 073 vs 40 387 (+0.8 %); byMessageId p99 590 vs 465 (-21 %); byMessageId read_bytes/query 8 698 vs 4 962 (-43 %).

## 03 RSS at scale (--scale 0.3, 120 s, one run per variant; gen 71 s / 64 s)

| metric (MB) | 8 KiB | 4 KiB |
|---|---|---|
| cold.mdb resident, median of 2nd half of samples | 42.7 | 25.7 (-40 %) |
| cold.mdb resident, max | 45.1 | 34.8 |
| hot.mdb resident, 2nd-half median / max | 20.2 / 20.7 | 20.1 / 21.4 |
| total .mdb resident, 2nd-half median | 62.9 | 45.8 |
| total .mdb resident, max of simultaneous sum | 65.8 | 56.3 |
| total .mdb resident, bench gate (peak hot + peak cold) | 65.8 | 56.4 |
| RSS peak / anonymous peak | 191.0 / 76.4 | 183.6 / 78.7 |
| cold.mdb file size | 589.1 | 579.0 |
| hot.mdb file size | 46.0 | 47.0 |
| mix msgs, errors | 39 380, 0 | 44 270, 0 |

## 05 hotpaths: event_log lagged catch-up, main thread

| variant | run | mainThreadMsPerCatchUpTxn (4 txns) | mainThreadMsPlain512P50 |
|---|---|---|---|
| 8 KiB | r1 | 54.30, 50.54, 41.04, 37.59 | 4.14 |
| 8 KiB | r2 | 68.97, 49.52, 43.13, 39.38 | 4.88 |
| 4 KiB | r1 | 63.50, 49.06, 40.49, 40.46 | 5.49 |
| 4 KiB | r2 | 60.07, 41.96, 39.71, 36.12 | 4.55 |

Median over all 8 catch-up values: 8 KiB 46.3 ms, 4 KiB 41.2 ms (-11 %). Plain 512 median: 4.51 vs 5.02 ms.

## 08 compaction (default scale 0.1, 499 997-row month; one run per variant)

| metric | 8 KiB | 4 KiB |
|---|---|---|
| dropCollection wall, local | 26.5 ms | 35.5 ms |
| dropCollection, projected (x10 rows, x2.4 cpu) | 0.64 s | 0.85 s |
| pages dropped | 18 655 | 38 429 |
| RSS spike during drop, local (anon + file) | 1.23 MB (0.39 + 0.84) | 1.83 MB (0.41 + 1.42) |
| RSS spike, projected | 8.8 MB | 14.6 MB |
| file growth on refill | 0 | 0 |

## The six checks (medians; 4 KiB vs 8 KiB)

| # | check | numbers | result |
|---|---|---|---|
| 1 | WA at least 8 % lower at 512 and 250 | 512: 2.40 -> 2.06 (-14.2 %); 250: 2.88 -> 2.32 (-19.4 %) | PASS |
| 2 | 03: cold.mdb resident (2nd-half median) <= +10 %, total .mdb resident <= 53 MB | cold 42.7 -> 25.7 MB (-40 %: PASS). Total: 2nd-half median 45.8 MB (PASS); the bench's own gate (peak hot + peak cold) 56.4 MB (above 53); 8 KiB is 62.9 / 65.8 | PASS on the median basis; FAIL on the bench's peak-sum gate (see note) |
| 3 | Cold event_log reads: read_bytes/query not higher for both types, p99 <= +20 % | byMessageId bytes 8 698 -> 4 962 (PASS); latest-100 bytes 40 073 -> 40 387 (+314 B, +0.8 %, deterministic: FAIL strictly). p99: channel -31 %, byMessageId -21 % (PASS) | FAIL (by 0.8 % on the channel query) |
| 4 | 08: projected drop <= 2 s, projected RSS spike <= 40 MB | 0.85 s, 14.6 MB | PASS |
| 5 | 05: catch-up main-thread <= +20 % | 46.3 -> 41.2 ms (-11 %) | PASS |
| 6 | bytesPerRowWithIndexes <= +10 % | 272.8 -> 284.1 (+4.1 %) | PASS |

Notes on the two non-clean checks:
* Check 2: the decision text does not say which "total .mdb resident" it means. The 2nd-half median passes (45.8 MB). The bench's existing gate sums the peak of hot and the peak of cold and gives 56.4 MB at 4 KiB, over 53; 8 KiB fails it by more (65.8 MB). This is one run per variant at scale 0.3, with other desktop load present.
* Check 3: the channel query reads 12.12 MB against 12.02 MB over 300 queries (about 9.9 faults per query at both sizes: the lagged index plus 100 primary gets are scattered, so each fault is one page either way and the page size does not change the count). The difference is below 1 %, but the rule says "not higher".

## Verdict

4 KiB is NOT confirmed under the rule as written: "confirmed only if all six pass", and check 3 fails by 0.8 % on read_bytes for "latest 100 of a channel", with check 2's total-resident part failing on the bench's peak-sum definition. cold stays at 8 KiB unless the lead accepts that reading. For the lead: on every other measure 4 KiB is better or equal (WA -14 % / -19 %, cold.mdb resident -40 %, byMessageId disk reads -43 %, cold p99 -21 % to -31 %, catch-up -11 %), at +4 % bytes per row; the cost is the drop (about 2x pages, 0.85 s projected) and the 2x branch pages. If 4 KiB is adopted, the 80-channel gates would be the 4 KiB medians + 20 %: 2.06 x 1.2 = 2.5x (512) and 2.32 x 1.2 = 2.8x (250).

## Bench changes (bench/ only; src/, README, TANO-v27/db untouched, nothing committed)

* `--cold-page-size N` in 01, 02, 03, 05, 08 (helpers `lmdbWithCold`, `coldPageArgv`, `checkColdPageSize` in lib.mjs), forwarded to every child; every bench records `coldPageSize` and fails if it differs from the flag.
* 02: `ev.flushLagged()` before close; `elog-keys.json`; cold-child event_log queries with latency, major faults and read_bytes per query; extra isolated children (`--elog-only chan|msg`) because the combined child warms byMessageId's pages; note about noReadAhead fixed.
* size-facts: real page size instead of 8192.
* 01 gates (step 4, 4 KiB not confirmed): new index-free single-stream append gate on `ts:u48 seq:u16` cold, <= 1.6x (measured 1.50); 80-channel gates <= 3.0x (512) and <= 3.5x (250); the single-stream-with-indexes check (1.77x) is informational. Verified by one 01 run at 8 KiB: exit 0, all checks pass. That run's 80-channel WA read 2.39 / 2.89 (the new collection shifts the tree slightly), and `test/*.test.js`: 167 pass, 1 skip.

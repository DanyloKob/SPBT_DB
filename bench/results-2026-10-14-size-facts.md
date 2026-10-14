# SPBT_DB size facts (2026-10-14)

AMD Ryzen 5 7535HS with Radeon Graphics, Node v22.23.1, linux-x64. Produced by `bench/size-facts.mjs`.

## Code

* `src/`: 16 files, **3,718 lines of code** (1,309 comment lines, 418 blank, 5,445 in total).
* `test/`: 16 files, 2,820 lines of code.

| file | code | comments | total |
|---|---:|---:|---:|
| ai-schema.js | 45 | 33 | 87 |
| backend-lmdb.js | 180 | 90 | 302 |
| backend-memory.js | 187 | 21 | 234 |
| backend.js | 14 | 77 | 100 |
| blobs.js | 319 | 94 | 445 |
| boot.js | 30 | 34 | 71 |
| buckets.js | 244 | 76 | 344 |
| coalesce.js | 302 | 95 | 417 |
| collection.js | 614 | 195 | 871 |
| frame.js | 213 | 78 | 321 |
| index.js | 121 | 51 | 191 |
| keys.js | 318 | 88 | 438 |
| sched.js | 400 | 145 | 587 |
| schema.js | 71 | 46 | 130 |
| ttl.js | 127 | 57 | 197 |
| vector.js | 533 | 129 | 710 |

## Package

* `npm pack`: **93.4 KB** tarball, 287.5 KB unpacked, 21 files.
* Installed with its dependencies (`node_modules`, linux-x64): **20.1 MB**. Native prebuilds: @lmdb/lmdb-linux-x64 14.9 MB, @msgpackr-extract/msgpackr-extract-linux-x64 59.4 KB.

| package | size |
|---|---:|
| @lmdb/lmdb-linux-x64 | 14.9 MB |
| lmdb | 2.4 MB |
| msgpackr | 2.0 MB |
| node-addon-api | 384.5 KB |
| ordered-binary | 157.0 KB |
| @harperfast/extended-iterable | 66.6 KB |
| @msgpackr-extract/msgpackr-extract-linux-x64 | 59.4 KB |
| weak-lru-cache | 27.5 KB |
| detect-libc | 25.8 KB |
| msgpackr-extract | 15.3 KB |
| node-gyp-build-optional-packages | 14.5 KB |

## RAM at idle (fresh process, after gc)

| process | RSS | anonymous | file-backed | JS heap used |
|---|---:|---:|---:|---:|
| bare Node | 53.5 MB | 13.5 MB | 40 MB | 3.7 MB |
| Node + `import spbt-db` | 71.5 MB | 23 MB | 48.5 MB | 5.8 MB |
| + `openDB()` on an empty dir (core schemas) | 71.7 MB | 23.2 MB | 48.5 MB | 6.2 MB |
| + scheduler and TTL sweeper | 72.1 MB | 23.8 MB | 48.3 MB | 6.2 MB |

## Bytes per record on disk

Averages over the records inserted (in random key order unless noted), measured from the B+tree page counts: "on pages" is the data tree alone, "with indexes" adds every index tree. LMDB pages are 4 KiB in the hot env and 8 KiB in the cold env (event_log).

| collection | records | key | value (frame) | on pages | with indexes | notes |
|---|---:|---:|---:|---:|---:|---|
| guild | 20,000 | 8 B | 102.3 B | 179.4 B | 179.4 B |  |
| guild_feature | 50,000 | 9 B | 8 B | 41.4 B | 70.4 B (feature_enabled) | varint codec, 9 features per guild |
| feature_config (levels, 0.5 KB JSON) | 10,000 | 9 B | 223 B | 378.5 B | 378.5 B | msgpack, under the 512 B deflate threshold (same schema, separate DBI) |
| feature_config (moderation, 4.4 KB JSON) | 10,000 | 9 B | 398.5 B | 682 B | 682 B | msgpack + deflate (the moderation config of 12 commands) |
| user | 50,000 | 8 B | 51.8 B | 105.3 B | 138.5 B (user_by_plan, user_by_expiry) | 10 % premium with an expiry (user_by_expiry is sparse) |
| news | 2,000 | 8 B | 2054 B | 4137 B | 4137 B |  insert order: time |
| level | 100,000 | 16 B | 3 B | 43.4 B | 87.2 B (level_by_xp) | 500 guilds x 200 members |
| kv | 20,001 | 17.4 B | 6.9 B | 50.4 B | 50.4 B |  |
| sched | 50,000 | 9 B | 39.1 B | 86.8 B | 135.6 B (sched_by_subject) | a third of the jobs carry a ~45 B payload insert order: random dueAt |
| event_log | 100,000 | 8 B | 244.9 B | 485.1 B | 536.2 B (elog_by_chan_202610, elog_by_msg_202610) | 40-200 char messages, 15 % edits insert order: time (appendMany of 512) |


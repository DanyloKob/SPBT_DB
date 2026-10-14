# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.0 (2026-10-14)

The first public release. The code is the database written for the TANO Discord bot (TANO v27,
where it was called TanoDB), after a review for correctness bugs. Each fix below has a regression
test in `test/regressions.test.js`, named by its letter. Every one of those tests fails on the
code as it was imported (A and I only on the lmdb backend, which is where those bugs lived), and
passes now.

### Fixed

- **A. `txnAsync` inside an open `db.txn()` aborted the caller's txn and lost a whole coalescer batch.**
  lmdb-js `childTransaction()` called inside a write txn runs the callback at once as a savepoint
  and returns a plain value, not a promise. `runTxnAsync` then threw `Cannot read properties of
  undefined (reading 'then')`. In practice: a `db.level.bump()` inside `db.txn()` that filled the
  buffer (2 000 keys) threw out of `bump()`, rolled back the caller's txn, and dropped every
  buffered XP delta. `runTxnAsync` now runs after the caller's txn, as its own commit, on both
  backends.
- **B. A failed savepoint could make records unreadable for every other reader.** When a nested
  `db.txn()` threw, the list of codecs that had saved new msgpack shared structures in the outer
  txn was cleared. If the outer txn then aborted too, those codecs kept the rolled-back structures
  in memory and kept writing records that referenced them. The same process could read them; a
  reopen or a second process could not (`Data read, but end of buffer not reached`). The codecs
  now stay pending until the outer txn ends.
- **C. `patch()` and `incr()` gave a never-expiring record the schema's default TTL.** A record
  written with `{ expiresAt: 0 }` in a collection with `schema.ttl` gained that TTL on its next
  `patch` or `incr`, and then expired. Both now keep the current expiry, including "never", as
  documented.
- **D. One entry that could not be written blocked a coalescer forever, in a retry storm.** An XP
  delta that would make `xp` negative (the varint field is unsigned) failed the whole flush. The
  batch was restored and, being over `maxEntries`, flushed again at once: 12 896 failed commits in
  one second on lmdb, and on the memory backend a microtask loop that starved the event loop
  completely. No other key was ever written. Now the first retry runs every entry in its own
  savepoint, drops the entries that fail on their own (counted in `metrics().rejected` and
  reported to `onError`), and commits the rest. If every entry fails, the problem is the txn, so
  the batch is kept and retried only on the `flushMs` timer.
- **E. A bad `reschedule` from a scheduler handler re-ran the whole batch on every wake.** A
  handler returning `{ reschedule: 'soon' }` or `{ reschedule: 1e300 }`, or a payload msgpackr
  cannot pack, made the batch commit throw. Nothing was deleted, so every handler in the batch
  (an unban, a role removal) ran again at the next wake, which was due at once. Now such a job
  fails on its own (final, reported to `onError`), a numeric reschedule is clamped to the u48
  range like `at()`, and a failed batch commit makes the next wake wait `stallMs`.
- **F. Due jobs of a kind without a handler could starve every other job.** A wake read a fixed
  window of 2 000 rows. With 2 000 or more due jobs of an unhandled kind at the head of the
  queue, handled jobs behind them never ran. The wake now steps over unhandled rows by their kind
  byte (no decode, no copy), up to `scanMax` (`batch × 64`) of them.
- **G. `dropCollection` left a lagged index's epoch key behind in `__meta`.** One stale key per
  lagged index per dropped collection, e.g. two per month for the event log. Both the watermark
  and the epoch key are now deleted in the drop txn.
- **H. `db.close()` threw when called twice.** A second call (a SIGTERM handler plus a
  `beforeExit` hook, say) touched the closed env: `Can not renew a transaction from a closed
  database`. `close()` now returns the same promise every time, and closes the envs even if an
  earlier step throws.
- **I. `flush()` during a flush resolved before the newest entries were committed.** It returned
  the in-flight flush, which had taken its batch before the caller's latest entries. It now also
  waits for the flush that picks those up.
- **J. TTL `'job'` mode left expired rows on disk forever.** The scheduler runs jobs up to 50 ms
  early. An `expire` job that fired before its row's expiry found the row still live and ended,
  and `'job'` collections are never scanned, so the row was never deleted. Two rows written 30 ms
  apart were enough. The job now re-arms itself for the row's expiry when the row still carries
  the expiry the job was queued for.
- **P. A string or fractional `limit` returned every row.** `query({ limit: '10' })` or
  `top(gid, 2.5)` compared the item count with `===` and never matched, so the whole range came
  back. Limits are now converted with `Math.floor(Number(limit))`, and a non-numeric limit throws.
  The same applies to merged multi-month bucket queries.

### Added

- `open()` and `openDB()` entry points; `openTanoDB()` stays as an alias.
- Coalescer metrics: `rejected` (entries dropped by isolation) and `failing`.
- Scheduler option `scanMax`.

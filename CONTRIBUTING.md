# Contributing

Thanks for looking. SPBT_DB is small on purpose, so the bar for adding code is "it fixes a real
problem and it is measured".

## Setup

Node 22 or newer, Linux x64 (the only platform tested so far).

```sh
npm install
npm test            # node --test test/*.test.js, about 10 s
```

The code is plain ESM with JSDoc types. There is no build step and no other dependency than
`lmdb` and `msgpackr`; please keep it that way.

## Rules for changes

* **A bug fix comes with a regression test** that fails without the fix. Run the test against the
  old code once and say so in the PR. If the bug can happen on both backends, test both
  (`for (const kind of ['memory', 'lmdb'])`, see `test/regressions.test.js`).
* **A performance claim comes with a measurement** on a real disk, never tmpfs (fsync is free
  there). Use the scripts in `bench/` or add one, and put the machine in the PR description.
* **Keep the two backends in step.** `test/backend-conformance.test.js` runs the same contract on
  the memory and the lmdb backend; a new backend method needs a case there.
* **Do not change the on-disk format** (key codec, frame header, sched rows) without a migration
  path. Existing data must keep opening.
* Update `CHANGELOG.md` under an "Unreleased" heading.

## Benchmarks

```sh
npm run bench:json -- --dir ~/.cache/spbtdb-bench   # v26 JSON files vs SPBT_DB, about 8 minutes
npm run bench:size                                   # lines of code, package size, bytes per record
npm run bench:suite -- --dir ~/.cache/spbtdb-bench  # the full suite from the TANO v27 work
```

Each writes `bench/results-<date>-*.json` and `.md`. Commit a result file only when it backs a
number in the README.

## Reporting bugs

Open an issue with the Node version, the OS and file system, a minimal script that shows the
problem, and what you expected. For crash or corruption reports, say whether the process was
killed, the machine lost power, or the disk filled up.

// bench/run.mjs - runs the suite, writes bench/results-<date>.json and bench/results-<date>.md.
//
//   node bench/run.mjs [--dir D] [--only 01,04] [--scale 0.1] [--iterations 200] [--seconds 60] [--tag name]
//
// 00-calibrate runs first; its factors are passed to every other bench (SPBTDB_BENCH_CAL), which
// then gate each check on the value projected to the target (see lib.mjs report()).
// Each bench runs in its own process with --expose-gc. A bench's own exit code is kept: 1 = a
// threshold failed, 2+ = the bench crashed.
// --dir sets the dataset directory for every bench. On tmpfs (e.g. the default $TMPDIR in some
// sandboxes) fsync is free and cannot be evicted: write and cold-read numbers are then meaningless.

import fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, BENCH_DIR, fsInfo, baseDir, hostInfo, log } from './lib.mjs';

const args = parseArgs();
const dir = baseDir(args);
const scale = args.scale ?? 0.1;
const only = args.only ? String(args.only).split(',').map((s) => s.padStart(2, '0')) : null;
const dirArg = ['--dir', dir];

const SUITE = [
  { id: '00', file: '00-calibrate.mjs', argv: [] },
  { id: '01', file: '01-write-throughput.mjs', argv: [] },
  { id: '02', file: '02-read-latency.mjs', argv: ['--scale', String(Math.min(1, scale * 10))] },
  { id: '03', file: '03-rss-at-scale.mjs', argv: ['--scale', String(scale), '--seconds', String(args.seconds ?? 60), '--keep'], label: '03-rss-at-scale (as shipped)' },
  { id: '03', file: '03-rss-at-scale.mjs', argv: ['--scale', String(scale), '--seconds', String(args.seconds ?? 60), '--reuse', '--hot-mapsize', '0', '--cold-readahead'], label: '03-rss-at-scale (pre-r2 env: growing hot map + cold readahead)' },
  { id: '04', file: '04-crash-safety.mjs', argv: ['--iterations', String(args.iterations ?? 200)] },
  { id: '05', file: '05-hotpaths.mjs', argv: [] },
  { id: '08', file: '08-compaction.mjs', argv: ['--scale', String(scale)] },
  { id: '09', file: '09-multiprocess.mjs', argv: ['--incr-ops', String(args['incr-ops'] ?? 20000)] },
];

const started = new Date();
const out = { startedAt: started.toISOString(), host: hostInfo(), fs: fsInfo(dir), scale, benches: [] };
let cal = null;
for (const b of SUITE) {
  if (only && b.id !== '00' && !only.includes(b.id)) continue;
  const label = b.label ?? b.file.replace('.mjs', '');
  log(`\n=== ${label}`);
  const t0 = performance.now();
  const r = spawnSync(process.execPath, ['--expose-gc', join(BENCH_DIR, b.file), ...dirArg, ...b.argv], {
    encoding: 'utf8',
    maxBuffer: 256 * 2 ** 20,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...(cal ? { SPBTDB_BENCH_CAL: JSON.stringify(cal) } : {}) },
  });
  const seconds = +((performance.now() - t0) / 1000).toFixed(1);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { log(`  ${label}: no JSON on stdout (exit ${r.status})`); }
  if (b.id === '00' && json) cal = { factors: json.results.factors };
  out.benches.push({ label, file: b.file, argv: b.argv, exit: r.status, seconds, result: json });
  log(`  -> exit ${r.status} in ${seconds} s`);
}
// 03 (proposed) reused the dataset of 03 (as shipped); remove it now
fs.rmSync(join(dir, '03-rss'), { recursive: true, force: true });
out.finishedAt = new Date().toISOString();

/* ------------------------------------------------------------- markdown */
const fmt = (v) => (v == null ? '–' : typeof v === 'number' ? (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(+v.toPrecision(4))) : String(v));
const lines = [];
lines.push(`# SPBT_DB bench results ${started.toISOString().slice(0, 10)}`);
lines.push('');
lines.push(`Host: ${out.host.cpu}, ${out.host.cores} threads, ${out.host.memMB} MB RAM, node ${out.host.node}, lmdb ${out.host.lmdb}, kernel ${out.host.kernel}.`);
lines.push(`Dataset dir: ${dir} (${out.fs.type}${out.fs.compress ? `, compress=${out.fs.compress}` : ''}). Scale for 03/08: ${scale}.`);
const f = cal?.factors;
lines.push(f ? `Target projection factors (00-calibrate; ASSUMED unless bench/target-host.json exists): cpu ×${f.cpu}, fsync ×${f.fsync}, seq write ×${f.seqWrite}.` : 'No calibration: checks gated on raw local values.');
lines.push('Thresholds are for the target (EPYC 7551 Zen 1, E2.1.Micro); "projected" is the local value scaled to it, and the verdict uses it when present.');
lines.push('');
lines.push('| bench | check | local | projected | threshold | verdict |');
lines.push('|---|---|---:|---:|---:|---|');
for (const b of out.benches) {
  if (!b.result) { lines.push(`| ${b.label} | (bench crashed, exit ${b.exit}) | | | | **ERROR** |`); continue; }
  if (!b.result.checks.length) { lines.push(`| ${b.label} | informational only | | | | info |`); continue; }
  for (const c of b.result.checks) {
    const verdict = c.pass === null ? 'info' : c.pass ? 'PASS' : '**FAIL**';
    lines.push(`| ${b.label} | ${c.name} | ${fmt(c.value)} ${c.unit} | ${fmt(c.projected)} | ${c.op} ${fmt(c.limit)} ${c.unit} | ${verdict} |`);
  }
}
const md = lines.join('\n') + '\n';
const stamp = started.toISOString().slice(0, 10) + (args.tag ? `-${args.tag}` : '');
fs.writeFileSync(join(BENCH_DIR, `results-${stamp}.json`), JSON.stringify(out, null, 2) + '\n');
fs.writeFileSync(join(BENCH_DIR, `results-${stamp}.md`), md);
process.stdout.write(md);
log(`\nwrote bench/results-${stamp}.json and .md`);
process.exitCode = out.benches.some((b) => b.exit !== 0 && b.file !== '00-calibrate.mjs') ? 1 : 0;

// Size facts for the README: lines of code, package size, installed size, RAM at idle, and bytes
// per record of every core collection on disk.
//
//   node bench/size-facts.mjs [--dir DIR] [--npm path/to/npm-cli.js]
//   -> bench/results-<date>-size-facts.json + .md
//
// DIR (default $SPBTDB_BENCH_DIR or ~/.cache/spbtdb-bench) holds the scratch databases and is
// removed afterwards. `npm pack --dry-run` needs npm: found on PATH, or pass --npm.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const DAY = 86_400_000;

/* ------------------------------------------------------------ child: idle */

if (argv[0] === '--idle') {
  // one fresh process per variant: bare Node, Node + the package, + an open empty db, + sched/ttl
  const variant = argv[1], dir = argv[2];
  const tick = () => new Promise((r) => setImmediate(r));
  let db;
  if (variant !== 'node') {
    const { openDB } = await import('../src/index.js');
    if (variant === 'open') db = openDB({ dir });
    if (variant === 'open+sched') db = openDB({ dir, sched: true, ttl: true });
  }
  for (let i = 0; i < 4; i++) { global.gc(); await tick(); }
  await new Promise((r) => setTimeout(r, 200));
  global.gc();
  const s = fs.readFileSync('/proc/self/status', 'utf8');
  const mb = (k) => +((+new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(s)[1]) / 1024).toFixed(1);
  const heap = process.memoryUsage();
  process.stdout.write(JSON.stringify({ variant, rssMB: mb('VmRSS'), anonMB: mb('RssAnon'), fileMB: mb('RssFile'), heapUsedMB: +(heap.heapUsed / 2 ** 20).toFixed(1) }) + '\n');
  if (db) await db.close();
  process.exit(0);
}

/* ------------------------------------------------------------------ LOC */

/** Lines that hold code: not blank, not only a comment (// or inside a block comment). */
function countLines(src) {
  let code = 0, comment = 0, blank = 0, inBlock = false;
  for (const raw of src.split('\n')) {
    let line = raw.trim();
    if (!line) { blank++; continue; }
    let hasCode = false;
    while (line) {
      if (inBlock) {
        const e = line.indexOf('*/');
        if (e < 0) { line = ''; break; }
        inBlock = false;
        line = line.slice(e + 2).trim();
        continue;
      }
      if (line.startsWith('//')) break;
      if (line.startsWith('/*')) { inBlock = true; line = line.slice(2); continue; }
      hasCode = true;
      break; // code on the line (a trailing comment does not make it a comment line)
    }
    if (hasCode) code++; else comment++;
  }
  return { code, comment, blank, total: code + comment + blank };
}

function loc() {
  const dir = path.join(ROOT, 'src');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  const per = {};
  const sum = { code: 0, comment: 0, blank: 0, total: 0 };
  for (const f of files) {
    const c = countLines(fs.readFileSync(path.join(dir, f), 'utf8'));
    per[f] = c;
    for (const k in sum) sum[k] += c[k];
  }
  const testFiles = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.js'));
  let testCode = 0;
  for (const f of testFiles) testCode += countLines(fs.readFileSync(path.join(ROOT, 'test', f), 'utf8')).code;
  return { files: files.length, ...sum, perFile: per, testFiles: testFiles.length, testCode };
}

/* --------------------------------------------------------- package sizes */

function findNpm() {
  if (arg('npm')) return [process.execPath, arg('npm')];
  const w = spawnSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' });
  return w.status === 0 && w.stdout.trim() ? [w.stdout.trim()] : null;
}

function npmPack() {
  const npm = findNpm();
  if (!npm) return { error: 'npm not found (pass --npm path/to/npm-cli.js)' };
  const r = spawnSync(npm[0], [...npm.slice(1), 'pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return { error: r.stderr.slice(0, 500) };
  const [p] = JSON.parse(r.stdout);
  return { tarballBytes: p.size, unpackedBytes: p.unpackedSize, files: p.entryCount, fileList: p.files.map((f) => f.path).sort() };
}

function du(p) {
  let n = 0;
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return 0;
  if (st.isFile()) return st.size;
  if (st.isDirectory()) for (const e of fs.readdirSync(p)) n += du(path.join(p, e));
  return n;
}

function installed() {
  const nm = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(nm)) return { error: 'run npm install first' };
  const pkgs = {};
  for (const e of fs.readdirSync(nm)) {
    if (e.startsWith('.')) continue;
    if (e.startsWith('@')) for (const s of fs.readdirSync(path.join(nm, e))) pkgs[`${e}/${s}`] = du(path.join(nm, e, s));
    else pkgs[e] = du(path.join(nm, e));
  }
  const total = Object.values(pkgs).reduce((a, b) => a + b, 0);
  const native = {};
  for (const [k, v] of Object.entries(pkgs)) if (/^@lmdb\/lmdb-|^@msgpackr-extract\//.test(k)) native[k] = v;
  return { nodeModulesBytes: total, packages: pkgs, nativePrebuilds: native };
}

/* ------------------------------------------------------- bytes per record */

const rnd = (() => { let s = 12345; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
const snow = (i) => 1100000000000000000n + BigInt(i) * 7919n + BigInt(Math.floor(rnd() * 7000));
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
const shuffled = (n) => { const a = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const words = 'бот сервер роль канал повідомлення модерація музика рівень тікет оновлення налаштування guild update role channel music level'.split(' ');
const text = (len) => { let s = ''; while (s.length < len) s += words[Math.floor(rnd() * words.length)] + ' '; return s.slice(0, len); };

async function bytesPerRecord(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  const { openDB, coreSchemas, eventLogSchema, snowflakeTs, DISCORD_EPOCH } = await import('../src/index.js');
  const db = openDB({ dir, sched: { autoStart: false } });
  const out = {};
  const now = Date.now();
  const levelsCfg = { cooldown: 60, notification: { enabled: true, channelId: '900000000000000001', message: '{user} отримав роль **{role}**! ({xp} очок)' }, rewards: [10, 50, 100, 250, 500].map((xp, i) => ({ xp, roleId: String(900000000000000100n + BigInt(i)) })), ignoredChannels: ['900000000000000007'], ignoredRoles: [] };
  const modCfg = () => { const commands = {}; for (const c of ['warn', 'mute', 'unmute', 'kick', 'ban', 'unban', 'tempban', 'clear', 'slowmode', 'lock', 'unlock', 'history']) commands[c] = { enabled: rnd() < 0.9, allowedRoles: [String(snow(1)), String(snow(2))], logChannelId: String(snow(3)), dmUser: c !== 'clear', requireReason: c === 'ban', defaultDuration: c.includes('mute') ? 3_600_000 : null, message: `Користувача {user} покарано командою /${c}. Причина: {reason}` }; return { enabled: true, logChannelId: String(snow(3)), commands }; };

  /** insert `n` records (in the order given) in txns of 1000, then read the page counts */
  async function measure(name, col, n, make, { order = 'random', note } = {}) {
    const idx = order === 'random' ? shuffled(n) : Array.from({ length: n }, (_, i) => i);
    const be = col.backend;
    const txn = (fn) => (be === db.backend('hot') ? db.txn(fn) : db.coldTxn(fn));
    for (let i = 0; i < n; i += 1000) txn(() => { for (let j = i; j < Math.min(n, i + 1000); j++) col.put(make(idx[j])); });
    const st = col.stat();
    const pageSize = be.info ? be.info().pageSize : 4096;
    const dataPages = st[col.name].pages;
    let ixPages = 0;
    for (const k of Object.keys(st)) if (k !== col.name) ixPages += st[k].pages;
    let keyBytes = 0, valBytes = 0, cnt = 0;
    for (const { key, value } of be.range(be.openCollection(col.name, {}), {})) { keyBytes += key.length; valBytes += value.length; cnt++; }
    out[name] = {
      records: cnt,
      keyBytes: +(keyBytes / cnt).toFixed(1),
      valueBytes: +(valBytes / cnt).toFixed(1),
      onPagesBytes: +((dataPages * pageSize) / cnt).toFixed(1),
      withIndexesBytes: +(((dataPages + ixPages) * pageSize) / cnt).toFixed(1),
      indexes: Object.keys(st).filter((k) => k !== col.name),
      pageSize,
      insertOrder: order,
      ...(note ? { note } : {}),
    };
    process.stderr.write(`  ${name}: ${JSON.stringify(out[name])}\n`);
  }

  await measure('guild', db.guild, 20_000, (i) => ({ gid: snow(i), name: `Guild ${i} ${text(12)}`, icon: hex(32), ownerId: snow(i + 1e6), memberCount: Math.floor(rnd() * 5000), joinedAt: now - Math.floor(rnd() * 900) * DAY, locale: 'uk', flags: 0, lastSeenAt: now }));
  await measure('guild_feature', db.guildFeature, 50_000, (i) => ({ gid: snow(Math.floor(i / 9)), tag: 1 + (i % 9), enabled: rnd() < 0.7, enabledAt: now - Math.floor(rnd() * 300) * DAY }), { note: 'varint codec, 9 features per guild' });
  await measure('feature_config (levels, 0.5 KB JSON)', db.collection('feature_config_small', coreSchemas.feature_config), 10_000, (i) => ({ gid: snow(i), tag: 8, ...levelsCfg }), { note: 'msgpack, under the 512 B deflate threshold (same schema, separate DBI)' });
  await measure('feature_config (moderation, 4.4 KB JSON)', db.featureConfig, 10_000, (i) => ({ gid: snow(i), tag: 6, ...modCfg() }), { note: 'msgpack + deflate (the moderation config of 12 commands)' });
  await measure('user', db.user, 50_000, (i) => ({ uid: snow(i), plan: rnd() < 0.1 ? 1 : 0, since: now - Math.floor(rnd() * 700) * DAY, ...(rnd() < 0.1 ? { planExpiresAt: now + Math.floor(rnd() * 60) * DAY } : {}), username: `user_${Math.floor(rnd() * 1e6)}`, avatarHash: Buffer.from(hex(32), 'hex'), seenAt: now }), { note: '10 % premium with an expiry (user_by_expiry is sparse)' });
  await measure('news', db.news, 2_000, (i) => ({ createdAt: now - (2000 - i) * DAY / 10, seq: 0, title: text(60), body: text(1200), tags: ['update'], authorId: snow(7), pinned: false }), { order: 'time' });
  await measure('level', db.level, 100_000, (i) => ({ gid: snow(Math.floor(i / 200)), uid: snow(1e6 + i), xp: Math.floor(rnd() * 5000) }), { note: '500 guilds x 200 members' });
  await measure('kv', db.kv, 20_000, (i) => ({ k: `cfg:${i}:${hex(6)}`, v: Math.floor(rnd() * 1e6) }));

  // sched rows (raw frames + the sched_by_subject index) through the scheduler's own API
  db.sched.defineKind('bench', 200);
  const kinds = ['unban', 'unmute', 'role_remove', 'msg_send', 'ticket_autoclose', 'bench'];
  for (let i = 0; i < 50_000; i += 1000) db.txn(() => { for (let j = i; j < i + 1000; j++) db.sched.at(now + Math.floor(rnd() * 30 * DAY), { kind: kinds[j % kinds.length], gid: snow(j % 500), subject: snow(1e6 + j), ...(j % 3 === 0 ? { payload: { reason: text(30) } } : {}) }); });
  {
    const be = db.backend('hot');
    const s = be.stat(be.openCollection('sched', {})), x = be.stat(be.openCollection('sched_by_subject', { dupSort: true }));
    let valBytes = 0, cnt = 0;
    for (const { value } of be.range(be.openCollection('sched', {}), {})) { valBytes += value.length; cnt++; }
    out.sched = { records: cnt, keyBytes: 9, valueBytes: +(valBytes / cnt).toFixed(1), onPagesBytes: +((s.pages * 4096) / cnt).toFixed(1), withIndexesBytes: +(((s.pages + x.pages) * 4096) / cnt).toFixed(1), indexes: ['sched_by_subject'], pageSize: 4096, insertOrder: 'random dueAt', note: 'a third of the jobs carry a ~45 B payload' };
    process.stderr.write(`  sched: ${JSON.stringify(out.sched)}\n`);
  }

  // event_log: one month bucket in the cold env, appended in time order like the bot does
  const elog = db.bucketed('event_log', eventLogSchema, { retentionDays: 30 });
  const t0 = Date.UTC(2026, 9, 1);
  const rows = 100_000;
  for (let i = 0; i < rows; i += 512) {
    const batch = [];
    for (let j = i; j < Math.min(rows, i + 512); j++) {
      const ts = t0 + j * 20;
      const msgId = String((BigInt(ts - DISCORD_EPOCH) << 22n) + BigInt(j & 0xfff));
      const edit = rnd() < 0.15;
      batch.push({ gid: snow(j % 50), chan: snow(1e5 + (j % 80)), ts: edit ? ts + 1000 : snowflakeTs(msgId), k: edit ? 1 : 0, msgId, authorId: snow(2e6 + (j % 3000)), content: text(40 + Math.floor(rnd() * 160)) });
    }
    elog.appendMany(batch);
  }
  {
    const col = elog.collectionFor(t0);
    col.flushLagged();
    const st = col.stat();
    let ix = 0;
    for (const k of Object.keys(st)) if (k !== col.name) ix += st[k].pages;
    let valBytes = 0, cnt = 0;
    const be = col.backend;
    for (const { value } of be.range(be.openCollection(col.name, {}), {})) { valBytes += value.length; cnt++; }
    const pageSize = db.stats().cold.pageSize;
    out.event_log = { records: cnt, keyBytes: 8, valueBytes: +(valBytes / cnt).toFixed(1), onPagesBytes: +((st[col.name].pages * pageSize) / cnt).toFixed(1), withIndexesBytes: +(((st[col.name].pages + ix) * pageSize) / cnt).toFixed(1), indexes: Object.keys(st).filter((k) => k !== col.name), pageSize, insertOrder: 'time (appendMany of 512)', note: '40-200 char messages, 15 % edits' };
    process.stderr.write(`  event_log: ${JSON.stringify(out.event_log)}\n`);
  }
  out._files = { hotMdbBytes: fs.statSync(path.join(dir, 'hot.mdb')).size, coldMdbBytes: fs.statSync(path.join(dir, 'cold.mdb')).size };
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

/* ------------------------------------------------------------------ main */

const root = path.resolve(arg('dir') ?? process.env.SPBTDB_BENCH_DIR ?? path.join(os.homedir(), '.cache', 'spbtdb-bench'));
fs.mkdirSync(root, { recursive: true });
const res = { date: new Date().toISOString().slice(0, 10), node: process.version, cpu: os.cpus()[0]?.model, platform: `${process.platform}-${process.arch}` };
res.loc = loc();
res.pack = npmPack();
res.installed = installed();
res.idle = [];
for (const v of ['node', 'import', 'open', 'open+sched']) {
  const d = path.join(root, `idle-${v}`);
  fs.rmSync(d, { recursive: true, force: true });
  const r = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--idle', v, d], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  res.idle.push(JSON.parse(r.stdout.trim().split('\n').pop()));
  fs.rmSync(d, { recursive: true, force: true });
}
res.records = await bytesPerRecord(path.join(root, 'records'));

const kb = (b) => (b >= 2 ** 20 ? `${(b / 2 ** 20).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`);
const L = [];
L.push(`# SPBT_DB size facts (${res.date})`);
L.push('');
L.push(`${res.cpu}, Node ${res.node}, ${res.platform}. Produced by \`bench/size-facts.mjs\`.`);
L.push('');
L.push('## Code');
L.push('');
L.push(`* \`src/\`: ${res.loc.files} files, **${res.loc.code.toLocaleString('en')} lines of code** (${res.loc.comment.toLocaleString('en')} comment lines, ${res.loc.blank.toLocaleString('en')} blank, ${res.loc.total.toLocaleString('en')} in total).`);
L.push(`* \`test/\`: ${res.loc.testFiles} files, ${res.loc.testCode.toLocaleString('en')} lines of code.`);
L.push('');
L.push('| file | code | comments | total |');
L.push('|---|---:|---:|---:|');
for (const [f, c] of Object.entries(res.loc.perFile)) L.push(`| ${f} | ${c.code} | ${c.comment} | ${c.total} |`);
L.push('');
L.push('## Package');
L.push('');
if (res.pack.error) L.push(`* npm pack: ${res.pack.error}`);
else L.push(`* \`npm pack\`: **${kb(res.pack.tarballBytes)}** tarball, ${kb(res.pack.unpackedBytes)} unpacked, ${res.pack.files} files.`);
if (!res.installed.error) {
  const nat = Object.entries(res.installed.nativePrebuilds).map(([k, v]) => `${k} ${kb(v)}`).join(', ');
  L.push(`* Installed with its dependencies (\`node_modules\`, ${res.platform}): **${kb(res.installed.nodeModulesBytes)}**. Native prebuilds: ${nat}.`);
  L.push('');
  L.push('| package | size |');
  L.push('|---|---:|');
  for (const [k, v] of Object.entries(res.installed.packages).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${kb(v)} |`);
}
L.push('');
L.push('## RAM at idle (fresh process, after gc)');
L.push('');
L.push('| process | RSS | anonymous | file-backed | JS heap used |');
L.push('|---|---:|---:|---:|---:|');
const label = { node: 'bare Node', import: 'Node + `import spbt-db`', open: '+ `openDB()` on an empty dir (core schemas)', 'open+sched': '+ scheduler and TTL sweeper' };
for (const x of res.idle) L.push(`| ${label[x.variant]} | ${x.rssMB} MB | ${x.anonMB} MB | ${x.fileMB} MB | ${x.heapUsedMB} MB |`);
L.push('');
L.push('## Bytes per record on disk');
L.push('');
L.push('Averages over the records inserted (in random key order unless noted), measured from the B+tree page counts: "on pages" is the data tree alone, "with indexes" adds every index tree. LMDB pages are 4 KiB in the hot env and 8 KiB in the cold env (event_log).');
L.push('');
L.push('| collection | records | key | value (frame) | on pages | with indexes | notes |');
L.push('|---|---:|---:|---:|---:|---:|---|');
for (const [k, v] of Object.entries(res.records)) {
  if (k.startsWith('_')) continue;
  L.push(`| ${k} | ${v.records.toLocaleString('en')} | ${v.keyBytes} B | ${v.valueBytes} B | ${v.onPagesBytes} B | ${v.withIndexesBytes} B${v.indexes.length ? ` (${v.indexes.join(', ')})` : ''} | ${v.note ?? ''}${v.insertOrder !== 'random' ? ` insert order: ${v.insertOrder}` : ''} |`);
}
L.push('');
const home = os.homedir();
const scrub = (s) => s.split(home).join('~');
const base = path.join(HERE, `results-${res.date}-size-facts`);
fs.writeFileSync(`${base}.json`, scrub(JSON.stringify(res, null, 2)) + '\n');
fs.writeFileSync(`${base}.md`, scrub(L.join('\n')) + '\n');
console.error(`wrote ${path.relative(process.cwd(), base)}.{json,md}`);
try { fs.rmdirSync(root); } catch {} // only if empty: the directory may hold other runs

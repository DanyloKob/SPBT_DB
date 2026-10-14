// Test helpers (no tests in this file).
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { createMemoryBackend } from '../src/backend-memory.js';
import { createLmdbBackend } from '../src/backend-lmdb.js';

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    float: next,
    int: (n) => Math.floor(next() * n),
    big64: () => (BigInt(Math.floor(next() * 2 ** 32)) << 32n) | BigInt(Math.floor(next() * 2 ** 32)),
  };
}

export function tmpDir(tag) {
  return fs.mkdtempSync(join(os.tmpdir(), `spbt-db-${tag}-`));
}

/** Backend factories shared by the conformance and collection tests. */
export const BACKENDS = {
  memory: () => ({ backend: createMemoryBackend(), cleanup: async () => {} }),
  lmdb: () => {
    const dir = tmpDir('lmdb');
    const backend = createLmdbBackend({ path: join(dir, 'hot.mdb'), profile: 'hot' });
    return { backend, dir, cleanup: async () => { await backend.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
  },
};

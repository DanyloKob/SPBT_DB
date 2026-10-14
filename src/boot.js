// SPBT_DB `__boot` record (design §4.5): did the previous process shut down cleanly?
//
//   kv['__boot'] = { bootId, startedAt, cleanShutdown, writerPid, dirtyBoots, stoppedAt? }
//
// open:  read the previous record, then write a new one with cleanShutdown: false
//        (one commit, NOT fsynced: see below). If the previous one is still false, that process died without
//        db.close() (kill -9, OOM, power loss): its coalescer buffers (§7.3) are gone, and
//        dirtyBoots (the spbtdb_dirty_boot_total metric) is incremented.
// close: after the coalescers are flushed, cleanShutdown: true (one commit).

import { randomBytes } from 'node:crypto';
import { coreSchemas } from './schema.js';
import { runTxn } from './collection.js';

export const BOOT_KEY = '__boot';

/**
 * @typedef {object} BootRecord
 * @property {string} bootId
 * @property {number} startedAt
 * @property {boolean} cleanShutdown
 * @property {number} writerPid
 * @property {number} dirtyBoots     how many opens found an unclean previous shutdown (all time)
 * @property {number} [stoppedAt]
 *
 * @typedef {object} BootInfo
 * @property {BootRecord} current
 * @property {BootRecord | null} previous     null on the first open of a data dir
 * @property {boolean | null} lastShutdownClean  null on the first open
 * @property {number} dirtyBoots
 */

const kvOf = (db) => db.collections.get('kv') ?? db.collection('kv', coreSchemas.kv);

/**
 * Record this process as the writer. @param {any} db @param {{ clock?: () => number }} [o]
 * @returns {BootInfo}
 */
export function markBoot(db, o = {}) {
  const clock = o.clock ?? Date.now;
  const kv = kvOf(db);
  const prev = kv.get(BOOT_KEY) ?? null;
  const dirty = prev !== null && prev.cleanShutdown !== true;
  const current = {
    bootId: randomBytes(8).toString('hex'),
    startedAt: clock(),
    cleanShutdown: false,
    writerPid: process.pid,
    dirtyBoots: (prev?.dirtyBoots ?? 0) + (dirty ? 1 : 0),
  };
  // Committed but not fsynced (backend.txnLazy): after a kill -9 the first DURABLE commit has to
  // flush whatever the dead writer left dirty in the page cache (fdatasync covers the whole file),
  // which measured up to 1-2 s on btrfs. That cost now lands on the first real sync commit (or the
  // background flush), not inside openDB. A process crash keeps the record (page cache); a
  // power loss may roll it back with the other unflushed txns, and is detected by the OS boot id.
  runTxn(kv.backend, () => kv.put({ k: BOOT_KEY, ...current }), { lazy: true });
  return { current, previous: prev, lastShutdownClean: prev === null ? null : !dirty, dirtyBoots: current.dirtyBoots };
}

/** Mark the shutdown clean (call after every buffer is flushed). @param {any} db @param {BootInfo} info */
export function markCleanShutdown(db, info, o = {}) {
  const clock = o.clock ?? Date.now;
  const kv = kvOf(db);
  const cur = kv.get(BOOT_KEY);
  if (cur && cur.bootId !== info.current.bootId) return false; // another writer took over: leave its record alone
  info.current.cleanShutdown = true;
  info.current.stoppedAt = clock();
  kv.put({ k: BOOT_KEY, ...info.current });
  return true;
}

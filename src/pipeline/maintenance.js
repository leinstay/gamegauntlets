// Maintenance jobs run by the `maintenance` BullMQ worker (src/worker.js):
// `retention` (delete old roll_log rows) and `export` (nightly steamdb
// export). Kept separate from worker.js so the retention loop/SQL and the
// export dynamic-import guard can be unit-tested with a fake `db`/`log`, no
// real MySQL connection or src/pipeline/export-push.js required.
//
// src/worker.js's `maintenance` worker only ever calls runRetention(db, months, { log }) for its
// repeatable 'retention' job (job.name === 'retention') - the one existing "daily maintenance job" this
// codebase has. So the nightly non-game purge (src/pipeline/purge-non-games.js) is run from inside
// runRetention itself, right after the roll_log sweep, rather than as a separate job worker.js would need
// to know how to dispatch: guarded by config.maintenance.purgeNonGames (default true), read directly from
// src/config.js's singleton (mirrors runExport()'s own export-push.js reading config.export.enabled
// itself) so this doesn't need a new argument threaded through worker.js's call site.

import { config } from '../config.js';
import { purgeNonGames } from './purge-non-games.js';

const RETENTION_BATCH_LIMIT = 50_000;

/**
 * SQL for one retention batch. `months` and `limit` are always passed as
 * bound parameters (never interpolated).
 */
export function retentionDeleteSql() {
  return 'DELETE FROM roll_log WHERE created_at < NOW() - INTERVAL ? MONTH LIMIT ?';
}

/**
 * Delete `roll_log` rows older than `months` months, `limit` rows at a time,
 * looping until a batch deletes fewer than `limit` rows (including zero).
 * `db` only needs a `query(sql, params)` method returning something with
 * `.affectedRows` (a mysql2 OkPacket in production, a plain object in
 * tests). Returns the total number of rows deleted.
 */
export async function runRetention(db, months, { limit = RETENTION_BATCH_LIMIT, log } = {}) {
  const sql = retentionDeleteSql();
  let totalDeleted = 0;
  for (;;) {
    const result = await db.query(sql, [months, limit]);
    const affected = result?.affectedRows ?? 0;
    totalDeleted += affected;
    log?.info?.('maintenance: retention batch', { affected, totalDeleted, months });
    if (affected < limit) break;
  }

  // Piggybacks on the same daily job as the roll_log sweep above - see the module-level comment for why
  // this lives here rather than as its own worker.js-dispatched job.
  if (config.maintenance?.purgeNonGames ?? true) {
    const { purged, skipped } = await purgeNonGames({ db, log });
    log?.info?.('maintenance: purge non-games', { purged: purged.length, skipped });
  }

  return totalDeleted;
}

/**
 * Nightly steamdb export. `src/pipeline/export-push.js` is a later task (T20);
 * until it exists this dynamically imports it behind a guard so the
 * repeatable `export` job is a harmless no-op rather than a failing job.
 * Calls its `main` export if present, else its default export.
 */
export async function runExport({ log } = {}) {
  let mod;
  try {
    // Sibling module; imported lazily so tests of this file never load git/DB code.
    mod = await import('./export-push.js');
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      log?.info?.('maintenance: src/pipeline/export-push.js not present yet, skipping export');
      return { skipped: true };
    }
    throw err;
  }
  const run = mod.main ?? mod.default;
  if (typeof run !== 'function') {
    log?.warn?.('maintenance: src/pipeline/export-push.js has no main()/default export, skipping');
    return { skipped: true };
  }
  return run();
}

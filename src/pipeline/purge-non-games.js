// Physically deletes games the classifier (or an admin) has flagged non_game (src/lib/non-game.js,
// `games.non_game`) instead of merely hiding them from the wheel - the owner's decision (2026-09-19): "the
// base must contain standalone games only". Called nightly from src/pipeline/maintenance.js's
// runRetention() (config.maintenance.purgeNonGames, default true); also importable directly
// (`import('./src/pipeline/purge-non-games.js')`) by a one-off external script - no CLI entry lives in
// this repo (owner's rule: one-off tools stay outside git).
//
// For each candidate game, in its own transaction:
//   1. Tombstone every `source_records` row that still points at it: `game_id = NULL`, `status =
//      'not_found'`, a descriptive `error`, and (payload NULL-ed for every other source, to save space)
//      a small `{purged:true, class, name}` payload kept ONLY on 'steam'/'gog' rows - src/sources/
//      steam.js's / src/sources/gog.js's fetchOne() reads that payload back before ever creating a new
//      `games` row for the same external id, so a source can never silently recreate a game this purge
//      just deleted. `source_records.game_id` has NO foreign key to `games.id` (unlike `game_links`/
//      `conflicts`/`overrides`/`preset_games`, which do and cascade on delete - see migrations/
//      001_init.sql), so this step must be an explicit UPDATE or those rows would be left dangling,
//      pointing at a games.id that no longer exists.
//   2. `DELETE FROM games WHERE id = ?` - `game_links`/`conflicts`/`overrides`/`preset_games` rows for it
//      cascade away automatically via their own FK (see src/api/admin.js:476 for the same cascade already
//      relied on for `preset_games`).
//
// A game with an admin override on the `non_game` field itself is never purged: an override that sets it
// back to NULL already makes `games.non_game IS NULL` (so it never matches the candidate query's own
// `non_game IS NOT NULL` half at all), and an override that instead pins it to a class is still a standing
// admin decision the resolver keeps re-applying every pass (src/pipeline/resolve.js) - purge must not
// destroy the row out from under a decision an admin could still reverse. Either way, the simple rule
// "skip any game with an overrides row for field='non_game'" covers both cases correctly.

const DEFAULT_LIMIT = 500;

const SELECT_CANDIDATES_SQL = `
  SELECT g.id, g.name, g.non_game
  FROM games g
  WHERE g.non_game IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM overrides o WHERE o.game_id = g.id AND o.field = 'non_game')
  LIMIT ?
`;

const COUNT_SKIPPED_SQL = `
  SELECT COUNT(*) AS c
  FROM games g
  WHERE g.non_game IS NOT NULL
    AND EXISTS (SELECT 1 FROM overrides o WHERE o.game_id = g.id AND o.field = 'non_game')
`;

// Every source_records row for the game EXCEPT steam/gog: payload NULL-ed (nothing there is worth
// remembering once the game is gone - see module header).
const TOMBSTONE_OTHER_SOURCES_SQL = `
  UPDATE source_records
  SET game_id = NULL, status = 'not_found', error = ?, payload = NULL
  WHERE game_id = ? AND source NOT IN ('steam', 'gog')
`;

// steam/gog rows keep a small marker payload - this is the row src/sources/steam.js's / gog.js's
// fetchOne() reads back to refuse recreating the game (see isPurgedTombstone()/buildTombstonePayload()).
const TOMBSTONE_STORE_SOURCES_SQL = `
  UPDATE source_records
  SET game_id = NULL, status = 'not_found', error = ?, payload = ?
  WHERE game_id = ? AND source IN ('steam', 'gog')
`;

const DELETE_GAME_SQL = 'DELETE FROM games WHERE id = ?';

function tombstoneError(cls) {
  return `purged non-game (${cls})`;
}

/**
 * The payload shape written to a purged game's 'steam'/'gog' `source_records` rows, and what
 * `isPurgedTombstone()` recognises on the way back in. `cls` is one of `games.non_game`'s enum values.
 */
export function buildTombstonePayload({ cls, name }) {
  return { purged: true, class: cls, name: name ?? null };
}

/**
 * `payload` is an already-`JSON.parse()`d `source_records.payload` (or null/undefined) - true when it
 * marks this (source, external_id) as a game purge already tombstoned, i.e. "do not recreate this game".
 */
export function isPurgedTombstone(payload) {
  return Boolean(payload) && payload.purged === true;
}

async function purgeOne(db, row, log) {
  const errorMessage = tombstoneError(row.non_game);
  const tombstonePayload = JSON.stringify(buildTombstonePayload({ cls: row.non_game, name: row.name }));

  const run = async (scopedDb) => {
    await scopedDb.query(TOMBSTONE_OTHER_SOURCES_SQL, [errorMessage, row.id]);
    await scopedDb.query(TOMBSTONE_STORE_SOURCES_SQL, [errorMessage, tombstonePayload, row.id]);
    await scopedDb.query(DELETE_GAME_SQL, [row.id]);
  };

  if (typeof db.tx === 'function') {
    await db.tx(run);
  } else {
    await run(db);
  }

  log?.info?.('purge-non-games: purged', { id: row.id, name: row.name, class: row.non_game });
}

/**
 * `purgeNonGames(ctx, { dryRun, limit }) -> { purged: [{id, name, class}], skipped }`.
 *
 * `ctx` only needs `ctx.db` (`{query, one}`, optionally `.tx` for the one-transaction-per-game guarantee
 * described in the module header - mirrors src/pipeline/resolve.js's own `ctx.db` contract) and
 * `ctx.log`. `limit` bounds how many games are purged in one call (default 500, a batch small enough to
 * run inside the nightly retention job without holding a long-running transaction open per game).
 * `dryRun` runs both SELECTs and reports what *would* be purged, without writing anything.
 */
export async function purgeNonGames(ctx, { dryRun = false, limit = DEFAULT_LIMIT } = {}) {
  const { db, log } = ctx;

  const [candidates, skippedRow] = await Promise.all([
    db.query(SELECT_CANDIDATES_SQL, [limit]),
    db.one(COUNT_SKIPPED_SQL, []),
  ]);
  const skipped = Number(skippedRow?.c ?? 0);

  const purged = [];
  for (const row of candidates) {
    if (!dryRun) await purgeOne(db, row, log);
    purged.push({ id: row.id, name: row.name, class: row.non_game });
  }

  return { purged, skipped };
}

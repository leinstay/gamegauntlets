// The resolve step of the ingestion pipeline (spec docs/specs/2026-09-19-rewrite-design.md §5 item 5,
// §6): for one game, load everything known about it, run each source's extract(), merge through the pure
// resolver (src/lib/resolver/index.js), and persist the result. `src/worker.js`'s `resolve` BullMQ worker
// dynamically imports this file and calls `resolveGame(ctx, job.data.gameId)`.
//
// `ctx` (built by src/pipeline/context.js / scripts/resolve-all.js) only needs `ctx.db.query`/`ctx.db.one`
// (the mysql2-shaped interface every other pipeline module already uses — see maintenance.js) plus
// `ctx.config` and `ctx.log`. When `ctx.db.tx(fn)` (src/db.js's real transaction wrapper) is also present —
// as it is for both real callers, `src/worker.js`'s `resolve` worker and `scripts/resolve-all.js` — the
// SELECTs + UPDATE + conflicts upsert/delete run as one transaction per game; a `ctx.db` without `tx` (e.g.
// a fake `{ query, one }` in a test) still works, just without that guarantee.

import { getSource } from '../sources/index.js';
import { resolveGame as computeResolution } from '../lib/resolver/index.js';
import { classifyNonGame, bundleBaseName } from '../lib/non-game.js';
import { classifyPurchasable } from '../lib/purchasable.js';
import { normalizeName } from '../lib/names.js';

// Never overwritten by the resolver: identity is set once by scripts/migrate-legacy.js or a catalog
// source's insert, and only ever changed afterwards through an explicit admin override.
const IDENTITY_COLUMNS = new Set(['id', 'kind', 'steam_appid', 'gog_id']);
const JSON_COLUMNS = new Set(['ggp_parts']);

// These are genuinely *derived facts about the current set of sources*, not data relayed from one of them —
// release date/gg_score/final_time/ggp/ggp_parts must go back to null the moment the sources that produced
// them stop reporting, the same way `conflicts` (reconciled unconditionally below, on every pass) must. Every
// other column follows the general rule instead (see buildUpdateSql): most of the ~111k games migrated from
// legacy have only a `legacy_steamdb` source_records row until Steam/GOG re-fetch them (days later), and a
// resolve pass in between must not blank their name/image/description/prices/etc. just because this
// particular pass's fieldsBySource has nothing to say about a field — see legacy_steamdb.js, which now
// supplies those as a lowest-priority fallback specifically so they're populated in the meantime.
const ALWAYS_RECOMPUTE_COLUMNS = new Set([
  'gg_score',
  'final_time',
  'time_complete', // computed by the same time.js call as final_time; kept in lock-step with it
  'ggp',
  'ggp_parts',
  'release_date',
  'release_precision',
  'release_confidence',
  'early_access_date',
  'store_release_date',
  // Same reasoning as the release/score/time columns above: classifyNonGame()'s answer is a fact about
  // the *current* source set (name/genres/Steam type), and must go back to null the moment whatever made
  // it non-null (e.g. a bad name match, a since-corrected Steam type) stops being true - see
  // src/lib/non-game.js.
  'non_game',
  // Same reasoning again: classifyPurchasable()'s answer (src/lib/purchasable.js, migrations/
  // 005_purchasable.sql) is a fact about the *current* live Steam/GOG evidence (price, package_groups/
  // isAvailableForSale, release date) and must go back to 1 ("purchasable") the moment whatever made it 0
  // (e.g. Steam re-lists the game) stops being true.
  'purchasable',
]);

function isBlank(value) {
  return value === null || value === undefined || value === '';
}

function parseJsonMaybe(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value; // already parsed (e.g. mysql2 JSON type, or a test fixture)
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function loadOverrides(db, gameId) {
  const rows = await db.query('SELECT field, value FROM overrides WHERE game_id = ?', [gameId]);
  const overrides = {};
  for (const row of rows) overrides[row.field] = parseJsonMaybe(row.value);
  return overrides;
}

function parsePayloadMaybe(payload) {
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * GOG's product type for src/lib/non-game.js's classifyNonGame(), read straight off the 'gog' source's
 * already-fetched 'ok' record (part of `records`, no extra query needed) rather than through extract() -
 * the extracted-field vocabulary (src/lib/resolver/index.js) has no `productType` key, only src/sources/
 * gog.js's raw stored payload does. Prefers the catalog-listing snippet's lowercase value ('game'/'pack',
 * src/sources/gog.js's discover()) and falls back to the details endpoint's own (uppercase 'GAME') field.
 */
function findGogType(records) {
  const record = records.find((r) => r.source === 'gog');
  if (!record) return null;
  const payload = parsePayloadMaybe(record.payload);
  return payload?.catalog?.productType ?? payload?.en?._embedded?.product?.productType ?? null;
}

/**
 * Steam's appdetails `type` for a game whose Steam side is NOT a game (src/sources/steam.js's fetchOne(),
 * the `enEntry.data.type !== 'game'` branch: recorded `status: 'not_found'` with `payload: { appType }`,
 * never status 'ok', so it never reaches `records`/fieldsBySource above - buildFieldsBySource() and this
 * function's own caller only load status='ok' rows). Only queried when this game has no 'ok' 'steam'
 * record already (a confirmed real game, in which case there's nothing useful a not_found row could add).
 */
async function findSteamNotFoundType(db, gameId) {
  const rows = await db.query(
    "SELECT payload FROM source_records WHERE game_id = ? AND source = 'steam' AND status = 'not_found' AND payload IS NOT NULL",
    [gameId],
  );
  for (const row of rows) {
    const payload = parsePayloadMaybe(row.payload);
    if (payload?.appType) return payload.appType;
  }
  return null;
}

/**
 * For a "<Base> + <extras>"-shaped title (src/lib/non-game.js's bundleBaseName()), check whether a
 * separate real base-game row for `base` actually exists in `games` - only then does classifyNonGame()
 * classify this listing `bundle` rather than leaving a likely sole listing (e.g. "KINGDOM HEARTS III + Re
 * Mind (DLC)") unflagged. `non_game IS NULL` excludes matching against another non-game row that happens
 * to share a normalized name (e.g. a same-named soundtrack entry) - only a real, currently-unflagged game
 * counts as "the base game exists". One indexed lookup (ix_games_name), only ever run for a bundle-shaped
 * title, never for the other ~110k rows.
 *
 * Exported so src/sources/steam.js / src/sources/gog.js's fetchOne() can run the exact same check before
 * *creating* a brand new `games` row for a bundle-shaped title (see their own module comments) - the
 * candidate has no `id` of its own yet at that point, so `excludeGameId` is simply omitted rather than
 * passed as e.g. 0 or null; imported lazily (dynamic `import()`) by those two callers specifically to
 * avoid a static import cycle back through this module's own `getSource()` (src/sources/index.js) import.
 */
export async function findBaseGameExists(db, base, excludeGameId) {
  const row =
    excludeGameId === undefined || excludeGameId === null
      ? await db.one('SELECT id FROM games WHERE name_normalized = ? AND non_game IS NULL LIMIT 1', [normalizeName(base)])
      : await db.one(
          'SELECT id FROM games WHERE name_normalized = ? AND id <> ? AND non_game IS NULL LIMIT 1',
          [normalizeName(base), excludeGameId],
        );
  return !!row;
}

/**
 * Run every registered source module's `extract()` over this game's `source_records` (status 'ok'),
 * merging into `{ [source]: extractedFields }`. A record whose source isn't registered (typo, a module
 * that was removed, ...), or whose payload isn't valid JSON, or whose `extract()` throws, is skipped with a
 * warning rather than failing the whole resolve — one bad record must never block every other source.
 */
function buildFieldsBySource(records, log) {
  const fieldsBySource = {};
  for (const record of records) {
    const mod = getSource(record.source);
    if (!mod || typeof mod.extract !== 'function') {
      log?.warn?.('resolve: unknown source, skipping', { source: record.source, externalId: record.external_id });
      continue;
    }

    let payload = null;
    if (record.payload !== null && record.payload !== undefined) {
      try {
        payload = typeof record.payload === 'string' ? JSON.parse(record.payload) : record.payload;
      } catch (err) {
        log?.warn?.('resolve: invalid payload JSON, skipping', { source: record.source, error: String(err?.message ?? err) });
        continue;
      }
    }

    let fields;
    try {
      fields = mod.extract(payload) || {};
    } catch (err) {
      log?.warn?.('resolve: extract() threw, skipping', { source: record.source, error: String(err?.message ?? err) });
      continue;
    }

    // A game can in principle have more than one source_records row for the same source (e.g. a stale
    // external id from a past match); later rows win per field.
    fieldsBySource[record.source] = { ...(fieldsBySource[record.source] || {}), ...fields };
  }
  return fieldsBySource;
}

/**
 * Build the `UPDATE games SET ...` statement from the resolver's `columns`.
 *
 * A column is included only if there is something to actually write:
 *  - Identity columns (id/kind/steam_appid/gog_id) are skipped entirely unless an admin override exists —
 *    identity is never recomputed by the resolver itself, overrides are the only way to change it.
 *  - Every other column is skipped when the resolver's value for it is blank (null/undefined/'') *and*
 *    there's no override for it — i.e. no source this pass reported anything for that column, so the
 *    existing DB value (set by a previous resolve, or by scripts/migrate-legacy.js) is left untouched
 *    rather than blanked.
 *  - `ALWAYS_RECOMPUTE_COLUMNS` are written every pass even when blank, because they're derived facts about
 *    the *current* source set (see that constant's comment).
 *  - An override always wins and is always written, blank or not (an admin explicitly setting a field to
 *    empty is a deliberate action, not "nobody knows").
 */
function buildUpdateSql(gameId, columns, overrides) {
  const assignments = [];
  const params = [];

  for (const [column, value] of Object.entries(columns)) {
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides || {}, column);
    if (IDENTITY_COLUMNS.has(column) && !hasOverride) continue;
    if (!ALWAYS_RECOMPUTE_COLUMNS.has(column) && isBlank(value) && !hasOverride) continue;
    assignments.push(`${column} = ?`);
    params.push(JSON_COLUMNS.has(column) && value !== null && value !== undefined ? JSON.stringify(value) : value);
  }
  assignments.push('resolved_at = NOW()');
  params.push(gameId);

  return { sql: `UPDATE games SET ${assignments.join(', ')} WHERE id = ?`, params };
}

/**
 * Upsert/clear `conflicts` rows for this game: every field the resolver flags this pass gets an 'open' row
 * (refreshed if it already existed as 'open'; left alone if an admin already marked it 'accepted'/
 * 'overridden' — that decision always wins over a fresh recompute). Any existing 'open' row for a field the
 * resolver did *not* flag this pass is deleted (no longer in conflict). 'accepted'/'overridden' rows are
 * never deleted here — only an admin action removes those.
 */
async function reconcileConflicts(db, gameId, conflicts) {
  const existing = await db.query('SELECT field, status FROM conflicts WHERE game_id = ?', [gameId]);
  const statusByField = new Map(existing.map((row) => [row.field, row.status]));
  const activeFields = new Set(conflicts.map((c) => c.field));

  for (const conflict of conflicts) {
    const status = statusByField.get(conflict.field);
    if (status === 'accepted' || status === 'overridden') continue;
    await db.query(
      `INSERT INTO conflicts (game_id, field, candidates, reason, status)
       VALUES (?, ?, ?, ?, 'open')
       ON DUPLICATE KEY UPDATE candidates = VALUES(candidates), reason = VALUES(reason), status = 'open'`,
      [gameId, conflict.field, JSON.stringify(conflict.candidates ?? []), conflict.reason ?? ''],
    );
  }

  for (const [field, status] of statusByField) {
    if (status === 'open' && !activeFields.has(field)) {
      await db.query('DELETE FROM conflicts WHERE game_id = ? AND field = ?', [gameId, field]);
    }
  }
}

async function runResolve(db, gameId, config, log, now) {
  const [records, overrides] = await Promise.all([
    db.query("SELECT source, external_id, payload FROM source_records WHERE game_id = ? AND status = 'ok'", [gameId]),
    loadOverrides(db, gameId),
  ]);

  const fieldsBySource = buildFieldsBySource(records, log);
  const { columns, conflicts } = computeResolution(fieldsBySource, overrides, config, now);

  // `non_game` (migrations/004_non_game.sql): computeResolution() above already applies every entry of
  // `overrides` onto `columns` generically (src/lib/resolver/index.js, last block of resolveGame() - not
  // specific to any one field), so an admin override on 'non_game' has already won by the time we get
  // here. Only compute+write our own classification when there ISN'T one, so we never clobber it.
  if (!Object.prototype.hasOwnProperty.call(overrides, 'non_game')) {
    const steamType = fieldsBySource.steam ? null : await findSteamNotFoundType(db, gameId);
    const gogType = findGogType(records);
    const base = bundleBaseName(columns.name);
    const baseGameExists = base ? await findBaseGameExists(db, base, gameId) : false;
    columns.non_game = classifyNonGame({
      name: columns.name,
      steamType,
      gogType,
      categories: columns.categories,
      genres: columns.genres,
      baseGameExists,
    });
  }

  // `purchasable` (migrations/005_purchasable.sql): same "don't clobber an existing override" guard as
  // non_game above - computeResolution() already applied every overrides entry (including a 'purchasable'
  // one, if any) onto columns, so only compute+write our own classification when there isn't one.
  if (!Object.prototype.hasOwnProperty.call(overrides, 'purchasable')) {
    columns.purchasable = classifyPurchasable({
      isFree: Boolean(columns.is_free),
      priceUsd: columns.price_usd,
      priceRub: columns.price_rub,
      priceCisUsd: columns.price_cis_usd,
      releaseDate: columns.release_date,
      steamPurchasable: fieldsBySource.steam?.steamPurchasable,
      gogPurchasable: fieldsBySource.gog?.gogPurchasable,
      hasSteamRecord: Boolean(fieldsBySource.steam),
      hasGogRecord: Boolean(fieldsBySource.gog),
      now,
    });
  }

  const { sql, params } = buildUpdateSql(gameId, columns, overrides);
  await db.query(sql, params);
  await reconcileConflicts(db, gameId, conflicts);

  return { gameId, sources: Object.keys(fieldsBySource), conflicts: conflicts.length };
}

/**
 * `resolveGame(ctx, gameId, opts)` — resolve one game and persist it. `opts.now` defaults to `new Date()`
 * (the production behaviour); tests pass a fixed date to make the age-penalty math in `ggScore` deterministic,
 * the same way the pure resolver functions already do.
 */
export async function resolveGame(ctx, gameId, { now = new Date() } = {}) {
  const { db, log, config } = ctx;

  const game = await db.one('SELECT id FROM games WHERE id = ?', [gameId]);
  if (!game) {
    log?.warn?.('resolve: game not found, skipping', { gameId });
    return { gameId, skipped: true, reason: 'not_found' };
  }

  if (typeof db.tx === 'function') {
    return db.tx((scopedDb) => runResolve(scopedDb, gameId, config, log, now));
  }
  return runResolve(db, gameId, config, log, now);
}

/** Resolve many games with bounded concurrency. Never throws: a per-game failure is reported in its result. */
export async function resolveMany(ctx, ids, { concurrency = 4 } = {}) {
  const results = new Array(ids.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= ids.length) return;
      try {
        results[i] = await resolveGame(ctx, ids[i]);
      } catch (err) {
        ctx.log?.error?.('resolve: failed', { gameId: ids[i], error: String(err?.message ?? err) });
        results[i] = { gameId: ids[i], error: String(err?.message ?? err) };
      }
    }
  }

  const poolSize = Math.max(1, Math.min(concurrency, ids.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}

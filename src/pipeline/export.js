// Nightly export of the catalog to the public leinstay/steamdb JSON files —
// the data side only (query, map, write files, gzip). The git commit/push
// step, the stats/README generation and the CLI/worker entry points live in
// src/pipeline/export-push.js (README text itself: src/pipeline/export-readme.js),
// which is what src/pipeline/maintenance.js's runExport() dynamically
// imports for the worker's `maintenance` 'export' job.
//
// One dump, both catalogs (2026-09-19, owner's README review): steamdb.json/
// steamdb.min.json/steamdb.min.json.gz (file names unchanged from the legacy
// dump) carry every exported game, Steam and GOG-exclusive alike, ordered by
// id — the appended `kind` field on each row ('steam' or 'gog_exclusive')
// tells them apart; store-specific keys (steam_appid, steam_url, gog_url,
// ...) are simply null on a row from the other store (the LEFT JOINs/columns below
// already return null for those, no per-kind branching needed). There used
// to be a second gogdb.json/.min.json/.min.json.gz file pair
// (kind='gog_exclusive' only); the owner asked for a single dump instead —
// src/pipeline/export-push.js's push step removes any gogdb.* files still
// sitting in the public repo from before this change (see that file).
//
// Cleanup (2026-09-19, owner's dump review): the export used to carry a
// legacy key layout (mapRow()) with the rewrite's own fields appended after
// it (mapRowV2()), plus a frozen legacy_steamdb snapshot join and RUB/CIS
// price columns. Backward compatibility with that layout is no longer
// required, so all of that collapsed into the single mapRow() below, with
// one clean key order (identity, store data, per-source blocks, derived,
// updated_at) and no dropped-legacy-only/frozen-snapshot/CIS/RUB keys.
//
// Final schema pass (2026-09-20, owner's relaunch review — backward
// compatibility is explicitly not a goal): `store_uscore` was a byte-for-byte
// duplicate of `steam_reviews_percent` (both `g.score_steam`) and is gone.
// Every remaining cryptic legacy key was renamed to a self-explanatory
// snake_case name grouped by source prefix (sid -> steam_appid, store_url ->
// steam_url, full_price -> price_usd, current_price -> price_final_usd,
// discount -> discount_percent, published_store -> store_release_date,
// stsp_owners -> steamspy_owners, gfq_* -> gamefaqs_*, hltb_single ->
// hltb_main_hours, hltb_complete -> hltb_complete_hours, meta_url/meta_score/
// meta_uscore -> metacritic_url/metacritic_score/metacritic_user_score,
// igdb_uscore -> igdb_user_score, ggp -> gg_points). List-type fields
// (developers/publishers/languages/voiceovers/categories/genres/tags/
// platforms) are now exported as JSON arrays of strings instead of
// comma-joined strings — `[]` when empty, never `null` (see fromPipeList()/
// platformsToArray() below).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { fromPipeList } from '../lib/names.js';
import { steamReviewLabel } from '../lib/steam-review-label.js';

// Row count per DB round trip. Small enough that peak RSS for the full
// ~110k-row catalog stays well under the 200MB budget (nothing accumulates
// across chunks — each chunk is mapped and written to disk immediately),
// large enough to keep the number of round trips reasonable.
export const CHUNK_SIZE = 2000;

// id-ordered chunks (WHERE id > ? ORDER BY id LIMIT ?) rather than a single
// unbuffered/streamed cursor: `src/db.js`'s pool wraps mysql2/promise, whose
// promise API has no row-streaming mode (only the callback API does), and
// chunking on the primary key is trivial to unit-test with a fake `db`.
//
// LEFT JOIN game_links picks up the one link row per (game, source) the
// unique key (game_id, source) guarantees (src/pipeline schema doc).
//
// `g.kind` is selected (it's the JSON's own `kind` field) but is not a
// filter here — this query returns every exported game regardless of kind,
// ordered by id, in one pass (see the header). `g.non_game IS NULL`
// (migrations/004_non_game.sql) keeps DLC/soundtracks/etc. out;
// `g.purchasable = 1` (migrations/005_purchasable.sql, landing separately)
// keeps delisted/unpurchasable rows out — both flags are "never publish this
// row" the same way steam_delisted is elsewhere (src/lib/wheel-query.js),
// independent of the 100%-discount check below (a temporary free promo, not
// a removal).
export const EXPORT_QUERY = `
SELECT
  g.id, g.kind, g.steam_appid, g.gog_id, g.image, g.name, g.description_en,
  g.price_usd, g.price_final_usd, g.discount_usd,
  g.platforms, g.developers, g.publishers, g.languages, g.voiceovers, g.categories, g.genres, g.tags,
  g.achievements, g.difficulty, g.score_gamefaqs, g.owners_estimate, g.time_main, g.time_complete,
  g.time_average, g.time_average_source,
  g.score_critics, g.score_critics_source, g.score_critics_count, g.score_users_metacritic, g.score_gamerankings,
  g.score_igdb, g.score_igdb_users,
  g.score_steam, g.score_steam_votes, g.score_steam_recent, g.score_steam_recent_votes,
  g.gg_score, g.ggp, g.release_date, g.release_precision, g.early_access_date, g.store_release_date,
  g.updated_at,
  gl_steam.url AS link_steam, gl_gog.url AS link_gog, gl_gfq.url AS link_gamefaqs, gl_hltb.url AS link_hltb,
  gl_meta.url AS link_metacritic, gl_igdb.url AS link_igdb
FROM games g
LEFT JOIN game_links gl_steam ON gl_steam.game_id = g.id AND gl_steam.source = 'steam'
LEFT JOIN game_links gl_gog   ON gl_gog.game_id   = g.id AND gl_gog.source   = 'gog'
LEFT JOIN game_links gl_gfq   ON gl_gfq.game_id   = g.id AND gl_gfq.source   = 'gamefaqs'
LEFT JOIN game_links gl_hltb  ON gl_hltb.game_id  = g.id AND gl_hltb.source  = 'hltb'
LEFT JOIN game_links gl_meta  ON gl_meta.game_id  = g.id AND gl_meta.source  = 'metacritic'
LEFT JOIN game_links gl_igdb  ON gl_igdb.game_id  = g.id AND gl_igdb.source  = 'igdb'
WHERE g.non_game IS NULL AND g.purchasable = 1 AND (g.discount_usd <> 100 OR g.discount_usd IS NULL) AND g.id > ?
ORDER BY g.id
LIMIT ?
`;

/** Every exported game (both kinds), one id-ordered page at a time. */
export function buildExportQuery({ afterId = 0, limit = CHUNK_SIZE } = {}) {
  return { sql: EXPORT_QUERY, params: [afterId, limit] };
}

function num(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Pipe-wrapped list column ('|a|b|') -> array of strings (['a','b']), or `[]` when empty/null. */
function pipeToArray(text) {
  return fromPipeList(text);
}

/** SET column value ('WIN,MAC') -> array of strings, or `[]` when empty/null (never pipe-wrapped). */
function platformsToArray(value) {
  if (value === null || value === undefined) return [];
  const str = String(value).trim();
  if (str === '') return [];
  return str.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * One row of the shape `EXPORT_QUERY` returns -> the exported JSON object.
 * Pure, no I/O. Key order (identity, release, store data, per-source blocks,
 * derived, updated_at last) is exactly the file order written to
 * steamdb.json — documented in full, table form, in the generated README
 * (see src/pipeline/export-readme.js's FIELD_DEFS, which mirrors this
 * order).
 *
 * `metacritic_score`/`metacritic_reviews` are only ever the rewrite's
 * score_critics(_count) when score_critics_source is 'metacritic' (that
 * column can also come from OpenCritic) — null otherwise.
 * `metacritic_user_score` is unambiguously Metacritic-only, so it always
 * passes through as-is.
 */
export function mapRow(row) {
  const isMetacritic = row.score_critics_source === 'metacritic';
  return {
    // --- identity ---
    id: num(row.id),
    kind: row.kind ?? null,
    name: row.name ?? null,
    image: row.image ?? null,
    description: row.description_en ?? null,

    // --- steam ---
    steam_appid: num(row.steam_appid),
    steam_url: row.link_steam ?? null,

    // --- gog ---
    gog_id: num(row.gog_id),
    gog_url: row.link_gog ?? null,

    // --- release ---
    release_date: row.release_date ?? null,
    release_precision: row.release_precision ?? null,
    early_access_date: row.early_access_date ?? null,
    store_release_date: row.store_release_date ?? null,

    // --- store data ---
    price_usd: row.price_usd ?? null,
    price_final_usd: row.price_final_usd ?? null,
    discount_percent: row.discount_usd ?? null,
    platforms: platformsToArray(row.platforms),
    developers: pipeToArray(row.developers),
    publishers: pipeToArray(row.publishers),
    languages: pipeToArray(row.languages),
    voiceovers: pipeToArray(row.voiceovers),
    categories: pipeToArray(row.categories),
    genres: pipeToArray(row.genres),
    tags: pipeToArray(row.tags),
    achievements: row.achievements ?? null,

    // --- steam reviews ---
    steam_reviews_percent: num(row.score_steam),
    steam_reviews_count: num(row.score_steam_votes),
    steam_reviews_label: steamReviewLabel(row.score_steam, row.score_steam_votes),
    steam_recent_percent: num(row.score_steam_recent),
    steam_recent_count: num(row.score_steam_recent_votes),
    steam_recent_label: steamReviewLabel(row.score_steam_recent, row.score_steam_recent_votes),

    // --- steamspy ---
    steamspy_owners: row.owners_estimate ?? null,

    // --- derived ---
    average_playtime_hours: num(row.time_average),
    average_playtime_source: row.time_average_source ?? null,

    // --- hltb ---
    hltb_url: row.link_hltb ?? null,
    hltb_main_hours: num(row.time_main),
    hltb_complete_hours: num(row.time_complete),

    // --- gamefaqs ---
    gamefaqs_url: row.link_gamefaqs ?? null,
    gamefaqs_difficulty: row.difficulty ?? null,
    gamefaqs_rating: num(row.score_gamefaqs),

    // --- metacritic ---
    metacritic_url: row.link_metacritic ?? null,
    metacritic_score: isMetacritic ? (row.score_critics ?? null) : null,
    metacritic_reviews: isMetacritic ? num(row.score_critics_count) : null,
    metacritic_user_score: row.score_users_metacritic ?? null,

    // --- igdb ---
    igdb_url: row.link_igdb ?? null,
    igdb_score: row.score_igdb ?? null,
    igdb_user_score: row.score_igdb_users ?? null,

    // --- gamerankings ---
    gamerankings_score: row.score_gamerankings ?? null,

    // --- gamegauntlets (derived) ---
    gg_score: row.gg_score ?? null,
    gg_points: row.ggp ?? null,

    // the DB hands back 'YYYY-MM-DD HH:MM:SS' in UTC; publish real ISO 8601
    updated_at: row.updated_at ? String(row.updated_at).replace(' ', 'T') + 'Z' : null,
  };
}

/**
 * Fetch every exported row (both kinds) in ascending-id chunks, calling
 * `onChunk(rows)` for each chunk instead of accumulating them — the caller
 * controls memory. `db.query(sql, params)` -> rows (mysql2 shape, a plain
 * array works too for a fake db in tests). Returns the total row count.
 */
export async function streamRows(db, onChunk, { chunkSize = CHUNK_SIZE } = {}) {
  let afterId = 0;
  let total = 0;
  for (;;) {
    const { sql, params } = buildExportQuery({ afterId, limit: chunkSize });
    const rows = await db.query(sql, params);
    if (rows.length === 0) break;
    await onChunk(rows);
    total += rows.length;
    afterId = rows[rows.length - 1].id;
    if (rows.length < chunkSize) break;
  }
  return total;
}

async function writeAll(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

function endStream(stream) {
  return new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()));
  });
}

function gzipFile(source, dest) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(source);
    const output = fs.createWriteStream(dest);
    const gzip = zlib.createGzip({ level: 9 });
    input.on('error', reject);
    output.on('error', reject);
    gzip.on('error', reject);
    output.on('close', resolve);
    input.pipe(gzip).pipe(output);
  });
}

function unlinkQuiet(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // best effort cleanup only
  }
}

/**
 * Write `<baseName>.json` (pretty), `<baseName>.min.json` and
 * `<baseName>.min.json.gz` into `outDir`, atomically (write to `<name>.tmp`,
 * then rename once complete — mirrors dump.php's own atomic-rename
 * approach). Streams rows from the DB in chunks (streamRows) and writes
 * each mapped row as it arrives; nothing accumulates the whole result set
 * in memory.
 *
 * `ctx = { db, log }` — `db.query(sql, params)` -> rows; `log` optional.
 * `opts.outDir` is required. `opts.baseName` (default 'steamdb') sets the
 * file names to write under. `opts.chunkSize` overrides CHUNK_SIZE (tests
 * use a small one). `opts.mapRow` overrides the row mapper (default the
 * exported mapRow above; a caller can pass its own for a custom shape).
 * Returns `{ count, baseName, prettyPath, minPath, gzPath, firstRow }` —
 * `firstRow` is the first mapped row object (not accumulated per-row output,
 * just the one row kept for the README's "Example" section in
 * src/pipeline/export-push.js), or `undefined` when the export is empty.
 */
export async function runExport(ctx, opts = {}) {
  const { db, log } = ctx;
  const { outDir, chunkSize, baseName = 'steamdb', mapRow: mapFn = mapRow } = opts;
  if (!outDir) throw new Error('runExport: opts.outDir is required');

  fs.mkdirSync(outDir, { recursive: true });
  const prettyPath = path.join(outDir, `${baseName}.json`);
  const minPath = path.join(outDir, `${baseName}.min.json`);
  const gzPath = `${minPath}.gz`;
  const tmpPretty = `${prettyPath}.tmp`;
  const tmpMin = `${minPath}.tmp`;
  const tmpGz = `${gzPath}.tmp`;

  const prettyStream = fs.createWriteStream(tmpPretty);
  const minStream = fs.createWriteStream(tmpMin);

  let first = true;
  let count = 0;
  let firstRow;
  try {
    await writeAll(prettyStream, '[\n');
    await writeAll(minStream, '[');

    await streamRows(
      db,
      async (rows) => {
        for (const row of rows) {
          const mapped = mapFn(row);
          const jsonMin = JSON.stringify(mapped);
          const jsonPretty = JSON.stringify(mapped, null, 4)
            .split('\n')
            .map((line) => `    ${line}`)
            .join('\n');

          if (!first) {
            await writeAll(minStream, ',');
            await writeAll(prettyStream, ',\n');
          } else {
            firstRow = mapped;
          }
          await writeAll(minStream, jsonMin);
          await writeAll(prettyStream, jsonPretty);
          first = false;
          count += 1;
        }
        log?.info?.('export: chunk written', { baseName, chunk: rows.length, total: count });
      },
      { chunkSize },
    );

    await writeAll(prettyStream, '\n]');
    await writeAll(minStream, ']');
    await Promise.all([endStream(prettyStream), endStream(minStream)]);
  } catch (err) {
    prettyStream.destroy();
    minStream.destroy();
    unlinkQuiet(tmpPretty);
    unlinkQuiet(tmpMin);
    throw err;
  }

  try {
    await gzipFile(tmpMin, tmpGz);
    fs.renameSync(tmpPretty, prettyPath);
    fs.renameSync(tmpMin, minPath);
    fs.renameSync(tmpGz, gzPath);
  } catch (err) {
    unlinkQuiet(tmpPretty);
    unlinkQuiet(tmpMin);
    unlinkQuiet(tmpGz);
    throw err;
  }

  log?.info?.('export: done', { baseName, count, outDir });
  return { count, baseName, prettyPath, minPath, gzPath, firstRow };
}

/**
 * Write the single public dump (steamdb.json/.min.json/.min.json.gz) into
 * `outDir`: every exported game, Steam and GOG-exclusive alike, in one file
 * set (see the file header — there used to be a second gogdb.* pair, the
 * owner asked for one dump instead). Kept as its own function (rather than
 * folding into runExport) because src/pipeline/export-push.js imports it by
 * this name as the top-level "run the whole export" entry point. Just a
 * thin wrapper around runExport() now that there is only one catalog to
 * write.
 */
export async function runFullExport(ctx, opts = {}) {
  return runExport(ctx, { ...opts, baseName: 'steamdb' });
}

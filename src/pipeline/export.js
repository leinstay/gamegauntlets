// Nightly export of the catalog to the public leinstay/steamdb JSON files —
// the data side only (query, map, write files, gzip). The git commit/push
// step, the stats/README generation and the CLI/worker entry points live in
// src/pipeline/export-push.js (README text itself: src/pipeline/export-readme.js),
// which is what src/pipeline/maintenance.js's runExport() dynamically
// imports for the worker's `maintenance` 'export' job.
//
// Schema v2 (2026-09-19): every legacy key from legacy/ajax/misc/dump.php's
// SELECT is kept byte-for-byte (same names, same order, same renames —
// mapRow() below, untouched) so nothing downstream in the public repo
// (consumed as plain JSON, no schema) breaks. mapRowV2() spreads mapRow()'s
// object first, then APPENDS the new columns the rewrite actually has that
// dump.php never did (Steam review percent/count/label, average playtime,
// Metacritic review count, gg_score/ggp, release_date, kind, GOG identity,
// RUB/CIS prices, updated_at — see mapRowV2's own doc comment for the full
// list and why each one is there) — object spread preserves insertion
// order, so the file order is exactly "every legacy key, then every new
// key", never interleaved.
//
// One dump, both catalogs (2026-09-19, owner's README review): steamdb.json/
// steamdb.min.json/steamdb.min.json.gz (file names unchanged from the legacy
// dump) carry every exported game, Steam and GOG-exclusive alike, ordered by
// id — the appended `kind` field on each row ('steam' or 'gog_exclusive')
// tells them apart; Steam-only legacy keys (sid, store_url, ...) are simply
// null on a GOG-exclusive row (the LEFT JOINs/columns below already return
// null for those, no per-kind branching needed). There used to be a second
// gogdb.json/.min.json/.min.json.gz file pair (kind='gog_exclusive' only);
// the owner asked for a single dump instead — src/pipeline/export-push.js's
// push step removes any gogdb.* files still sitting in the public repo from
// before this change (see that file).

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
// unique key (game_id, source) guarantees (src/pipeline schema doc); LEFT
// JOIN source_records picks up the *original Steam-side* legacy snapshot,
// if this game was migrated from steamdb — matching `sr.external_id` back
// to `g.id` (not just `sr.game_id = g.id`) is required because a game that
// absorbed a merged GOG row (scripts/migrate-legacy.js) can have a SECOND
// legacy_steamdb source_records row on the same game_id, keyed by the GOG
// row's own (different) legacy id — without that filter the second row
// would fan out the JOIN into a duplicate output row. The comparison casts
// `sr.external_id` to UNSIGNED rather than casting `g.id` to CHAR: a CHAR
// cast takes the connection's default collation for utf8mb4
// (utf8mb4_general_ci), which fails "Illegal mix of collations" against
// `external_id`'s column collation (utf8mb4_unicode_ci, confirmed against
// the real gg schema) — comparing as integers sidesteps collations
// entirely instead of chasing a matching one.
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
  g.price_rub, g.price_final_rub, g.discount_rub,
  g.price_cis_usd, g.price_final_cis_usd, g.discount_cis_usd,
  g.platforms, g.developers, g.publishers, g.languages, g.voiceovers, g.categories, g.genres, g.tags,
  g.achievements, g.difficulty, g.score_gamefaqs, g.owners_estimate, g.time_main, g.time_complete,
  g.time_average, g.time_average_source,
  g.score_critics, g.score_critics_source, g.score_critics_count, g.score_users_metacritic, g.score_gamerankings,
  g.score_igdb, g.score_igdb_users,
  g.score_steam, g.score_steam_votes, g.score_steam_recent, g.score_steam_recent_votes,
  g.gg_score, g.ggp, g.release_date, g.release_precision, g.early_access_date, g.store_release_date,
  g.updated_at,
  gl_steam.url AS link_steam, gl_gog.url AS link_gog, gl_gfq.url AS link_gamefaqs, gl_hltb.url AS link_hltb,
  gl_meta.url AS link_metacritic, gl_igdb.url AS link_igdb,
  JSON_UNQUOTE(JSON_EXTRACT(sr.payload, '$.published_meta')) AS legacy_published_meta,
  JSON_UNQUOTE(JSON_EXTRACT(sr.payload, '$.published_stsp')) AS legacy_published_stsp,
  JSON_UNQUOTE(JSON_EXTRACT(sr.payload, '$.published_hltb')) AS legacy_published_hltb,
  JSON_UNQUOTE(JSON_EXTRACT(sr.payload, '$.published_igdb')) AS legacy_published_igdb
FROM games g
LEFT JOIN game_links gl_steam ON gl_steam.game_id = g.id AND gl_steam.source = 'steam'
LEFT JOIN game_links gl_gog   ON gl_gog.game_id   = g.id AND gl_gog.source   = 'gog'
LEFT JOIN game_links gl_gfq   ON gl_gfq.game_id   = g.id AND gl_gfq.source   = 'gamefaqs'
LEFT JOIN game_links gl_hltb  ON gl_hltb.game_id  = g.id AND gl_hltb.source  = 'hltb'
LEFT JOIN game_links gl_meta  ON gl_meta.game_id  = g.id AND gl_meta.source  = 'metacritic'
LEFT JOIN game_links gl_igdb  ON gl_igdb.game_id  = g.id AND gl_igdb.source  = 'igdb'
LEFT JOIN source_records sr   ON sr.game_id = g.id AND sr.source = 'legacy_steamdb' AND CAST(sr.external_id AS UNSIGNED) = g.id
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

/** Pipe-wrapped list column ('|a|b|') -> legacy comma string ('a,b'), or null. */
function pipeToComma(text) {
  const items = fromPipeList(text);
  return items.length ? items.join(',') : null;
}

/**
 * One row of the shape `EXPORT_QUERY` returns -> the exact object shape
 * legacy/ajax/misc/dump.php put in steamdb.json / steamdb.min.json (same
 * keys, same order, same renames as its SELECT). Pure, no I/O. Unchanged
 * since the legacy dump — see mapRowV2() for the schema-v2 fields appended
 * after this shape in the actual export output.
 *
 * Fields with no equivalent in the rewrite are always null here (documented
 * per field, rather than guessed at — dump.php's consumers only ever saw a
 * live scraper's values for these; a stable null beats a fabricated one):
 *   - store_promo_url: legacy igdb.php wrote this (a YouTube trailer url);
 *     the rewrite has no column for it.
 *   - gfq_difficulty_comment / gfq_rating_comment / gfq_length_comment: were
 *     already always NULL in production (dead columns, never written by
 *     any legacy parser).
 *   - gfq_length: GameFAQs' own completion-time estimate; the rewrite only
 *     persists HLTB's main/complete time (time_main/time_complete).
 *   - stsp_mdntime: SteamSpy median playtime; not persisted in the rewrite
 *     as such (see mapRowV2's average_playtime_hours for its replacement).
 *   - igdb_single / igdb_complete / igdb_popularity: were already always
 *     NULL in production too (legacy igdb.php never requested them, see
 *     .claude/docs/parsers.md) — not a regression.
 *   - published_meta / published_stsp / published_hltb / published_igdb:
 *     the rewrite keeps only the resolver's final release_date and the
 *     store's own store_release_date on `games`, not a per-source
 *     candidate — so these are the frozen legacy values (LEFT JOIN
 *     source_records source='legacy_steamdb'), present for every game
 *     migrated from steamdb, null for a game that only ever existed in the
 *     rewrite (a real per-source re-derivation would need one extra query
 *     per independent source per row; not "cheap" at export time).
 *   - meta_score: legacy `meta_score` specifically means Metacritic; the
 *     rewrite's score_critics can also come from OpenCritic
 *     (score_critics_source), so this is only ever the rewrite's
 *     score_critics when that source is 'metacritic', null otherwise.
 *     meta_uscore (score_users_metacritic) is unambiguously Metacritic-only
 *     and frozen forever, so it is always passed through as-is.
 */
export function mapRow(row) {
  return {
    sid: num(row.steam_appid),
    store_url: row.link_steam ?? null,
    store_promo_url: null,
    store_uscore: row.score_steam ?? null,
    published_store: row.store_release_date ?? null,
    published_meta: row.legacy_published_meta ?? null,
    published_stsp: row.legacy_published_stsp ?? null,
    published_hltb: row.legacy_published_hltb ?? null,
    published_igdb: row.legacy_published_igdb ?? null,
    image: row.image ?? null,
    name: row.name ?? null,
    description: row.description_en ?? null,
    full_price: row.price_usd ?? null,
    current_price: row.price_final_usd ?? null,
    discount: row.discount_usd ?? null,
    platforms: row.platforms ?? null,
    developers: pipeToComma(row.developers),
    publishers: pipeToComma(row.publishers),
    languages: pipeToComma(row.languages),
    voiceovers: pipeToComma(row.voiceovers),
    categories: pipeToComma(row.categories),
    genres: pipeToComma(row.genres),
    tags: pipeToComma(row.tags),
    achievements: row.achievements ?? null,
    gfq_url: row.link_gamefaqs ?? null,
    gfq_difficulty: row.difficulty ?? null,
    gfq_difficulty_comment: null,
    gfq_rating: num(row.score_gamefaqs),
    gfq_rating_comment: null,
    gfq_length: null,
    gfq_length_comment: null,
    stsp_owners: row.owners_estimate ?? null,
    stsp_mdntime: null,
    hltb_url: row.link_hltb ?? null,
    hltb_single: num(row.time_main),
    hltb_complete: num(row.time_complete),
    meta_url: row.link_metacritic ?? null,
    meta_score: row.score_critics_source === 'metacritic' ? (row.score_critics ?? null) : null,
    meta_uscore: row.score_users_metacritic ?? null,
    grnk_score: row.score_gamerankings ?? null,
    igdb_url: row.link_igdb ?? null,
    igdb_single: null,
    igdb_complete: null,
    igdb_score: row.score_igdb ?? null,
    igdb_uscore: row.score_igdb_users ?? null,
    igdb_popularity: null,
  };
}

/**
 * Schema v2: mapRow()'s legacy shape, unchanged, with the rewrite's own
 * fields APPENDED after it (never interleaved — downstream consumers that
 * parse positionally, however unlikely, still see every legacy key first).
 * This is what runExport() actually writes to steamdb.json/gogdb.json.
 * Documented in full, table form, in the generated README (see
 * src/pipeline/export-readme.js's SCHEMA_FIELDS).
 *
 *   - steam_reviews_percent/count/label, steam_recent_percent/count/label:
 *     games.score_steam(_votes)/score_steam_recent(_votes)
 *     (migrations/002_time_average.sql) — `label` via
 *     src/lib/steam-review-label.js's steamReviewLabel(), which is already
 *     null under 10 votes (both "all" and "recent"), matching
 *     src/lib/game-card.js's card. Unlike the card, the raw recent
 *     percent/count are still exported even under 10 votes (only the
 *     *label* is suppressed) — a data consumer, unlike the card UI, may
 *     still want the raw numbers.
 *   - average_playtime_hours/source: games.time_average/time_average_source
 *     (migrations/002_time_average.sql, priority order fixed by 003) —
 *     replaces the dropped legacy stsp_mdntime with a real (better-sourced)
 *     value.
 *   - metacritic_reviews: games.score_critics_count
 *     (migrations/001_init.sql), gated the same way legacy meta_score is
 *     (null unless score_critics_source='metacritic') — the one Metacritic
 *     number dump.php never had. metacritic_score itself is NOT repeated
 *     here: legacy meta_score already carries games.score_critics under
 *     the same 'metacritic'-source gate, so a second copy would be a pure
 *     duplicate.
 *   - gamerankings_score: games.score_gamerankings, a readable alias of the
 *     legacy grnk_score key above (same value) — kept for consumers that
 *     don't want to learn the legacy abbreviations to read schema v2 keys.
 *   - gg_score, ggp: games.gg_score/ggp (migrations/001_init.sql) — the
 *     site's own composite score/priority, never published before.
 *   - release_date, release_precision: games.release_date/release_precision
 *     (migrations/001_init.sql) — the resolver's cross-source consensus
 *     date, distinct from published_store above (which is just the store's
 *     own listing date, sometimes a re-listing — see legacy-map.js's
 *     referenceYear doc for why the two differ).
 *   - kind: games.kind ('steam' or 'gog_exclusive') — which catalog this
 *     row belongs to; always 'steam' in steamdb.json, always 'gog_exclusive'
 *     in gogdb.json (see runFullExport), included on both for a consumer
 *     that concatenates the two files.
 *   - gog_id, gog_url: games.gog_id (own column — set on a Steam row too
 *     when the resolver cross-matched it to a GOG listing, e.g. via
 *     wikidata) and game_links (source='gog') respectively.
 *   - early_access_date: games.early_access_date (migrations/001_init.sql).
 *   - price_rub/price_final_rub/discount_rub, price_cis_usd/
 *     price_final_cis_usd/discount_cis_usd: games.* (migrations/
 *     001_init.sql) — the legacy dump only ever published the USD price
 *     (full_price/current_price/discount above); RUB and the CIS "backup
 *     region" price were never exported.
 *   - updated_at: games.updated_at (migrations/001_init.sql) — lets a
 *     consumer diff against a previous dump without re-downloading it.
 */
export function mapRowV2(row) {
  const isMetacritic = row.score_critics_source === 'metacritic';
  return {
    ...mapRow(row),
    steam_reviews_percent: num(row.score_steam),
    steam_reviews_count: num(row.score_steam_votes),
    steam_reviews_label: steamReviewLabel(row.score_steam, row.score_steam_votes),
    steam_recent_percent: num(row.score_steam_recent),
    steam_recent_count: num(row.score_steam_recent_votes),
    steam_recent_label: steamReviewLabel(row.score_steam_recent, row.score_steam_recent_votes),
    average_playtime_hours: num(row.time_average),
    average_playtime_source: row.time_average_source ?? null,
    metacritic_reviews: isMetacritic ? num(row.score_critics_count) : null,
    gamerankings_score: row.score_gamerankings ?? null,
    gg_score: row.gg_score ?? null,
    ggp: row.ggp ?? null,
    release_date: row.release_date ?? null,
    release_precision: row.release_precision ?? null,
    kind: row.kind ?? null,
    gog_id: num(row.gog_id),
    gog_url: row.link_gog ?? null,
    early_access_date: row.early_access_date ?? null,
    price_rub: row.price_rub ?? null,
    price_final_rub: row.price_final_rub ?? null,
    discount_rub: row.discount_rub ?? null,
    price_cis_usd: row.price_cis_usd ?? null,
    price_final_cis_usd: row.price_final_cis_usd ?? null,
    discount_cis_usd: row.discount_cis_usd ?? null,
    updated_at: row.updated_at ?? null,
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
 * use a small one). `opts.mapRow` overrides the row mapper (default
 * mapRowV2 — the schema-v2 shape actually published; tests exercising the
 * legacy-only shape pass mapRow explicitly).
 * Returns `{ count, baseName, prettyPath, minPath, gzPath }`.
 */
export async function runExport(ctx, opts = {}) {
  const { db, log } = ctx;
  const { outDir, chunkSize, baseName = 'steamdb', mapRow: mapFn = mapRowV2 } = opts;
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
  return { count, baseName, prettyPath, minPath, gzPath };
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

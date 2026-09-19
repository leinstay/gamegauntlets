// Stats + README generator for the public leinstay/steamdb export. Two pure/impure halves,
// deliberately split:
//   - collectStats(db): the only function that touches the database. A handful of aggregate/grouped
//     SQL queries (never one row per game) so it stays fast on the full ~115k-game / ~700k-
//     source_records catalog — see each query's own comment for why it's shaped the way it is.
//   - renderReadme(stats, opts): pure, `stats in -> markdown string out`, unit-testable without a
//     database (tests/export-readme.test.js builds a small `stats` object by hand).
//
// src/pipeline/export-push.js calls collectStats() then renderReadme(), adds the dump files' on-disk
// sizes/row counts (collectStats never touches the filesystem either) to `stats.files`, and writes the
// result as README.md in the steamdb working copy before every commit — so the README updates in the
// same commit as the data, every night.
//
// The README is a terse, factual dataset README (2026-09-19, owner review): no explanation of how the
// site or its scheduler work internally, no internal table/column names, one short defining sentence
// per table only where a column genuinely needs it ("Coverage", "Remaining").

import { config } from '../config.js';

// --- field coverage -------------------------------------------------------------------------------
//
// One row per key `mapRow()` (src/pipeline/export.js) puts in the dump, in the exact order it appears
// there (identity, store data, per-source blocks, derived, updated_at). `sql` is a boolean SQL
// expression, TRUE exactly when the row would carry a non-null value for this key in the actual export
// (mirrors mapRow's own null rules field by field) — summed by FIELD_COVERAGE_QUERY below in one pass
// over the exported rows, joins reused from src/pipeline/export.js's EXPORT_QUERY (same aliases:
// gl_steam/gl_gog/gl_gfq/gl_hltb/gl_meta/gl_igdb). A handful of list columns (developers/publishers/...)
// approximate "non-null after pipeToComma()" as "column set and not empty" — pipeToComma additionally
// treats an empty-list marker ('||') as null, which SQL doesn't see cheaply; close enough for a
// coverage report, not used for anything else.
//
// `source` is always one of the plain site names (steam, gog, steamspy, gamefaqs, hltb, metacritic,
// igdb, gamerankings) or `gamegauntlets` for a field the catalog itself computes/normalizes rather than
// one lifted as-is from a single external site.
export const FIELD_DEFS = [
  { key: 'id', source: 'gamegauntlets', description: 'catalog id, stable across updates', sql: '1' },
  { key: 'kind', source: 'gamegauntlets', description: "'steam' or 'gog_exclusive'", sql: '1' },
  { key: 'sid', source: 'steam', description: 'Steam appid', sql: 'g.steam_appid IS NOT NULL' },
  { key: 'gog_id', source: 'gog', description: 'GOG catalog id', sql: 'g.gog_id IS NOT NULL' },
  { key: 'name', source: 'gamegauntlets', description: 'game title', sql: 'g.name IS NOT NULL' },
  { key: 'image', source: 'gamegauntlets', description: 'header image URL', sql: 'g.image IS NOT NULL' },
  { key: 'description', source: 'gamegauntlets', description: 'English store description (raw HTML)', sql: 'g.description_en IS NOT NULL' },
  { key: 'store_url', source: 'steam', description: 'Steam store page URL', sql: 'gl_steam.url IS NOT NULL' },
  { key: 'gog_url', source: 'gog', description: 'GOG store page URL', sql: 'gl_gog.url IS NOT NULL' },
  { key: 'full_price', source: 'gamegauntlets', description: 'USD list price, cents', sql: 'g.price_usd IS NOT NULL' },
  { key: 'current_price', source: 'gamegauntlets', description: 'USD price after discount, cents', sql: 'g.price_final_usd IS NOT NULL' },
  { key: 'discount', source: 'gamegauntlets', description: 'discount percent, 0..100', sql: 'g.discount_usd IS NOT NULL' },
  { key: 'platforms', source: 'gamegauntlets', description: 'comma list of WIN/MAC/LNX', sql: 'g.platforms IS NOT NULL' },
  { key: 'developers', source: 'gamegauntlets', description: 'comma list', sql: "g.developers IS NOT NULL AND g.developers <> ''" },
  { key: 'publishers', source: 'gamegauntlets', description: 'comma list', sql: "g.publishers IS NOT NULL AND g.publishers <> ''" },
  { key: 'languages', source: 'gamegauntlets', description: 'comma list', sql: "g.languages IS NOT NULL AND g.languages <> ''" },
  { key: 'voiceovers', source: 'gamegauntlets', description: 'comma list', sql: "g.voiceovers IS NOT NULL AND g.voiceovers <> ''" },
  { key: 'categories', source: 'gamegauntlets', description: 'comma list', sql: "g.categories IS NOT NULL AND g.categories <> ''" },
  { key: 'genres', source: 'gamegauntlets', description: 'comma list', sql: "g.genres IS NOT NULL AND g.genres <> ''" },
  { key: 'tags', source: 'gamegauntlets', description: 'comma list', sql: "g.tags IS NOT NULL AND g.tags <> ''" },
  { key: 'achievements', source: 'steam', description: 'achievement count', sql: 'g.achievements IS NOT NULL' },
  { key: 'release_date', source: 'gamegauntlets', description: 'cross-source consensus release date', sql: 'g.release_date IS NOT NULL' },
  { key: 'release_precision', source: 'gamegauntlets', description: 'day/month/quarter/year/unknown', sql: "g.release_precision IS NOT NULL AND g.release_precision <> 'unknown'" },
  { key: 'early_access_date', source: 'steam', description: 'date the game entered Early Access, if it did', sql: 'g.early_access_date IS NOT NULL' },
  { key: 'published_store', source: 'gamegauntlets', description: 'store listing date (may be a re-listing, not the true release date)', sql: 'g.store_release_date IS NOT NULL' },
  { key: 'store_uscore', source: 'steam', description: 'all-review score, 0..100', sql: 'g.score_steam IS NOT NULL' },
  { key: 'steam_reviews_percent', source: 'steam', description: 'all-time positive review share, 0..100', sql: 'g.score_steam IS NOT NULL' },
  { key: 'steam_reviews_count', source: 'steam', description: 'all-time review count', sql: 'g.score_steam_votes IS NOT NULL' },
  { key: 'steam_reviews_label', source: 'steam', description: 'Steam\'s own label ("Very Positive", ...), null under 10 votes', sql: 'g.score_steam IS NOT NULL AND g.score_steam_votes IS NOT NULL AND g.score_steam_votes >= 10' },
  { key: 'steam_recent_percent', source: 'steam', description: 'last ~30 days positive review share, 0..100', sql: 'g.score_steam_recent IS NOT NULL' },
  { key: 'steam_recent_count', source: 'steam', description: 'last ~30 days review count', sql: 'g.score_steam_recent_votes IS NOT NULL' },
  { key: 'steam_recent_label', source: 'steam', description: 'recent-reviews label, null under 10 votes', sql: 'g.score_steam_recent IS NOT NULL AND g.score_steam_recent_votes IS NOT NULL AND g.score_steam_recent_votes >= 10' },
  { key: 'stsp_owners', source: 'steamspy', description: 'owners estimate, lower bound', sql: 'g.owners_estimate IS NOT NULL' },
  { key: 'gfq_url', source: 'gamefaqs', description: 'GameFAQs product page URL', sql: 'gl_gfq.url IS NOT NULL' },
  { key: 'gfq_difficulty', source: 'gamefaqs', description: 'GameFAQs difficulty label', sql: 'g.difficulty IS NOT NULL' },
  { key: 'gfq_rating', source: 'gamefaqs', description: 'GameFAQs rating, 0..5', sql: 'g.score_gamefaqs IS NOT NULL' },
  { key: 'hltb_url', source: 'hltb', description: 'HowLongToBeat page URL', sql: 'gl_hltb.url IS NOT NULL' },
  { key: 'hltb_single', source: 'hltb', description: 'main story hours', sql: 'g.time_main IS NOT NULL' },
  { key: 'hltb_complete', source: 'hltb', description: 'completionist hours', sql: 'g.time_complete IS NOT NULL' },
  { key: 'meta_url', source: 'metacritic', description: 'Metacritic page URL', sql: 'gl_meta.url IS NOT NULL' },
  { key: 'meta_score', source: 'metacritic', description: 'critic score, 0..100', sql: "g.score_critics IS NOT NULL AND g.score_critics_source = 'metacritic'" },
  { key: 'meta_uscore', source: 'metacritic', description: 'user score, 0..100', sql: 'g.score_users_metacritic IS NOT NULL' },
  { key: 'metacritic_reviews', source: 'metacritic', description: 'critic review count', sql: "g.score_critics_count IS NOT NULL AND g.score_critics_source = 'metacritic'" },
  { key: 'igdb_url', source: 'igdb', description: 'IGDB page URL', sql: 'gl_igdb.url IS NOT NULL' },
  { key: 'igdb_score', source: 'igdb', description: 'IGDB critic score, 0..100', sql: 'g.score_igdb IS NOT NULL' },
  { key: 'igdb_uscore', source: 'igdb', description: 'IGDB user score, 0..100', sql: 'g.score_igdb_users IS NOT NULL' },
  { key: 'gamerankings_score', source: 'gamerankings', description: 'critic score, 0..100', sql: 'g.score_gamerankings IS NOT NULL' },
  { key: 'gg_score', source: 'gamegauntlets', description: "Game Gauntlets' own composite score", sql: 'g.gg_score IS NOT NULL' },
  { key: 'ggp', source: 'gamegauntlets', description: 'Game Gauntlets priority score (wheel weighting)', sql: 'g.ggp IS NOT NULL' },
  { key: 'average_playtime_hours', source: 'gamegauntlets', description: 'resolved average playtime, hours', sql: 'g.time_average IS NOT NULL' },
  { key: 'average_playtime_source', source: 'gamegauntlets', description: 'which source produced average_playtime_hours', sql: 'g.time_average_source IS NOT NULL' },
  { key: 'updated_at', source: 'gamegauntlets', description: 'last time this row changed', sql: '1' },
];

// Same FROM/JOIN shape as src/pipeline/export.js's EXPORT_QUERY (without the id-chunking bind params —
// this scans the exported set once, in the database, and returns a single summary row rather than
// ~115k rows to sum in JS). The WHERE clause matches EXPORT_QUERY's filter exactly — a game is
// "exported" (into steamdb.json) whenever it clears non_game/purchasable/discount, whichever of the two
// `kind` values it has (see migrations/001_init.sql — there are only ever those two).
function fieldCoverageSql() {
  const sums = FIELD_DEFS.map((f) => `  SUM(${f.sql}) AS \`${f.key}\``).join(',\n');
  return `
SELECT
  COUNT(*) AS total,
${sums}
FROM games g
LEFT JOIN game_links gl_steam ON gl_steam.game_id = g.id AND gl_steam.source = 'steam'
LEFT JOIN game_links gl_gog   ON gl_gog.game_id   = g.id AND gl_gog.source   = 'gog'
LEFT JOIN game_links gl_gfq   ON gl_gfq.game_id   = g.id AND gl_gfq.source   = 'gamefaqs'
LEFT JOIN game_links gl_hltb  ON gl_hltb.game_id  = g.id AND gl_hltb.source  = 'hltb'
LEFT JOIN game_links gl_meta  ON gl_meta.game_id  = g.id AND gl_meta.source  = 'metacritic'
LEFT JOIN game_links gl_igdb  ON gl_igdb.game_id  = g.id AND gl_igdb.source  = 'igdb'
WHERE g.non_game IS NULL AND g.purchasable = 1 AND (g.discount_usd <> 100 OR g.discount_usd IS NULL)
`;
}

// --- sources ---------------------------------------------------------------------------------------
//
// The sources with a live worker/queue (config.json `sources.*`, in that file's own key order — the
// order the scheduler itself was introduced in). Fixed at module load, independent of anything in the
// database, so the source table's row order never depends on query result order — deterministic
// nightly diffs (task requirement). Only these appear in the "Source status" table.
const LIVE_SOURCES = Object.keys(config.sources ?? {});
export const SOURCE_ORDER = LIVE_SOURCES;

function refreshDaysFor(source) {
  return config.sources?.[source]?.refreshDays ?? null;
}

/**
 * "remaining" for one source: games with no source_records row for it yet, or whose newest row is
 * older than that source's configured refreshDays — the same "due for a refresh" rule the scheduler
 * itself uses. Only meaningful for a source with a configured refreshDays (every entry in SOURCE_ORDER
 * has one); a source without one (there currently is none) would get `remaining: null` instead of a
 * query, rather than reporting a number that would never change and would misleadingly imply an
 * ongoing backlog.
 *
 * Denominator is every currently-exportable game (non_game IS NULL AND purchasable = 1) regardless of
 * kind — every source in principle applies to both Steam and GOG-exclusive rows (wikidata/igdb/hltb/
 * gamefaqs/metacritic all match by name, not by store).
 */
function remainingSql() {
  return `
SELECT COUNT(*) AS remaining
FROM games g
LEFT JOIN (
  SELECT game_id, MAX(fetched_at) AS latest
  FROM source_records
  WHERE source = ?
  GROUP BY game_id
) sr ON sr.game_id = g.id
WHERE g.non_game IS NULL AND g.purchasable = 1
  AND (sr.game_id IS NULL OR sr.latest < DATE_SUB(NOW(), INTERVAL ? DAY))
`;
}

function toInt(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Run every aggregate query against `db` (`db.query(sql, params) -> rows`, the same shape as
 * src/db.js's `query`) and assemble the stats object `renderReadme()` consumes. A handful of grouped
 * queries total — see each query builder above for why none of them scan per-row in JS.
 */
export async function collectStats(db) {
  // Every count here describes the exported set only (non_game IS NULL AND purchasable = 1 AND not
  // 100%-discounted — the same filter EXPORT_QUERY applies in src/pipeline/export.js) — the README's
  // "Catalog totals" never mentions a row this dump doesn't actually publish.
  const [totalsRow] = await db.query(`
    SELECT
      SUM(kind = 'steam' AND non_game IS NULL AND purchasable = 1 AND (discount_usd <> 100 OR discount_usd IS NULL)) AS steam_games,
      SUM(kind = 'gog_exclusive' AND non_game IS NULL AND purchasable = 1 AND (discount_usd <> 100 OR discount_usd IS NULL)) AS gog_games,
      SUM(kind = 'steam' AND gog_id IS NOT NULL AND non_game IS NULL AND purchasable = 1 AND (discount_usd <> 100 OR discount_usd IS NULL)) AS both_stores
    FROM games
  `);

  const steamGames = toInt(totalsRow?.steam_games);
  const gogGames = toInt(totalsRow?.gog_games);
  const totals = {
    steamGames,
    gogGames,
    gamesInCatalog: steamGames + gogGames,
    bothStores: toInt(totalsRow?.both_stores),
  };

  const [coverageRow] = await db.query(fieldCoverageSql());
  const coverageTotal = toInt(coverageRow?.total);
  const coverage = FIELD_DEFS.map((f) => {
    const count = toInt(coverageRow?.[f.key]);
    return {
      key: f.key,
      source: f.source,
      description: f.description,
      count,
      percent: coverageTotal > 0 ? Math.round((count / coverageTotal) * 1000) / 10 : 0,
    };
  });

  const statusRows = await db.query('SELECT source, status, COUNT(*) AS n FROM source_records GROUP BY source, status');
  const coveredRows = await db.query(
    'SELECT source, COUNT(DISTINCT game_id) AS games FROM source_records WHERE game_id IS NOT NULL GROUP BY source',
  );
  const stateRows = await db.query('SELECT source, paused, last_run_at, last_full_pass_at FROM source_state');

  const statusBySource = new Map();
  for (const row of statusRows) {
    const entry = statusBySource.get(row.source) ?? { ok: 0, not_found: 0, error: 0 };
    entry[row.status] = toInt(row.n);
    statusBySource.set(row.source, entry);
  }
  const coveredBySource = new Map(coveredRows.map((r) => [r.source, toInt(r.games)]));
  const stateBySource = new Map(stateRows.map((r) => [r.source, r]));

  const sources = [];
  for (const source of SOURCE_ORDER) {
    const status = statusBySource.get(source) ?? { ok: 0, not_found: 0, error: 0 };
    const state = stateBySource.get(source) ?? null;
    const refreshDays = refreshDaysFor(source);

    let remaining = null;
    if (refreshDays !== null) {
      const [remainingRow] = await db.query(remainingSql(), [source, refreshDays]);
      remaining = toInt(remainingRow?.remaining);
    }

    sources.push({
      source,
      refreshDays,
      ok: status.ok ?? 0,
      notFound: status.not_found ?? 0,
      error: status.error ?? 0,
      gamesCovered: coveredBySource.get(source) ?? 0,
      paused: Boolean(state?.paused),
      lastRunAt: state?.last_run_at ?? null,
      lastFullPassAt: state?.last_full_pass_at ?? null,
      remaining,
    });
  }

  // OpenCritic is dropped from the project (2026-09-19) and excluded here even if a stray game_links
  // row is still sitting in the database; "linked games" is scoped to the exported set, same filter as
  // totals/coverage above — a link on an excluded game (unpurchasable/delisted/DLC/...) isn't published.
  const linkRows = await db.query(`
    SELECT gl.source, COUNT(DISTINCT gl.game_id) AS games
    FROM game_links gl
    JOIN games g ON g.id = gl.game_id
    WHERE gl.source <> 'opencritic'
      AND g.non_game IS NULL AND g.purchasable = 1 AND (g.discount_usd <> 100 OR g.discount_usd IS NULL)
    GROUP BY gl.source
    ORDER BY gl.source
  `);
  const links = linkRows.map((r) => ({ source: r.source, games: toInt(r.games) }));

  return { totals, coverage, sources, links };
}

// --- README rendering -------------------------------------------------------------------------------

function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}

function pct(n) {
  return `${Number(n ?? 0).toFixed(1)}%`;
}

function renderTotals(totals) {
  return [
    '| Metric | Count |',
    '|---|---|',
    `| Games in the catalog | ${fmt(totals.gamesInCatalog)} |`,
    `| Steam games | ${fmt(totals.steamGames)} |`,
    `| GOG-exclusive games | ${fmt(totals.gogGames)} |`,
    `| Steam games also on GOG | ${fmt(totals.bothStores)} |`,
  ].join('\n');
}

function renderCoverage(coverage) {
  const lines = ['| Key | Source | Coverage | Description |', '|---|---|---|---|'];
  for (const row of coverage) {
    lines.push(`| \`${row.key}\` | ${row.source} | ${pct(row.percent)} (${fmt(row.count)}) | ${row.description} |`);
  }
  return lines.join('\n');
}

function renderSources(sources) {
  const lines = [
    '| Source | Refresh | OK | Not found | Error | Games covered | Remaining | Paused | Last run |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of sources) {
    const refresh = s.refreshDays !== null ? `${s.refreshDays}d` : 'n/a';
    const remaining = s.remaining !== null ? fmt(s.remaining) : 'n/a';
    lines.push(
      `| ${s.source} | ${refresh} | ${fmt(s.ok)} | ${fmt(s.notFound)} | ${fmt(s.error)} | ${fmt(s.gamesCovered)} | ${remaining} | ${s.paused ? 'yes' : 'no'} | ${s.lastRunAt ?? 'never'} |`,
    );
  }
  return lines.join('\n');
}

function renderLinks(links) {
  const lines = ['| Site | Linked games |', '|---|---|'];
  for (const l of links) lines.push(`| ${l.source} | ${fmt(l.games)} |`);
  return lines.join('\n');
}

function renderFiles(files) {
  if (!files?.length) return '_(dump files not available for this render)_';
  const lines = ['| File | Rows | Size |', '|---|---|---|'];
  for (const f of files) lines.push(`| \`${f.name}\` | ${fmt(f.rows)} | ${f.size} |`);
  return lines.join('\n');
}

/**
 * `stats` (from collectStats(), plus `stats.files` added by the caller — see file header) + `{
 * generatedAt }` (a Date or ISO string; defaults to "now") -> the full README.md text. Pure, no I/O —
 * deterministic for a given `stats`/`generatedAt` (stable key/row ordering throughout, see FIELD_DEFS/
 * SOURCE_ORDER above), so a nightly diff only ever reflects a real change in the data.
 */
export function renderReadme(stats, { generatedAt = new Date() } = {}) {
  const { totals, coverage, sources, links, files } = stats;
  const asOf = generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt);

  return `# Steam Game Database

JSON dump of the [Game Gauntlets](https://gamegauntlets.com) game catalog: prices, scores and metadata
merged from Steam, GOG, SteamSpy, GameFAQs, Metacritic, IGDB, HowLongToBeat, Wikidata and GameRankings.

Updated nightly at 23:48 UTC.

_Generated ${asOf}._

## Files

${renderFiles(files)}

## Catalog totals

${renderTotals(totals)}

## Schema

"Coverage" is the share of exported games that currently have a value for that key.

${renderCoverage(coverage)}

## Source status

"Remaining" is games with no data from that source yet, or whose last fetch is older than the source's own refresh interval.

${renderSources(sources)}

## External links

${renderLinks(links)}

## Licence

The dataset is released under the GNU General Public License v3.0 (see \`LICENSE\` in this repo). Game
names, images, descriptions and prices belong to their respective publishers, platforms and third-party
sources.
`;
}

// Pure SQL builder for the wheel filter set. Never touches the network or the DB — it only turns a
// validated `filters` object into `{ sql, params }` for `src/db.js`'s `query()`. All request-derived
// values go through `?` placeholders; nothing from `filters` is ever concatenated into the SQL
// string itself (see the tests for injection-attempt cases).
//
// The query selects `id` only. The route samples `segments` rows from the id list in JS with
// `crypto.randomInt` instead of `ORDER BY RAND() LIMIT n` — see the "Random selection" note in the
// task: RAND() forces MySQL to materialise and sort the whole matching set, which is fine once a
// filter has narrowed things down but not as a blanket strategy over a ~110k-row table.
//
// Filter semantics (legacy reference: legacy/ajax/scripts/gateway.php lines 74-160; re-verified
// against that file — owner decision: keep legacy product behaviour in the rewrite):
//   - "include" lists: legacy turns the selected values into a single REGEXP alternation
//     (`genres REGEXP 'RPG|Action'`), which matches a game with *any* of the selected values —
//     OR across values. Ported here as a single grouped condition per field:
//     `(col LIKE CONCAT('%|', ?, '|%') OR col LIKE CONCAT('%|', ?, '|%') OR ...)`.
//   - "exclude" lists: legacy rejects a game whose column matches that same alternation
//     (`NOT col REGEXP 'RPG|Action'`), i.e. it rejects a game that has *any* of the excluded
//     values — `NOT (col LIKE ... OR col LIKE ... OR ...)` here, NULL-safe (a NULL column has no
//     tags, so it always passes an exclude filter, same as this rewrite's previous behaviour).
//   - developers/publishers compare case-insensitively (`col COLLATE utf8mb4_unicode_ci LIKE ...`)
//     — see CASE_INSENSITIVE_LIST_FIELDS below for why.
//   - "difficulty" is a scalar column here (`games.difficulty`), not a pipe list (GameFAQs assigns
//     exactly one difficulty tier per game) — AND semantics would only ever match when at most one
//     value is selected, so difficulty include/exclude use plain `IN` / `NOT IN` (OR-style exact
//     match) instead of the LIKE pattern. This is a deliberate divergence from the other list fields
//     forced by the schema shape, not an oversight.
//   - price: on `price_final_rub` (lang 'ru'), `price_final_cis_usd` (cisPrices), else
//     `price_final_usd`. `filters.price` is `[from, to]` in major currency units (matches the
//     sessionStorage/API contract values, same as legacy's `$post['price']` before its `*100`) and is
//     converted to cents here. A `to` at or above the slider's top (`config.wheel.priceMax`, default
//     5000 RUB / 500 USD — legacy's hardcoded slider max) means "unlimited": the upper bound is
//     dropped entirely. A game with no price at all (free/not yet priced) still matches when
//     `from` is 0, mirroring legacy's `IF(:pricefrom = 0, price IS NULL, ...)`.
//   - score: `gg_score BETWEEN from AND to`. length: `final_time BETWEEN from AND to` (hours).
//   - released: `[fromYYYYMM, toYYYYMM]` → `release_date BETWEEN 'from-01' AND LAST_DAY('to-01')`.
//   - allowEmpty === false (the default) excludes rows with a NULL `gg_score` or `final_time`
//     (legacy's `empty` checkbox).
//   - preset: joins `preset_games` for that preset id. names: `games.id IN (...)`. steamLibrary:
//     this function does not call Steam — the route resolves the owner's library to an array of
//     owned `appid`s first and passes that array in as `filters.steamLibrary`; here it only becomes
//     `games.steam_appid IN (...)`.
//   - always: `steam_delisted = 0 AND non_game IS NULL AND purchasable = 1` (migrations/004_non_game.sql,
//     005_purchasable.sql - DLC/soundtracks/artbooks/etc. flagged by src/lib/non-game.js's
//     classifyNonGame(), and titles no store will actually sell flagged by src/lib/purchasable.js's
//     classifyPurchasable(), are never dealt into the wheel), plus the regional-availability filter (legacy
//     gateway.php lines ~160-166, see regionAvailabilityCondition() below): with the "use CIS region"
//     toggle off, a title priced elsewhere but not in the requesting language's own region (ru vs.
//     everything else, matching legacy's `price_ru`/`price_en` split) is excluded — `cisPrices` on drops
//     this filter entirely, same as legacy's `$isBackupRegion`.

const PIPE_LIST_FIELDS = [
  'genres',
  'tags',
  'categories',
  'languages',
  'voiceovers',
  'developers',
  'publishers',
];

const COLUMN_BY_FIELD = {
  genres: 'genres',
  tags: 'tags',
  categories: 'categories',
  languages: 'languages',
  voiceovers: 'voiceovers',
  developers: 'developers',
  publishers: 'publishers',
};

const MAX_LIST_ITEMS = 16;
const MAX_NAMES = 16;

// developers/publishers dictionary values are case-merged (src/api/dictionaries.js folds "8floor" and
// "8FLOOR" into one entry, keeping whichever spelling is most common as the value everyone filters
// with). A LIKE match against a single spelling would then miss rows stored under any other spelling
// in the same group, so these two columns compare case-insensitively — COLLATE rather than
// LOWER(column), so an index on the column (if one is ever added) stays usable. The other pipe-list
// fields aren't case-merged and keep the plain (collation-default) comparison, matching legacy's
// REGEXP alternation, which wasn't case-insensitive either.
const CASE_INSENSITIVE_LIST_FIELDS = new Set(['developers', 'publishers']);

function likeColumnExpr(column) {
  return CASE_INSENSITIVE_LIST_FIELDS.has(column) ? `${column} COLLATE utf8mb4_unicode_ci` : column;
}

// Legacy slider tops (`.claude/docs/frontend.md` "Options": "ru max 5000 ₽ = unlimited, en $500").
const DEFAULT_PRICE_MAX = { rub: 5000, usd: 500 };

function capArray(value, max) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).filter((v) => v !== null && v !== undefined && v !== '');
}

function priceColumn(lang, cisPrices) {
  if (cisPrices) return 'price_final_cis_usd';
  return lang === 'ru' ? 'price_final_rub' : 'price_final_usd';
}

function priceMax(lang, cisPrices, config) {
  const configured = config?.wheel?.priceMax;
  if (cisPrices) return configured?.usd ?? DEFAULT_PRICE_MAX.usd;
  return lang === 'ru' ? (configured?.rub ?? DEFAULT_PRICE_MAX.rub) : (configured?.usd ?? DEFAULT_PRICE_MAX.usd);
}

/**
 * Port of legacy gateway.php's regional-availability check (lines ~160-166), per candidate row:
 * ```php
 * if ($isBackupRegion) {}                                                        // CIS on: no filter
 * else if ($lang == "ru") { if (empty($price_ru) && !empty($price_en)) continue; }  // paid elsewhere, not RU
 * else if ($lang == "en") { if (empty($price_en) && !empty($price_ru)) continue; }  // paid elsewhere, not EN
 * ```
 * PHP `empty()` is true for both `NULL` and `0`, hence `COALESCE(..., 0) = 0` here. `cisPrices` on (the
 * "use CIS region" toggle) drops the filter entirely, exactly like legacy's `$isBackupRegion`. Legacy only
 * special-cased `lang == "ru"`/`"en"` (de/fr fell through both branches untouched); this rewrite applies
 * the same "en" condition to every non-ru language, at the owner's explicit instruction — a deliberate
 * generalisation, not an oversight (see the task's Part B).
 *
 * Returns `null` when no condition applies (nothing to push into the WHERE clause).
 */
export function regionAvailabilityCondition(lang, cisPrices) {
  if (cisPrices) return null;
  return lang === 'ru'
    ? 'NOT (COALESCE(price_rub, 0) = 0 AND COALESCE(price_usd, 0) > 0)'
    : 'NOT (COALESCE(price_usd, 0) = 0 AND COALESCE(price_rub, 0) > 0)';
}

function addPipeListConditions(conditions, params, group, mode) {
  for (const field of PIPE_LIST_FIELDS) {
    const values = capArray(group?.[field], MAX_LIST_ITEMS);
    if (values.length === 0) continue;
    const column = COLUMN_BY_FIELD[field];
    const columnExpr = likeColumnExpr(column);
    const likeAlternation = values.map(() => `${columnExpr} LIKE CONCAT('%|', ?, '|%')`).join(' OR ');
    if (mode === 'include') {
      // OR: matches if the game has ANY of the selected values (legacy REGEXP alternation).
      conditions.push(`(${likeAlternation})`);
    } else {
      // Exclude: rejects if the game has ANY of the excluded values. NULL-safe so untagged rows
      // always pass.
      conditions.push(`(${column} IS NULL OR NOT (${likeAlternation}))`);
    }
    params.push(...values.map(String));
  }

  const difficulty = capArray(group?.difficulty, MAX_LIST_ITEMS);
  if (difficulty.length > 0) {
    const placeholders = difficulty.map(() => '?').join(', ');
    if (mode === 'include') {
      conditions.push(`difficulty IN (${placeholders})`);
    } else {
      conditions.push(`(difficulty IS NULL OR difficulty NOT IN (${placeholders}))`);
    }
    params.push(...difficulty.map(String));
  }
}

function addRangeCondition(conditions, params, column, range) {
  if (!Array.isArray(range) || range.length !== 2) return;
  const [from, to] = range;
  if (from == null || to == null) return;
  conditions.push(`${column} BETWEEN ? AND ?`);
  params.push(from, to);
}

/**
 * @param {object} filters - validated wheel filter object (see docs/plans "API contract").
 * @param {object} opts
 * @param {'en'|'ru'|'de'|'fr'} [opts.lang]
 * @param {boolean} [opts.cisPrices]
 * @param {object} [opts.config] - parsed config.json, used only for `config.wheel.priceMax`.
 * @returns {{ sql: string, params: any[] }}
 */
export function buildWheelQuery(filters = {}, { lang = 'en', cisPrices = false, config = null } = {}) {
  const conditions = ['steam_delisted = 0', 'non_game IS NULL', 'purchasable = 1'];
  const params = [];
  const joins = [];

  const regionCondition = regionAvailabilityCondition(lang, cisPrices);
  if (regionCondition) conditions.push(regionCondition);

  addPipeListConditions(conditions, params, filters.include, 'include');
  addPipeListConditions(conditions, params, filters.exclude, 'exclude');

  // Price.
  if (Array.isArray(filters.price) && filters.price.length === 2 && filters.price[0] != null && filters.price[1] != null) {
    const column = priceColumn(lang, cisPrices);
    const fromCents = Math.round(Number(filters.price[0]) * 100);
    const rawToCents = Math.round(Number(filters.price[1]) * 100);
    const maxCents = priceMax(lang, cisPrices, config) * 100;
    if (rawToCents >= maxCents) {
      // Unlimited upper bound: only enforce the lower bound (still let unpriced rows through
      // when the slider starts at 0, same as the bounded branch below).
      if (fromCents <= 0) {
        conditions.push(`(${column} >= ? OR ${column} IS NULL)`);
        params.push(fromCents);
      } else {
        conditions.push(`${column} >= ?`);
        params.push(fromCents);
      }
    } else {
      conditions.push(`(${column} BETWEEN ? AND ? OR (? = 0 AND ${column} IS NULL))`);
      params.push(fromCents, rawToCents, fromCents);
    }
  }

  // Score / length.
  addRangeCondition(conditions, params, 'gg_score', filters.score);
  addRangeCondition(conditions, params, 'final_time', filters.length);

  // Released (YYYY-MM pair → month bounds).
  if (Array.isArray(filters.released) && filters.released.length === 2 && filters.released[0] && filters.released[1]) {
    conditions.push('release_date BETWEEN ? AND LAST_DAY(?)');
    params.push(`${filters.released[0]}-01`, `${filters.released[1]}-01`);
  }

  // allowEmpty === false (default) excludes rows missing score/time entirely.
  if (filters.allowEmpty !== true) {
    conditions.push('gg_score IS NOT NULL');
    conditions.push('final_time IS NOT NULL');
  }

  // Preset (join) and hand-picked names.
  if (Number.isInteger(filters.preset) && filters.preset > 0) {
    joins.push('INNER JOIN preset_games ON preset_games.game_id = games.id AND preset_games.preset_id = ?');
    params.push(filters.preset);
  }

  const names = capArray(filters.names, MAX_NAMES).filter((id) => Number.isInteger(id) && id > 0);
  if (names.length > 0) {
    conditions.push(`games.id IN (${names.map(() => '?').join(', ')})`);
    params.push(...names);
  }

  // Steam library: the route already resolved this to a list of owned appids.
  if (Array.isArray(filters.steamLibrary)) {
    if (filters.steamLibrary.length === 0) {
      conditions.push('1 = 0');
    } else {
      conditions.push(`games.steam_appid IN (${filters.steamLibrary.map(() => '?').join(', ')})`);
      params.push(...filters.steamLibrary);
    }
  }

  const sql = `SELECT games.id FROM games ${joins.join(' ')} WHERE ${conditions.join(' AND ')}`.replace(/\s+/g, ' ').trim();
  return { sql, params };
}

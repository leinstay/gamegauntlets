import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildWheelQuery, regionAvailabilityCondition } from '../../src/lib/wheel-query.js';

// Always-on prefix for the default `{ lang: 'en' }` (or omitted, same default) case: steam_delisted/
// non_game/purchasable plus the regional-availability filter's "en" branch (see the
// "purchasable / regional availability" section below for the ru/cisPrices variants).
const ALWAYS_ON_EN = "steam_delisted = 0 AND non_game IS NULL AND purchasable = 1 AND NOT (COALESCE(price_usd, 0) = 0 AND COALESCE(price_rub, 0) > 0)";
const ALWAYS_ON_RU = "steam_delisted = 0 AND non_game IS NULL AND purchasable = 1 AND NOT (COALESCE(price_rub, 0) = 0 AND COALESCE(price_usd, 0) > 0)";

test('no filters: only the always-on steam_delisted/non_game/purchasable/region conditions', () => {
  const { sql, params } = buildWheelQuery({}, { lang: 'en' });
  assert.equal(
    sql,
    `SELECT games.id FROM games WHERE ${ALWAYS_ON_EN} AND gg_score IS NOT NULL AND final_time IS NOT NULL`,
  );
  assert.deepEqual(params, []);
});

test('allowEmpty: true drops the NOT NULL conditions', () => {
  const { sql, params } = buildWheelQuery({ allowEmpty: true }, {});
  assert.equal(sql, `SELECT games.id FROM games WHERE ${ALWAYS_ON_EN}`);
  assert.deepEqual(params, []);
});

test('include list: OR semantics, one grouped LIKE alternation (legacy REGEXP alternation)', () => {
  const { sql, params } = buildWheelQuery({ include: { genres: ['RPG', 'Action'] }, allowEmpty: true }, {});
  assert.equal(
    sql,
    `SELECT games.id FROM games WHERE ${ALWAYS_ON_EN} AND (genres LIKE CONCAT('%|', ?, '|%') OR genres LIKE CONCAT('%|', ?, '|%'))`,
  );
  assert.deepEqual(params, ['RPG', 'Action']);
});

test('exclude list: NULL-safe, rejects a game with ANY of the excluded values', () => {
  const { sql, params } = buildWheelQuery({ exclude: { tags: ['Horror'] }, allowEmpty: true }, {});
  assert.equal(
    sql,
    `SELECT games.id FROM games WHERE ${ALWAYS_ON_EN} AND (tags IS NULL OR NOT (tags LIKE CONCAT('%|', ?, '|%')))`,
  );
  assert.deepEqual(params, ['Horror']);
});

test('exclude list: multiple values grouped into one NOT (... OR ...)', () => {
  const { sql, params } = buildWheelQuery({ exclude: { tags: ['Horror', 'Gore'] }, allowEmpty: true }, {});
  assert.equal(
    sql,
    `SELECT games.id FROM games WHERE ${ALWAYS_ON_EN} AND (tags IS NULL OR NOT (tags LIKE CONCAT('%|', ?, '|%') OR tags LIKE CONCAT('%|', ?, '|%')))`,
  );
  assert.deepEqual(params, ['Horror', 'Gore']);
});

test('include + exclude across several fields combine with AND, each field independent', () => {
  // All include-group fields are emitted first (in PIPE_LIST_FIELDS order), then all
  // exclude-group fields — buildWheelQuery processes the two groups as separate passes.
  const { sql, params } = buildWheelQuery(
    {
      include: { genres: ['RPG'], developers: ['CD Projekt'] },
      exclude: { categories: ['VR'] },
      allowEmpty: true,
    },
    {},
  );
  assert.equal(
    sql,
    `SELECT games.id FROM games WHERE ${ALWAYS_ON_EN} ` +
      "AND (genres LIKE CONCAT('%|', ?, '|%')) " +
      "AND (developers COLLATE utf8mb4_unicode_ci LIKE CONCAT('%|', ?, '|%')) " +
      "AND (categories IS NULL OR NOT (categories LIKE CONCAT('%|', ?, '|%')))",
  );
  assert.deepEqual(params, ['RPG', 'CD Projekt', 'VR']);
});

test('developers/publishers: include compares case-insensitively (COLLATE), matching every spelling merged into the value', () => {
  const { sql, params } = buildWheelQuery({ include: { developers: ['8floor'] }, allowEmpty: true }, {});
  assert.equal(
    sql,
    `SELECT games.id FROM games WHERE ${ALWAYS_ON_EN} AND (developers COLLATE utf8mb4_unicode_ci LIKE CONCAT('%|', ?, '|%'))`,
  );
  assert.deepEqual(params, ['8floor']);
});

test('developers/publishers: exclude also compares case-insensitively, still NULL-safe', () => {
  const { sql, params } = buildWheelQuery({ exclude: { publishers: ['8FLOOR'] }, allowEmpty: true }, {});
  assert.equal(
    sql,
    `SELECT games.id FROM games WHERE ${ALWAYS_ON_EN} AND (publishers IS NULL OR NOT (publishers COLLATE utf8mb4_unicode_ci LIKE CONCAT('%|', ?, '|%')))`,
  );
  assert.deepEqual(params, ['8FLOOR']);
});

test('other pipe-list fields are NOT made case-insensitive (no COLLATE added)', () => {
  const { sql } = buildWheelQuery({ include: { genres: ['RPG'], tags: ['Indie'], categories: ['VR'], languages: ['English'], voiceovers: ['English'] }, allowEmpty: true }, {});
  assert.ok(!sql.includes('COLLATE'), sql);
});

test('difficulty include/exclude use IN / NOT IN, not LIKE (scalar column, not pipe-wrapped)', () => {
  const included = buildWheelQuery({ include: { difficulty: ['Easy', 'Tough'] }, allowEmpty: true }, {});
  assert.equal(
    included.sql,
    `SELECT games.id FROM games WHERE ${ALWAYS_ON_EN} AND difficulty IN (?, ?)`,
  );
  assert.deepEqual(included.params, ['Easy', 'Tough']);

  const excluded = buildWheelQuery({ exclude: { difficulty: ['Unforgiving'] }, allowEmpty: true }, {});
  assert.equal(
    excluded.sql,
    `SELECT games.id FROM games WHERE ${ALWAYS_ON_EN} AND (difficulty IS NULL OR difficulty NOT IN (?))`,
  );
  assert.deepEqual(excluded.params, ['Unforgiving']);
});

test('list filters are capped at 16 items', () => {
  const genres = Array.from({ length: 30 }, (_, i) => `G${i}`);
  const { params } = buildWheelQuery({ include: { genres }, allowEmpty: true }, {});
  assert.equal(params.length, 16);
  assert.deepEqual(params, genres.slice(0, 16));
});

test('price: ru uses price_final_rub, bounded range with the NULL-as-free clause when from=0', () => {
  const { sql, params } = buildWheelQuery({ price: [0, 1000], allowEmpty: true }, { lang: 'ru' });
  assert.equal(
    sql,
    `SELECT games.id FROM games WHERE ${ALWAYS_ON_RU} AND (price_final_rub BETWEEN ? AND ? OR (? = 0 AND price_final_rub IS NULL))`,
  );
  assert.deepEqual(params, [0, 100000, 0]);
});

test('price: non-ru uses price_final_usd; from>0 does not admit NULL-priced rows', () => {
  const { sql, params } = buildWheelQuery({ price: [10, 50], allowEmpty: true }, { lang: 'en' });
  assert.equal(
    sql,
    `SELECT games.id FROM games WHERE ${ALWAYS_ON_EN} AND (price_final_usd BETWEEN ? AND ? OR (? = 0 AND price_final_usd IS NULL))`,
  );
  assert.deepEqual(params, [1000, 5000, 1000]);
});

test('price: cisPrices forces price_final_cis_usd regardless of lang', () => {
  const { sql, params } = buildWheelQuery({ price: [0, 20], allowEmpty: true }, { lang: 'ru', cisPrices: true });
  assert.match(sql, /price_final_cis_usd/);
  assert.deepEqual(params, [0, 2000, 0]);
});

test('price: top-of-slider (ru 5000) means unlimited — upper bound dropped', () => {
  const { sql, params } = buildWheelQuery({ price: [0, 5000], allowEmpty: true }, { lang: 'ru' });
  assert.equal(
    sql,
    `SELECT games.id FROM games WHERE ${ALWAYS_ON_RU} AND (price_final_rub >= ? OR price_final_rub IS NULL)`,
  );
  assert.deepEqual(params, [0]);
});

test('price: top-of-slider with from>0 means unlimited but no free-game admission', () => {
  const { sql, params } = buildWheelQuery({ price: [10, 500] }, { lang: 'en', config: null });
  assert.ok(sql.includes('price_final_usd >= ?'));
  assert.deepEqual(params.slice(0, 1), [1000]);
});

test('price: config.wheel.priceMax overrides the legacy default top-of-slider', () => {
  const config = { wheel: { priceMax: { usd: 100 } } };
  const { sql } = buildWheelQuery({ price: [0, 100] }, { lang: 'en', config });
  assert.ok(sql.includes('price_final_usd >= ?'));
});

test('score and length are BETWEEN on gg_score / final_time', () => {
  const { sql, params } = buildWheelQuery({ score: [50, 100], length: [5, 20], allowEmpty: true }, {});
  assert.equal(
    sql,
    `SELECT games.id FROM games WHERE ${ALWAYS_ON_EN} AND gg_score BETWEEN ? AND ? AND final_time BETWEEN ? AND ?`,
  );
  assert.deepEqual(params, [50, 100, 5, 20]);
});

test('released: YYYY-MM pair becomes a month-bounded release_date range with LAST_DAY', () => {
  const { sql, params } = buildWheelQuery({ released: ['2020-01', '2020-06'], allowEmpty: true }, {});
  assert.equal(
    sql,
    `SELECT games.id FROM games WHERE ${ALWAYS_ON_EN} AND release_date BETWEEN ? AND LAST_DAY(?)`,
  );
  assert.deepEqual(params, ['2020-01-01', '2020-06-01']);
});

test('preset: INNER JOIN preset_games with the preset id as a parameter', () => {
  const { sql, params } = buildWheelQuery({ preset: 7, allowEmpty: true }, {});
  assert.equal(
    sql,
    `SELECT games.id FROM games INNER JOIN preset_games ON preset_games.game_id = games.id AND preset_games.preset_id = ? WHERE ${ALWAYS_ON_EN}`,
  );
  assert.deepEqual(params, [7]);
});

test('names: games.id IN (...), capped at 16', () => {
  const names = Array.from({ length: 20 }, (_, i) => i + 1);
  const { sql, params } = buildWheelQuery({ names, allowEmpty: true }, {});
  assert.ok(sql.includes('games.id IN ('));
  assert.equal(params.length, 16);
  assert.deepEqual(params, names.slice(0, 16));
});

test('steamLibrary: resolved appid array becomes steam_appid IN (...)', () => {
  const { sql, params } = buildWheelQuery({ steamLibrary: [10, 20, 30], allowEmpty: true }, {});
  assert.equal(
    sql,
    `SELECT games.id FROM games WHERE ${ALWAYS_ON_EN} AND games.steam_appid IN (?, ?, ?)`,
  );
  assert.deepEqual(params, [10, 20, 30]);
});

test('steamLibrary: empty owned-games array short-circuits to no matches, not invalid SQL', () => {
  const { sql, params } = buildWheelQuery({ steamLibrary: [], allowEmpty: true }, {});
  assert.equal(sql, `SELECT games.id FROM games WHERE ${ALWAYS_ON_EN} AND 1 = 0`);
  assert.deepEqual(params, []);
});

test('steam_delisted = 0 AND non_game IS NULL AND purchasable = 1 is always present regardless of other filters', () => {
  const { sql } = buildWheelQuery({ include: { genres: ['RPG'] }, preset: 1, names: [1, 2] }, {});
  assert.ok(sql.startsWith('SELECT games.id FROM games'));
  assert.ok(sql.includes('steam_delisted = 0 AND non_game IS NULL AND purchasable = 1'));
});

test('injection attempts in list values land only in params, never in the SQL text', () => {
  const evil = "'; DROP TABLE games; --";
  const { sql, params } = buildWheelQuery({ include: { genres: [evil] }, allowEmpty: true }, {});
  assert.ok(!sql.includes('DROP TABLE'));
  assert.ok(!sql.includes(evil));
  assert.deepEqual(params, [evil]);
  // The only place user input appears in the query string at all is as a `?` placeholder.
  assert.equal((sql.match(/\?/g) || []).length, params.length);
});

test('injection attempts in preset/names/steamLibrary (numeric-typed fields) also land only in params', () => {
  const { sql, params } = buildWheelQuery(
    {
      preset: '1; DROP TABLE users; --',
      names: ["1) OR ('1'='1"],
      steamLibrary: ["10; DELETE FROM games; --"],
      allowEmpty: true,
    },
    {},
  );
  assert.ok(!sql.includes('DROP TABLE'));
  assert.ok(!sql.includes('DELETE FROM'));
  assert.ok(!sql.includes('OR'));
  // Non-integer preset/name ids are dropped entirely (never reach SQL or params); the
  // steamLibrary value still only ever travels as a bound parameter.
  assert.ok(!sql.includes('preset_games'));
  assert.deepEqual(params, ['10; DELETE FROM games; --']);
});

test('every ? placeholder in the SQL has exactly one corresponding param, in order, for a kitchen-sink filter set', () => {
  const { sql, params } = buildWheelQuery(
    {
      include: { genres: ['RPG'], tags: ['Roguelike'] },
      exclude: { categories: ['VR'] },
      price: [0, 20],
      score: [10, 90],
      length: [1, 50],
      released: ['2010-01', '2020-12'],
      preset: 3,
      names: [1, 2, 3],
      steamLibrary: [100, 200],
    },
    { lang: 'en' },
  );
  const placeholderCount = (sql.match(/\?/g) || []).length;
  assert.equal(placeholderCount, params.length);
  // Sanity: nothing from the filter values leaked into the SQL text itself.
  for (const p of params) {
    if (typeof p === 'string' && p.length > 2) assert.ok(!sql.includes(p));
  }
});

test('coerced nulls (preset 0, names [0]) do not add a preset join or an id filter', () => {
  const { sql, params } = buildWheelQuery(
    { include: {}, exclude: {}, preset: 0, names: [0], allowEmpty: true },
    { lang: 'en', cisPrices: false },
  );
  assert.ok(!sql.includes('preset_games'), sql);
  assert.ok(!sql.includes('games.id IN'), sql);
  assert.deepEqual(params, []);
});

// --- purchasable / regional availability (migrations/005_purchasable.sql, Part B: legacy gateway.php
// lines ~160-166 - the CIS-region toggle and the ru/en price-availability filter) -----------------------

test('purchasable = 1 is always in the WHERE clause, regardless of filters', () => {
  const { sql } = buildWheelQuery({}, {});
  assert.match(sql, /\bpurchasable = 1\b/);
});

test('regionAvailabilityCondition: cisPrices true drops the filter entirely, for every language', () => {
  assert.equal(regionAvailabilityCondition('ru', true), null);
  assert.equal(regionAvailabilityCondition('en', true), null);
  assert.equal(regionAvailabilityCondition('de', true), null);
});

test('regionAvailabilityCondition: ru (cisPrices off) rejects "paid elsewhere, not sold in RU"', () => {
  assert.equal(
    regionAvailabilityCondition('ru', false),
    'NOT (COALESCE(price_rub, 0) = 0 AND COALESCE(price_usd, 0) > 0)',
  );
});

test('regionAvailabilityCondition: every non-ru language (en/de/fr) rejects "paid elsewhere, not sold in that region" the same way as legacy\'s "en" branch', () => {
  const expected = 'NOT (COALESCE(price_usd, 0) = 0 AND COALESCE(price_rub, 0) > 0)';
  assert.equal(regionAvailabilityCondition('en', false), expected);
  assert.equal(regionAvailabilityCondition('de', false), expected);
  assert.equal(regionAvailabilityCondition('fr', false), expected);
});

test('buildWheelQuery: cisPrices true drops the regional-availability condition from the WHERE clause', () => {
  const { sql } = buildWheelQuery({}, { lang: 'ru', cisPrices: true });
  assert.ok(!sql.includes('COALESCE(price_rub'));
  assert.ok(!sql.includes('COALESCE(price_usd'));
  assert.match(sql, /purchasable = 1/);
});

test('buildWheelQuery: ru without cisPrices includes the ru regional-availability condition', () => {
  const { sql } = buildWheelQuery({}, { lang: 'ru', cisPrices: false });
  assert.match(sql, /NOT \(COALESCE\(price_rub, 0\) = 0 AND COALESCE\(price_usd, 0\) > 0\)/);
});

// src/pipeline/export-push.js / src/pipeline/export.js (nightly export to the public
// leinstay/steamdb repo). Covers only the data pipeline (src/pipeline/export.js): row mapping
// (mapRow's single clean key order), list conversion, and the file writer against a real temp
// dir. No git: src/pipeline/export-push.js's commit/push/README step needs a real git checkout
// and DB and is out of scope for a unit test (and importing that file here would require
// DB_HOST/DB_NAME to be set, since it lazily imports src/db.js — see that file's header).
//
// 2026-09-19 dump cleanup: the export used to carry a legacy dump.php key layout (mapRow) with the
// rewrite's own fields appended after it (mapRowV2), reproduced here against a frozen migration
// fixture (tests/fixtures/legacy/export-rows-sample.json). Backward compatibility with that layout
// is no longer required — both mappers collapsed into one mapRow with a clean key order — so those
// round-trip tests and the fixture they used are gone; the rules mapRow still has to follow (source
// gating, list conversion, numeric coercion, key order) are covered with small hand-built rows below,
// same style as the synthetic-row tests already used for the rules with no real fixture to exercise
// them.
//
// 2026-09-20 final schema pass: every cryptic legacy key was renamed to a self-explanatory,
// source-prefixed name (sid -> steam_appid, store_url -> steam_url, full_price -> price_usd,
// current_price -> price_final_usd, discount -> discount_percent, published_store ->
// store_release_date, stsp_owners -> steamspy_owners, gfq_* -> gamefaqs_*, hltb_single ->
// hltb_main_hours, hltb_complete -> hltb_complete_hours, meta_* -> metacritic_*, igdb_uscore ->
// igdb_user_score, ggp -> gg_points), the duplicate `store_uscore` (== steam_reviews_percent) is gone,
// and every list field (developers/publishers/languages/voiceovers/categories/genres/tags/platforms)
// is now an array of strings instead of a comma-joined string.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  mapRow,
  buildExportQuery,
  streamRows,
  runExport,
  runFullExport,
  CHUNK_SIZE,
} from '../src/pipeline/export.js';
import { steamReviewLabel } from '../src/lib/steam-review-label.js';

// The exact key order mapRow() writes to steamdb.json (identity, steam, gog, release, store data,
// per-source blocks, derived, updated_at last) — see that file's own comment for the reasoning,
// mirrored in src/pipeline/export-readme.js's FIELD_DEFS.
const EXPECTED_KEY_ORDER = [
  'id', 'kind', 'name', 'image', 'description', 'steam_appid', 'steam_url', 'gog_id', 'gog_url',
  'release_date', 'release_precision', 'early_access_date', 'store_release_date',
  'price_usd', 'price_final_usd', 'discount_percent', 'platforms', 'developers', 'publishers',
  'languages', 'voiceovers', 'categories', 'genres', 'tags', 'achievements',
  'steam_reviews_percent', 'steam_reviews_count', 'steam_reviews_label',
  'steam_recent_percent', 'steam_recent_count', 'steam_recent_label',
  'steamspy_owners', 'average_playtime_hours', 'average_playtime_source',
  'hltb_url', 'hltb_main_hours', 'hltb_complete_hours',
  'gamefaqs_url', 'gamefaqs_difficulty', 'gamefaqs_rating',
  'metacritic_url', 'metacritic_score', 'metacritic_reviews', 'metacritic_user_score',
  'igdb_url', 'igdb_score', 'igdb_user_score',
  'gamerankings_score',
  'gg_score', 'gg_points',
  'updated_at',
];

// --- mapRow: key order and per-field rules -----------------------------------

test('mapRow: key order is identity, store data, per-source blocks, derived, updated_at last', () => {
  const mapped = mapRow({ id: 1 });
  assert.deepEqual(Object.keys(mapped), EXPECTED_KEY_ORDER);
});

test('mapRow: no removed key (dropped-legacy-only, frozen snapshots, duplicate grnk_score, CIS/RUB) is present', () => {
  const mapped = mapRow({ id: 1 });
  const removed = [
    'store_promo_url', 'gfq_difficulty_comment', 'gfq_rating_comment', 'gfq_length', 'gfq_length_comment',
    'stsp_mdntime', 'igdb_single', 'igdb_complete', 'igdb_popularity',
    'published_meta', 'published_stsp', 'published_hltb', 'published_igdb',
    'grnk_score',
    'price_cis_usd', 'price_final_cis_usd', 'discount_cis_usd',
    'price_rub', 'price_final_rub', 'discount_rub',
    // 2026-09-20 final schema pass: store_uscore was a byte-for-byte duplicate of
    // steam_reviews_percent (both g.score_steam); every other old cryptic key (sid, store_url,
    // full_price, current_price, discount, published_store, stsp_owners, gfq_*, hltb_single,
    // hltb_complete, meta_*, igdb_uscore, ggp) was renamed, not removed — checked separately below.
    'store_uscore',
  ];
  for (const key of removed) assert.ok(!(key in mapped), `${key} must not be exported`);
});

test('mapRow: no old cryptic key name survives the rename', () => {
  const mapped = mapRow({ id: 1 });
  const renamedAway = [
    'sid', 'store_url', 'full_price', 'current_price', 'discount', 'published_store',
    'stsp_owners', 'gfq_url', 'gfq_difficulty', 'gfq_rating', 'hltb_single', 'hltb_complete',
    'meta_url', 'meta_score', 'meta_uscore', 'igdb_uscore', 'ggp',
  ];
  for (const key of renamedAway) assert.ok(!(key in mapped), `${key} must not be exported (renamed)`);
});

test('mapRow: every field is null (not undefined) for a bare row with only an id', () => {
  const mapped = mapRow({ id: 1 });
  for (const [key, value] of Object.entries(mapped)) {
    assert.notEqual(value, undefined, `${key} should be null, not undefined`);
  }
  assert.equal(mapped.kind, null);
  assert.equal(mapped.gg_score, null);
});

test('mapRow: identity fields pass through their source columns', () => {
  const row = {
    id: 7,
    kind: 'steam',
    steam_appid: '50130',
    gog_id: null,
    name: 'Mafia II',
    image: 'https://example.com/header.jpg',
    description_en: 'desc',
    link_steam: 'https://store.steampowered.com/app/50130',
    link_gog: null,
  };
  const mapped = mapRow(row);
  assert.equal(mapped.id, 7);
  assert.equal(mapped.kind, 'steam');
  assert.equal(mapped.steam_appid, 50130);
  assert.equal(mapped.gog_id, null);
  assert.equal(mapped.name, 'Mafia II');
  assert.equal(mapped.image, 'https://example.com/header.jpg');
  assert.equal(mapped.description, 'desc');
  assert.equal(mapped.steam_url, 'https://store.steampowered.com/app/50130');
  assert.equal(mapped.gog_url, null);
});

test('mapRow: metacritic_score is null when score_critics came from OpenCritic, not Metacritic', () => {
  const row = {
    id: 1,
    score_critics: 88,
    score_critics_source: 'opencritic',
    score_users_metacritic: 81,
    score_critics_count: 500,
  };
  const mapped = mapRow(row);
  assert.equal(mapped.metacritic_score, null);
  assert.equal(mapped.metacritic_user_score, 81);
  assert.equal(mapped.metacritic_reviews, null, 'metacritic_reviews is gated the same way metacritic_score is');
});

test('mapRow: metacritic_reviews passes through score_critics_count when the source is metacritic', () => {
  const row = { id: 1, score_critics: 77, score_critics_source: 'metacritic', score_critics_count: 1234 };
  const mapped = mapRow(row);
  assert.equal(mapped.metacritic_score, 77);
  assert.equal(mapped.metacritic_reviews, 1234);
});

test('mapRow: steam review percent/count/label track score_steam(_votes) via steamReviewLabel', () => {
  const row = { id: 1, score_steam: 97, score_steam_votes: 50000 };
  const mapped = mapRow(row);
  assert.equal(mapped.steam_reviews_percent, 97);
  assert.equal(mapped.steam_reviews_count, 50000);
  assert.equal(mapped.steam_reviews_label, steamReviewLabel(97, 50000));
  assert.equal(mapped.steam_reviews_label, 'Overwhelmingly Positive');
});

test('mapRow: steam_reviews_label is null under 10 votes, but percent/count still pass through', () => {
  const row = { id: 1, score_steam: 100, score_steam_votes: 3 };
  const mapped = mapRow(row);
  assert.equal(mapped.steam_reviews_percent, 100);
  assert.equal(mapped.steam_reviews_count, 3);
  assert.equal(mapped.steam_reviews_label, null);
});

test('mapRow: steam_recent_* mirrors steam_reviews_* but off score_steam_recent(_votes)', () => {
  const row = { id: 1, score_steam_recent: 60, score_steam_recent_votes: 200 };
  const mapped = mapRow(row);
  assert.equal(mapped.steam_recent_percent, 60);
  assert.equal(mapped.steam_recent_count, 200);
  assert.equal(mapped.steam_recent_label, 'Mixed');
});

test('mapRow: average_playtime_hours/source pass through time_average/time_average_source', () => {
  const row = { id: 1, time_average: '11.5', time_average_source: 'steam_reviews' };
  const mapped = mapRow(row);
  assert.equal(mapped.average_playtime_hours, 11.5);
  assert.equal(mapped.average_playtime_source, 'steam_reviews');
});

test('mapRow: kind/gog_id/gog_url/release_date/gg_score/gg_points pass through the games/game_links columns', () => {
  const row = {
    id: 1,
    kind: 'gog_exclusive',
    gog_id: '1234567890',
    link_gog: 'https://www.gog.com/game/example',
    release_date: '2015-06-01',
    release_precision: 'day',
    early_access_date: '2014-01-01',
    gg_score: 82,
    ggp: 40,
    updated_at: '2026-09-19 03:00:00',
  };
  const mapped = mapRow(row);
  assert.equal(mapped.kind, 'gog_exclusive');
  assert.equal(mapped.gog_id, 1234567890);
  assert.equal(mapped.gog_url, 'https://www.gog.com/game/example');
  assert.equal(mapped.release_date, '2015-06-01');
  assert.equal(mapped.release_precision, 'day');
  assert.equal(mapped.early_access_date, '2014-01-01');
  assert.equal(mapped.gg_score, 82);
  assert.equal(mapped.gg_points, 40);
  assert.equal(mapped.updated_at, '2026-09-19T03:00:00Z');
});

test('mapRow: gamerankings_score passes through score_gamerankings as-is', () => {
  const mapped = mapRow({ id: 1, score_gamerankings: 88 });
  assert.equal(mapped.gamerankings_score, 88);
});

// --- list conversion ------------------------------------------------

test('mapRow: pipe-wrapped list columns convert to arrays of strings', () => {
  const row = { id: 1, genres: '|Action|RPG|', tags: '|Open World|Story Rich|' };
  const mapped = mapRow(row);
  assert.deepEqual(mapped.genres, ['Action', 'RPG']);
  assert.deepEqual(mapped.tags, ['Open World', 'Story Rich']);
});

test('mapRow: null/empty list columns convert to [], not null or an empty string', () => {
  assert.deepEqual(mapRow({ id: 1, genres: null }).genres, []);
  assert.deepEqual(mapRow({ id: 1, genres: '||' }).genres, []);
  assert.deepEqual(mapRow({ id: 1, genres: '' }).genres, []);
});

test('mapRow: every list field is an array, empty when the source column has no data', () => {
  const mapped = mapRow({ id: 1 });
  for (const key of ['platforms', 'developers', 'publishers', 'languages', 'voiceovers', 'categories', 'genres', 'tags']) {
    assert.deepEqual(mapped[key], [], `${key} should be [] for a bare row`);
  }
});

test('mapRow: platforms (SET column, a comma string, not pipe-wrapped) converts to an array of strings', () => {
  assert.deepEqual(mapRow({ id: 1, platforms: 'WIN,MAC' }).platforms, ['WIN', 'MAC']);
  assert.deepEqual(mapRow({ id: 1, platforms: null }).platforms, []);
  assert.deepEqual(mapRow({ id: 1, platforms: '' }).platforms, []);
});

test('mapRow: DECIMAL score/time columns (returned as strings by mysql2) are coerced to numbers', () => {
  const row = { id: 1, score_gamefaqs: '3.76', time_main: '12.0', time_complete: '28.5', steam_appid: '50130' };
  const mapped = mapRow(row);
  assert.equal(mapped.gamefaqs_rating, 3.76);
  assert.equal(mapped.hltb_main_hours, 12);
  assert.equal(mapped.hltb_complete_hours, 28.5);
  assert.equal(mapped.steam_appid, 50130);
});

// --- buildExportQuery / streamRows (one dump, both kinds, id-ordered chunks) ---------

test('buildExportQuery: excludes non-games/unpurchasable/100%-discounted, orders and paginates by id, not filtered by kind', () => {
  const { sql, params } = buildExportQuery({ afterId: 42, limit: 500 });
  assert.doesNotMatch(sql, /g\.kind = \?/); // one dump, both kinds — see src/pipeline/export.js's header
  assert.match(sql, /g\.non_game IS NULL/); // migrations/004_non_game.sql: never publish DLC/soundtracks/etc.
  assert.match(sql, /g\.purchasable = 1/); // migrations/005_purchasable.sql: never publish an unpurchasable row
  assert.match(sql, /discount_usd <> 100 OR g\.discount_usd IS NULL/);
  assert.match(sql, /ORDER BY g\.id/);
  assert.deepEqual(params, [42, 500]);
});

test('buildExportQuery: no longer joins the frozen legacy_steamdb source_records snapshot', () => {
  const { sql } = buildExportQuery();
  assert.doesNotMatch(sql, /legacy_steamdb/);
  assert.doesNotMatch(sql, /source_records/);
});

test('buildExportQuery: defaults to afterId=0, limit=CHUNK_SIZE', () => {
  const { params } = buildExportQuery();
  assert.deepEqual(params, [0, CHUNK_SIZE]);
});

/**
 * Fake `db` tolerant of the `purchasable` column not existing yet on a row
 * (migrations/005_purchasable.sql lands separately from this task — see
 * src/pipeline/export.js's header) — a row with no `purchasable` field at
 * all is still matched, same as one explicitly `purchasable: 1`. Not scoped
 * by `kind` — the real query isn't anymore either (see buildExportQuery).
 */
function makeFakeDb(allRows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push(params);
      const [afterId, limit] = params;
      return allRows.filter((r) => r.id > afterId && r.purchasable !== 0).slice(0, limit);
    },
  };
}

test('streamRows: walks every row (both kinds) in ascending-id chunks, one round trip per chunk', async () => {
  const allRows = [
    { id: 1, kind: 'steam' },
    { id: 2, kind: 'gog_exclusive' },
    { id: 3, kind: 'steam' },
    { id: 4, kind: 'steam' },
    { id: 5, kind: 'gog_exclusive' },
    { id: 6, kind: 'steam' },
    { id: 7, kind: 'gog_exclusive' },
  ];
  const db = makeFakeDb(allRows);
  const chunks = [];
  const total = await streamRows(db, async (rows) => chunks.push(rows), { chunkSize: 3 });

  assert.equal(total, 7);
  assert.deepEqual(
    chunks.map((c) => c.map((r) => r.id)),
    [[1, 2, 3], [4, 5, 6], [7]],
  );
  // afterId escalates from the last row of the previous chunk each time.
  assert.deepEqual(db.calls, [[0, 3], [3, 3], [6, 3]]);
});

test('streamRows: an empty result set makes exactly one round trip and calls onChunk zero times', async () => {
  const db = makeFakeDb([]);
  let calls = 0;
  const total = await streamRows(db, async () => { calls += 1; }, { chunkSize: 3 });
  assert.equal(total, 0);
  assert.equal(calls, 0);
  assert.equal(db.calls.length, 1);
});

test('streamRows: default chunk size is CHUNK_SIZE', async () => {
  const db = makeFakeDb([{ id: 1, kind: 'steam' }]);
  await streamRows(db, async () => {});
  assert.deepEqual(db.calls[0], [0, CHUNK_SIZE]);
});

// --- runExport: writer against a real temp dir (no git) ----------------------

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-export-test-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const gunzip = (buf) => new Promise((resolve, reject) => zlib.gunzip(buf, (err, out) => (err ? reject(err) : resolve(out))));

test('runExport: writes steamdb.json, steamdb.min.json and steamdb.min.json.gz with matching content by default', async () => {
  await withTempDir(async (dir) => {
    const rows = [
      { id: 1, kind: 'steam', steam_appid: 10, name: 'Alpha', genres: '|Action|', discount_usd: null },
      { id: 2, kind: 'steam', steam_appid: 20, name: 'Beta', genres: '|RPG|Indie|', discount_usd: 50 },
      { id: 3, kind: 'steam', steam_appid: 30, name: 'Gamma', genres: null, discount_usd: 0 },
    ];
    const db = makeFakeDb(rows);
    const log = { info() {}, warn() {}, error() {} };

    const result = await runExport({ db, log }, { outDir: dir, chunkSize: 2 });

    assert.equal(result.count, 3);
    assert.equal(result.baseName, 'steamdb');
    assert.equal(result.prettyPath, path.join(dir, 'steamdb.json'));
    assert.equal(result.minPath, path.join(dir, 'steamdb.min.json'));
    assert.equal(result.gzPath, path.join(dir, 'steamdb.min.json.gz'));

    const pretty = JSON.parse(fs.readFileSync(result.prettyPath, 'utf8'));
    const min = JSON.parse(fs.readFileSync(result.minPath, 'utf8'));
    const gunzipped = JSON.parse((await gunzip(fs.readFileSync(result.gzPath))).toString('utf8'));

    const expected = rows.map(mapRow);
    assert.deepEqual(pretty, expected);
    assert.deepEqual(min, expected);
    assert.deepEqual(gunzipped, expected);
    assert.ok('kind' in pretty[0], 'rows carry kind');
    assert.deepEqual(result.firstRow, expected[0], 'firstRow is the first mapped row, for the README Example section');

    // Pretty file is actually pretty-printed (not just valid JSON).
    const prettyText = fs.readFileSync(result.prettyPath, 'utf8');
    assert.ok(prettyText.includes('\n'));
    assert.ok(prettyText.startsWith('[\n'));

    // No leftover .tmp files after a successful run.
    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      ['steamdb.json', 'steamdb.min.json', 'steamdb.min.json.gz'],
    );
  });
});

test('runExport: opts.mapRow overrides the mapper', async () => {
  await withTempDir(async (dir) => {
    const rows = [{ id: 1, kind: 'steam', name: 'Solo' }];
    const db = makeFakeDb(rows);
    const customMapper = (row) => ({ onlyId: row.id });
    const result = await runExport({ db }, { outDir: dir, mapRow: customMapper });
    const min = JSON.parse(fs.readFileSync(result.minPath, 'utf8'));
    assert.deepEqual(min, [{ onlyId: 1 }]);
  });
});

test('runExport: an empty result set still writes a valid empty JSON array', async () => {
  await withTempDir(async (dir) => {
    const db = makeFakeDb([]);
    const result = await runExport({ db, log: undefined }, { outDir: dir });
    assert.equal(result.count, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.minPath, 'utf8')), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.prettyPath, 'utf8')), []);
    assert.equal(result.firstRow, undefined, 'no rows -> no firstRow');
  });
});

test('runExport: throws when opts.outDir is missing', async () => {
  await assert.rejects(() => runExport({ db: makeFakeDb([]) }, {}), /outDir is required/);
});

test('runExport: creates outDir if it does not exist yet', async () => {
  await withTempDir(async (dir) => {
    const nested = path.join(dir, 'nested', 'steamdb');
    const db = makeFakeDb([{ id: 1, kind: 'steam', name: 'Solo' }]);
    const result = await runExport({ db }, { outDir: nested });
    assert.equal(result.count, 1);
    assert.ok(fs.existsSync(nested));
  });
});

test('runExport: a purchasable=0 row is excluded (fake db mirrors the SQL filter)', async () => {
  await withTempDir(async (dir) => {
    const rows = [
      { id: 1, kind: 'steam', name: 'Keep' },
      { id: 2, kind: 'steam', name: 'Drop', purchasable: 0 },
    ];
    const db = makeFakeDb(rows);
    const result = await runExport({ db }, { outDir: dir });
    assert.equal(result.count, 1);
    const min = JSON.parse(fs.readFileSync(result.minPath, 'utf8'));
    assert.equal(min.length, 1);
    assert.equal(min[0].name, 'Keep');
  });
});

test('runExport: mixes steam and gog_exclusive rows in one dump, ordered by id, kind tells them apart', async () => {
  await withTempDir(async (dir) => {
    const rows = [
      { id: 1, kind: 'steam', name: 'Steam Game', steam_appid: 10 },
      { id: 2, kind: 'gog_exclusive', name: 'GOG Only Game', gog_id: 999 },
      { id: 3, kind: 'steam', name: 'Another Steam Game', steam_appid: 30 },
    ];
    const db = makeFakeDb(rows);
    const result = await runExport({ db }, { outDir: dir });

    assert.equal(result.count, 3);
    const min = JSON.parse(fs.readFileSync(result.minPath, 'utf8'));
    assert.deepEqual(min.map((r) => r.name), ['Steam Game', 'GOG Only Game', 'Another Steam Game']);
    assert.deepEqual(min.map((r) => r.kind), ['steam', 'gog_exclusive', 'steam']);
    assert.equal(min[1].steam_appid, null, 'steam-only keys are null on a GOG-exclusive row');
    assert.equal(min[1].gog_id, 999);
  });
});

// --- runFullExport: one dump (steamdb.*), no gogdb.* files ---

test('runFullExport: writes steamdb.* only, with both kinds mixed into the same file set', async () => {
  await withTempDir(async (dir) => {
    const rows = [
      { id: 1, kind: 'steam', name: 'Steam Game' },
      { id: 2, kind: 'gog_exclusive', name: 'GOG Only Game', gog_id: 999 },
    ];
    const db = makeFakeDb(rows);
    const result = await runFullExport({ db }, { outDir: dir });

    assert.equal(result.count, 2);
    assert.equal(result.baseName, 'steamdb');
    assert.equal(result.prettyPath, path.join(dir, 'steamdb.json'));

    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      ['steamdb.json', 'steamdb.min.json', 'steamdb.min.json.gz'],
    );

    const min = JSON.parse(fs.readFileSync(result.minPath, 'utf8'));
    assert.equal(min.length, 2);
    assert.equal(min[0].name, 'Steam Game');
    assert.equal(min[0].kind, 'steam');
    assert.equal(min[1].name, 'GOG Only Game');
    assert.equal(min[1].kind, 'gog_exclusive');
    assert.equal(min[1].gog_id, 999);
  });
});

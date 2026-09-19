// src/pipeline/export-push.js / src/pipeline/export.js (T20 — nightly export
// to the public leinstay/steamdb repo). Covers only the data pipeline
// (src/pipeline/export.js): row mapping against legacy/ajax/misc/dump.php's
// real output shape plus schema-v2's appended fields, list conversion, and
// the file writer against a real temp dir. No git: src/pipeline/export-push.js's
// commit/push/README step needs a real git checkout and DB and is out of
// scope for a unit test (and importing that file here would require
// DB_HOST/DB_NAME to be set, since it lazily imports src/db.js — see that
// file's header).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  mapRow,
  mapRowV2,
  buildExportQuery,
  streamRows,
  runExport,
  runFullExport,
  CHUNK_SIZE,
} from '../src/pipeline/export.js';
import { steamReviewLabel } from '../src/lib/steam-review-label.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const legacyRows = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/legacy/games-sample.json'), 'utf8'));

// Frozen snapshot of what scripts/migrate-legacy.js's mapGameColumns()/mapGameLinks() produced for the three
// legacy rows below, back when that one-time migration tool still lived in the repo (it has since been moved
// to the owner's local .claude/ workstation copy, now that the migration itself is long done). This is exactly
// how a real migrated+exported game reaches mapRow(), so keeping the snapshot pinned still catches a mapRow()
// regression; it just no longer re-derives the migration mapping on every run.
const exportRowsById = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/legacy/export-rows-sample.json'), 'utf8'),
);

function legacyRowById(id) {
  const row = legacyRows.find((r) => r.id === id);
  assert.ok(row, `fixture row ${id} not found`);
  return row;
}

function toExportRow(legacyRow) {
  const row = exportRowsById[String(legacyRow.id)];
  assert.ok(row, `no export-rows-sample.json snapshot for fixture row ${legacyRow.id}`);
  return row;
}

/** dump.php's own SELECT/AS shape for `legacyRow`, straight off the legacy
 * columns — the ground truth mapRow() is compared against, with the
 * fields the rewrite genuinely doesn't keep forced to their documented
 * null (see mapRow's own doc comment for why each one is there). */
function expectedLegacyShape(legacyRow) {
  return {
    sid: Number(legacyRow.sid),
    store_url: legacyRow.store_url ?? null,
    store_promo_url: null, // dropped: no equivalent column in the rewrite
    store_uscore: legacyRow.store_uscore ?? null,
    published_store: legacyRow.published_store ?? null,
    published_meta: legacyRow.published_meta ?? null,
    published_stsp: legacyRow.published_stsp ?? null,
    published_hltb: legacyRow.published_hltb ?? null,
    published_igdb: legacyRow.published_igdb ?? null,
    image: legacyRow.image ?? null,
    name: legacyRow.name ?? null,
    description: legacyRow.description_en ?? null,
    full_price: legacyRow.price_en ?? null,
    current_price: legacyRow.price_final_en ?? null,
    discount: legacyRow.discount_en ?? null,
    platforms: legacyRow.platforms ?? null,
    developers: legacyRow.developers ?? null,
    publishers: legacyRow.publishers ?? null,
    languages: legacyRow.languages ?? null,
    voiceovers: legacyRow.voiceovers ?? null,
    categories: legacyRow.categories ?? null,
    genres: legacyRow.genres ?? null,
    tags: legacyRow.tags ?? null,
    achievements: legacyRow.achievements ?? null,
    gfq_url: legacyRow.gfq_url ?? null,
    gfq_difficulty: legacyRow.gfq_difficulty ?? null,
    gfq_difficulty_comment: null, // always NULL in production already
    gfq_rating: legacyRow.gfq_rating ?? null,
    gfq_rating_comment: null, // always NULL in production already
    gfq_length: null, // dropped: not persisted in the rewrite
    gfq_length_comment: null, // always NULL in production already
    stsp_owners: legacyRow.stsp_owners ?? null,
    stsp_mdntime: null, // dropped: not persisted in the rewrite
    hltb_url: legacyRow.hltb_url ?? null,
    hltb_single: legacyRow.hltb_single ?? null,
    hltb_complete: legacyRow.hltb_complete ?? null,
    meta_url: legacyRow.meta_url ?? null,
    meta_score: legacyRow.meta_score ?? null,
    meta_uscore: legacyRow.meta_uscore ?? null,
    grnk_score: legacyRow.grnk_score ?? null,
    igdb_url: legacyRow.igdb_url ?? null,
    igdb_single: null, // always NULL in production already (never requested)
    igdb_complete: null, // always NULL in production already (never requested)
    igdb_score: legacyRow.igdb_score ?? null,
    igdb_uscore: legacyRow.igdb_uscore ?? null,
    igdb_popularity: null, // always NULL in production already (never requested)
  };
}

/**
 * Schema-v2 shape for a plain migrated Steam row (toExportRow() above) —
 * expectedLegacyShape() plus every field mapRowV2() appends. Resolver-only
 * columns migrate-legacy.js never populates stay null (no source data),
 * matching a real just-migrated game the resolver hasn't run on yet.
 */
function expectedV2Shape(legacyRow) {
  return {
    ...expectedLegacyShape(legacyRow),
    steam_reviews_percent: legacyRow.store_uscore ?? null,
    steam_reviews_count: null,
    steam_reviews_label: null,
    steam_recent_percent: null,
    steam_recent_count: null,
    steam_recent_label: null,
    average_playtime_hours: null,
    average_playtime_source: null,
    metacritic_reviews: null,
    gamerankings_score: legacyRow.grnk_score ?? null,
    gg_score: null,
    ggp: null,
    release_date: null,
    release_precision: null,
    kind: 'steam',
    gog_id: null,
    gog_url: null,
    early_access_date: null,
    price_rub: legacyRow.price_ru ?? null,
    price_final_rub: legacyRow.price_final_ru ?? null,
    discount_rub: legacyRow.discount_ru ?? null,
    price_cis_usd: legacyRow.price_temp ?? null,
    price_final_cis_usd: legacyRow.price_final_temp ?? null,
    discount_cis_usd: legacyRow.discount_temp ?? null,
    updated_at: null,
  };
}

// --- mapRow: round-tripped through the real migration mapping ---------------

test('mapRow: Mafia II (full fields) reproduces dump.php\'s shape after a legacy->rewrite migration round trip', () => {
  const legacyRow = legacyRowById(1062);
  const exportRow = toExportRow(legacyRow);
  assert.deepEqual(mapRow(exportRow), expectedLegacyShape(legacyRow));
});

test('mapRow: Cyberpunk 2077 (null Metacritic, path-style HLTB url) reproduces dump.php\'s shape', () => {
  const legacyRow = legacyRowById(40139);
  const exportRow = toExportRow(legacyRow);
  assert.deepEqual(mapRow(exportRow), expectedLegacyShape(legacyRow));
});

test('mapRow: Night in the Woods (discount present, no GameFAQs/Metacritic) reproduces dump.php\'s shape', () => {
  const legacyRow = legacyRowById(9907);
  const exportRow = toExportRow(legacyRow);
  assert.deepEqual(mapRow(exportRow), expectedLegacyShape(legacyRow));
});

// --- mapRowV2: legacy keys unchanged and in order, new keys appended --------

test('mapRowV2: Mafia II — legacy keys first (same values as mapRow), new keys appended after', () => {
  const legacyRow = legacyRowById(1062);
  const exportRow = toExportRow(legacyRow);
  const mapped = mapRowV2(exportRow);
  assert.deepEqual(mapped, expectedV2Shape(legacyRow));

  const keys = Object.keys(mapped);
  const legacyKeys = Object.keys(mapRow(exportRow));
  assert.deepEqual(keys.slice(0, legacyKeys.length), legacyKeys, 'legacy keys must come first, in their original order');
  assert.ok(keys.length > legacyKeys.length, 'v2 must append at least one new key');
});

test('mapRowV2: Cyberpunk 2077 reproduces the v2 shape', () => {
  const legacyRow = legacyRowById(40139);
  const exportRow = toExportRow(legacyRow);
  assert.deepEqual(mapRowV2(exportRow), expectedV2Shape(legacyRow));
});

test('mapRowV2: Night in the Woods reproduces the v2 shape', () => {
  const legacyRow = legacyRowById(9907);
  const exportRow = toExportRow(legacyRow);
  assert.deepEqual(mapRowV2(exportRow), expectedV2Shape(legacyRow));
});

test('mapRowV2: every appended field is null (not undefined) for a bare row with only an id', () => {
  const mapped = mapRowV2({ id: 1 });
  for (const [key, value] of Object.entries(mapped)) {
    assert.notEqual(value, undefined, `${key} should be null, not undefined`);
  }
  assert.equal(mapped.kind, null);
  assert.equal(mapped.gg_score, null);
});

// --- mapRowV2: rules that need a synthetic row (no real fixture exercises them) ---

test('mapRowV2: meta_score is null when score_critics came from OpenCritic, not Metacritic (unchanged legacy rule)', () => {
  const row = {
    id: 1,
    score_critics: 88,
    score_critics_source: 'opencritic',
    score_users_metacritic: 81,
    score_critics_count: 500,
  };
  const mapped = mapRowV2(row);
  assert.equal(mapped.meta_score, null);
  assert.equal(mapped.meta_uscore, 81);
  assert.equal(mapped.metacritic_reviews, null, 'metacritic_reviews is gated the same way meta_score is');
});

test('mapRowV2: metacritic_reviews passes through score_critics_count when the source is metacritic', () => {
  const row = { id: 1, score_critics: 77, score_critics_source: 'metacritic', score_critics_count: 1234 };
  const mapped = mapRowV2(row);
  assert.equal(mapped.meta_score, 77);
  assert.equal(mapped.metacritic_reviews, 1234);
});

test('mapRowV2: steam review percent/count/label track score_steam(_votes) via steamReviewLabel', () => {
  const row = { id: 1, score_steam: 97, score_steam_votes: 50000 };
  const mapped = mapRowV2(row);
  assert.equal(mapped.steam_reviews_percent, 97);
  assert.equal(mapped.steam_reviews_count, 50000);
  assert.equal(mapped.steam_reviews_label, steamReviewLabel(97, 50000));
  assert.equal(mapped.steam_reviews_label, 'Overwhelmingly Positive');
});

test('mapRowV2: steam_reviews_label is null under 10 votes, but percent/count still pass through', () => {
  const row = { id: 1, score_steam: 100, score_steam_votes: 3 };
  const mapped = mapRowV2(row);
  assert.equal(mapped.steam_reviews_percent, 100);
  assert.equal(mapped.steam_reviews_count, 3);
  assert.equal(mapped.steam_reviews_label, null);
});

test('mapRowV2: steam_recent_* mirrors steam_reviews_* but off score_steam_recent(_votes)', () => {
  const row = { id: 1, score_steam_recent: 60, score_steam_recent_votes: 200 };
  const mapped = mapRowV2(row);
  assert.equal(mapped.steam_recent_percent, 60);
  assert.equal(mapped.steam_recent_count, 200);
  assert.equal(mapped.steam_recent_label, 'Mixed');
});

test('mapRowV2: average_playtime_hours/source pass through time_average/time_average_source', () => {
  const row = { id: 1, time_average: '11.5', time_average_source: 'steam_reviews' };
  const mapped = mapRowV2(row);
  assert.equal(mapped.average_playtime_hours, 11.5);
  assert.equal(mapped.average_playtime_source, 'steam_reviews');
});

test('mapRowV2: kind/gog_id/gog_url/release_date/gg_score/ggp pass through the new games/game_links columns', () => {
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
  const mapped = mapRowV2(row);
  assert.equal(mapped.kind, 'gog_exclusive');
  assert.equal(mapped.gog_id, 1234567890);
  assert.equal(mapped.gog_url, 'https://www.gog.com/game/example');
  assert.equal(mapped.release_date, '2015-06-01');
  assert.equal(mapped.release_precision, 'day');
  assert.equal(mapped.early_access_date, '2014-01-01');
  assert.equal(mapped.gg_score, 82);
  assert.equal(mapped.ggp, 40);
  assert.equal(mapped.updated_at, '2026-09-19 03:00:00');
});

test('mapRowV2: RUB/CIS price columns pass through as-is', () => {
  const row = {
    id: 1,
    price_rub: 199900,
    price_final_rub: 149900,
    discount_rub: 25,
    price_cis_usd: 1999,
    price_final_cis_usd: 1999,
    discount_cis_usd: null,
  };
  const mapped = mapRowV2(row);
  assert.equal(mapped.price_rub, 199900);
  assert.equal(mapped.price_final_rub, 149900);
  assert.equal(mapped.discount_rub, 25);
  assert.equal(mapped.price_cis_usd, 1999);
  assert.equal(mapped.price_final_cis_usd, 1999);
  assert.equal(mapped.discount_cis_usd, null);
});

// --- list conversion (mapRow, reused unchanged by mapRowV2) ------------------

test('mapRow: pipe-wrapped list columns convert to legacy comma strings', () => {
  const row = { id: 1, genres: '|Action|RPG|', tags: '|Open World|Story Rich|' };
  const mapped = mapRow(row);
  assert.equal(mapped.genres, 'Action,RPG');
  assert.equal(mapped.tags, 'Open World,Story Rich');
});

test('mapRow: null/empty list columns convert to null, not an empty string', () => {
  assert.equal(mapRow({ id: 1, genres: null }).genres, null);
  assert.equal(mapRow({ id: 1, genres: '||' }).genres, null);
  assert.equal(mapRow({ id: 1, genres: '' }).genres, null);
});

test('mapRow: platforms passes through as-is (SET column, already a comma string, not pipe-wrapped)', () => {
  assert.equal(mapRow({ id: 1, platforms: 'WIN,MAC' }).platforms, 'WIN,MAC');
  assert.equal(mapRow({ id: 1, platforms: null }).platforms, null);
});

test('mapRow: DECIMAL score/time columns (returned as strings by mysql2) are coerced to numbers', () => {
  const row = { id: 1, score_gamefaqs: '3.76', time_main: '12.0', time_complete: '28.5', steam_appid: '50130' };
  const mapped = mapRow(row);
  assert.equal(mapped.gfq_rating, 3.76);
  assert.equal(mapped.hltb_single, 12);
  assert.equal(mapped.hltb_complete, 28.5);
  assert.equal(mapped.sid, 50130);
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

test('runExport: writes steamdb.json, steamdb.min.json and steamdb.min.json.gz with matching v2 content by default', async () => {
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

    const expected = rows.map(mapRowV2);
    assert.deepEqual(pretty, expected);
    assert.deepEqual(min, expected);
    assert.deepEqual(gunzipped, expected);
    assert.ok('kind' in pretty[0], 'v2 rows carry kind');

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

test('runExport: opts.mapRow overrides the mapper (legacy-only shape, e.g. for an old consumer)', async () => {
  await withTempDir(async (dir) => {
    const rows = [{ id: 1, kind: 'steam', name: 'Solo' }];
    const db = makeFakeDb(rows);
    const result = await runExport({ db }, { outDir: dir, mapRow });
    const min = JSON.parse(fs.readFileSync(result.minPath, 'utf8'));
    assert.deepEqual(min, rows.map(mapRow));
    assert.ok(!('kind' in min[0]), 'legacy mapRow has no kind key');
  });
});

test('runExport: an empty result set still writes a valid empty JSON array', async () => {
  await withTempDir(async (dir) => {
    const db = makeFakeDb([]);
    const result = await runExport({ db, log: undefined }, { outDir: dir });
    assert.equal(result.count, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.minPath, 'utf8')), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.prettyPath, 'utf8')), []);
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
    // mapRowV2's output has no `id` key (see export.js) — name/kind order proves id ordering instead.
    assert.deepEqual(min.map((r) => r.name), ['Steam Game', 'GOG Only Game', 'Another Steam Game']);
    assert.deepEqual(min.map((r) => r.kind), ['steam', 'gog_exclusive', 'steam']);
    assert.equal(min[1].sid, null, 'steam-only legacy keys are null on a GOG-exclusive row');
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

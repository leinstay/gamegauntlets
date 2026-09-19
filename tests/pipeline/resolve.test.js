// src/pipeline/resolve.js — the DB side of the resolve step. Everything here runs against a fake `db`
// (`{ query, one }`, no `tx`, matching src/pipeline/context.js's ctx.db shape) so no real MySQL is needed.
// Whichever source modules are registered under src/sources/ (steam, gog, wikidata, legacy_steamdb, ...) run
// for real here — buildFieldsBySource() only calls extract() for sources that actually have a
// source_records row, so a test that only feeds a 'legacy_steamdb' record exercises exactly the "game with
// only a legacy record" scenario regardless of what else is registered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { resolveGame, resolveMany } from '../../src/pipeline/resolve.js';
import { config } from '../../src/config.js';
import { normalizeName } from '../../src/lib/names.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const legacyFixture = JSON.parse(
  readFileSync(path.join(__dirname, '../fixtures/resolver/legacy-sample.json'), 'utf8'),
);
const NOW = new Date(`${legacyFixture.meta.now}T00:00:00Z`);

const noopLog = { info() {}, warn() {}, error() {} };

/**
 * A tiny in-memory `db` that understands exactly the statements src/pipeline/resolve.js issues, and keeps
 * enough state (conflicts rows) to let a test run resolveGame() more than once and see it evolve — the same
 * way a real UPDATE/INSERT/DELETE would behave against a real `conflicts` table.
 */
function makeFakeDb({ gameId, gameIds, sourceRecords = [], overrides = [], conflicts = [], steamNotFound = [], baseGames = [], failFor } = {}) {
  const validGameIds = gameIds ? new Set(gameIds) : new Set(gameId === undefined || gameId === null ? [] : [gameId]);
  let conflictRows = conflicts.map((row) => ({ ...row }));
  const calls = { updates: [], conflictUpserts: [], conflictDeletes: [] };

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT id FROM games WHERE name_normalized')) {
      const [normalized, excludeId] = params;
      const match = baseGames.find(
        (g) => g.name_normalized === normalized && g.id !== excludeId && (g.non_game ?? null) === null,
      );
      return match ? [{ id: match.id }] : [];
    }
    if (s.startsWith('SELECT id FROM games')) {
      const [id] = params;
      return validGameIds.has(id) ? [{ id }] : [];
    }
    if (s.startsWith('SELECT source, external_id, payload FROM source_records')) {
      const [id] = params;
      if (failFor !== undefined && id === failFor) throw new Error(`fake db: simulated failure for game ${id}`);
      return sourceRecords.filter((r) => r.gameId === undefined || r.gameId === id).map(({ gameId: _g, ...rest }) => rest);
    }
    if (s.startsWith('SELECT field, value FROM overrides')) {
      return overrides;
    }
    if (s.startsWith("SELECT payload FROM source_records WHERE game_id = ? AND source = 'steam' AND status = 'not_found'")) {
      const [id] = params;
      return steamNotFound.filter((r) => r.gameId === undefined || r.gameId === id).map(({ gameId: _g, ...rest }) => rest);
    }
    if (s.startsWith('SELECT field, status FROM conflicts')) {
      return conflictRows.map((row) => ({ field: row.field, status: row.status }));
    }
    if (s.startsWith('UPDATE games SET')) {
      calls.updates.push({ sql: s, params });
      return { affectedRows: 1 };
    }
    if (s.startsWith('INSERT INTO conflicts')) {
      calls.conflictUpserts.push({ sql: s, params });
      const [, field, candidates, reason] = params;
      const existing = conflictRows.find((row) => row.field === field);
      if (existing) Object.assign(existing, { status: 'open', candidates, reason });
      else conflictRows.push({ field, status: 'open', candidates, reason });
      return { affectedRows: 1 };
    }
    if (s.startsWith('DELETE FROM conflicts')) {
      calls.conflictDeletes.push({ sql: s, params });
      const [, field] = params;
      conflictRows = conflictRows.filter((row) => row.field !== field);
      return { affectedRows: 1 };
    }
    throw new Error(`fake db: unhandled query: ${s}`);
  }

  async function one(sql, params = []) {
    const rows = await query(sql, params);
    return rows[0] ?? null;
  }

  return {
    query,
    one,
    calls,
    get conflictRows() {
      return conflictRows;
    },
  };
}

function lastUpdateColumns(db) {
  const last = db.calls.updates.at(-1);
  const columnNames = [...last.sql.matchAll(/(\w+) = \?/g)].map((m) => m[1]);
  const values = {};
  columnNames.forEach((col, i) => {
    values[col] = last.params[i];
  });
  return values;
}

function legacyRecord(gameId, input) {
  return { source: 'legacy_steamdb', external_id: String(gameId), payload: JSON.stringify(input) };
}

// --- regression: reproduces the legacy fixture on a game with only a legacy record -----------------------

test('resolveGame: a game with only a legacy_steamdb record reproduces the legacy fixture outputs', async () => {
  // Full 300-row pinning of the pure formulas already lives in tests/resolver/legacy-fixtures.test.js; here
  // a sample is enough to prove the *pipeline* (extract -> resolver -> UPDATE) reaches the same numbers.
  //
  // final_time/time_complete never depend on the release date, so they must match on every row. gg_score
  // (age penalty) and ggp (via gg_score) can legitimately differ from the legacy fixture on the rows where
  // the new source-agnostic resolveRelease() picks a different date than the frozen legacyRelease() —
  // release.js's own header says the two are deliberately NOT bit-exact (legacyRelease keeps a quirky
  // fixed source-priority fallback; resolveRelease clusters candidates and applies the old-game rule). That
  // drift is exactly what `scripts/resolve-all.js --compare-legacy` measures on the real dataset, not
  // something this test should paper over — so it's asserted here only on the rows where both algorithms
  // land on the same date (the large majority), and is otherwise just reported.
  const sampleRows = legacyFixture.rows.filter((_, i) => i % 12 === 0); // ~25 rows spread across the sample
  const timeMismatches = [];
  const scoreMismatches = [];
  let releaseAgreements = 0;

  for (const row of sampleRows) {
    const db = makeFakeDb({ gameId: row.id, sourceRecords: [legacyRecord(row.id, row.input)] });
    const ctx = { db, log: noopLog, config };

    await resolveGame(ctx, row.id, { now: NOW });
    const columns = lastUpdateColumns(db);

    if (columns.final_time !== row.expected.final_time || columns.time_complete !== row.expected.hltb_complete) {
      timeMismatches.push({
        id: row.id,
        expected: { final_time: row.expected.final_time, time_complete: row.expected.hltb_complete },
        actual: { final_time: columns.final_time, time_complete: columns.time_complete },
      });
    }

    if (columns.release_date === row.expected.published_date) {
      releaseAgreements++;
      if (columns.gg_score !== row.expected.final_score || columns.ggp !== row.expected.ggp) {
        scoreMismatches.push({
          id: row.id,
          expected: { gg_score: row.expected.final_score, ggp: row.expected.ggp },
          actual: { gg_score: columns.gg_score, ggp: columns.ggp },
        });
      }
    }
  }

  assert.equal(timeMismatches.length, 0, `final_time/time_complete mismatches: ${JSON.stringify(timeMismatches)}`);
  assert.equal(
    scoreMismatches.length,
    0,
    `gg_score/ggp mismatches on rows where the release date agrees: ${JSON.stringify(scoreMismatches)}`,
  );
  // The two algorithms should agree on the release date for the large majority of real rows (drift is
  // expected only where the legacy sources genuinely disagreed with each other).
  assert.ok(
    releaseAgreements >= sampleRows.length * 0.8,
    `expected most sampled rows to agree on the release date, only ${releaseAgreements}/${sampleRows.length} did`,
  );
});

// --- never blank a column no source reported this pass (the ~111k legacy-only-games gap) -------------------

test('resolveGame: a legacy-only game keeps image/description (fallback-supplied, not blanked)', async () => {
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [
      legacyRecord(1, {
        name: 'Legacy Game',
        image: 'https://cdn.example/legacy.jpg',
        description_en: 'A legacy description.',
        description_ru: 'Legacy описание.',
        achievements: 12,
      }),
    ],
  });

  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  const columns = lastUpdateColumns(db);

  assert.equal(columns.name, 'Legacy Game');
  assert.equal(columns.image, 'https://cdn.example/legacy.jpg');
  assert.equal(columns.description_en, 'A legacy description.');
  assert.equal(columns.description_ru, 'Legacy описание.');
  assert.equal(columns.achievements, 12);
});

test('resolveGame: a game with a steam record takes steam data over the legacy fallback', async () => {
  // 'steam' is a real registered module (src/sources/steam.js, T8) in this repo, so this exercises the
  // actual store-priority wiring end to end, not just the resolver-level unit test.
  const steamPayload = { en: { name: 'Steam Name', header_image: 'https://cdn.example/steam.jpg' } };
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [
      legacyRecord(1, { name: 'Legacy Name', image: 'https://cdn.example/legacy.jpg' }),
      { source: 'steam', external_id: '730', payload: JSON.stringify(steamPayload) },
    ],
  });

  const result = await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  const columns = lastUpdateColumns(db);

  assert.deepEqual(result.sources.sort(), ['legacy_steamdb', 'steam']);
  assert.equal(columns.name, 'Steam Name');
  assert.equal(columns.image, 'https://cdn.example/steam.jpg');
});

test('resolveGame: a column no source reports is not in the UPDATE at all', async () => {
  const db = makeFakeDb({
    gameId: 1,
    // A legacy row with (almost) nothing on it: no scores, no owners, no lists, no prices, no display
    // fields either.
    sourceRecords: [legacyRecord(1, { store_platform: 'Steam' })],
  });

  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  const sql = db.calls.updates.at(-1).sql;

  for (const column of ['name', 'image', 'description_en', 'description_ru', 'achievements', 'score_igdb', 'owners_estimate', 'difficulty', 'platforms', 'genres', 'price_usd']) {
    assert.doesNotMatch(sql, new RegExp(`\\b${column} = \\?`), `expected ${column} to be absent from the UPDATE`);
  }
  // The derived columns are still recomputed (to null/0), every pass, regardless of source coverage.
  for (const column of ['gg_score', 'final_time', 'ggp', 'release_date']) {
    assert.match(sql, new RegExp(`\\b${column} = \\?`), `expected ${column} to always be recomputed`);
  }
});

test('resolveGame: never touches identity columns (id/kind/steam_appid/gog_id) unless overridden', async () => {
  const row = legacyFixture.rows[0];
  const db = makeFakeDb({ gameId: row.id, sourceRecords: [legacyRecord(row.id, row.input)] });
  const ctx = { db, log: noopLog, config };

  await resolveGame(ctx, row.id, { now: NOW });
  const sql = db.calls.updates.at(-1).sql;

  assert.doesNotMatch(sql, /\bkind = \?/);
  assert.doesNotMatch(sql, /\bsteam_appid = \?/);
  assert.doesNotMatch(sql, /\bgog_id = \?/);
  assert.doesNotMatch(sql, /\bid = \?.*WHERE/); // 'id' only appears in the WHERE clause, not as a SET target
});

test('resolveGame: game not found is reported, not thrown', async () => {
  const db = makeFakeDb({ gameId: null });
  const ctx = { db, log: noopLog, config };
  const result = await resolveGame(ctx, 12345, { now: NOW });
  assert.equal(result.skipped, true);
  assert.equal(db.calls.updates.length, 0);
});

// --- transactions: ctx.db.tx is used when present, and it's optional -----------------------------------------

test('resolveGame: runs the whole resolve inside ctx.db.tx when it is present', async () => {
  const inner = makeFakeDb({ gameId: 1, sourceRecords: [legacyRecord(1, { store_uscore: 80 })] });
  let txCalls = 0;
  const db = {
    query: inner.query,
    one: inner.one,
    tx: async (fn) => {
      txCalls++;
      return fn({ query: inner.query, one: inner.one }); // real src/db.js's tx() hands the callback a scoped {query,one}
    },
  };

  const result = await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });

  assert.equal(txCalls, 1);
  assert.equal(result.gameId, 1);
  assert.equal(inner.calls.updates.length, 1);
});

test('resolveGame: works without ctx.db.tx (runs the same statements directly against ctx.db)', async () => {
  const db = makeFakeDb({ gameId: 1, sourceRecords: [legacyRecord(1, { store_uscore: 80 })] });
  assert.equal(typeof db.tx, 'undefined');

  const result = await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });

  assert.equal(result.gameId, 1);
  assert.equal(db.calls.updates.length, 1);
});

// --- unknown source is skipped, not fatal ------------------------------------------------------------------

test('resolveGame: a source_records row for an unregistered source is skipped with a warning, not fatal', async () => {
  const warnings = [];
  const log = { info() {}, error() {}, warn: (msg, meta) => warnings.push({ msg, meta }) };
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [
      { source: 'made_up_source', external_id: '1', payload: '{}' },
      legacyRecord(1, { store_uscore: 80 }),
    ],
  });

  const result = await resolveGame({ db, log, config }, 1, { now: NOW });

  assert.equal(result.skipped, undefined);
  assert.deepEqual(result.sources, ['legacy_steamdb']); // the unknown one never made it into fieldsBySource
  assert.ok(warnings.some((w) => /unknown source/i.test(w.msg)));
  const columns = lastUpdateColumns(db);
  assert.equal(columns.score_steam, 80);
});

// --- overrides always win, applied last --------------------------------------------------------------------

test('resolveGame: an override replaces a resolved column', async () => {
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [legacyRecord(1, { store_uscore: 40 })],
    overrides: [{ field: 'gg_score', value: JSON.stringify(99) }],
  });

  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  const columns = lastUpdateColumns(db);
  assert.equal(columns.gg_score, 99);
});

test('resolveGame: an override on a protected identity column is allowed through, unlike a resolver-computed one', async () => {
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [legacyRecord(1, { store_platform: 'Steam', sid: 730 })],
    overrides: [{ field: 'steam_appid', value: JSON.stringify(730) }],
  });

  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  const sql = db.calls.updates.at(-1).sql;
  assert.match(sql, /\bsteam_appid = \?/);
});

// --- name/name_normalized are never blanked (a legacy-only game has a name set by migrate-legacy.js, not
// by any source this resolve pass can see) --------------------------------------------------------------

test('resolveGame: does not blank name/name_normalized when no source in this pass reports a name', async () => {
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [legacyRecord(1, { store_uscore: 80 })], // legacy_steamdb never maps `name`
  });

  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  const sql = db.calls.updates.at(-1).sql;
  assert.doesNotMatch(sql, /\bname = \?/);
  assert.doesNotMatch(sql, /\bname_normalized = \?/);
});

test('resolveGame: writes name once the resolver actually has a non-blank value for it', async () => {
  // Which sources contribute `name` (store priority Steam > GOG) is the resolver's concern, already
  // covered in tests/resolver/index.test.js; this only proves resolve.js's "never blank" guard doesn't
  // withhold a genuine value — an admin override is the simplest way to get resolveGame() a non-null name
  // without needing a second registered source module in this test file.
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [legacyRecord(1, { store_uscore: 80 })],
    overrides: [{ field: 'name', value: JSON.stringify('Manual Name') }],
  });

  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  const sql = db.calls.updates.at(-1).sql;
  assert.match(sql, /\bname = \?/);
});

// --- conflicts upsert/clear ----------------------------------------------------------------------------------

// Three independent legacy candidates that all disagree by more than the tolerance, with a store date, is
// exactly release.js's "disagreement without a majority" path (see resolveRelease's file header).
const DISAGREEING_PAYLOAD = {
  store_platform: 'Steam',
  published_store: '2015-06-01',
  published_meta: '2015-01-01',
  published_stsp: '2018-01-01',
  published_hltb: '2021-01-01',
  published_igdb: null,
};
const AGREEING_PAYLOAD = {
  store_platform: 'Steam',
  published_store: '2015-06-01',
  published_meta: '2015-06-15',
  published_stsp: '2015-07-01',
  published_hltb: '2015-06-20',
  published_igdb: null,
};

test('conflicts: a fresh disagreement opens a conflicts row', async () => {
  const db = makeFakeDb({ gameId: 1, sourceRecords: [legacyRecord(1, DISAGREEING_PAYLOAD)] });
  const { conflicts } = await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });

  assert.equal(conflicts, 1);
  assert.equal(db.calls.conflictUpserts.length, 1);
  assert.deepEqual(
    db.conflictRows.map((r) => [r.field, r.status]),
    [['release_date', 'open']],
  );
});

test('conflicts: a field that stops conflicting has its open row deleted', async () => {
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [legacyRecord(1, DISAGREEING_PAYLOAD)],
    conflicts: [{ field: 'release_date', status: 'open' }],
  });

  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW }); // still conflicting: refreshed, not deleted
  assert.equal(db.calls.conflictDeletes.length, 0);
  assert.equal(db.conflictRows.find((r) => r.field === 'release_date')?.status, 'open');

  // Now the sources agree: the same open row must be cleared.
  const db2 = makeFakeDb({
    gameId: 1,
    sourceRecords: [legacyRecord(1, AGREEING_PAYLOAD)],
    conflicts: [{ field: 'release_date', status: 'open' }],
  });
  const { conflicts } = await resolveGame({ db: db2, log: noopLog, config }, 1, { now: NOW });

  assert.equal(conflicts, 0);
  assert.equal(db2.calls.conflictDeletes.length, 1);
  assert.equal(db2.conflictRows.length, 0);
});

test('conflicts: an accepted/overridden row is never touched, even while still in conflict', async () => {
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [legacyRecord(1, DISAGREEING_PAYLOAD)],
    conflicts: [{ field: 'release_date', status: 'accepted' }],
  });

  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });

  assert.equal(db.calls.conflictUpserts.length, 0);
  assert.equal(db.calls.conflictDeletes.length, 0);
  assert.equal(db.conflictRows[0].status, 'accepted');
});

// --- resolveMany ----------------------------------------------------------------------------------------------

test('resolveMany: resolves every id, reports "not found" for a missing game, and never throws', async () => {
  const db = makeFakeDb({
    gameIds: [1],
    sourceRecords: [{ ...legacyRecord(1, { store_uscore: 70 }), gameId: 1 }],
  });
  const ctx = { db, log: noopLog, config };

  const results = await resolveMany(ctx, [1, 2], { concurrency: 2 });
  const byId = new Map(results.map((r) => [r.gameId, r]));

  assert.equal(results.length, 2);
  assert.equal(byId.get(1).skipped, undefined);
  assert.deepEqual(byId.get(1).sources, ['legacy_steamdb']);
  assert.equal(byId.get(2).skipped, true); // game 2 doesn't exist in this fake db
});

test('resolveMany: a per-game failure is reported in its result, not thrown', async () => {
  const db = makeFakeDb({
    gameIds: [1, 2],
    sourceRecords: [
      { ...legacyRecord(1, { store_uscore: 70 }), gameId: 1 },
      { ...legacyRecord(2, { store_uscore: 50 }), gameId: 2 },
    ],
    failFor: 2,
  });
  const ctx = { db, log: noopLog, config };

  const results = await resolveMany(ctx, [1, 2], { concurrency: 2 });
  const byId = new Map(results.map((r) => [r.gameId, r]));

  assert.equal(byId.get(1).error, undefined);
  assert.match(byId.get(2).error, /simulated failure/);
});

// --- non_game (migrations/004_non_game.sql) --------------------------------------------------------------

test('resolveGame: non_game is always in the UPDATE (null) when nothing flags the game', async () => {
  const db = makeFakeDb({ gameId: 1, sourceRecords: [legacyRecord(1, { store_uscore: 80 })] });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  const sql = db.calls.updates.at(-1).sql;
  const columns = lastUpdateColumns(db);
  assert.match(sql, /\bnon_game = \?/);
  assert.equal(columns.non_game, null);
});

test('resolveGame: a resolved name ending in "Soundtrack" classifies non_game via the store name', async () => {
  const steamPayload = { en: { name: 'Chained Echoes (Original Game Soundtrack)' } };
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [{ source: 'steam', external_id: '1', payload: JSON.stringify(steamPayload) }],
  });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  assert.equal(lastUpdateColumns(db).non_game, 'soundtrack');
});

test('resolveGame: a Steam not_found record\'s stored appType classifies non_game (dlc) with no "ok" steam record at all', async () => {
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [legacyRecord(1, { store_uscore: 80 })],
    steamNotFound: [{ gameId: 1, payload: JSON.stringify({ appType: 'dlc' }) }],
  });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  assert.equal(lastUpdateColumns(db).non_game, 'dlc');
});

test('resolveGame: an "ok" steam record present means the not_found lookup is never even queried', async () => {
  const steamPayload = { en: { name: 'A Real Game' } };
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [{ source: 'steam', external_id: '1', payload: JSON.stringify(steamPayload) }],
    steamNotFound: [{ gameId: 1, payload: JSON.stringify({ appType: 'dlc' }) }], // must be ignored
  });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  assert.equal(lastUpdateColumns(db).non_game, null);
});

test('resolveGame: a GOG "ok" record\'s catalog product type feeds the classifier too', async () => {
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [{ source: 'gog', external_id: '1', payload: JSON.stringify({ catalog: { productType: 'dlc' } }) }],
  });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  assert.equal(lastUpdateColumns(db).non_game, 'dlc');
});

// --- bundle base-game lookup (review follow-up: "<Base> + <extras>" false positives) --------------------

test('resolveGame: a "<Base> + <extras>" title is NOT flagged bundle when no separate base-game row exists (sole listing)', async () => {
  // Real false positive fixed here: "KINGDOM HEARTS III + Re Mind (DLC)" is the ONLY Steam listing of
  // KINGDOM HEARTS III - flagging it would have pulled a real game out of the wheel.
  const steamPayload = { en: { name: 'KINGDOM HEARTS III + Re Mind (DLC)' } };
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [{ source: 'steam', external_id: '1', payload: JSON.stringify(steamPayload) }],
    baseGames: [], // no separate "KINGDOM HEARTS III" row anywhere in the catalog
  });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  assert.equal(lastUpdateColumns(db).non_game, null);
});

test('resolveGame: the same title IS flagged bundle once a separate base-game row is found by normalized name', async () => {
  const steamPayload = { en: { name: 'KINGDOM HEARTS III + Re Mind (DLC)' } };
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [{ source: 'steam', external_id: '1', payload: JSON.stringify(steamPayload) }],
    baseGames: [{ id: 2, name_normalized: normalizeName('KINGDOM HEARTS III'), non_game: null }],
  });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  assert.equal(lastUpdateColumns(db).non_game, 'bundle');
});

test('resolveGame: a base-game candidate that is itself flagged non_game does not count as "the base game exists"', async () => {
  const steamPayload = { en: { name: 'Sinless + OST' } };
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [{ source: 'steam', external_id: '1', payload: JSON.stringify(steamPayload) }],
    baseGames: [{ id: 2, name_normalized: normalizeName('Sinless'), non_game: 'soundtrack' }],
  });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  assert.equal(lastUpdateColumns(db).non_game, null);
});

test('resolveGame: a title with no "+"/bundle shape is unaffected even if a same-named row exists elsewhere', async () => {
  // bundleBaseName("A Perfectly Normal Game") is null (no "+", no digital-goods-bundle suffix), so the
  // base-game lookup never even runs for it - this row existing under `baseGames` must have no effect.
  const steamPayload = { en: { name: 'A Perfectly Normal Game' } };
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [{ source: 'steam', external_id: '1', payload: JSON.stringify(steamPayload) }],
    baseGames: [{ id: 2, name_normalized: normalizeName('A Perfectly Normal Game'), non_game: null }],
  });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  assert.equal(lastUpdateColumns(db).non_game, null);
  assert.equal(db.calls.updates.length, 1);
});

test('resolveGame: an admin override on non_game wins over the classifier, including overriding it back to null', async () => {
  const steamPayload = { en: { name: 'Some Game Soundtrack' } };
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [{ source: 'steam', external_id: '1', payload: JSON.stringify(steamPayload) }],
    overrides: [{ field: 'non_game', value: JSON.stringify(null) }],
  });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  const sql = db.calls.updates.at(-1).sql;
  assert.match(sql, /\bnon_game = \?/); // still written (override always wins, blank or not)
  assert.equal(lastUpdateColumns(db).non_game, null);
});

test('resolveGame: an admin override can also set non_game to a class the classifier itself would not have picked', async () => {
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [legacyRecord(1, { store_uscore: 80 })], // no signal at all on its own
    overrides: [{ field: 'non_game', value: JSON.stringify('tool') }],
  });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  assert.equal(lastUpdateColumns(db).non_game, 'tool');
});

// --- purchasable (migrations/005_purchasable.sql) -----------------------------------------------------

test('resolveGame: purchasable is always in the UPDATE (1) when nothing flags it (legacy-only game, no live store)', async () => {
  const db = makeFakeDb({ gameId: 1, sourceRecords: [legacyRecord(1, { store_uscore: 80 })] });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  const sql = db.calls.updates.at(-1).sql;
  const columns = lastUpdateColumns(db);
  assert.match(sql, /\bpurchasable = \?/);
  assert.equal(columns.purchasable, 1);
});

test('resolveGame: a live Steam record with no price and empty package_groups (delisted-but-visible) sets purchasable = 0', async () => {
  // The owner's motivating case: Steam app 1145100 "Singaria - Prologue" - appdetails succeeds (so this
  // is never a steam_delisted case) but the page has no price and no purchasable package.
  const steamPayload = { en: { name: 'Singaria - Prologue', is_free: false, release_date: { coming_soon: false, date: '1 Jan, 2023' }, package_groups: [] } };
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [{ source: 'steam', external_id: '1', payload: JSON.stringify(steamPayload) }],
  });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  assert.equal(lastUpdateColumns(db).purchasable, 0);
});

test('resolveGame: a GOG-only buyable game (isAvailableForSale true, no steam record at all) stays purchasable = 1', async () => {
  const gogPayload = { en: { _embedded: { product: { id: 1, title: 'Some GOG Game', isAvailableForSale: true, isPreorder: false } } } };
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [{ source: 'gog', external_id: '1', payload: JSON.stringify(gogPayload) }],
  });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  assert.equal(lastUpdateColumns(db).purchasable, 1);
});

test('resolveGame: a GOG-only game that positively reports isAvailableForSale = false sets purchasable = 0', async () => {
  const gogPayload = { en: { _embedded: { product: { id: 1, title: 'Some Delisted GOG Game', isAvailableForSale: false, isPreorder: false } } } };
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [{ source: 'gog', external_id: '1', payload: JSON.stringify(gogPayload) }],
  });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  assert.equal(lastUpdateColumns(db).purchasable, 0);
});

test('resolveGame: a Steam record with no price of its own falls back to a GOG price, which also keeps purchasable = 1', async () => {
  // Exercises the resolver's price-fallback fix (src/lib/resolver/index.js's pickPriceSource) end-to-end
  // through the pipeline: Steam wins name/etc (STORE_PRIORITY) but has no steamPurchasable evidence at all
  // (no is_free/price_overview/package_groups reported), so on its own it would be "no opinion"; GOG's
  // real price must both populate the price columns AND be enough on its own to keep purchasable = 1.
  const steamPayload = { en: { name: 'Steam Side, No Price Data' } };
  const gogPayload = {
    en: { _embedded: { product: { id: 1, title: 'GOG Side' } } },
    pricesUsd: { _embedded: { prices: [{ currency: { code: 'USD' }, basePrice: '1999 USD', finalPrice: '999 USD' }] } },
  };
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [
      { source: 'steam', external_id: '1', payload: JSON.stringify(steamPayload) },
      { source: 'gog', external_id: '1', payload: JSON.stringify(gogPayload) },
    ],
  });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  const columns = lastUpdateColumns(db);
  assert.equal(columns.name, 'Steam Side, No Price Data');
  assert.equal(columns.price_usd, 1999);
  assert.equal(columns.purchasable, 1);
});

test('resolveGame: an admin override on purchasable wins over the classifier, even overriding an otherwise-0 verdict back to 1', async () => {
  const steamPayload = { en: { name: 'Singaria - Prologue', is_free: false, release_date: { coming_soon: false, date: '1 Jan, 2023' }, package_groups: [] } };
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [{ source: 'steam', external_id: '1', payload: JSON.stringify(steamPayload) }],
    overrides: [{ field: 'purchasable', value: JSON.stringify(1) }],
  });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  const sql = db.calls.updates.at(-1).sql;
  assert.match(sql, /\bpurchasable = \?/); // still written (override always wins)
  assert.equal(lastUpdateColumns(db).purchasable, 1);
});

test('resolveGame: an admin override can also set purchasable to 0 for a game the classifier itself would leave at 1', async () => {
  const db = makeFakeDb({
    gameId: 1,
    sourceRecords: [legacyRecord(1, { store_uscore: 80 })], // no live store evidence -> classifier alone would say 1
    overrides: [{ field: 'purchasable', value: JSON.stringify(0) }],
  });
  await resolveGame({ db, log: noopLog, config }, 1, { now: NOW });
  assert.equal(lastUpdateColumns(db).purchasable, 0);
});

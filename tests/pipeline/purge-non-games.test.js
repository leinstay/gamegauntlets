// src/pipeline/purge-non-games.js — runs entirely against a fake `db` (`{ query, one }`, optionally `.tx`),
// no real MySQL needed. The fake below models just enough of `games`/`overrides`/`source_records` to
// exercise the exact SQL purge-non-games.js issues.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { purgeNonGames, buildTombstonePayload, isPurgedTombstone } from '../../src/pipeline/purge-non-games.js';

const noopLog = { info() {}, warn() {}, error() {} };

function makeFakeDb({ games = [], overrides = [], sourceRecords = [] } = {}) {
  let gameRows = games.map((g) => ({ ...g }));
  const overrideRows = overrides.map((o) => ({ ...o }));
  const recordRows = sourceRecords.map((r) => ({ ...r }));

  function overriddenGameIds() {
    return new Set(overrideRows.filter((o) => o.field === 'non_game').map((o) => o.game_id));
  }

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT g.id, g.name, g.non_game FROM games g WHERE g.non_game IS NOT NULL AND NOT EXISTS')) {
      const [limit] = params;
      const overridden = overriddenGameIds();
      return gameRows
        .filter((g) => g.non_game != null && !overridden.has(g.id))
        .slice(0, limit)
        .map((g) => ({ id: g.id, name: g.name, non_game: g.non_game }));
    }

    if (s.startsWith("UPDATE source_records SET game_id = NULL, status = 'not_found', error = ?, payload = NULL WHERE game_id = ? AND source NOT IN")) {
      const [error, gameId] = params;
      let affected = 0;
      for (const r of recordRows) {
        if (r.game_id === gameId && r.source !== 'steam' && r.source !== 'gog') {
          Object.assign(r, { game_id: null, status: 'not_found', error, payload: null });
          affected += 1;
        }
      }
      return { affectedRows: affected };
    }

    if (s.startsWith("UPDATE source_records SET game_id = NULL, status = 'not_found', error = ?, payload = ? WHERE game_id = ? AND source IN")) {
      const [error, payload, gameId] = params;
      let affected = 0;
      for (const r of recordRows) {
        if (r.game_id === gameId && (r.source === 'steam' || r.source === 'gog')) {
          Object.assign(r, { game_id: null, status: 'not_found', error, payload });
          affected += 1;
        }
      }
      return { affectedRows: affected };
    }

    if (s.startsWith('DELETE FROM games WHERE id = ?')) {
      const [id] = params;
      const before = gameRows.length;
      gameRows = gameRows.filter((g) => g.id !== id);
      return { affectedRows: before - gameRows.length };
    }

    throw new Error(`fake db: unhandled query: ${s}`);
  }

  async function one(sql) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT COUNT(*) AS c FROM games g WHERE g.non_game IS NOT NULL AND EXISTS')) {
      const overridden = overriddenGameIds();
      const c = gameRows.filter((g) => g.non_game != null && overridden.has(g.id)).length;
      return { c };
    }
    throw new Error(`fake db: unhandled one: ${s}`);
  }

  return {
    query,
    one,
    get games() {
      return gameRows;
    },
    get sourceRecords() {
      return recordRows;
    },
  };
}

// --- buildTombstonePayload / isPurgedTombstone -----------------------------------------------------

test('buildTombstonePayload: shape matches what isPurgedTombstone recognises', () => {
  const payload = buildTombstonePayload({ cls: 'dlc', name: 'Some DLC' });
  assert.deepEqual(payload, { purged: true, class: 'dlc', name: 'Some DLC' });
  assert.equal(isPurgedTombstone(payload), true);
});

test('buildTombstonePayload: name defaults to null when omitted', () => {
  assert.deepEqual(buildTombstonePayload({ cls: 'tool' }), { purged: true, class: 'tool', name: null });
});

test('isPurgedTombstone: false for null/undefined/ordinary payloads', () => {
  assert.equal(isPurgedTombstone(null), false);
  assert.equal(isPurgedTombstone(undefined), false);
  assert.equal(isPurgedTombstone({}), false);
  assert.equal(isPurgedTombstone({ purged: false }), false);
  assert.equal(isPurgedTombstone({ appType: 'dlc' }), false);
});

// --- purgeNonGames: deletes + tombstones ------------------------------------------------------------

test('purgeNonGames: deletes the game and tombstones its source_records rows', async () => {
  const db = makeFakeDb({
    games: [{ id: 1, name: 'Chained Echoes (Original Game Soundtrack)', non_game: 'soundtrack' }],
    sourceRecords: [
      { id: 10, game_id: 1, source: 'steam', payload: JSON.stringify({ en: { name: 'x' } }), status: 'ok', error: null },
      { id: 11, game_id: 1, source: 'gog', payload: JSON.stringify({ en: { title: 'x' } }), status: 'ok', error: null },
      { id: 12, game_id: 1, source: 'igdb', payload: JSON.stringify({ some: 'thing' }), status: 'ok', error: null },
    ],
  });

  const result = await purgeNonGames({ db, log: noopLog });

  assert.deepEqual(result.purged, [{ id: 1, name: 'Chained Echoes (Original Game Soundtrack)', class: 'soundtrack' }]);
  assert.equal(result.skipped, 0);
  assert.deepEqual(db.games, []); // physically deleted

  const bySource = Object.fromEntries(db.sourceRecords.map((r) => [r.source, r]));
  assert.equal(bySource.steam.game_id, null);
  assert.equal(bySource.steam.status, 'not_found');
  assert.equal(bySource.steam.error, 'purged non-game (soundtrack)');
  assert.deepEqual(JSON.parse(bySource.steam.payload), { purged: true, class: 'soundtrack', name: 'Chained Echoes (Original Game Soundtrack)' });

  assert.equal(bySource.gog.game_id, null);
  assert.deepEqual(JSON.parse(bySource.gog.payload), { purged: true, class: 'soundtrack', name: 'Chained Echoes (Original Game Soundtrack)' });

  // Non-steam/gog source: payload NULL-ed, not kept.
  assert.equal(bySource.igdb.game_id, null);
  assert.equal(bySource.igdb.status, 'not_found');
  assert.equal(bySource.igdb.error, 'purged non-game (soundtrack)');
  assert.equal(bySource.igdb.payload, null);
});

test('purgeNonGames: logs one info line per purged game', async () => {
  const db = makeFakeDb({
    games: [
      { id: 1, name: 'Game A DLC', non_game: 'dlc' },
      { id: 2, name: 'Game B Soundtrack', non_game: 'soundtrack' },
    ],
  });
  const infoLines = [];
  const log = { info: (msg, meta) => infoLines.push({ msg, meta }), warn() {}, error() {} };

  await purgeNonGames({ db, log });

  assert.equal(infoLines.filter((l) => /purged/i.test(l.msg)).length, 2);
});

// --- purgeNonGames: override protects the row -------------------------------------------------------

test('purgeNonGames: a game with an overrides row for field=non_game is skipped, not deleted', async () => {
  const db = makeFakeDb({
    games: [
      { id: 1, name: 'Admin-Forced DLC', non_game: 'dlc' },
      { id: 2, name: 'Real Purge Candidate', non_game: 'tool' },
    ],
    overrides: [{ game_id: 1, field: 'non_game' }],
  });

  const result = await purgeNonGames({ db, log: noopLog });

  assert.deepEqual(result.purged, [{ id: 2, name: 'Real Purge Candidate', class: 'tool' }]);
  assert.equal(result.skipped, 1);
  assert.deepEqual(
    db.games.map((g) => g.id),
    [1],
  );
});

test('purgeNonGames: an override for a different field does not protect the row', async () => {
  const db = makeFakeDb({
    games: [{ id: 1, name: 'DLC With Unrelated Override', non_game: 'dlc' }],
    overrides: [{ game_id: 1, field: 'name' }],
  });

  const result = await purgeNonGames({ db, log: noopLog });

  assert.equal(result.purged.length, 1);
  assert.equal(result.skipped, 0);
  assert.deepEqual(db.games, []);
});

// --- purgeNonGames: dryRun writes nothing -----------------------------------------------------------

test('purgeNonGames: dryRun reports candidates without deleting or tombstoning anything', async () => {
  const db = makeFakeDb({
    games: [{ id: 1, name: 'Would Be Purged', non_game: 'dlc' }],
    sourceRecords: [{ id: 10, game_id: 1, source: 'steam', payload: JSON.stringify({ ok: true }), status: 'ok', error: null }],
  });

  const result = await purgeNonGames({ db, log: noopLog }, { dryRun: true });

  assert.deepEqual(result.purged, [{ id: 1, name: 'Would Be Purged', class: 'dlc' }]);
  assert.equal(db.games.length, 1, 'the game row must still exist');
  assert.equal(db.sourceRecords[0].game_id, 1, 'source_records must be untouched');
  assert.equal(db.sourceRecords[0].status, 'ok');
});

// --- purgeNonGames: limit --------------------------------------------------------------------------

test('purgeNonGames: limit bounds how many games are purged in one call', async () => {
  const db = makeFakeDb({
    games: [
      { id: 1, name: 'A DLC', non_game: 'dlc' },
      { id: 2, name: 'B DLC', non_game: 'dlc' },
      { id: 3, name: 'C DLC', non_game: 'dlc' },
    ],
  });

  const result = await purgeNonGames({ db, log: noopLog }, { limit: 2 });

  assert.equal(result.purged.length, 2);
  assert.equal(db.games.length, 1, 'the third candidate is left for a later call');
});

// --- purgeNonGames: transactions --------------------------------------------------------------------

test('purgeNonGames: uses db.tx per game when present', async () => {
  const inner = makeFakeDb({
    games: [
      { id: 1, name: 'A DLC', non_game: 'dlc' },
      { id: 2, name: 'B DLC', non_game: 'dlc' },
    ],
  });
  let txCalls = 0;
  const db = {
    query: inner.query,
    one: inner.one,
    tx: async (fn) => {
      txCalls += 1;
      return fn({ query: inner.query, one: inner.one });
    },
  };

  const result = await purgeNonGames({ db, log: noopLog });

  assert.equal(txCalls, 2, 'one transaction per purged game');
  assert.equal(result.purged.length, 2);
});

test('purgeNonGames: works without db.tx (runs the same statements directly against ctx.db)', async () => {
  const db = makeFakeDb({ games: [{ id: 1, name: 'A DLC', non_game: 'dlc' }] });
  assert.equal(typeof db.tx, 'undefined');

  const result = await purgeNonGames({ db, log: noopLog });
  assert.equal(result.purged.length, 1);
});

// --- purgeNonGames: nothing to purge -----------------------------------------------------------------

test('purgeNonGames: an empty catalog purges nothing and reports zero skipped', async () => {
  const db = makeFakeDb({ games: [] });
  const result = await purgeNonGames({ db, log: noopLog });
  assert.deepEqual(result, { purged: [], skipped: 0 });
});

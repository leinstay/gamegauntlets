// tests/sources/steam.test.js
//
// Fixtures under tests/fixtures/steam/ were recorded live (see git history /
// task report) except applist-page1.json / applist-page2.json, which are
// small hand-shaped pages used only to test `walkAppList`'s own paging loop
// in isolation (matching the real shape confirmed against
// api.steampowered.com while building this module) - `discover()` itself no
// longer calls `walkAppList`/`buildAppListUrl` at all, see the
// "ROLLING-BATCH REDESIGN" comment at the top of src/sources/steam.js; they
// stay exported/tested as pure utilities for a possible future catalog-crawl
// job.
//
// Everything here runs offline: http and db are fakes injected via ctx, per
// the source module interface (docs/plans/2026-09-19-rewrite-plan.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  name as sourceName,
  rateLimit,
  discover,
  fetchOne,
  extract,
  buildAppListUrl,
  walkAppList,
  htmlToText,
  parseLanguages,
  sumRecentHistogram,
  summarizeReviewPlaytime,
  reduceReviewsResponse,
  DELIST_RECHECK_GAP_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CATALOG_WALK_HOURS,
  NEW_APPID_JOB_PRIORITY,
} from '../../src/sources/steam.js';
import { createContext } from '../../src/pipeline/context.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'steam');

function loadFixture(file) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
}

const PORTAL2 = loadFixture('game-portal2.json');
const CS2 = loadFixture('free-cs2.json');
const DEADLOCK = loadFixture('comingsoon-deadlock.json');
const ZOMBOID = loadFixture('earlyaccess-projectzomboid.json');
const CITIES_DLC = loadFixture('dlc-citiesafterdark.json');
const NOTFOUND_RAW = loadFixture('appdetails-notfound.json');
const APPLIST_PAGE1 = loadFixture('applist-page1.json');
const APPLIST_PAGE2 = loadFixture('applist-page2.json');
// Recorded live 2026-09-19 (see appReviewHistogramUrl's doc): a busy game (Portal 2, appid 620, 30
// daily buckets), a low-volume one (Sam & Max Hit the Road, appid 355170) and an unreleased game with
// zero reviews at all (Deadlock, appid 1422450, results.recent: []).
const HISTOGRAM_620 = loadFixture('appreviewhistogram-620.json');
const HISTOGRAM_SMALL = loadFixture('appreviewhistogram-355170-small.json');
const HISTOGRAM_EMPTY = loadFixture('appreviewhistogram-1422450-empty.json');
// Recorded live 2026-09-19: one full appreviews page (num_per_page=100, filter=all) for Portal 2
// (appid 620), trimmed to query_summary + per-review author.playtime_forever/playtime_at_review/
// voted_up only (see summarizeReviewPlaytime()'s doc - review texts/authors are never stored).
const REVIEWS_620_PAGE = loadFixture('appreviews-620-page.json');

// --- module shape -----------------------------------------------------

test('module: exports name/rateLimit matching the source module interface', () => {
  assert.equal(sourceName, 'steam');
  assert.equal(typeof rateLimit.max, 'number');
  assert.equal(typeof rateLimit.duration, 'number');
});

// --- buildAppListUrl ----------------------------------------------------

test('buildAppListUrl: sets the fixed include_*/key/max_results params', () => {
  const url = new URL(buildAppListUrl({ apiKey: 'KEY', maxResults: 12345 }));
  assert.equal(url.origin + url.pathname, 'https://api.steampowered.com/IStoreService/GetAppList/v1/');
  assert.equal(url.searchParams.get('key'), 'KEY');
  assert.equal(url.searchParams.get('include_games'), '1');
  assert.equal(url.searchParams.get('include_dlc'), '0');
  assert.equal(url.searchParams.get('include_software'), '0');
  assert.equal(url.searchParams.get('include_videos'), '0');
  assert.equal(url.searchParams.get('include_hardware'), '0');
  assert.equal(url.searchParams.get('max_results'), '12345');
  assert.equal(url.searchParams.has('last_appid'), false);
  assert.equal(url.searchParams.has('if_modified_since'), false);
});

test('buildAppListUrl: includes last_appid/if_modified_since only when given', () => {
  const url = new URL(buildAppListUrl({ apiKey: 'KEY', lastAppid: 730, ifModifiedSince: 1700000000 }));
  assert.equal(url.searchParams.get('last_appid'), '730');
  assert.equal(url.searchParams.get('if_modified_since'), '1700000000');
});

// --- walkAppList (paging) ------------------------------------------------

test('walkAppList: pages until have_more_results is false, following last_appid', async () => {
  const requestedCursors = [];
  const pages = [APPLIST_PAGE1, APPLIST_PAGE2];
  let call = 0;
  const getPage = async (cursor) => {
    requestedCursors.push(cursor);
    return pages[call++];
  };

  const yielded = [];
  for await (const apps of walkAppList(getPage)) {
    yielded.push(apps);
  }

  assert.equal(call, 2);
  assert.deepEqual(requestedCursors, [null, 30]); // 2nd request resumes from page 1's last_appid
  assert.equal(yielded.length, 2);
  assert.deepEqual(
    yielded[0].map((a) => a.appid),
    [10, 20, 30],
  );
  assert.deepEqual(
    yielded[1].map((a) => a.appid),
    [40, 50],
  );
});

test('walkAppList: stops immediately on an empty page even if have_more_results were true', async () => {
  const getPage = async () => ({ response: { apps: [], have_more_results: true, last_appid: null } });
  const yielded = [];
  for await (const apps of walkAppList(getPage)) yielded.push(apps);
  assert.equal(yielded.length, 1);
  assert.deepEqual(yielded[0], []);
});

// --- discover() -----------------------------------------------------------

function createFakeDb({ gameRows = [], recordRows = [], initialSourceState = null, initialSourceRecords = {} } = {}) {
  const calls = [];
  const delistUpdates = []; // { gameId, delisted }, one per `UPDATE games SET steam_delisted = ...` call
  const insertedGames = [];
  let sourceState = initialSourceState;
  let nextInsertId = 1000;
  const gamesByAppid = new Map();
  // external_id -> { game_id, status, payload } - mirrors the real source_records row this appid owns.
  const sourceRecords = new Map(Object.entries(initialSourceRecords));

  return {
    calls,
    delistUpdates,
    insertedGames,
    getSourceState: () => sourceState,
    getSourceRecord: (externalId) => sourceRecords.get(String(externalId)),
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/SELECT steam_appid FROM games/i.test(sql)) return gameRows;
      if (/SELECT external_id, UNIX_TIMESTAMP/i.test(sql)) return recordRows;
      if (/INSERT INTO games/i.test(sql)) {
        const insertId = nextInsertId++;
        insertedGames.push({ insertId, params });
        gamesByAppid.set(String(params[2]), { id: insertId });
        return { insertId, affectedRows: 1 };
      }
      if (/UPDATE games SET steam_delisted = 1/i.test(sql)) {
        delistUpdates.push({ gameId: params[0], delisted: 1 });
        return { affectedRows: 1 };
      }
      if (/UPDATE games SET steam_delisted = 0/i.test(sql)) {
        delistUpdates.push({ gameId: params[0], delisted: 0 });
        return { affectedRows: 1 };
      }
      if (/INSERT INTO source_state/i.test(sql)) {
        const [, cursorJson, statsJson] = params;
        const prev = sourceState || { cursor_state: null, stats: null };
        sourceState = {
          cursor_state: cursorJson !== null ? cursorJson : prev.cursor_state,
          stats: statsJson !== null ? statsJson : prev.stats,
        };
        return { affectedRows: 1 };
      }
      if (/INSERT INTO source_records/i.test(sql)) {
        const [, externalId, gameId, status, payloadJson] = params;
        sourceRecords.set(String(externalId), { game_id: gameId, status, payload: payloadJson });
        return { affectedRows: 1 };
      }
      if (/INSERT INTO game_links/i.test(sql)) {
        return { affectedRows: 1 };
      }
      return [];
    },
    one: async (sql, params = []) => {
      calls.push({ sql, params, one: true });
      if (/SELECT id FROM games WHERE steam_appid/i.test(sql)) return gamesByAppid.get(String(params[0])) ?? null;
      if (/SELECT cursor_state, stats FROM source_state/i.test(sql)) return sourceState;
      if (/SELECT payload, game_id FROM source_records/i.test(sql)) {
        const record = sourceRecords.get(String(params[1]));
        return record ? { payload: record.payload, game_id: record.game_id } : null;
      }
      return null;
    },
  };
}

function fakeEnqueueTracker() {
  const calls = [];
  return {
    calls,
    enqueue: async (src, data, opts) => {
      calls.push({ source: src, data, opts });
    },
  };
}

function buildCtx({ db, http, enqueue, enqueueResolve, config, queueCounts, trimQueue, env }) {
  return createContext({
    db,
    http,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    env: env ?? { STEAM_API_KEY: 'test-key' },
    config: config ?? { sources: { steam: {} } },
    enqueue: enqueue ?? (async () => {}),
    enqueueResolve: enqueueResolve ?? (async () => {}),
    queueCounts,
    trimQueue,
  });
}

// --- discover() (PART A: gated daily catalog walk for brand-new appids +  ---
// --- the missing/delisting recheck; PART B: rolling SQL-priority batch +  ---
// --- queue-count gate + trimQueue backlog drain - see the module-level    ---
// --- comment at the top of src/sources/steam.js).                        ---

// Fakes every query discover()/runCatalogWalk() issue:
//   - `candidateGames` ([{ gameId, appid, fetchedAt }], `fetchedAt: null` =
//     never fetched) drives CANDIDATE_SQL (PART B) with the same WHERE/ORDER
//     BY/LIMIT the real SQL expresses.
//   - `knownAppids` (defaults to `candidateGames.map(g => g.appid)`) drives
//     PART A's "SELECT steam_appid FROM games" (which `games` already have a
//     steam_appid at all - independent of whether they've ever been
//     fetched).
//   - `recordedExternalIds` ([{ external_id, fetchedAt }], defaults to
//     `candidateGames` with a non-null `fetchedAt`) drives PART A's "SELECT
//     external_id, UNIX_TIMESTAMP(fetched_at)... FROM source_records" - ANY
//     source_records row, regardless of status, counts as "not new".
//   - `initialCursorState`/`initialStats` seed `source_state` for
//     `readSourceState()`.
function createDiscoverDb({ candidateGames = [], knownAppids = null, recordedExternalIds = null, initialCursorState = null, initialStats = null } = {}) {
  const calls = [];
  const resolvedKnownAppids = knownAppids ?? candidateGames.map((g) => g.appid);
  const resolvedRecords = recordedExternalIds ?? candidateGames
    .filter((g) => g.fetchedAt !== null)
    .map((g) => ({ external_id: String(g.appid), fetchedAt: Math.floor(new Date(g.fetchedAt).getTime() / 1000) }));
  let state = (initialCursorState !== null || initialStats !== null)
    ? { cursor_state: initialCursorState !== null ? JSON.stringify(initialCursorState) : null, stats: initialStats !== null ? JSON.stringify(initialStats) : null }
    : null;

  return {
    calls,
    getState: () => state,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/SELECT steam_appid FROM games/i.test(sql)) {
        return resolvedKnownAppids.map((appid) => ({ steam_appid: appid }));
      }
      if (/SELECT external_id, UNIX_TIMESTAMP/i.test(sql)) {
        return resolvedRecords;
      }
      if (/FROM games g/.test(sql) && /LEFT JOIN source_records/.test(sql)) {
        const [, refreshDays, limit] = params;
        const cutoffMs = Date.now() - Number(refreshDays) * 24 * 60 * 60 * 1000;
        return candidateGames
          .filter((g) => g.fetchedAt === null || new Date(g.fetchedAt).getTime() < cutoffMs)
          .slice()
          .sort((a, b) => {
            const aNever = a.fetchedAt === null;
            const bNever = b.fetchedAt === null;
            if (aNever !== bNever) return aNever ? -1 : 1; // never-fetched group sorts first
            if (aNever) return b.appid - a.appid; // newest appid first
            return new Date(a.fetchedAt).getTime() - new Date(b.fetchedAt).getTime(); // oldest fetch first
          })
          .slice(0, Number(limit))
          .map((g) => ({ gameId: g.gameId, appid: g.appid }));
      }
      if (/INSERT INTO source_state/i.test(sql)) {
        const [, cursorJson, statsJson] = params;
        const prev = state || { cursor_state: null, stats: null };
        state = {
          cursor_state: cursorJson !== null ? cursorJson : prev.cursor_state,
          stats: statsJson !== null ? statsJson : prev.stats,
        };
        return { affectedRows: 1 };
      }
      return [];
    },
    one: async (sql) => {
      calls.push({ sql, one: true });
      if (/SELECT cursor_state, stats FROM source_state/i.test(sql)) return state;
      return null;
    },
  };
}

function fakeQueueCounts(counts) {
  return async () => counts;
}

// A `cursor_state` that suppresses PART A's catalog walk ("just walked") -
// used by every PART-B-only test below so they don't need an http fixture.
const RECENT_WALK_CURSOR = { lastCatalogWalkAt: new Date().toISOString(), missingAppids: [] };

function catalogPage(appids, { haveMore = false, lastAppid } = {}) {
  return {
    response: {
      apps: appids.map((appid) => ({ appid, name: `App ${appid}`, last_modified: 1_700_000_000, price_change_number: 1 })),
      have_more_results: haveMore,
      last_appid: lastAppid ?? appids[appids.length - 1] ?? null,
    },
  };
}

test('discover: exports its rolling-batch/catalog-walk defaults', () => {
  assert.equal(typeof DEFAULT_BATCH_SIZE, 'number');
  assert.ok(DEFAULT_BATCH_SIZE > 0);
  assert.equal(typeof DEFAULT_CATALOG_WALK_HOURS, 'number');
  assert.ok(DEFAULT_CATALOG_WALK_HOURS > 0);
  assert.equal(typeof NEW_APPID_JOB_PRIORITY, 'number');
});

// --- PART B: rolling SQL-priority batch (queue-count gate, ordering, trimQueue) ---

test('discover: skips enqueueing entirely when the queue already has more than batchSize/2 pending (waiting+delayed)', async () => {
  const db = createDiscoverDb({ candidateGames: [{ gameId: 1, appid: 730, fetchedAt: null }], initialCursorState: RECENT_WALK_CURSOR });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({
    db,
    enqueue,
    config: { sources: { steam: { batchSize: 10, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 4, delayed: 2 }), // 6 > 10/2
  });

  const result = await discover(ctx);

  assert.equal(result.skipped, true);
  assert.equal(result.enqueued, 0);
  assert.deepEqual(enqueued, []);
  assert.equal(db.calls.some((c) => /FROM games g/.test(c.sql)), false); // the candidate query never even runs
  assert.deepEqual(JSON.parse(db.getState().stats), {
    batchSize: 10, refreshDays: 3, waiting: 4, delayed: 2, trimmed: 0, skipped: true, candidates: 0, enqueued: 0,
  });
});

test('discover: enqueues when pending is exactly at the batchSize/2 boundary (not skipped)', async () => {
  const db = createDiscoverDb({ candidateGames: [{ gameId: 1, appid: 730, fetchedAt: null }], initialCursorState: RECENT_WALK_CURSOR });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({
    db,
    enqueue,
    config: { sources: { steam: { batchSize: 10, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 5, delayed: 0 }), // exactly 10/2 - not "above"
  });

  const result = await discover(ctx);

  assert.equal(result.skipped, undefined);
  assert.equal(result.enqueued, 1);
  assert.deepEqual(enqueued.map((c) => c.data), [{ gameId: 1, externalId: '730' }]);
});

test('discover: never-fetched candidates (no source_records row) come before stale ones, regardless of appid/fetchedAt values', async () => {
  const candidateGames = [
    { gameId: 1, appid: 100, fetchedAt: '2000-01-01T00:00:00.000Z' }, // very stale, but already fetched once
    { gameId: 2, appid: 999999, fetchedAt: null }, // never fetched
    { gameId: 3, appid: 200, fetchedAt: '2020-01-01T00:00:00.000Z' }, // stale
  ];
  const db = createDiscoverDb({ candidateGames, initialCursorState: RECENT_WALK_CURSOR });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({
    db,
    enqueue,
    config: { sources: { steam: { batchSize: 10, refreshDays: 1 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  const result = await discover(ctx);

  assert.equal(result.enqueued, 3);
  assert.deepEqual(enqueued.map((c) => c.data.gameId), [2, 1, 3]); // never-fetched first, then oldest-fetched-first
});

test('discover: within the never-fetched group, newest appid goes first', async () => {
  const candidateGames = [
    { gameId: 1, appid: 100, fetchedAt: null },
    { gameId: 2, appid: 300, fetchedAt: null },
    { gameId: 3, appid: 200, fetchedAt: null },
  ];
  const db = createDiscoverDb({ candidateGames, initialCursorState: RECENT_WALK_CURSOR });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({
    db,
    enqueue,
    config: { sources: { steam: { batchSize: 10, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  await discover(ctx);

  assert.deepEqual(enqueued.map((c) => c.data.externalId), ['300', '200', '100']);
});

test('discover: within the stale group, oldest fetched_at goes first', async () => {
  const candidateGames = [
    { gameId: 1, appid: 100, fetchedAt: '2022-06-01T00:00:00.000Z' },
    { gameId: 2, appid: 200, fetchedAt: '2020-01-01T00:00:00.000Z' }, // oldest
    { gameId: 3, appid: 300, fetchedAt: '2021-01-01T00:00:00.000Z' },
  ];
  const db = createDiscoverDb({ candidateGames, initialCursorState: RECENT_WALK_CURSOR });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({
    db,
    enqueue,
    config: { sources: { steam: { batchSize: 10, refreshDays: 1 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  await discover(ctx);

  assert.deepEqual(enqueued.map((c) => c.data.gameId), [2, 3, 1]);
});

test('discover: a record fresher than refreshDays is not a candidate at all', async () => {
  const db = createDiscoverDb({
    candidateGames: [{ gameId: 1, appid: 100, fetchedAt: new Date().toISOString() }], // fetched just now
    initialCursorState: RECENT_WALK_CURSOR,
  });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({
    db,
    enqueue,
    config: { sources: { steam: { batchSize: 10, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  const result = await discover(ctx);

  assert.equal(result.enqueued, 0);
  assert.deepEqual(enqueued, []);
});

test('discover: respects batchSize - only the top N candidates (by priority) are enqueued, the SQL LIMIT is passed through', async () => {
  const candidateGames = Array.from({ length: 20 }, (_, i) => ({ gameId: i + 1, appid: 1000 + i, fetchedAt: null }));
  const db = createDiscoverDb({ candidateGames, initialCursorState: RECENT_WALK_CURSOR });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({
    db,
    enqueue,
    config: { sources: { steam: { batchSize: 5, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  const result = await discover(ctx);

  assert.equal(result.enqueued, 5);
  assert.equal(enqueued.length, 5);
  // Newest-appid-first among the never-fetched group -> the top 5 of appids 1000..1019 is 1019..1015.
  assert.deepEqual(enqueued.map((c) => c.data.externalId), ['1019', '1018', '1017', '1016', '1015']);
  const candidateCall = db.calls.find((c) => /FROM games g/.test(c.sql));
  assert.deepEqual(candidateCall.params, ['steam', 3, 5]); // source, refreshDays, LIMIT batchSize
});

test('discover: trims the queue when waiting exceeds 2x batchSize before deciding whether to enqueue', async () => {
  const db = createDiscoverDb({ candidateGames: [{ gameId: 1, appid: 730, fetchedAt: null }], initialCursorState: RECENT_WALK_CURSOR });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const trimCalls = [];
  const ctx = buildCtx({
    db,
    enqueue,
    config: { sources: { steam: { batchSize: 100, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 250, delayed: 0 }), // > 2*100
    trimQueue: async (source, keep) => {
      trimCalls.push({ source, keep });
      return 200; // simulate removing 200, leaving 50 waiting
    },
  });

  const result = await discover(ctx);

  assert.deepEqual(trimCalls, [{ source: 'steam', keep: 100 }]);
  assert.equal(result.trimmed, 200);
  // post-trim waiting (250 - 200 = 50) is <= batchSize/2 (50) -> proceeds to enqueue normally.
  assert.equal(result.enqueued, 1);
  assert.equal(result.waiting, 50);
});

test('discover: trimming that does not bring the queue below batchSize/2 still skips enqueueing this run', async () => {
  const db = createDiscoverDb({ candidateGames: [{ gameId: 1, appid: 730, fetchedAt: null }], initialCursorState: RECENT_WALK_CURSOR });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({
    db,
    enqueue,
    config: { sources: { steam: { batchSize: 100, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 1000, delayed: 0 }),
    trimQueue: async () => 800, // leaves 200 waiting, still > 100/2
  });

  const result = await discover(ctx);

  assert.equal(result.trimmed, 800);
  assert.equal(result.skipped, true);
  assert.deepEqual(enqueued, []);
});

test('discover: does not trim when waiting is within 2x batchSize', async () => {
  const db = createDiscoverDb({ candidateGames: [{ gameId: 1, appid: 730, fetchedAt: null }], initialCursorState: RECENT_WALK_CURSOR });
  let trimCalled = false;
  const ctx = buildCtx({
    db,
    config: { sources: { steam: { batchSize: 100, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 199, delayed: 0 }), // exactly at 2x, not "above"
    trimQueue: async () => { trimCalled = true; return 0; },
  });

  const result = await discover(ctx);

  assert.equal(trimCalled, false);
  assert.equal(result.trimmed, 0);
});

test('discover: writes source_state (stats + last_run_at, last_full_pass_at untouched) after a walk-less run', async () => {
  const db = createDiscoverDb({ candidateGames: [{ gameId: 1, appid: 730, fetchedAt: null }], initialCursorState: RECENT_WALK_CURSOR });
  const ctx = buildCtx({
    db,
    enqueue: async () => {},
    config: { sources: { steam: { batchSize: 10, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  await discover(ctx);

  const stateCall = db.calls.find((c) => /INSERT INTO source_state/i.test(c.sql));
  assert.ok(stateCall);
  assert.match(stateCall.sql, /last_run_at.*NOW\(\)/s);
  assert.match(stateCall.sql, /last_full_pass_at.*NULL/s); // no walk ran this run -> not touched
  assert.deepEqual(JSON.parse(db.getState().stats), {
    batchSize: 10, refreshDays: 3, waiting: 0, delayed: 0, trimmed: 0, skipped: false, candidates: 1, enqueued: 1,
  });
  // cursor_state (which only the walk would touch) stays exactly as seeded.
  assert.deepEqual(JSON.parse(db.getState().cursor_state), RECENT_WALK_CURSOR);
});

test('discover: with no queueCounts/trimQueue wired at all (context.js defaults), behaves as if the queue is empty', async () => {
  const db = createDiscoverDb({ candidateGames: [{ gameId: 1, appid: 730, fetchedAt: null }], initialCursorState: RECENT_WALK_CURSOR });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  // createContext's own default stand-ins (queueCounts/trimQueue both omitted) - see src/pipeline/context.js.
  const ctx = createContext({
    db,
    http: { getJson: async () => { throw new Error('the SQL-batch-only path must not call http'); } },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    env: {},
    config: { sources: { steam: { batchSize: 10, refreshDays: 3 } } },
    enqueue,
    enqueueResolve: async () => {},
  });

  const result = await discover(ctx);

  assert.equal(result.enqueued, 1);
  assert.deepEqual(enqueued[0].data, { gameId: 1, externalId: '730' });
});

// --- PART A: gated daily catalog walk (new-appid discovery + missing/delisting recheck) ---

test('discover: does not walk the catalog before catalogWalkHours has passed since the last walk', async () => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const db = createDiscoverDb({
    candidateGames: [],
    initialCursorState: { lastCatalogWalkAt: oneHourAgo, missingAppids: [] },
  });
  let httpCalled = false;
  const ctx = buildCtx({
    db,
    http: { getJson: async () => { httpCalled = true; return catalogPage([]); } },
    config: { sources: { steam: { batchSize: 10, refreshDays: 3, catalogWalkHours: 24 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  const result = await discover(ctx);

  assert.equal(httpCalled, false);
  assert.equal(result.newFound, undefined); // PART A didn't run at all this time
  assert.deepEqual(JSON.parse(db.getState().cursor_state), { lastCatalogWalkAt: oneHourAgo, missingAppids: [] }); // untouched
});

test('discover: walks the catalog when there is no recorded lastCatalogWalkAt at all (first run ever)', async () => {
  const db = createDiscoverDb({ candidateGames: [], knownAppids: [], recordedExternalIds: [], initialCursorState: null });
  let httpCalled = false;
  const ctx = buildCtx({
    db,
    http: { getJson: async () => { httpCalled = true; return catalogPage([]); } },
    config: { sources: { steam: { batchSize: 10, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  await discover(ctx);

  assert.equal(httpCalled, true);
});

test('discover: walks the catalog once catalogWalkHours has elapsed', async () => {
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const db = createDiscoverDb({
    candidateGames: [],
    knownAppids: [],
    recordedExternalIds: [],
    initialCursorState: { lastCatalogWalkAt: twoDaysAgo, missingAppids: [] },
  });
  let httpCalled = false;
  const ctx = buildCtx({
    db,
    http: { getJson: async () => { httpCalled = true; return catalogPage([]); } },
    config: { sources: { steam: { batchSize: 10, refreshDays: 3, catalogWalkHours: 24 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  await discover(ctx);

  assert.equal(httpCalled, true);
});

test('discover: catalog walk is skipped (logged, not thrown) when STEAM_API_KEY is unset', async () => {
  const db = createDiscoverDb({ candidateGames: [], knownAppids: [], recordedExternalIds: [], initialCursorState: null });
  let httpCalled = false;
  const errors = [];
  const ctx = buildCtx({
    db,
    http: { getJson: async () => { httpCalled = true; return catalogPage([]); } },
    env: {}, // no STEAM_API_KEY
    config: { sources: { steam: { batchSize: 10, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });
  ctx.log.error = (msg) => errors.push(msg);

  await discover(ctx);

  assert.equal(httpCalled, false);
  assert.ok(errors.some((m) => /STEAM_API_KEY/.test(m)));
});

test('discover: a "new" appid (in the catalog, no games.steam_appid, no source_records row at all) is enqueued first, with NEW_APPID_JOB_PRIORITY, ahead of the SQL batch', async () => {
  const db = createDiscoverDb({
    candidateGames: [{ gameId: 1, appid: 730, fetchedAt: null }], // an unrelated PART B candidate
    knownAppids: [], // 730 has no games row either (matches candidateGames' "never fetched" bucket)
    recordedExternalIds: [],
    initialCursorState: null,
  });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({
    db,
    enqueue,
    http: { getJson: async () => catalogPage([999999]) }, // 999999: genuinely new
    config: { sources: { steam: { batchSize: 10, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  const result = await discover(ctx);

  assert.equal(result.newFound, 1);
  assert.equal(result.newAppidsEnqueued, 1);
  assert.equal(enqueued.length, 2); // the new appid, then the PART B candidate
  assert.equal(enqueued[0].data.externalId, '999999');
  assert.deepEqual(enqueued[0].opts, { lifo: true });
  assert.equal(enqueued[1].data.externalId, '730');
  assert.equal(enqueued[1].opts, undefined); // the ordinary rolling-batch job carries no special priority
});

test('discover: an appid with ANY source_records row (e.g. a DLC recorded not_found) is NOT treated as new, even with no games row', async () => {
  const db = createDiscoverDb({
    candidateGames: [],
    knownAppids: [], // no games row for 12345
    recordedExternalIds: [{ external_id: '12345', fetchedAt: Math.floor(Date.now() / 1000) }], // but a source_records row exists
    initialCursorState: null,
  });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({
    db,
    enqueue,
    http: { getJson: async () => catalogPage([12345]) },
    config: { sources: { steam: { batchSize: 10, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  const result = await discover(ctx);

  assert.equal(result.newFound, 0);
  assert.deepEqual(enqueued, []);
});

test('discover: an appid already known via games.steam_appid (even with no source_records row) is NOT treated as new by the walk', async () => {
  // It IS a PART B candidate (never fetched) - just not a PART A "new appid".
  const db = createDiscoverDb({
    candidateGames: [{ gameId: 5, appid: 42, fetchedAt: null }],
    knownAppids: [42],
    recordedExternalIds: [],
    initialCursorState: null,
  });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({
    db,
    enqueue,
    http: { getJson: async () => catalogPage([42]) },
    config: { sources: { steam: { batchSize: 10, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  const result = await discover(ctx);

  assert.equal(result.newFound, 0);
  // Still enqueued exactly once - by PART B (the SQL batch), not PART A, and with no priority opt.
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].opts, undefined);
});

test('discover: caps new-appid enqueues at batchSize per run and does not stamp lastCatalogWalkAt when a remainder is left', async () => {
  const newAppids = [201, 202, 203, 204, 205]; // 5 new appids, batchSize 2
  const db = createDiscoverDb({ candidateGames: [], knownAppids: [], recordedExternalIds: [], initialCursorState: null });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({
    db,
    enqueue,
    http: { getJson: async () => catalogPage(newAppids) },
    config: { sources: { steam: { batchSize: 2, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  const result = await discover(ctx);

  assert.equal(result.newFound, 5);
  assert.equal(result.newAppidsEnqueued, 2);
  assert.equal(result.newRemainder, 3);
  assert.deepEqual(enqueued.map((c) => c.data.externalId), ['205', '204']); // newest-first, capped at batchSize
  assert.equal(JSON.parse(db.getState().cursor_state).lastCatalogWalkAt, null); // remainder left -> not stamped
});

test('discover: stamps lastCatalogWalkAt once a walk finds no new-appid remainder', async () => {
  const db = createDiscoverDb({ candidateGames: [], knownAppids: [], recordedExternalIds: [], initialCursorState: null });
  const ctx = buildCtx({
    db,
    enqueue: async () => {},
    http: { getJson: async () => catalogPage([301, 302]) }, // 2 new appids, well under batchSize
    config: { sources: { steam: { batchSize: 100, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  const before = Date.now();
  const result = await discover(ctx);

  assert.equal(result.newRemainder, 0);
  const cursorState = JSON.parse(db.getState().cursor_state);
  assert.ok(cursorState.lastCatalogWalkAt);
  assert.ok(Date.parse(cursorState.lastCatalogWalkAt) >= before);
});

test('discover: a caught-up walk (remainder 0) also touches last_full_pass_at', async () => {
  const db = createDiscoverDb({ candidateGames: [], knownAppids: [], recordedExternalIds: [], initialCursorState: null });
  const ctx = buildCtx({
    db,
    enqueue: async () => {},
    http: { getJson: async () => catalogPage([]) },
    config: { sources: { steam: { batchSize: 100, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  await discover(ctx);

  const stateCall = db.calls.find((c) => /INSERT INTO source_state/i.test(c.sql));
  assert.match(stateCall.sql, /last_full_pass_at.*NOW\(\)/s);
});

test('discover: an appid missing from the catalog for the first time is recorded but not yet rechecked', async () => {
  const db = createDiscoverDb({
    candidateGames: [],
    knownAppids: [10, 30], // both known
    recordedExternalIds: [{ external_id: '10', fetchedAt: 1_700_000_000 }],
    initialCursorState: { lastCatalogWalkAt: null, missingAppids: [] }, // nothing missing on the previous walk
  });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({
    db,
    enqueue,
    http: { getJson: async () => catalogPage([10]) }, // 30 is absent this time
    config: { sources: { steam: { batchSize: 10, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  const result = await discover(ctx);

  assert.equal(result.missing, 1);
  assert.equal(result.missingVerifyEnqueued, 0);
  assert.deepEqual(enqueued, []);
  assert.deepEqual(JSON.parse(db.getState().cursor_state).missingAppids, [30]);
});

test('discover: an appid missing on two consecutive walks gets an ordinary (non-prioritized) fetch job re-enqueued, never steam_delisted directly', async () => {
  const db = createDiscoverDb({
    candidateGames: [],
    knownAppids: [10, 30],
    recordedExternalIds: [{ external_id: '10', fetchedAt: 1_700_000_000 }], // 30 has no source_records row -> immediately due
    initialCursorState: { lastCatalogWalkAt: null, missingAppids: [30] }, // 30 was already missing last walk
  });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({
    db,
    enqueue,
    http: { getJson: async () => catalogPage([10]) },
    config: { sources: { steam: { batchSize: 10, refreshDays: 3, missingRefreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  const result = await discover(ctx);

  assert.equal(result.missing, 1);
  assert.equal(result.missingVerifyEnqueued, 1);
  const missingCall = enqueued.find((c) => c.data.externalId === '30');
  assert.ok(missingCall);
  assert.equal(missingCall.opts, undefined); // no special priority for a missing-appid recheck
  assert.equal(db.calls.some((c) => /UPDATE games SET steam_delisted/i.test(c.sql)), false); // never a direct write
});

test('discover: does not re-enqueue a twice-missing appid again before missingRefreshDays has passed', async () => {
  const nowUnix = Math.floor(Date.now() / 1000);
  const db = createDiscoverDb({
    candidateGames: [],
    knownAppids: [30],
    recordedExternalIds: [{ external_id: '30', fetchedAt: nowUnix - 3600 }], // fetched (and verified missing) 1h ago
    initialCursorState: { lastCatalogWalkAt: null, missingAppids: [30] },
  });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({
    db,
    enqueue,
    http: { getJson: async () => catalogPage([]) },
    config: { sources: { steam: { batchSize: 10, refreshDays: 3, missingRefreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  const result = await discover(ctx);

  assert.equal(result.missingVerifyEnqueued, 0);
  assert.deepEqual(enqueued, []);
});

test('discover: new-appid jobs count toward PART B\'s queue-fullness gate for the same run', async () => {
  const db = createDiscoverDb({
    candidateGames: [{ gameId: 1, appid: 730, fetchedAt: null }],
    knownAppids: [],
    recordedExternalIds: [],
    initialCursorState: null,
  });
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({
    db,
    enqueue,
    // 3 new appids will be enqueued by PART A; batchSize 6 -> gate threshold 3 - already at the boundary
    // once PART A's 3 are added to the starting waiting count of 0, so PART B is skipped this run.
    http: { getJson: async () => catalogPage([1, 2, 3]) },
    config: { sources: { steam: { batchSize: 6, refreshDays: 3 } } },
    queueCounts: fakeQueueCounts({ waiting: 0, delayed: 0 }),
  });

  const result = await discover(ctx);

  assert.equal(result.newAppidsEnqueued, 3);
  assert.equal(result.skipped, undefined); // pending (3) is not "above" batchSize/2 (3) - boundary, not skipped
  assert.equal(result.candidates, 1); // PART B still ran and found the one candidate...
  assert.equal(enqueued.filter((c) => c.data.externalId === '730').length, 1); // ...and enqueued it
});

// --- fetchOne() -------------------------------------------------------

function rawAppDetails(appid, data) {
  if (data === null) return { [String(appid)]: { success: false } };
  return { [String(appid)]: { success: true, data } };
}

function httpForFixture(fixture) {
  return {
    getJson: async (url) => {
      if (url.includes('/appreviewhistogram/')) return fixture.histogram ?? { success: 1, results: { recent: [] } };
      if (url.includes('/appreviews/')) return fixture.reviews ?? { success: 0 };
      if (url.includes('cc=az')) return rawAppDetails(fixture.appid, fixture.az);
      if (url.includes('l=russian')) return rawAppDetails(fixture.appid, fixture.ru);
      return rawAppDetails(fixture.appid, fixture.en);
    },
  };
}

test('fetchOne: new game -> creates a games row, upserts record+link, enqueues resolve', async () => {
  const db = createFakeDb({ gameRows: [], recordRows: [] });
  const enqueueResolveCalls = [];
  const ctx = buildCtx({
    db,
    http: httpForFixture(PORTAL2),
    enqueueResolve: async (gameId) => enqueueResolveCalls.push(gameId),
  });

  const result = await fetchOne(ctx, { data: { externalId: '620' } });

  assert.equal(result.status, 'ok');
  assert.equal(result.externalId, '620');

  const insertGame = db.calls.find((c) => /INSERT INTO games/i.test(c.sql));
  assert.ok(insertGame, 'expected an INSERT INTO games call');
  assert.deepEqual(insertGame.params, ['Portal 2', 'Portal 2', '620']);

  const upsertRecord = db.calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  assert.ok(upsertRecord);
  assert.equal(upsertRecord.params[0], 'steam');
  assert.equal(upsertRecord.params[1], '620');
  assert.equal(upsertRecord.params[3], 'ok');

  const upsertLink = db.calls.find((c) => /INSERT INTO game_links/i.test(c.sql));
  assert.ok(upsertLink);
  assert.equal(upsertLink.params[0], 1000); // gameId from the fake INSERT
  assert.equal(upsertLink.params[1], 'steam');
  assert.equal(upsertLink.params[2], '620');
  assert.equal(upsertLink.params[3], 'https://store.steampowered.com/app/620');
  assert.equal(upsertLink.params[4], 'store');

  assert.deepEqual(enqueueResolveCalls, [1000]);
});

test('fetchOne: sums appreviewhistogram\'s results.recent into payload.recentReviews', async () => {
  const db = createFakeDb({ gameRows: [], recordRows: [] });
  const fixture = {
    ...PORTAL2,
    histogram: {
      success: 1,
      results: {
        recent: [
          { date: 1, recommendations_up: 10, recommendations_down: 2 },
          { date: 2, recommendations_up: 5, recommendations_down: 0 },
        ],
      },
    },
  };
  const ctx = buildCtx({ db, http: httpForFixture(fixture) });
  await fetchOne(ctx, { data: { externalId: '620' } });

  const upsertRecord = db.calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  const payload = JSON.parse(upsertRecord.params[4]);
  assert.deepEqual(payload.recentReviews, { positive: 15, negative: 2 });
});

test('fetchOne: an empty (no recent activity) histogram yields payload.recentReviews: null', async () => {
  const db = createFakeDb({ gameRows: [], recordRows: [] });
  const fixture = { ...PORTAL2, histogram: { success: 1, results: { recent: [] } } };
  const ctx = buildCtx({ db, http: httpForFixture(fixture) });
  await fetchOne(ctx, { data: { externalId: '620' } });

  const upsertRecord = db.calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  const payload = JSON.parse(upsertRecord.params[4]);
  assert.equal(payload.recentReviews, null);
});

test('fetchOne: a failed appreviewhistogram request is tolerated (job still succeeds, recentReviews null)', async () => {
  const db = createFakeDb({ gameRows: [], recordRows: [] });
  const http = {
    getJson: async (url) => {
      if (url.includes('/appreviewhistogram/')) throw new Error('histogram boom');
      if (url.includes('/appreviews/')) return PORTAL2.reviews;
      if (url.includes('cc=az')) return rawAppDetails(PORTAL2.appid, PORTAL2.az);
      if (url.includes('l=russian')) return rawAppDetails(PORTAL2.appid, PORTAL2.ru);
      return rawAppDetails(PORTAL2.appid, PORTAL2.en);
    },
  };
  const ctx = buildCtx({ db, http });
  const result = await fetchOne(ctx, { data: { externalId: '620' } });

  assert.equal(result.status, 'ok');
  const upsertRecord = db.calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  const payload = JSON.parse(upsertRecord.params[4]);
  assert.equal(payload.recentReviews, null);
});

test('fetchOne: reduces the appreviews page into payload.reviewsPlaytime and never stores the raw reviews/authors', async () => {
  const db = createFakeDb({ gameRows: [], recordRows: [] });
  const fixture = { ...PORTAL2, reviews: REVIEWS_620_PAGE };
  const ctx = buildCtx({ db, http: httpForFixture(fixture) });
  await fetchOne(ctx, { data: { externalId: '620' } });

  const upsertRecord = db.calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  const payloadJson = upsertRecord.params[4];
  const payload = JSON.parse(payloadJson);

  // query_summary is still there for scoreSteam (unaffected by num_per_page - see appReviewsUrl's doc).
  assert.deepEqual(payload.reviews, { success: REVIEWS_620_PAGE.success, query_summary: REVIEWS_620_PAGE.query_summary });
  // The raw per-review array/cursor never made it into the stored payload at all.
  assert.equal(payload.reviews.reviews, undefined);
  assert.equal(payload.reviews.cursor, undefined);
  assert.ok(!payloadJson.includes('playtime_at_review'), 'no per-review author fields should be serialized');

  assert.equal(payload.reviewsPlaytime.count, REVIEWS_620_PAGE.reviews.length);
  assert.ok(payload.reviewsPlaytime.medianAtReview > 0);
  assert.ok(payload.reviewsPlaytime.p25AtReview <= payload.reviewsPlaytime.medianAtReview);
  assert.ok(payload.reviewsPlaytime.p75AtReview >= payload.reviewsPlaytime.medianAtReview);
});

test('fetchOne: a review-less game (empty reviews page) yields payload.reviewsPlaytime: null', async () => {
  const db = createFakeDb({ gameRows: [], recordRows: [] });
  const fixture = { ...PORTAL2, reviews: { success: 1, query_summary: { total_reviews: 0 }, reviews: [] } };
  const ctx = buildCtx({ db, http: httpForFixture(fixture) });
  await fetchOne(ctx, { data: { externalId: '620' } });

  const upsertRecord = db.calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  const payload = JSON.parse(upsertRecord.params[4]);
  assert.equal(payload.reviewsPlaytime, null);
});

test('fetchOne: existing game (gameId in job.data) does not insert a new games row', async () => {
  const db = createFakeDb({ gameRows: [], recordRows: [] });
  const ctx = buildCtx({ db, http: httpForFixture(PORTAL2) });
  await fetchOne(ctx, { data: { gameId: 42, externalId: '620' } });
  assert.equal(db.calls.some((c) => /INSERT INTO games/i.test(c.sql)), false);
  const upsertLink = db.calls.find((c) => /INSERT INTO game_links/i.test(c.sql));
  assert.equal(upsertLink.params[0], 42);
});

// --- fetchOne: purge-non-games integration (creation-time guards, src/pipeline/purge-non-games.js) -----

test('fetchOne: a purged appid (source_records tombstone) is never recreated', async () => {
  const calls = [];
  const existingPayload = { purged: true, class: 'dlc', name: 'Old DLC' };
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO source_records/i.test(sql)) return { affectedRows: 1 };
      if (/INSERT INTO games/i.test(sql)) throw new Error('must not create a new games row for a purged appid');
      return [];
    },
    one: async (sql, params) => {
      calls.push({ sql, params, one: true });
      if (sql === 'SELECT payload FROM source_records WHERE source = ? AND external_id = ?') {
        return { payload: JSON.stringify(existingPayload) };
      }
      return null;
    },
  };
  const ctx = buildCtx({ db, http: httpForFixture(PORTAL2) });
  const result = await fetchOne(ctx, { data: { externalId: '620' } });

  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'purged');
  const upsertRecord = calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  assert.ok(upsertRecord);
  assert.equal(upsertRecord.params[3], 'not_found');
  assert.deepEqual(JSON.parse(upsertRecord.params[4]), existingPayload);
  assert.equal(calls.some((c) => /INSERT INTO game_links/i.test(c.sql)), false);
});

test('fetchOne: a brand-new appid whose title classifies as non-game is never created, tombstoned instead', async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO games/i.test(sql)) throw new Error('must not create a games row for a classified non-game');
      return [];
    },
    one: async (sql, params) => {
      calls.push({ sql, params, one: true });
      return null; // no tombstone yet, no base-game row found
    },
  };
  const fixture = { ...PORTAL2, en: { ...PORTAL2.en, name: 'Some Game (Original Game Soundtrack)' } };
  const ctx = buildCtx({ db, http: httpForFixture(fixture) });
  const result = await fetchOne(ctx, { data: { externalId: '620' } });

  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'non_game');
  const upsertRecord = calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  assert.ok(upsertRecord);
  assert.equal(upsertRecord.params[3], 'not_found');
  assert.deepEqual(JSON.parse(upsertRecord.params[4]), {
    purged: true,
    class: 'soundtrack',
    name: 'Some Game (Original Game Soundtrack)',
  });
  assert.equal(calls.some((c) => /INSERT INTO game_links/i.test(c.sql)), false);
});

test('fetchOne: a DLC (type !== game) is recorded not_found and never linked', async () => {
  const db = createFakeDb();
  const ctx = buildCtx({ db, http: httpForFixture(CITIES_DLC) });
  const result = await fetchOne(ctx, { data: { externalId: '369150' } });
  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'not-a-game');
  const record = db.calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  assert.equal(record.params[3], 'not_found');
  // `payload.appType` (migrations/004_non_game.sql / src/lib/non-game.js) - read directly by
  // src/pipeline/resolve.js since this row's status is never 'ok'.
  assert.deepEqual(JSON.parse(record.params[4]), { appType: 'dlc' });
  assert.equal(db.calls.some((c) => /INSERT INTO game_links/i.test(c.sql)), false);
});

test('fetchOne: success:false (removed/never-existed appid) is recorded not_found', async () => {
  const db = createFakeDb();
  const http = { getJson: async () => NOTFOUND_RAW };
  const ctx = buildCtx({ db, http });
  const result = await fetchOne(ctx, { data: { externalId: '999999999' } });
  assert.equal(result.status, 'not_found');
  const record = db.calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  assert.equal(record.params[3], 'not_found');
});

test('fetchOne: a network/HTTP failure records status error and rethrows for BullMQ to retry', async () => {
  const db = createFakeDb();
  const http = { getJson: async () => { throw new Error('boom'); } };
  const ctx = buildCtx({ db, http });
  await assert.rejects(() => fetchOne(ctx, { data: { externalId: '620' } }), /boom/);
  const record = db.calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  assert.equal(record.params[3], 'error');
});

test('fetchOne: throws when externalId is missing', async () => {
  const ctx = buildCtx({ db: createFakeDb(), http: { getJson: async () => ({}) } });
  await assert.rejects(() => fetchOne(ctx, { data: {} }), /externalId/);
});

// --- fetchOne(): delisting is only ever confirmed from two independently- --
// --- timed appdetails failures, never from GetAppList absence (T8b fix). --

function httpAllFail(appid) {
  return { getJson: async () => ({ [String(appid)]: { success: false } }) };
}

function httpEnFailRuSucceeds(appid, ruData) {
  return {
    getJson: async (url) => {
      if (url.includes('l=russian')) return { [String(appid)]: { success: true, data: ruData } };
      return { [String(appid)]: { success: false } };
    },
  };
}

test('fetchOne: a first appdetails failure (both en/us and ru/ru) records delistCheck but does not delist', async () => {
  const db = createFakeDb({ gameRows: [{ steam_appid: 42 }], recordRows: [] });
  const ctx = buildCtx({ db, http: httpAllFail('42') });

  const result = await fetchOne(ctx, { data: { gameId: 7, externalId: '42' } });

  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'appdetails-failed-both-locales');
  assert.equal(result.delisted, false);
  assert.equal(db.delistUpdates.length, 0); // one failure is never enough on its own

  const stored = db.getSourceRecord('42');
  assert.equal(stored.status, 'not_found');
  const delistCheck = JSON.parse(stored.payload).delistCheck;
  assert.equal(delistCheck.failCount, 1);
  assert.equal(delistCheck.firstFailedAt, delistCheck.lastFailedAt);
  assert.equal(delistCheck.confirmedAt, undefined);
});

test('fetchOne: a second failed check less than 24h after the first does not confirm delisting', async () => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const db = createFakeDb({
    gameRows: [{ steam_appid: 42 }],
    recordRows: [],
    initialSourceRecords: {
      42: {
        game_id: 7,
        status: 'not_found',
        payload: JSON.stringify({ delistCheck: { firstFailedAt: oneHourAgo, lastFailedAt: oneHourAgo, failCount: 1 } }),
      },
    },
  });
  const ctx = buildCtx({ db, http: httpAllFail('42') });

  const result = await fetchOne(ctx, { data: { gameId: 7, externalId: '42' } });

  assert.equal(result.delisted, false);
  assert.equal(db.delistUpdates.length, 0); // less than DELIST_RECHECK_GAP_MS since the first failure
  const delistCheck = JSON.parse(db.getSourceRecord('42').payload).delistCheck;
  assert.equal(delistCheck.failCount, 2);
  assert.equal(delistCheck.confirmedAt, undefined);
});

test('fetchOne: a second failed check at least 24h after the first confirms delisting', async () => {
  const longAgo = new Date(Date.now() - DELIST_RECHECK_GAP_MS - 60_000).toISOString();
  const db = createFakeDb({
    gameRows: [{ steam_appid: 42 }],
    recordRows: [],
    initialSourceRecords: {
      42: {
        game_id: 7,
        status: 'not_found',
        payload: JSON.stringify({ delistCheck: { firstFailedAt: longAgo, lastFailedAt: longAgo, failCount: 1 } }),
      },
    },
  });
  const ctx = buildCtx({ db, http: httpAllFail('42') });

  const result = await fetchOne(ctx, { data: { gameId: 7, externalId: '42' } });

  assert.equal(result.delisted, true);
  assert.deepEqual(db.delistUpdates, [{ gameId: 7, delisted: 1 }]);
  const delistCheck = JSON.parse(db.getSourceRecord('42').payload).delistCheck;
  assert.equal(delistCheck.failCount, 2);
  assert.ok(delistCheck.confirmedAt);
});

test('fetchOne: a later appdetails success clears a confirmed delisting and the delistCheck state', async () => {
  const db = createFakeDb({
    gameRows: [{ steam_appid: 620 }],
    recordRows: [],
    initialSourceRecords: {
      620: {
        game_id: 7,
        status: 'not_found',
        payload: JSON.stringify({
          delistCheck: {
            firstFailedAt: '2020-01-01T00:00:00.000Z',
            lastFailedAt: '2020-01-02T00:00:00.000Z',
            failCount: 2,
            confirmedAt: '2020-01-02T00:00:00.000Z',
          },
        }),
      },
    },
  });
  const ctx = buildCtx({ db, http: httpForFixture(PORTAL2) });

  const result = await fetchOne(ctx, { data: { gameId: 7, externalId: '620' } });

  assert.equal(result.status, 'ok');
  assert.deepEqual(db.delistUpdates, [{ gameId: 7, delisted: 0 }]);
  const stored = db.getSourceRecord('620');
  assert.equal(stored.status, 'ok');
  assert.equal(JSON.parse(stored.payload).delistCheck, undefined); // full payload replaced, nothing carried over
});

test('fetchOne: en/us failing while ru/ru succeeds is inconclusive - not a failed check, not a clear', async () => {
  const db = createFakeDb({ gameRows: [{ steam_appid: 42 }], recordRows: [] });
  const ctx = buildCtx({ db, http: httpEnFailRuSucceeds('42', { name: 'Some Game', type: 'game' }) });

  const result = await fetchOne(ctx, { data: { gameId: 7, externalId: '42' } });

  assert.equal(result.status, 'inconclusive');
  assert.equal(db.delistUpdates.length, 0);
  assert.equal(db.getSourceRecord('42'), undefined); // no source_records write at all for an inconclusive check
});

// --- extract() --------------------------------------------------------

test('extract: Portal 2 (full example) - every vocabulary branch', () => {
  const out = extract(PORTAL2);

  assert.equal(out.name, 'Portal 2');
  assert.equal(out.descriptionEn, 'The "Perpetual Testing Initiative" has been expanded to allow you to design co-op puzzles for you and your friends!');
  assert.ok(out.image.startsWith('https://'));
  assert.equal(out.steamAppid, 620);
  assert.deepEqual(out.storeRelease, { date: '2011-04-18', precision: 'day' });
  assert.equal(out.earlyAccess, undefined);
  assert.equal(out.isFree, false);

  assert.deepEqual(out.prices.usd, { initial: 999, final: 999, discount: 0 });
  assert.ok(out.prices.rub, 'expected a rub price block from the ru payload');
  assert.equal(out.prices.cisUsd.initial, 629);

  assert.deepEqual(out.platforms, ['WIN', 'LNX']);
  assert.deepEqual(out.developers, ['Valve']);
  assert.deepEqual(out.publishers, ['Valve']);
  assert.deepEqual(out.genres, ['Action', 'Adventure']);
  assert.ok(out.categories.includes('Single-player'));

  assert.equal(out.languages.length, 27);
  assert.deepEqual(out.voiceovers, ['English', 'French', 'German', 'Spanish - Spain', 'Russian']);

  assert.equal(out.achievements, 51);

  assert.deepEqual(out.links, { metacritic: { id: null, url: PORTAL2.en.metacritic.url } });
  assert.equal(out.scoreCritics, 95);
  assert.equal(out.scoreCriticsSource, 'metacritic');

  const { total_positive: pos, total_reviews: total } = PORTAL2.reviews.query_summary;
  assert.equal(out.scoreSteam, Math.round((pos / total) * 100));
  assert.equal(out.scoreSteamVotes, total);
});

test('extract: free game - isFree true, no price blocks even though az came back as []', () => {
  const out = extract(CS2);
  assert.equal(out.isFree, true);
  assert.equal(out.prices, undefined);
  assert.ok(out.genres.includes('Free To Play'));
});

test('extract: coming-soon game - storeRelease is unknown even though the raw date string is not empty', () => {
  const out = extract(DEADLOCK);
  assert.deepEqual(out.storeRelease, { date: null, precision: 'unknown' });
  assert.equal(out.earlyAccess, undefined);
  assert.equal(out.prices, undefined);
});

test('extract: early access game - earlyAccess is set from genre id 70', () => {
  const out = extract(ZOMBOID);
  assert.deepEqual(out.storeRelease, { date: '2013-11-08', precision: 'day' });
  assert.deepEqual(out.earlyAccess, out.storeRelease);
  assert.ok(out.genres.includes('Early Access'));
});

test('extract: returns {} for an empty/missing payload', () => {
  assert.deepEqual(extract(null), {});
  assert.deepEqual(extract({}), {});
});

// --- extract(): steamPurchasable (games.purchasable - migrations/005_purchasable.sql, src/lib/purchasable.js) ---

test('extract: steamPurchasable true for a normally-priced game with non-empty package_groups', () => {
  assert.equal(extract(PORTAL2).steamPurchasable, true);
});

test('extract: steamPurchasable true for a free game (isFree wins outright, no package_groups needed)', () => {
  assert.equal(extract(CS2).steamPurchasable, true);
});

test('extract: steamPurchasable true for a coming-soon game, even with empty package_groups and no price', () => {
  assert.equal(extract(DEADLOCK).steamPurchasable, true);
});

test('extract: steamPurchasable false - appdetails succeeds, not free, no price, empty package_groups, not coming soon (delisted-but-visible)', () => {
  const payload = {
    en: {
      name: 'Singaria - Prologue',
      is_free: false,
      release_date: { coming_soon: false, date: '1 Jan, 2023' },
      package_groups: [],
    },
  };
  assert.equal(extract(payload).steamPurchasable, false);
});

test('extract: steamPurchasable is omitted (undefined), not false, when package_groups is absent entirely (old stored payload)', () => {
  const payload = {
    en: {
      name: 'Some Old Record',
      is_free: false,
      release_date: { coming_soon: false, date: '1 Jan, 2020' },
      // no package_groups key at all - predates this field
    },
  };
  assert.equal(extract(payload).steamPurchasable, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(extract(payload), 'steamPurchasable'));
});

test('extract: steamPurchasable true from price_overview alone, even with empty package_groups', () => {
  const payload = {
    en: {
      name: 'Priced But No Packages (edge case)',
      is_free: false,
      release_date: { coming_soon: false, date: '1 Jan, 2020' },
      price_overview: { initial: 999, final: 999 },
      package_groups: [],
    },
  };
  assert.equal(extract(payload).steamPurchasable, true);
});

// --- extract(): playtimeReviewsMedianMinutes / playtimeReviewsCount (games.time_average) -----------

test('extract: playtimeReviewsMedianMinutes/playtimeReviewsCount/p25/p75 come from payload.reviewsPlaytime', () => {
  const out = extract({
    ...PORTAL2,
    reviewsPlaytime: { count: 42, medianAtReview: 654, p25AtReview: 300, p75AtReview: 900, medianForever: 1200 },
  });
  assert.equal(out.playtimeReviewsMedianMinutes, 654);
  assert.equal(out.playtimeReviewsCount, 42);
  assert.equal(out.playtimeReviewsP25Minutes, 300);
  assert.equal(out.playtimeReviewsP75Minutes, 900);
  // medianForever is not part of the resolver-facing vocabulary.
  assert.equal(out.playtimeReviewsMedianForeverMinutes, undefined);
});

test('extract: playtime fields are omitted when payload.reviewsPlaytime is null', () => {
  const out = extract({ ...PORTAL2, reviewsPlaytime: null });
  assert.equal(out.playtimeReviewsMedianMinutes, undefined);
  assert.equal(out.playtimeReviewsCount, undefined);
});

test('extract: PORTAL2 fixture (recorded with num_per_page=0, no reviewsPlaytime) has no playtime fields', () => {
  const out = extract(PORTAL2);
  assert.equal(out.playtimeReviewsMedianMinutes, undefined);
  assert.equal(out.playtimeReviewsCount, undefined);
});

// --- summarizeReviewPlaytime -----------------------------------------------------------------------

test('summarizeReviewPlaytime: null for empty/missing/non-array input', () => {
  assert.equal(summarizeReviewPlaytime(null), null);
  assert.equal(summarizeReviewPlaytime(undefined), null);
  assert.equal(summarizeReviewPlaytime([]), null);
});

test('summarizeReviewPlaytime: median/quartiles over a simple series (uses playtime_at_review)', () => {
  const reviews = [10, 20, 30, 40, 50].map((m) => ({ author: { playtime_at_review: m, playtime_forever: m } }));
  const result = summarizeReviewPlaytime(reviews);
  assert.equal(result.count, 5);
  assert.equal(result.medianAtReview, 30);
  assert.equal(result.medianForever, 30);
  assert.equal(result.p25AtReview, 20);
  assert.equal(result.p75AtReview, 40);
});

test('summarizeReviewPlaytime: falls back to playtime_forever when playtime_at_review is missing/0', () => {
  const reviews = [
    { author: { playtime_at_review: 0, playtime_forever: 500 } },
    { author: { playtime_forever: 700 } }, // playtime_at_review entirely absent
    { author: { playtime_at_review: 300, playtime_forever: 900 } },
  ];
  const result = summarizeReviewPlaytime(reviews);
  assert.equal(result.count, 3);
  // at-review series: [500 (fallback), 700 (fallback), 300] -> sorted [300, 500, 700] -> median 500
  assert.equal(result.medianAtReview, 500);
  // forever series (only reviews with a real nonzero playtime_forever): [500, 700, 900] -> median 700
  assert.equal(result.medianForever, 700);
});

test('summarizeReviewPlaytime: a review with 0 minutes on both fields is ignored outright', () => {
  const reviews = [
    { author: { playtime_at_review: 0, playtime_forever: 0 } },
    { author: { playtime_at_review: 100, playtime_forever: 100 } },
    { author: { playtime_at_review: 200, playtime_forever: 200 } },
  ];
  const result = summarizeReviewPlaytime(reviews);
  assert.equal(result.count, 2); // the all-zero review does not count at all
  assert.equal(result.medianAtReview, 150);
});

test('summarizeReviewPlaytime: real fixture (Portal 2, 100 helpfulness-ranked reviews)', () => {
  const result = summarizeReviewPlaytime(REVIEWS_620_PAGE.reviews);
  assert.equal(result.count, 100); // this recorded page had no zero-minute reviews at all
  assert.ok(result.medianAtReview > 0);
  assert.ok(result.p25AtReview <= result.medianAtReview);
  assert.ok(result.medianAtReview <= result.p75AtReview);
  assert.ok(result.medianForever >= result.medianAtReview, 'lifetime playtime should be >= at-review playtime, typically');
});

// --- reduceReviewsResponse ---------------------------------------------------------------------------

test('reduceReviewsResponse: keeps success/query_summary, drops reviews[]/cursor', () => {
  const reduced = reduceReviewsResponse(REVIEWS_620_PAGE);
  assert.deepEqual(reduced, { success: REVIEWS_620_PAGE.success, query_summary: REVIEWS_620_PAGE.query_summary });
});

test('reduceReviewsResponse: passes through null/non-object unchanged', () => {
  assert.equal(reduceReviewsResponse(null), null);
  assert.equal(reduceReviewsResponse(undefined), undefined);
});

// --- extract(): scoreSteamRecent / scoreSteamRecentVotes -----------------------------------------

test('extract: scoreSteamRecent/scoreSteamRecentVotes come from payload.recentReviews, separately from the all-time score', () => {
  const out = extract({ ...PORTAL2, recentReviews: { positive: 90, negative: 10 } });
  assert.equal(out.scoreSteamRecent, 90);
  assert.equal(out.scoreSteamRecentVotes, 100);
  // The all-time score is untouched and comes from a different field (query_summary), confirming the
  // two are independent.
  const { total_positive: pos, total_reviews: total } = PORTAL2.reviews.query_summary;
  assert.equal(out.scoreSteam, Math.round((pos / total) * 100));
});

test('extract: scoreSteamRecent is omitted (not 0/NaN) when payload.recentReviews is null', () => {
  const out = extract({ ...PORTAL2, recentReviews: null });
  assert.equal(out.scoreSteamRecent, undefined);
  assert.equal(out.scoreSteamRecentVotes, undefined);
});

test('extract: PORTAL2 fixture (recorded before recentReviews existed) has no scoreSteamRecent either', () => {
  const out = extract(PORTAL2);
  assert.equal(out.scoreSteamRecent, undefined);
  assert.equal(out.scoreSteamRecentVotes, undefined);
});

// --- sumRecentHistogram --------------------------------------------------------------------------

test('sumRecentHistogram: sums recommendations_up/down across every bucket', () => {
  assert.deepEqual(
    sumRecentHistogram([
      { recommendations_up: 10, recommendations_down: 2 },
      { recommendations_up: 5, recommendations_down: 0 },
    ]),
    { positive: 15, negative: 2 }
  );
});

test('sumRecentHistogram: real fixture - Portal 2 (busy game, ~98% recent positive)', () => {
  const result = sumRecentHistogram(HISTOGRAM_620.results.recent);
  assert.equal(HISTOGRAM_620.results.recent.length, 30);
  assert.ok(result.positive > 0);
  const total = result.positive + result.negative;
  assert.ok(result.positive / total > 0.9, 'Portal 2 should be overwhelmingly positive recently');
});

test('sumRecentHistogram: real fixture - a low-volume game still sums correctly', () => {
  const result = sumRecentHistogram(HISTOGRAM_SMALL.results.recent);
  assert.ok(result.positive + result.negative > 0);
  assert.ok(result.positive + result.negative < 100); // low-volume, per the fixture name
});

test('sumRecentHistogram: real fixture - an unreleased game with zero recent reviews is null', () => {
  assert.equal(HISTOGRAM_EMPTY.results.recent.length, 0);
  assert.equal(sumRecentHistogram(HISTOGRAM_EMPTY.results.recent), null);
});

test('sumRecentHistogram: null/empty/non-array input is null', () => {
  assert.equal(sumRecentHistogram(null), null);
  assert.equal(sumRecentHistogram(undefined), null);
  assert.equal(sumRecentHistogram([]), null);
});

test('sumRecentHistogram: all-zero buckets sum to null (nothing to report)', () => {
  assert.equal(sumRecentHistogram([{ recommendations_up: 0, recommendations_down: 0 }]), null);
});

test('extract: tolerates a non-game (DLC) payload without throwing', () => {
  assert.doesNotThrow(() => extract(CITIES_DLC));
});

// --- pure helpers -------------------------------------------------------

test('htmlToText: strips tags, decodes entities, collapses blank lines', () => {
  assert.equal(htmlToText('<p>Hello &amp; welcome</p><br><br>Second line'), 'Hello & welcome\n\nSecond line');
  assert.equal(htmlToText(''), undefined);
  assert.equal(htmlToText(undefined), undefined);
});

test('parseLanguages: marks only languages with a full-audio asterisk, drops the legend line', () => {
  const raw = 'English<strong>*</strong>, French, German<strong>*</strong><br><strong>*</strong>languages with full audio support';
  const { languages, voiceovers } = parseLanguages(raw);
  assert.deepEqual(languages, ['English', 'French', 'German']);
  assert.deepEqual(voiceovers, ['English', 'German']);
});

test('parseLanguages: empty input yields empty arrays', () => {
  assert.deepEqual(parseLanguages(''), { languages: [], voiceovers: [] });
  assert.deepEqual(parseLanguages(undefined), { languages: [], voiceovers: [] });
});

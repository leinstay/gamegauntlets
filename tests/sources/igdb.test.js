// tests/sources/igdb.test.js
//
// Fixtures under tests/fixtures/igdb/ were recorded live against
// api.igdb.com on 2026-09-19 (see the task report for the request/response
// transcript and the measured discover() size: 175,824 Steam-linked +
// 9,344 GOG-linked external_games rows). external-games-page*.json are
// small hand-shaped pages (real id/uid/game shape, arranged to exercise
// discover()'s matching/staleness/pagination logic) rather than a raw
// recording, since a real page is 500 rows.
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
  buildTokenUrl,
  getAccessToken,
  clearTokenCacheForTests,
  mapExternalGameSource,
  mapWebsiteKind,
  buildExternalGamesQuery,
  walkExternalGames,
  buildGamesQuery,
  buildTimeToBeatQuery,
} from '../../src/sources/igdb.js';
import { createContext } from '../../src/pipeline/context.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'igdb');

function loadFixture(file) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
}

const HALF_LIFE = loadFixture('game-half-life.json')[0];
const HALF_LIFE_TTB = loadFixture('ttb-half-life.json')[0];
const WITCHER3 = loadFixture('game-witcher3.json')[0];
const WITCHER3_TTB = loadFixture('ttb-witcher3.json')[0];
const GOG_EXCLUSIVE = loadFixture('game-gog-exclusive.json')[0];
const GOG_EXCLUSIVE_TTB = loadFixture('ttb-gog-exclusive.json')[0] ?? null;
const NORATING = loadFixture('game-norating.json')[0];
const NORATING_TTB = loadFixture('ttb-norating.json')[0] ?? null;
const EXTERNAL_GAMES_PAGE1 = loadFixture('external-games-page1.json');
const EXTERNAL_GAMES_PAGE2 = loadFixture('external-games-page2.json');

// --- module shape -----------------------------------------------------

test('module: exports name/rateLimit matching the source module interface', () => {
  assert.equal(sourceName, 'igdb');
  assert.equal(rateLimit.max, 4);
  assert.equal(rateLimit.duration, 1000);
});

// --- buildTokenUrl / getAccessToken --------------------------------------

test('buildTokenUrl: sets client_id/client_secret/grant_type', () => {
  const url = new URL(buildTokenUrl('CID', 'CSECRET'));
  assert.equal(url.origin + url.pathname, 'https://id.twitch.tv/oauth2/token');
  assert.equal(url.searchParams.get('client_id'), 'CID');
  assert.equal(url.searchParams.get('client_secret'), 'CSECRET');
  assert.equal(url.searchParams.get('grant_type'), 'client_credentials');
});

test('getAccessToken: fetches once and caches until near expiry, keyed per ctx.env', async () => {
  let calls = 0;
  const env = { IGDB_CLIENT_ID: 'cid', IGDB_CLIENT_SECRET: 'csecret' };
  const http = {
    postText: async () => {
      calls += 1;
      return { access_token: 'tok-1', expires_in: 3600 * 24 };
    },
  };
  let now = 1_000_000;
  const ctx = { env, http };

  const t1 = await getAccessToken(ctx, { now: () => now });
  assert.equal(t1, 'tok-1');
  assert.equal(calls, 1);

  now += 1000; // a bit later, still far from expiry
  const t2 = await getAccessToken(ctx, { now: () => now });
  assert.equal(t2, 'tok-1');
  assert.equal(calls, 1, 'expected the cached token to be reused');

  // Jump to within the 1h refresh buffer of expiry -> must refetch.
  now += 3600 * 24 * 1000 - 60_000;
  const t3 = await getAccessToken(ctx, { now: () => now });
  assert.equal(calls, 2);
  assert.equal(t3, 'tok-1');

  clearTokenCacheForTests(env);
});

test('getAccessToken: throws when IGDB_CLIENT_ID/SECRET are missing, without calling http', async () => {
  let called = false;
  const ctx = { env: {}, http: { postText: async () => { called = true; return {}; } } };
  await assert.rejects(() => getAccessToken(ctx), /IGDB_CLIENT_ID/);
  assert.equal(called, false);
});

test('getAccessToken: throws when the token response has no access_token', async () => {
  const env = { IGDB_CLIENT_ID: 'a', IGDB_CLIENT_SECRET: 'b' };
  const ctx = { env, http: { postText: async () => ({ status: 400 }) } };
  await assert.rejects(() => getAccessToken(ctx), /Twitch token exchange failed/);
  clearTokenCacheForTests(env);
});

// --- mapExternalGameSource / mapWebsiteKind ------------------------------

test('mapExternalGameSource: reads external_game_source (current) or category (deprecated), either order', () => {
  assert.equal(mapExternalGameSource({ external_game_source: 1 }), 'steam');
  assert.equal(mapExternalGameSource({ category: 1 }), 'steam');
  assert.equal(mapExternalGameSource({ external_game_source: 5 }), 'gog');
  assert.equal(mapExternalGameSource({ category: 5 }), 'gog');
  assert.equal(mapExternalGameSource({ category: 1, external_game_source: 1 }), 'steam');
  assert.equal(mapExternalGameSource({ external_game_source: 14 }), null); // twitch, not steam/gog
  assert.equal(mapExternalGameSource({}), null);
});

test('mapWebsiteKind: reads type (current) or category (deprecated)', () => {
  assert.equal(mapWebsiteKind({ type: 1 }), 'official');
  assert.equal(mapWebsiteKind({ category: 3 }), 'wikipedia');
  assert.equal(mapWebsiteKind({ type: 13 }), 'steam');
  assert.equal(mapWebsiteKind({ type: 17 }), 'gog');
  assert.equal(mapWebsiteKind({ type: 6 }), null); // twitch, not one we use
  assert.equal(mapWebsiteKind({}), null);
});

// --- buildExternalGamesQuery / walkExternalGames -------------------------

test('buildExternalGamesQuery: no cursor clause when cursor is 0', () => {
  const q = buildExternalGamesQuery(0, 500);
  assert.match(q, /where \(category = \(1,5\) \| external_game_source = \(1,5\)\); sort id asc; limit 500;$/);
  assert.doesNotMatch(q, /id >/);
});

test('buildExternalGamesQuery: includes an id > cursor clause when given', () => {
  const q = buildExternalGamesQuery(1113, 500);
  assert.match(q, /& id > 1113;/);
});

test('walkExternalGames: pages until a short page, following the last row id', async () => {
  const requested = [];
  const pages = [EXTERNAL_GAMES_PAGE1, EXTERNAL_GAMES_PAGE2];
  let call = 0;
  const getPage = async (lastId) => {
    requested.push(lastId);
    return pages[call++];
  };
  const yielded = [];
  for await (const rows of walkExternalGames(getPage, { pageLimit: 5 })) yielded.push(rows);
  assert.deepEqual(requested, [0, 14]); // 2nd request resumes from page1's last row id
  assert.equal(yielded.length, 2);
  assert.equal(yielded[1].length, 1); // page2 shorter than pageLimit -> stop
});

test('walkExternalGames: stops immediately on an empty page', async () => {
  const getPage = async () => [];
  const yielded = [];
  for await (const rows of walkExternalGames(getPage)) yielded.push(rows);
  assert.equal(yielded.length, 0);
});

// --- buildGamesQuery / buildTimeToBeatQuery ------------------------------

test('buildGamesQuery: sets a where id = (...) list and a limit covering every id', () => {
  const q = buildGamesQuery(['231', '1942']);
  assert.match(q, /where id = \(231,1942\); limit 2;$/);
  assert.match(q, /fields .*name.*first_release_date.*external_games\.external_game_source;/);
});

test('buildTimeToBeatQuery: sets a where game_id = (...) list and a limit covering every id', () => {
  const q = buildTimeToBeatQuery(['231']);
  assert.equal(q, 'fields game_id,hastily,normally,completely,count; where game_id = (231); limit 1;');
});

// --- discover() -----------------------------------------------------------

function createFakeDb({ steamGames = [], gogGames = [], recordRows = [], gameLinkRows = [], initialSourceState = null } = {}) {
  const calls = [];
  const linkUpserts = [];
  const recordUpserts = [];
  let sourceState = initialSourceState;
  const gameLinks = new Map(gameLinkRows.map((r) => [`${r.game_id}:${r.source}`, r]));

  return {
    calls,
    linkUpserts,
    recordUpserts,
    getSourceState: () => sourceState,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/INSERT INTO source_state \(source\) VALUES/i.test(sql)) {
        if (!sourceState) sourceState = { cursor_state: null, paused: 0 };
        return { affectedRows: 1 };
      }
      if (/SELECT id, steam_appid FROM games/i.test(sql)) return steamGames;
      if (/SELECT id, gog_id FROM games/i.test(sql)) return gogGames;
      if (/SELECT external_id, UNIX_TIMESTAMP\(fetched_at\) AS fetchedAt FROM source_records/i.test(sql)) return recordRows;
      if (/SELECT external_id, game_id FROM game_links WHERE source = \? AND external_id IN/i.test(sql)) {
        const [src, ids] = params;
        return [...gameLinks.values()].filter((r) => r.source === src && ids.map(String).includes(String(r.external_id)));
      }
      if (/UPDATE source_state SET cursor_state/i.test(sql)) {
        const [cursorJson] = params;
        sourceState = { ...(sourceState || {}), cursor_state: cursorJson };
        return { affectedRows: 1 };
      }
      if (/UPDATE source_state SET last_full_pass_at/i.test(sql)) {
        const [statsJson] = params;
        sourceState = { ...(sourceState || {}), stats: statsJson, last_full_pass_at: 'NOW', last_error: null };
        return { affectedRows: 1 };
      }
      if (/UPDATE source_state SET last_error/i.test(sql)) {
        const [message] = params;
        sourceState = { ...(sourceState || {}), last_error: message };
        return { affectedRows: 1 };
      }
      if (/INSERT INTO game_links/i.test(sql)) {
        linkUpserts.push(params);
        gameLinks.set(`${params[0]}:${params[1]}`, { game_id: params[0], source: params[1], external_id: params[2], match_method: params[4], confidence: params[5] });
        return { affectedRows: 1 };
      }
      if (/INSERT INTO source_records/i.test(sql)) {
        recordUpserts.push(params);
        return { affectedRows: 1 };
      }
      return [];
    },
    one: async (sql, params = []) => {
      calls.push({ sql, params, one: true });
      if (/SELECT cursor_state, paused FROM source_state/i.test(sql)) return sourceState;
      if (/SELECT match_method, confidence FROM game_links WHERE game_id = \? AND source = \?/i.test(sql)) {
        return gameLinks.get(`${params[0]}:${params[1]}`) ?? null;
      }
      return null;
    },
  };
}

function fakeEnqueueTracker() {
  const calls = [];
  return { calls, enqueue: async (src, data) => calls.push({ source: src, data }) };
}

function buildCtx({ db, http, enqueue, enqueueResolve, config, env }) {
  return createContext({
    db,
    http,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    env: env ?? { IGDB_CLIENT_ID: 'cid', IGDB_CLIENT_SECRET: 'csecret' },
    config: config ?? { sources: { igdb: {} } },
    enqueue: enqueue ?? (async () => {}),
    enqueueResolve: enqueueResolve ?? (async () => {}),
  });
}

function httpForDiscoverPages(pages) {
  const calls = [];
  let call = 0;
  return {
    calls,
    http: {
      postText: async (url, body) => {
        calls.push({ url, body });
        if (url.includes('oauth2/token')) return { access_token: 'tok', expires_in: 999999 };
        return pages[call++] ?? [];
      },
    },
  };
}

test('discover: matches Steam/GOG rows to existing games, upserts igdb links, enqueues fetch for unseen games', async () => {
  const db = createFakeDb({
    steamGames: [
      { id: 1000, steam_appid: 620 }, // matched via deprecated `category` field (page1 row id 14)
      { id: 1001, steam_appid: 730 }, // matched on page2
    ],
    gogGames: [{ id: 1002, gog_id: 1207664483 }], // 1849 Gold Edition
    recordRows: [],
  });
  const { http, calls: httpCalls } = httpForDiscoverPages([EXTERNAL_GAMES_PAGE1, EXTERNAL_GAMES_PAGE2]);
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  // discoverPageLimit matches the fixture's page size (5 rows) so a full
  // (500-row) page isn't required to continue paging in this test.
  const ctx = buildCtx({ db, http, enqueue, config: { sources: { igdb: { discoverPageLimit: 5 } } } });

  const result = await discover(ctx);

  assert.equal(result.pages, 2);
  assert.equal(result.seen, 6);
  assert.equal(result.matched, 3); // appid 620 (via category), gog 1207664483, appid 730 — appid 292030/9999999/(1942) have no matching games row
  assert.equal(result.linked, 3);
  assert.equal(result.enqueued, 3);

  assert.deepEqual(
    enqueued.map((c) => c.data).sort((a, b) => a.gameId - b.gameId),
    [
      { gameId: 1000, externalId: '620' },
      { gameId: 1001, externalId: '730' },
      { gameId: 1002, externalId: '21656' },
    ],
  );

  // Every igdb link was written with method 'igdb', confidence 95, url null (discover doesn't know the slug yet).
  for (const params of db.linkUpserts) {
    assert.equal(params[1], 'igdb');
    assert.equal(params[4], 'igdb');
    assert.equal(params[5], 95);
    assert.equal(params[3], null);
  }

  // Cursor persisted at the last row's id (page2's only row, id 15).
  assert.deepEqual(JSON.parse(db.getSourceState().cursor_state), { lastId: 15 });

  // The 2nd external_games request resumed from page1's last id (14), per the id-cursor.
  const externalGamesCalls = httpCalls.filter((c) => c.url.includes('/external_games'));
  assert.equal(externalGamesCalls.length, 2);
  assert.doesNotMatch(externalGamesCalls[0].body, /id >/);
  assert.match(externalGamesCalls[1].body, /id > 14;/);
});

test('discover: does not re-enqueue a game whose igdb record is fresher than refreshDays', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const db = createFakeDb({
    steamGames: [{ id: 1000, steam_appid: 620 }, { id: 1001, steam_appid: 730 }],
    gogGames: [{ id: 1002, gog_id: 1207664483 }],
    recordRows: [
      { external_id: '620', fetchedAt: nowSec }, // fresh
      { external_id: '21656', fetchedAt: nowSec - 40 * 24 * 60 * 60 }, // stale (> 30 days)
    ],
  });
  const { http } = httpForDiscoverPages([EXTERNAL_GAMES_PAGE1, EXTERNAL_GAMES_PAGE2]);
  const { calls: enqueued, enqueue } = fakeEnqueueTracker();
  const ctx = buildCtx({ db, http, enqueue, config: { sources: { igdb: { refreshDays: 30, discoverPageLimit: 5 } } } });

  await discover(ctx);

  const enqueuedIds = enqueued.map((c) => c.data.externalId).sort();
  assert.deepEqual(enqueuedIds, ['21656', '730']); // 620 skipped (fresh), 730 enqueued (never fetched), 21656 enqueued (stale)
});

test('discover: skips an unmatched appid (no games row) without erroring', async () => {
  const db = createFakeDb({ steamGames: [], gogGames: [], recordRows: [] });
  const { http } = httpForDiscoverPages([EXTERNAL_GAMES_PAGE1, EXTERNAL_GAMES_PAGE2]);
  const result = await discover(buildCtx({ db, http, config: { sources: { igdb: { discoverPageLimit: 5 } } } }));
  assert.equal(result.seen, 6);
  assert.equal(result.matched, 0);
  assert.equal(result.enqueued, 0);
});

test('discover: never overwrites a manually-overridden igdb link', async () => {
  const db = createFakeDb({
    steamGames: [{ id: 1000, steam_appid: 620 }],
    gogGames: [],
    recordRows: [],
    gameLinkRows: [{ game_id: 1000, source: 'igdb', external_id: '999', match_method: 'manual', confidence: 100 }],
  });
  const { http } = httpForDiscoverPages([[{ id: 14, uid: '620', category: 1, game: 620 }]]);
  const result = await discover(buildCtx({ db, http }));
  assert.equal(result.linked, 0); // matched, but the manual override was preserved
  assert.equal(db.linkUpserts.length, 0);
});

test('discover: returns early without calling http when credentials are missing', async () => {
  const db = createFakeDb();
  let httpCalled = false;
  const ctx = createContext({
    db,
    http: { postText: async () => { httpCalled = true; return {}; } },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    env: {},
    config: { sources: { igdb: {} } },
    enqueue: async () => {},
    enqueueResolve: async () => {},
  });
  const result = await discover(ctx);
  assert.equal(httpCalled, false);
  assert.equal(result.pages, 0);
});

test('discover: skipped when disabled in config, and when paused in source_state', async () => {
  const db1 = createFakeDb();
  const disabledResult = await discover(buildCtx({ db: db1, http: { postText: async () => ({}) }, config: { sources: { igdb: { enabled: false } } } }));
  assert.deepEqual(disabledResult, { skipped: true });

  const db2 = createFakeDb({ initialSourceState: { cursor_state: null, paused: 1 } });
  const pausedResult = await discover(buildCtx({ db: db2, http: { postText: async () => ({}) } }));
  assert.deepEqual(pausedResult, { skipped: true });
});

test('discover: resumes from a persisted cursor', async () => {
  const db = createFakeDb({
    steamGames: [{ id: 1001, steam_appid: 730 }],
    gogGames: [],
    recordRows: [],
    initialSourceState: { cursor_state: JSON.stringify({ lastId: 14 }), paused: 0 },
  });
  const { http, calls: httpCalls } = httpForDiscoverPages([EXTERNAL_GAMES_PAGE2]);
  await discover(buildCtx({ db, http }));
  const externalGamesCalls = httpCalls.filter((c) => c.url.includes('/external_games'));
  assert.equal(externalGamesCalls.length, 1);
  assert.match(externalGamesCalls[0].body, /id > 14;/);
});

// --- fetchOne() -------------------------------------------------------

function httpForGamesAndTtb({ games = [], ttb = [] } = {}) {
  return {
    postText: async (url) => {
      if (url.includes('oauth2/token')) return { access_token: 'tok', expires_in: 999999 };
      if (url.includes('/game_time_to_beats')) return ttb;
      if (url.includes('/games')) return games;
      throw new Error(`unexpected url ${url}`);
    },
  };
}

test('fetchOne: single id with gameId given - upserts record + link (url from game.url), enqueues resolve', async () => {
  const db = createFakeDb();
  const enqueueResolveCalls = [];
  const ctx = buildCtx({
    db,
    http: httpForGamesAndTtb({ games: [HALF_LIFE], ttb: [HALF_LIFE_TTB] }),
    enqueueResolve: async (gameId) => enqueueResolveCalls.push(gameId),
  });

  const result = await fetchOne(ctx, { data: { gameId: 42, externalId: '231' } });

  assert.equal(result.status, 'ok');
  assert.equal(result.externalId, '231');
  assert.deepEqual(result.payload.game, HALF_LIFE);
  assert.deepEqual(result.payload.timeToBeat, HALF_LIFE_TTB);

  const recordUpsert = db.calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  assert.equal(recordUpsert.params[0], 'igdb');
  assert.equal(recordUpsert.params[1], '231');
  assert.equal(recordUpsert.params[3], 'ok');

  const linkUpsert = db.calls.find((c) => /INSERT INTO game_links/i.test(c.sql));
  assert.deepEqual(linkUpsert.params.slice(0, 4), [42, 'igdb', '231', 'https://www.igdb.com/games/half-life']);

  assert.deepEqual(enqueueResolveCalls, [42]);
});

test('fetchOne: single id without gameId resolves it via game_links (already linked by discover)', async () => {
  const db = createFakeDb({ gameLinkRows: [{ game_id: 77, source: 'igdb', external_id: '231', match_method: 'igdb', confidence: 95 }] });
  const ctx = buildCtx({ db, http: httpForGamesAndTtb({ games: [HALF_LIFE], ttb: [HALF_LIFE_TTB] }) });
  const result = await fetchOne(ctx, { data: { externalId: '231' } });
  assert.equal(result.status, 'ok');
  const linkUpsert = db.calls.find((c) => /INSERT INTO game_links/i.test(c.sql));
  assert.equal(linkUpsert.params[0], 77);
});

test('fetchOne: batch mode (igdbIds) fetches every id in one pair of requests and returns per-id results', async () => {
  const db = createFakeDb({
    gameLinkRows: [
      { game_id: 1, source: 'igdb', external_id: '231', match_method: 'igdb', confidence: 95 },
      { game_id: 2, source: 'igdb', external_id: '1942', match_method: 'igdb', confidence: 95 },
    ],
  });
  let gamesCallCount = 0;
  let ttbCallCount = 0;
  const http = {
    postText: async (url, body) => {
      if (url.includes('oauth2/token')) return { access_token: 'tok', expires_in: 999999 };
      if (url.includes('/game_time_to_beats')) {
        ttbCallCount += 1;
        assert.match(body, /game_id = \(231,1942\)/);
        return [HALF_LIFE_TTB, WITCHER3_TTB];
      }
      gamesCallCount += 1;
      assert.match(body, /where id = \(231,1942\)/);
      return [HALF_LIFE, WITCHER3];
    },
  };
  const ctx = buildCtx({ db, http });

  const result = await fetchOne(ctx, { data: { igdbIds: [231, 1942] } });

  assert.equal(gamesCallCount, 1);
  assert.equal(ttbCallCount, 1);
  assert.equal(result.status, 'ok');
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.map((r) => r.externalId), ['231', '1942']);
  assert.ok(result.results.every((r) => r.status === 'ok'));
});

test('fetchOne: an id absent from the games response is recorded not_found', async () => {
  const db = createFakeDb();
  const ctx = buildCtx({ db, http: httpForGamesAndTtb({ games: [], ttb: [] }) });
  const result = await fetchOne(ctx, { data: { gameId: 1, externalId: '999999999' } });
  assert.equal(result.status, 'not_found');
  const recordUpsert = db.calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  assert.equal(recordUpsert.params[3], 'not_found');
  assert.equal(db.calls.some((c) => /INSERT INTO game_links/i.test(c.sql)), false);
});

test('fetchOne: a network/HTTP failure records status error for every id and rethrows for BullMQ to retry', async () => {
  const db = createFakeDb();
  const http = {
    postText: async (url) => {
      if (url.includes('oauth2/token')) return { access_token: 'tok', expires_in: 999999 };
      throw new Error('boom');
    },
  };
  const ctx = buildCtx({ db, http });
  await assert.rejects(() => fetchOne(ctx, { data: { gameId: 1, externalId: '231' } }), /boom/);
  const recordUpsert = db.calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  assert.equal(recordUpsert.params[3], 'error');
});

test('fetchOne: throws when neither externalId nor igdbIds is given', async () => {
  const ctx = buildCtx({ db: createFakeDb(), http: httpForGamesAndTtb() });
  await assert.rejects(() => fetchOne(ctx, { data: {} }), /externalId|igdbIds/);
});

// --- extract() --------------------------------------------------------

test('extract: Half-Life - full vocabulary (single developer+publisher overlap, day-precision release)', () => {
  const out = extract({ game: HALF_LIFE, timeToBeat: HALF_LIFE_TTB });
  assert.equal(out.name, 'Half-Life');
  assert.deepEqual(out.release, { date: '1998-11-19', precision: 'day' });
  assert.equal(out.scoreIgdb, 80);
  assert.equal(out.scoreIgdbUsers, 88);
  assert.equal(out.timeMain, 12);
  assert.equal(out.timeComplete, 18.7);
  assert.deepEqual(out.genres, ['Shooter', 'Puzzle', 'Adventure']);
  assert.deepEqual(out.developers, ['Valve']);
  assert.deepEqual(out.publishers, ['Valve', 'Sierra Entertainment']);
  assert.deepEqual(out.links.steam, { id: '70', url: 'https://store.steampowered.com/app/70' });
  assert.equal(out.links.official.url, 'https://www.half-life.com/en/halflife');
  assert.equal(out.links.wikipedia.url, 'https://en.wikipedia.org/wiki/Half-Life_(video_game)');
  assert.equal(out.links.gog, undefined);
});

test('extract: Witcher 3 - multiple companies, steam+gog links (gog url filled from websites)', () => {
  const out = extract({ game: WITCHER3, timeToBeat: WITCHER3_TTB });
  assert.equal(out.scoreIgdb, 92);
  assert.equal(out.scoreIgdbUsers, 94);
  assert.equal(out.timeMain, 70.8);
  assert.equal(out.timeComplete, 161.5);
  assert.deepEqual(out.developers, ['CD Projekt RED']);
  assert.deepEqual(out.publishers, ['WB Games', 'cdp.pl', 'Spike Chunsoft', 'Bandai Namco Entertainment']);
  assert.deepEqual(out.links.steam, { id: '292030', url: 'https://store.steampowered.com/app/292030' });
  assert.equal(out.links.gog.id, '1207664643');
  assert.equal(out.links.gog.url, 'https://www.gog.com/game/the_witcher_3_wild_hunt');
  assert.equal(out.links.wikipedia.url, 'https://en.wikipedia.org/wiki/The_Witcher_3:_Wild_Hunt');
});

test('extract: GOG-exclusive (1849: Gold Edition) - gog link, no steam link, no ttb, no user score', () => {
  const out = extract({ game: GOG_EXCLUSIVE, timeToBeat: GOG_EXCLUSIVE_TTB });
  assert.equal(out.scoreIgdb, 62);
  assert.equal(out.scoreIgdbUsers, undefined);
  assert.equal(out.timeMain, undefined);
  assert.equal(out.timeComplete, undefined);
  assert.deepEqual(out.developers, ['SomaSim']);
  assert.deepEqual(out.publishers, ['SomaSim']);
  assert.equal(out.links.gog.id, '1207664483');
  assert.equal(out.links.gog.url, 'https://www.gog.com/game/1849_the_gold_rush');
  assert.equal(out.links.steam, undefined); // no Steam entry in external_games, even though a Steam website exists
});

test('extract: no-rating game (Nomu) - no scores, no ttb, no companies, still gets a steam link', () => {
  const out = extract({ game: NORATING, timeToBeat: NORATING_TTB });
  assert.equal(out.scoreIgdb, undefined);
  assert.equal(out.scoreIgdbUsers, undefined);
  assert.equal(out.timeMain, undefined);
  assert.equal(out.timeComplete, undefined);
  assert.equal(out.developers, undefined);
  assert.equal(out.publishers, undefined);
  assert.deepEqual(out.genres, ['Adventure']);
  assert.deepEqual(out.links.steam, { id: '2931370', url: 'https://store.steampowered.com/app/2931370' });
  assert.deepEqual(out.release, { date: '2025-07-31', precision: 'day' });
});

test('extract: returns {} for an empty/missing payload', () => {
  assert.deepEqual(extract(null), {});
  assert.deepEqual(extract({}), {});
  assert.deepEqual(extract({ game: null }), {});
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTestApp, establishSession, testEnv } from './helpers.js';

function gameRow(id, overrides = {}) {
  return {
    id,
    name: `Game ${id}`,
    image: null,
    description_en: 'desc',
    description_ru: null,
    release_date: '2020-01-01',
    release_precision: 'day',
    gg_score: 80,
    score_steam: null,
    score_critics: null,
    score_critics_source: null,
    score_igdb: null,
    score_gamefaqs: null,
    final_time: 10,
    time_complete: null,
    difficulty: null,
    ggp: 50,
    price_usd: 999,
    price_final_usd: 999,
    discount_usd: 0,
    price_rub: null,
    price_final_rub: null,
    discount_rub: null,
    price_cis_usd: null,
    price_final_cis_usd: null,
    discount_cis_usd: null,
    platforms: 'WIN',
    genres: '|Action|',
    tags: null,
    steam_appid: 100 + id,
    ...overrides,
  };
}

/** Builds a fake db that serves a fixed pool of matching ids for the filter query, full rows for
 * `SELECT * FROM games WHERE id IN`, empty links, and records every INSERT into roll_log. */
function makeWheelDb({ ids = [1, 2, 3], rows, inserts = [] } = {}) {
  const rowMap = new Map((rows || ids.map((id) => gameRow(id))).map((r) => [r.id, r]));
  return {
    query: async (sql, params) => {
      if (/^SELECT games\.id FROM games/.test(sql)) return ids.map((id) => ({ id }));
      if (/^SELECT \* FROM games WHERE id IN/.test(sql)) return params.map((id) => rowMap.get(id)).filter(Boolean);
      if (/FROM game_links/.test(sql)) return [];
      if (/^INSERT INTO roll_log/.test(sql)) {
        inserts.push(params);
        return { insertId: inserts.length };
      }
      if (/^SELECT id, name FROM games WHERE id IN/.test(sql)) {
        return params.map((id) => ({ id, name: rowMap.get(id)?.name })).filter((r) => r.name);
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    one: async (sql, params) => {
      if (/^SELECT COUNT\(\*\) AS c FROM roll_log/.test(sql)) {
        return { c: inserts.filter((i) => i[0] === 'list' && i[3] === params?.[0]).length };
      }
      if (/^SELECT MIN\(id\) AS lo, MAX\(id\) AS hi/.test(sql)) {
        return ids.length ? { lo: Math.min(...ids), hi: Math.max(...ids) } : { lo: null, hi: null };
      }
      if (/^SELECT \* FROM games WHERE id >=/.test(sql)) {
        const [from] = params;
        const id = ids.find((i) => i >= from) ?? ids[0];
        return id != null ? rowMap.get(id) : null;
      }
      if (/^SELECT \* FROM games WHERE steam_delisted = 0 AND non_game IS NULL AND purchasable = 1.*ORDER BY id ASC LIMIT 1/.test(sql)) {
        return ids.length ? rowMap.get(Math.min(...ids)) : null;
      }
      return null;
    },
  };
}

async function postJson(app, url, body, session) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      cookie: session.cookieHeader,
      origin: 'https://gamegauntlets.com',
      'x-csrf-token': session.csrf,
      'content-type': 'application/json',
    },
    payload: body,
  });
}

test('POST /api/wheel: happy path returns `segments` GameCards built from the matching ids', async () => {
  const db = makeWheelDb({ ids: [1, 2, 3] });
  const app = buildTestApp({ db });
  const session = await establishSession(app);

  const res = await postJson(app, '/api/wheel', { segments: 3, filters: { allowEmpty: true } }, session);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.games.length, 3);
  for (const game of body.games) {
    assert.equal(typeof game.id, 'number');
    assert.equal(typeof game.name, 'string');
    assert.ok('price' in game && 'release' in game && 'links' in game);
  }
});

test('POST /api/wheel: fewer matches than segments pads by repeating, still returns exactly `segments` cards', async () => {
  const db = makeWheelDb({ ids: [1] });
  const app = buildTestApp({ db });
  const session = await establishSession(app);

  const res = await postJson(app, '/api/wheel', { segments: 5, filters: { allowEmpty: true } }, session);
  const body = JSON.parse(res.body);
  assert.equal(body.games.length, 5);
  assert.ok(body.games.every((g) => g.id === 1));
});

test('POST /api/wheel: no matching games returns {error: "empty"}', async () => {
  const db = makeWheelDb({ ids: [] });
  const app = buildTestApp({ db });
  const session = await establishSession(app);

  const res = await postJson(app, '/api/wheel', { segments: 6, filters: { allowEmpty: true } }, session);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { error: 'empty' });
});

test('POST /api/wheel: logs one roll_log row per roll, source "web" by default', async () => {
  const inserts = [];
  const db = makeWheelDb({ ids: [1, 2], inserts });
  const app = buildTestApp({ db });
  const session = await establishSession(app);

  await postJson(app, '/api/wheel', { segments: 2, filters: { allowEmpty: true } }, session);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][0], 'web');
});

test('POST /api/wheel: source is "direct" when hand-picked names are used', async () => {
  const inserts = [];
  const db = makeWheelDb({ ids: [1, 2], inserts });
  const app = buildTestApp({ db });
  const session = await establishSession(app);

  await postJson(app, '/api/wheel', { segments: 2, filters: { names: [1, 2], allowEmpty: true } }, session);
  assert.equal(inserts[0][0], 'direct');
});

test('POST /api/wheel: steamLibrary without a logged-in session drops the filter instead of erroring', async () => {
  const db = makeWheelDb({ ids: [1, 2] });
  const app = buildTestApp({ db });
  const session = await establishSession(app); // anonymous session, no steamid

  const res = await postJson(app, '/api/wheel', { segments: 2, filters: { steamLibrary: true, allowEmpty: true } }, session);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).games.length, 2);
});

test('POST /api/wheel: steamLibrary for a logged-in user with a private profile returns {error: "privacy"}', async () => {
  const db = makeWheelDb({ ids: [1, 2] });
  const fetch = async () => ({ ok: true, json: async () => ({ response: {} }) });
  const app = buildTestApp({ db, fetch });

  const { signSession, createSessionPayload } = await import('../../src/lib/session.js');
  const payload = createSessionPayload({ steamid: '76561198000000010' });
  const cookie = signSession(payload, testEnv().SESSION_SECRET);
  const sessionRes = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: `gg_session=${cookie}` } });
  const csrf = JSON.parse(sessionRes.body).csrf;

  const res = await postJson(
    app,
    '/api/wheel',
    { segments: 2, filters: { steamLibrary: true, allowEmpty: true } },
    { cookieHeader: `gg_session=${cookie}`, csrf },
  );
  assert.deepEqual(JSON.parse(res.body), { error: 'privacy' });
});

test('POST /api/wheel: steamLibrary resolves owned appids and narrows the SQL (steam_appid IN)', async () => {
  let capturedSql = null;
  let capturedParams = null;
  const db = {
    query: async (sql, params) => {
      if (/^SELECT games\.id/.test(sql)) {
        capturedSql = sql;
        capturedParams = params;
        return [{ id: 1 }];
      }
      if (/^SELECT \* FROM games WHERE id IN/.test(sql)) return [gameRow(1, { steam_appid: 10 })];
      if (/^SELECT game_id/.test(sql)) return [];
      if (/^INSERT/.test(sql)) return {};
      return [];
    },
    one: async () => null,
  };
  const fetch = async () => ({ ok: true, json: async () => ({ response: { games: [{ appid: 10 }, { appid: 20 }] } }) });
  const app = buildTestApp({ db, fetch });

  const { signSession, createSessionPayload } = await import('../../src/lib/session.js');
  const payload = createSessionPayload({ steamid: '76561198000000010' });
  const cookie = signSession(payload, testEnv().SESSION_SECRET);
  const sessionRes = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: `gg_session=${cookie}` } });
  const csrf = JSON.parse(sessionRes.body).csrf;

  const res = await postJson(
    app,
    '/api/wheel',
    { segments: 1, filters: { steamLibrary: true, allowEmpty: true } },
    { cookieHeader: `gg_session=${cookie}`, csrf },
  );
  assert.equal(res.statusCode, 200);
  assert.ok(capturedSql.includes('steam_appid IN'));
  assert.deepEqual(capturedParams, [10, 20]);
});

test('POST /api/wheel/random: returns a single GameCard and logs source "random"', async () => {
  const inserts = [];
  const db = makeWheelDb({ ids: [5, 6, 7], inserts });
  const app = buildTestApp({ db });
  const session = await establishSession(app);

  const res = await postJson(app, '/api/wheel/random', {}, session);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(typeof body.game.id, 'number');
  assert.equal(inserts[0][0], 'random');
});

test('POST /api/wheel/random: empty catalog returns {error: "empty"}', async () => {
  const db = makeWheelDb({ ids: [] });
  const app = buildTestApp({ db });
  const session = await establishSession(app);

  const res = await postJson(app, '/api/wheel/random', {}, session);
  assert.deepEqual(JSON.parse(res.body), { error: 'empty' });
});

test('POST /api/wheel/random: falls back to the first surviving row when the random pick lands in a gap', async () => {
  // ids has a gap between 5 and 9: any pick >= 6 finds no row at/after it among {5,9}, so the route must
  // fall back to the lowest surviving id (5) - exercises the fallback query's own WHERE clause (same
  // purchasable/non_game/steam_delisted/region conditions as the bounds and "id >=" queries).
  const inserts = [];
  const db = makeWheelDb({ ids: [5, 9], inserts });
  const app = buildTestApp({ db });
  const session = await establishSession(app);

  const res = await postJson(app, '/api/wheel/random', {}, session);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(typeof body.game.id, 'number');
});

test('POST /api/wheel/random: bounds/pick/fallback queries all carry purchasable = 1 and the en region condition', async () => {
  const capturedSql = [];
  const db = {
    query: async () => [],
    one: async (sql, params) => {
      capturedSql.push(sql);
      if (/^SELECT MIN\(id\)/.test(sql)) return { lo: 1, hi: 1 };
      if (/^SELECT \* FROM games WHERE id >=/.test(sql)) return gameRow(1);
      return null;
    },
  };
  const app = buildTestApp({ db });
  const session = await establishSession(app);

  const res = await postJson(app, '/api/wheel/random', { lang: 'en' }, session);
  assert.equal(res.statusCode, 200);
  for (const sql of capturedSql) {
    assert.match(sql, /purchasable = 1/);
    assert.match(sql, /NOT \(COALESCE\(price_usd, 0\) = 0 AND COALESCE\(price_rub, 0\) > 0\)/);
  }
});

test('POST /api/wheel/random: ru without cisPrices uses the ru region condition instead', async () => {
  const capturedSql = [];
  const db = {
    query: async () => [],
    one: async (sql) => {
      capturedSql.push(sql);
      if (/^SELECT MIN\(id\)/.test(sql)) return { lo: 1, hi: 1 };
      if (/^SELECT \* FROM games WHERE id >=/.test(sql)) return gameRow(1);
      return null;
    },
  };
  const app = buildTestApp({ db });
  const session = await establishSession(app);

  const res = await postJson(app, '/api/wheel/random', { lang: 'ru', cisPrices: false }, session);
  assert.equal(res.statusCode, 200);
  assert.ok(capturedSql.some((sql) => /NOT \(COALESCE\(price_rub, 0\) = 0 AND COALESCE\(price_usd, 0\) > 0\)/.test(sql)));
});

test('POST /api/wheel/random: cisPrices true drops the region condition from every query', async () => {
  const capturedSql = [];
  const db = {
    query: async () => [],
    one: async (sql) => {
      capturedSql.push(sql);
      if (/^SELECT MIN\(id\)/.test(sql)) return { lo: 1, hi: 1 };
      if (/^SELECT \* FROM games WHERE id >=/.test(sql)) return gameRow(1);
      return null;
    },
  };
  const app = buildTestApp({ db });
  const session = await establishSession(app);

  const res = await postJson(app, '/api/wheel/random', { lang: 'ru', cisPrices: true }, session);
  assert.equal(res.statusCode, 200);
  for (const sql of capturedSql) {
    assert.ok(!sql.includes('COALESCE(price_rub'));
    assert.ok(!sql.includes('COALESCE(price_usd'));
    assert.match(sql, /purchasable = 1/);
  }
});

test('POST /api/wheel/marbles: returns a CSV of names and logs source "list"', async () => {
  const inserts = [];
  const db = makeWheelDb({ ids: [1, 2, 3], inserts });
  const app = buildTestApp({ db });
  const session = await establishSession(app);

  const res = await postJson(app, '/api/wheel/marbles', { filters: { allowEmpty: true } }, session);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /marbles\.csv/);
  const lines = res.body.split('\n').filter(Boolean);
  assert.deepEqual(lines.sort(), ['Game 1', 'Game 2', 'Game 3']);
  assert.equal(inserts[0][0], 'list');
});

test('POST /api/wheel/marbles: per-IP daily limit is enforced (429 once exceeded)', async () => {
  const inserts = [];
  const db = makeWheelDb({ ids: [1, 2, 3], inserts });
  const config = {
    site: { origin: 'https://gamegauntlets.com', languages: ['en'], previewOrigins: [] },
    admins: [],
    wheel: { minSegments: 1, maxSegments: 16, defaultSegments: 12, marblesDailyLimit: 2 },
  };
  const app = buildTestApp({ db, config });
  const session = await establishSession(app);

  const first = await postJson(app, '/api/wheel/marbles', { filters: { allowEmpty: true } }, session);
  const second = await postJson(app, '/api/wheel/marbles', { filters: { allowEmpty: true } }, session);
  const third = await postJson(app, '/api/wheel/marbles', { filters: { allowEmpty: true } }, session);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(third.statusCode, 429);
  assert.deepEqual(JSON.parse(third.body), { error: 'rate_limited' });
});

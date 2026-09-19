import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../../src/api.js';
import { signSession, createSessionPayload } from '../../src/lib/session.js';
import { PUBLIC_ORIGIN, testConfig, testEnv, unusedFetch } from './helpers.js';

const ADMIN_STEAMID = '76561198000000010';
const NON_ADMIN_STEAMID = '1';

function adminConfig(overrides = {}) {
  return testConfig({ admins: [ADMIN_STEAMID], ...overrides });
}

function authFor(steamid) {
  const payload = createSessionPayload({ steamid });
  const cookie = signSession(payload, testEnv().SESSION_SECRET);
  return { cookieHeader: `gg_session=${cookie}`, csrf: payload.csrf };
}

function writeHeaders(auth, extra = {}) {
  return {
    cookie: auth.cookieHeader,
    origin: PUBLIC_ORIGIN,
    'x-csrf-token': auth.csrf,
    'content-type': 'application/json',
    ...extra,
  };
}

function buildAdminApp({ db, config, queueFor, enqueue, enqueueResolve } = {}) {
  return buildApp({
    db: db || { query: async () => [], one: async () => null },
    config: config || adminConfig(),
    env: testEnv(),
    fetch: unusedFetch(),
    queueFor,
    enqueue,
    enqueueResolve,
  });
}

function fakeQueueFor(calls = []) {
  return (name) => ({
    add: (jobName, data, opts) => {
      calls.push({ queue: name, jobName, data, opts });
      return Promise.resolve({ id: opts?.jobId ?? `${name}-1` });
    },
    getJobCounts: async () => ({ active: 0, waiting: 0, completed: 0, failed: 0 }),
  });
}

// ---------------- 403: anonymous / non-admin ----------------

test('GET /api/admin/sources: anonymous request is rejected (403)', async () => {
  const app = buildAdminApp();
  const res = await app.inject({ method: 'GET', url: '/api/admin/sources' });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), { error: 'forbidden' });
});

test('GET /api/admin/sources: a logged-in but non-admin steamid is rejected (403)', async () => {
  const app = buildAdminApp();
  const auth = authFor(NON_ADMIN_STEAMID);
  const res = await app.inject({ method: 'GET', url: '/api/admin/sources', headers: { cookie: auth.cookieHeader } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), { error: 'forbidden' });
});

test('POST /api/admin/sources/steam/pause: anonymous request is rejected (403), even with a made-up CSRF header', async () => {
  const app = buildAdminApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/sources/steam/pause',
    headers: { origin: PUBLIC_ORIGIN, 'x-csrf-token': 'whatever', 'content-type': 'application/json' },
  });
  assert.equal(res.statusCode, 403);
});

// ---------------- CSRF / origin on admin POST/PUT/DELETE ----------------

test('POST /api/admin/sources/steam/pause: admin session but missing CSRF header is rejected (403)', async () => {
  const app = buildAdminApp();
  const auth = authFor(ADMIN_STEAMID);
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/sources/steam/pause',
    headers: { cookie: auth.cookieHeader, origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'forbidden_csrf');
});

test('POST /api/admin/sources/steam/pause: admin session but foreign Origin is rejected (403)', async () => {
  const app = buildAdminApp();
  const auth = authFor(ADMIN_STEAMID);
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/sources/steam/pause',
    headers: { cookie: auth.cookieHeader, origin: 'https://evil.example', 'x-csrf-token': auth.csrf, 'content-type': 'application/json' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'forbidden_origin');
});

test('PUT /api/admin/presets/:id: admin session but wrong CSRF token is rejected (403)', async () => {
  const app = buildAdminApp();
  const auth = authFor(ADMIN_STEAMID);
  const res = await app.inject({
    method: 'PUT',
    url: '/api/admin/presets/1',
    headers: writeHeaders({ ...auth, csrf: 'not-the-real-token' }),
    payload: { name: 'X', gameIds: [] },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'forbidden_csrf');
});

test('DELETE /api/admin/overrides/:gameId/:field: admin session but foreign Origin is rejected (403)', async () => {
  const app = buildAdminApp();
  const auth = authFor(ADMIN_STEAMID);
  const res = await app.inject({
    method: 'DELETE',
    url: '/api/admin/overrides/1/name',
    headers: { cookie: auth.cookieHeader, origin: 'https://evil.example', 'x-csrf-token': auth.csrf },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'forbidden_origin');
});

// ---------------- GET /api/admin/sources ----------------

test('GET /api/admin/sources: merges config/source_state/queue counts/record+link counts, tolerates a dead queue', async () => {
  const db = {
    query: async (sql) => {
      if (/FROM source_state/.test(sql)) {
        return [{ source: 'steam', paused: 1, last_run_at: '2026-01-01 00:00:00', last_full_pass_at: null, last_error: 'boom', stats: { seen: 5 } }];
      }
      if (/FROM source_records/.test(sql)) return [{ source: 'steam', c: 3 }];
      if (/FROM game_links/.test(sql)) return [{ source: 'steam', c: 2 }];
      return [];
    },
    one: async () => null,
  };
  // Queue provider that fails for one source (simulating Redis down) and works for others.
  const queueFor = (name) => ({
    getJobCounts: async () => {
      if (name === 'hltb') throw new Error('ECONNREFUSED');
      return { active: 1, waiting: 0 };
    },
  });
  const app = buildAdminApp({ db, queueFor });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({ method: 'GET', url: '/api/admin/sources', headers: { cookie: auth.cookieHeader } });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.sources));

  const steam = body.sources.find((s) => s.name === 'steam');
  assert.ok(steam, 'steam source module must be registered');
  assert.equal(steam.paused, true);
  assert.equal(steam.lastError, 'boom');
  assert.deepEqual(steam.stats, { seen: 5 });
  assert.equal(steam.recordsCount, 3);
  assert.equal(steam.linksCount, 2);
  assert.deepEqual(steam.queueCounts, { active: 1, waiting: 0 });

  const hltb = body.sources.find((s) => s.name === 'hltb');
  assert.ok(hltb);
  assert.equal(hltb.queueCounts, null, 'a Redis failure for one source must not fail the whole request');
});

test('GET /api/admin/sources: exposes stats.lastErrorAt as lastErrorAt (its age is a frontend concern), tolerating a JSON-string stats column', async () => {
  const db = {
    query: async (sql) => {
      if (/FROM source_state/.test(sql)) {
        return [
          { source: 'steam', paused: 0, last_run_at: null, last_full_pass_at: null, last_error: 'boom', stats: { lastErrorAt: '2026-09-19T06:00:00.000Z' } },
          { source: 'hltb', paused: 0, last_run_at: null, last_full_pass_at: null, last_error: 'stale', stats: JSON.stringify({ lastErrorAt: '2026-09-18T00:00:00.000Z' }) },
          { source: 'gog', paused: 0, last_run_at: null, last_full_pass_at: null, last_error: null, stats: null },
        ];
      }
      return [];
    },
    one: async () => null,
  };
  const app = buildAdminApp({ db, queueFor: fakeQueueFor() });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({ method: 'GET', url: '/api/admin/sources', headers: { cookie: auth.cookieHeader } });
  const body = JSON.parse(res.body);

  assert.equal(body.sources.find((s) => s.name === 'steam').lastErrorAt, '2026-09-19T06:00:00.000Z');
  assert.equal(body.sources.find((s) => s.name === 'hltb').lastErrorAt, '2026-09-18T00:00:00.000Z');
  assert.equal(body.sources.find((s) => s.name === 'gog').lastErrorAt, null);
});

// ---------------- pause / resume / run ----------------

test('POST /api/admin/sources/steam/pause: happy path upserts source_state.paused=1', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { affectedRows: 1 }; }, one: async () => null };
  const app = buildAdminApp({ db });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({ method: 'POST', url: '/api/admin/sources/steam/pause', headers: writeHeaders(auth), payload: {} });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.match(calls[0].sql, /INSERT INTO source_state/);
  assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE/);
  assert.deepEqual(calls[0].params, ['steam', 1]);
});

test('POST /api/admin/sources/steam/resume: happy path upserts source_state.paused=0', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return {}; }, one: async () => null };
  const app = buildAdminApp({ db });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({ method: 'POST', url: '/api/admin/sources/steam/resume', headers: writeHeaders(auth), payload: {} });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0].params, ['steam', 0]);
});

test('POST /api/admin/sources/:name/pause: unknown source name is a 404', async () => {
  const app = buildAdminApp();
  const auth = authFor(ADMIN_STEAMID);
  const res = await app.inject({ method: 'POST', url: '/api/admin/sources/not-a-real-source/pause', headers: writeHeaders(auth), payload: {} });
  assert.equal(res.statusCode, 404);
});

test('POST /api/admin/sources/steam/run: enqueues a discover job with a colon-free unique jobId', async () => {
  const calls = [];
  const app = buildAdminApp({ queueFor: fakeQueueFor(calls) });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({ method: 'POST', url: '/api/admin/sources/steam/run', headers: writeHeaders(auth), payload: {} });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].queue, 'steam');
  assert.equal(calls[0].jobName, 'discover');
  assert.ok(!calls[0].opts.jobId.includes(':'), `jobId must not contain ':' (got ${calls[0].opts.jobId})`);
  assert.equal(JSON.parse(res.body).jobId, calls[0].opts.jobId);
});

test('POST /api/admin/sources/:name/run: legacy_steamdb (extract-only, not a worker/queue source) is a 404', async () => {
  // src/sources/index.js excludes extract-only modules (legacy_steamdb.js) from `sources` (the
  // worker/queue registry) even though getSource() still finds them for the resolve pipeline — so
  // "run" must treat it exactly like any other unregistered name.
  const calls = [];
  const app = buildAdminApp({ queueFor: fakeQueueFor(calls) });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({ method: 'POST', url: '/api/admin/sources/legacy_steamdb/run', headers: writeHeaders(auth), payload: {} });
  assert.equal(res.statusCode, 404);
  assert.equal(calls.length, 0);
});

// ---------------- conflicts ----------------

test('GET /api/admin/conflicts: defaults to status=open, joins games for the name, paginates', async () => {
  let captured;
  const db = {
    query: async (sql, params) => { captured = { sql, params }; return [{ id: 1, game_id: 5, field: 'release_date', candidates: [{ source: 'igdb', value: '2020-01-01' }], reason: 'no majority', status: 'open', game_name: 'Portal 2' }]; },
    one: async () => ({ c: 1 }),
  };
  const app = buildAdminApp({ db });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({ method: 'GET', url: '/api/admin/conflicts', headers: { cookie: auth.cookieHeader } });
  assert.equal(res.statusCode, 200);
  assert.match(captured.sql, /JOIN games g ON g\.id = c\.game_id/);
  assert.match(captured.sql, /WHERE c\.status = \?/);
  assert.deepEqual(captured.params.slice(0, 1), ['open']);
  const body = JSON.parse(res.body);
  assert.equal(body.conflicts[0].game_name, 'Portal 2');
  assert.equal(body.total, 1);
});

test('GET /api/admin/conflicts?field=: adds the field filter', async () => {
  let captured;
  const db = { query: async (sql, params) => { captured = { sql, params }; return []; }, one: async () => ({ c: 0 }) };
  const app = buildAdminApp({ db });
  const auth = authFor(ADMIN_STEAMID);

  await app.inject({ method: 'GET', url: '/api/admin/conflicts?status=accepted&field=name', headers: { cookie: auth.cookieHeader } });
  assert.match(captured.sql, /c\.field = \?/);
  assert.deepEqual(captured.params.slice(0, 2), ['accepted', 'name']);
});

test('GET /api/admin/conflicts: an invalid status is a schema validation error (400)', async () => {
  const app = buildAdminApp();
  const auth = authFor(ADMIN_STEAMID);
  const res = await app.inject({ method: 'GET', url: '/api/admin/conflicts?status=bogus', headers: { cookie: auth.cookieHeader } });
  assert.equal(res.statusCode, 400);
});

test('POST /api/admin/conflicts/:id/accept: happy path marks the conflict accepted', async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => { calls.push({ sql, params }); return {}; },
    one: async () => ({ id: 7 }),
  };
  const app = buildAdminApp({ db });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({ method: 'POST', url: '/api/admin/conflicts/7/accept', headers: writeHeaders(auth), payload: {} });
  assert.equal(res.statusCode, 200);
  assert.match(calls[0].sql, /UPDATE conflicts SET status = 'accepted'/);
  assert.deepEqual(calls[0].params, [7]);
});

test('POST /api/admin/conflicts/:id/accept: unknown id is a 404', async () => {
  const app = buildAdminApp({ db: { query: async () => [], one: async () => null } });
  const auth = authFor(ADMIN_STEAMID);
  const res = await app.inject({ method: 'POST', url: '/api/admin/conflicts/999/accept', headers: writeHeaders(auth), payload: {} });
  assert.equal(res.statusCode, 404);
});

// ---------------- overrides ----------------

test('POST /api/admin/overrides: a field outside the allow-list is rejected by the schema (400)', async () => {
  const app = buildAdminApp();
  const auth = authFor(ADMIN_STEAMID);
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/overrides',
    headers: writeHeaders(auth),
    payload: { gameId: 1, field: 'steam_appid', value: 999 }, // steam_appid is NOT in the allow-list
  });
  assert.equal(res.statusCode, 400);
});

test('POST /api/admin/overrides: an unknown top-level property is rejected (additionalProperties: false)', async () => {
  const app = buildAdminApp();
  const auth = authFor(ADMIN_STEAMID);
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/overrides',
    headers: writeHeaders(auth),
    payload: { gameId: 1, field: 'name', value: 'X', evil: true },
  });
  assert.equal(res.statusCode, 400);
});

test('POST /api/admin/overrides: happy path upserts the override, marks the conflict overridden, enqueues resolve', async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => { calls.push({ sql, params }); return {}; },
    one: async (sql, params) => (/FROM games/.test(sql) ? { id: params[0] } : null),
  };
  const resolveCalls = [];
  const app = buildAdminApp({ db, enqueueResolve: async (gameId) => { resolveCalls.push(gameId); } });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/overrides',
    headers: writeHeaders(auth),
    payload: { gameId: 42, field: 'difficulty', value: 'Tough', note: 'confirmed on GameFAQs' },
  });
  assert.equal(res.statusCode, 200);

  const insertCall = calls.find((c) => /INSERT INTO overrides/.test(c.sql));
  assert.ok(insertCall);
  assert.deepEqual(insertCall.params, [42, 'difficulty', JSON.stringify('Tough'), 'confirmed on GameFAQs', ADMIN_STEAMID]);

  const conflictCall = calls.find((c) => /UPDATE conflicts SET status = 'overridden'/.test(c.sql));
  assert.deepEqual(conflictCall.params, [42, 'difficulty']);

  assert.deepEqual(resolveCalls, [42]);
});

test('POST /api/admin/overrides: unknown gameId is a 404, no enqueue', async () => {
  const resolveCalls = [];
  const db = { query: async () => ({}), one: async () => null };
  const app = buildAdminApp({ db, enqueueResolve: async (id) => resolveCalls.push(id) });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/overrides',
    headers: writeHeaders(auth),
    payload: { gameId: 999999, field: 'name', value: 'X' },
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(resolveCalls, []);
});

test('DELETE /api/admin/overrides/:gameId/:field: happy path deletes, reopens the conflict, enqueues resolve', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return {}; }, one: async () => null };
  const resolveCalls = [];
  const app = buildAdminApp({ db, enqueueResolve: async (id) => resolveCalls.push(id) });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({ method: 'DELETE', url: '/api/admin/overrides/42/difficulty', headers: writeHeaders(auth), payload: {} });
  assert.equal(res.statusCode, 200);
  assert.match(calls[0].sql, /DELETE FROM overrides WHERE game_id = \? AND field = \?/);
  assert.deepEqual(calls[0].params, [42, 'difficulty']);
  assert.match(calls[1].sql, /UPDATE conflicts SET status = 'open'/);
  assert.deepEqual(resolveCalls, [42]);
});

test('DELETE /api/admin/overrides/:gameId/:field: a field outside the allow-list is a 404', async () => {
  const app = buildAdminApp();
  const auth = authFor(ADMIN_STEAMID);
  const res = await app.inject({ method: 'DELETE', url: '/api/admin/overrides/42/steam_appid', headers: writeHeaders(auth), payload: {} });
  assert.equal(res.statusCode, 404);
});

// ---------------- games ----------------

test('GET /api/admin/games/:id: returns the full row, links, source_records summary (no payload), overrides, conflicts', async () => {
  const db = {
    query: async (sql) => {
      if (/FROM game_links/.test(sql)) return [{ source: 'steam', external_id: '620', url: 'https://x' }];
      if (/FROM source_records/.test(sql)) {
        assert.doesNotMatch(sql, /payload/);
        return [{ source: 'steam', status: 'ok', fetched_at: '2026-01-01' }];
      }
      if (/FROM overrides/.test(sql)) return [{ field: 'name', value: 'Portal 2' }];
      if (/FROM conflicts/.test(sql)) return [{ id: 1, field: 'release_date', status: 'open' }];
      return [];
    },
    one: async (sql, params) => ({ id: params[0], name: 'Portal 2' }),
  };
  const app = buildAdminApp({ db });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({ method: 'GET', url: '/api/admin/games/42', headers: { cookie: auth.cookieHeader } });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.game.name, 'Portal 2');
  assert.equal(body.links.length, 1);
  assert.equal(body.sourceRecords.length, 1);
  assert.equal(body.overrides.length, 1);
  assert.equal(body.conflicts.length, 1);
});

test('GET /api/admin/games/:id: unknown id is a 404', async () => {
  const app = buildAdminApp({ db: { query: async () => [], one: async () => null } });
  const auth = authFor(ADMIN_STEAMID);
  const res = await app.inject({ method: 'GET', url: '/api/admin/games/999999', headers: { cookie: auth.cookieHeader } });
  assert.equal(res.statusCode, 404);
});

test('POST /api/admin/games/:id/resolve: happy path enqueues a resolve job', async () => {
  const resolveCalls = [];
  const db = { query: async () => [], one: async (sql, params) => ({ id: params[0] }) };
  const app = buildAdminApp({ db, enqueueResolve: async (id) => resolveCalls.push(id) });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({ method: 'POST', url: '/api/admin/games/42/resolve', headers: writeHeaders(auth), payload: {} });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(resolveCalls, [42]);
});

test('POST /api/admin/games/:id/refresh/:source: happy path enqueues a fetch job with the known external id', async () => {
  const enqueueCalls = [];
  const db = {
    query: async () => [],
    one: async (sql, params) => {
      if (/FROM games/.test(sql)) return { id: params[0] };
      if (/FROM game_links/.test(sql)) return { external_id: '620' };
      return null;
    },
  };
  const app = buildAdminApp({ db, enqueue: async (source, data) => enqueueCalls.push({ source, data }) });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({ method: 'POST', url: '/api/admin/games/42/refresh/steam', headers: writeHeaders(auth), payload: {} });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(enqueueCalls, [{ source: 'steam', data: { gameId: 42, externalId: '620' } }]);
});

test('POST /api/admin/games/:id/refresh/:source: an unknown source is a 404', async () => {
  const app = buildAdminApp({ db: { query: async () => [], one: async (sql, params) => ({ id: params[0] }) } });
  const auth = authFor(ADMIN_STEAMID);
  const res = await app.inject({ method: 'POST', url: '/api/admin/games/42/refresh/not-a-source', headers: writeHeaders(auth), payload: {} });
  assert.equal(res.statusCode, 404);
});

// ---------------- presets ----------------

test('GET /api/admin/presets: lists presets with their gameIds', async () => {
  const db = {
    query: async (sql) => {
      if (/FROM presets/.test(sql)) return [{ id: 1, name: 'GGG #1', sortOrder: 0 }];
      if (/FROM preset_games/.test(sql)) return [{ preset_id: 1, game_id: 10 }, { preset_id: 1, game_id: 11 }];
      return [];
    },
    one: async () => null,
  };
  const app = buildAdminApp({ db });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({ method: 'GET', url: '/api/admin/presets', headers: { cookie: auth.cookieHeader } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), [{ id: 1, name: 'GGG #1', sortOrder: 0, gameIds: [10, 11] }]);
});

test('POST /api/admin/presets: creates the preset and inserts preset_games in one shot', async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO presets/.test(sql)) return { insertId: 5 };
      return {};
    },
    one: async () => null,
  };
  const app = buildAdminApp({ db });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/presets',
    headers: writeHeaders(auth),
    payload: { name: 'New Preset', gameIds: [1, 2, 3] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { id: 5, name: 'New Preset', sortOrder: 0, gameIds: [1, 2, 3] });

  const presetInsert = calls.find((c) => /INSERT INTO presets/.test(c.sql));
  assert.deepEqual(presetInsert.params, ['New Preset', 0]);
  const gamesInsert = calls.find((c) => /INSERT IGNORE INTO preset_games/.test(c.sql));
  assert.deepEqual(gamesInsert.params, [5, 1, 5, 2, 5, 3]);
});

test('PUT /api/admin/presets/:id: replaces name/sortOrder and the full preset_games set', async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => { calls.push({ sql, params }); return {}; },
    one: async () => ({ id: 5 }),
  };
  const app = buildAdminApp({ db });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({
    method: 'PUT',
    url: '/api/admin/presets/5',
    headers: writeHeaders(auth),
    payload: { name: 'Renamed', sortOrder: 2, gameIds: [9] },
  });
  assert.equal(res.statusCode, 200);

  const update = calls.find((c) => /UPDATE presets SET/.test(c.sql));
  assert.deepEqual(update.params, ['Renamed', 2, 5]);
  const del = calls.find((c) => /DELETE FROM preset_games WHERE preset_id = \?/.test(c.sql));
  assert.deepEqual(del.params, [5]);
  const ins = calls.find((c) => /INSERT IGNORE INTO preset_games/.test(c.sql));
  assert.deepEqual(ins.params, [5, 9]);
});

test('PUT /api/admin/presets/:id: unknown id is a 404', async () => {
  const app = buildAdminApp({ db: { query: async () => ({}), one: async () => null } });
  const auth = authFor(ADMIN_STEAMID);
  const res = await app.inject({ method: 'PUT', url: '/api/admin/presets/999', headers: writeHeaders(auth), payload: { name: 'X', gameIds: [] } });
  assert.equal(res.statusCode, 404);
});

test('DELETE /api/admin/presets/:id: happy path, unknown id is a 404', async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => { calls.push({ sql, params }); return {}; },
    one: async (sql, params) => (params[0] === 5 ? { id: 5 } : null),
  };
  const app = buildAdminApp({ db });
  const auth = authFor(ADMIN_STEAMID);

  const ok = await app.inject({ method: 'DELETE', url: '/api/admin/presets/5', headers: writeHeaders(auth), payload: {} });
  assert.equal(ok.statusCode, 200);
  assert.ok(calls.some((c) => /DELETE FROM presets WHERE id = \?/.test(c.sql)));

  const missing = await app.inject({ method: 'DELETE', url: '/api/admin/presets/999', headers: writeHeaders(auth), payload: {} });
  assert.equal(missing.statusCode, 404);
});

// ---------------- users ----------------

test('GET /api/admin/users?q=: filters by name/steamid with LIKE', async () => {
  let captured;
  const db = {
    query: async (sql, params) => { captured = { sql, params }; return [{ steamid: ADMIN_STEAMID, name: 'Tester' }]; },
    one: async () => ({ c: 1 }),
  };
  const app = buildAdminApp({ db });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({ method: 'GET', url: '/api/admin/users?q=Lein', headers: { cookie: auth.cookieHeader } });
  assert.equal(res.statusCode, 200);
  assert.match(captured.sql, /name LIKE \? OR steamid LIKE \?/);
  assert.deepEqual(captured.params.slice(0, 2), ['%Lein%', '%Lein%']);
});

test('PUT /api/admin/users/:steamid: happy path updates level and status', async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => { calls.push({ sql, params }); return {}; },
    one: async () => ({ steamid: NON_ADMIN_STEAMID }),
  };
  const app = buildAdminApp({ db });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({
    method: 'PUT',
    url: `/api/admin/users/${NON_ADMIN_STEAMID}`,
    headers: writeHeaders(auth),
    payload: { level: 3, status: 'streamer' },
  });
  assert.equal(res.statusCode, 200);
  const update = calls.find((c) => /UPDATE users SET/.test(c.sql));
  assert.deepEqual(update.params, [3, 'streamer', NON_ADMIN_STEAMID]);
});

test('PUT /api/admin/users/:steamid: level can be explicitly cleared to null', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return {}; }, one: async () => ({ steamid: NON_ADMIN_STEAMID }) };
  const app = buildAdminApp({ db });
  const auth = authFor(ADMIN_STEAMID);

  const res = await app.inject({
    method: 'PUT',
    url: `/api/admin/users/${NON_ADMIN_STEAMID}`,
    headers: writeHeaders(auth),
    payload: { level: null },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0].params, [null, NON_ADMIN_STEAMID]);
});

test('PUT /api/admin/users/:steamid: an out-of-range level is a schema validation error (400)', async () => {
  const app = buildAdminApp();
  const auth = authFor(ADMIN_STEAMID);
  const res = await app.inject({
    method: 'PUT',
    url: `/api/admin/users/${NON_ADMIN_STEAMID}`,
    headers: writeHeaders(auth),
    payload: { level: 7 },
  });
  assert.equal(res.statusCode, 400);
});

test('PUT /api/admin/users/:steamid: unknown steamid is a 404', async () => {
  const app = buildAdminApp({ db: { query: async () => ({}), one: async () => null } });
  const auth = authFor(ADMIN_STEAMID);
  const res = await app.inject({ method: 'PUT', url: '/api/admin/users/999999999999', headers: writeHeaders(auth), payload: { status: 'normal' } });
  assert.equal(res.statusCode, 404);
});

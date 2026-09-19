import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifySession } from '../../src/lib/session.js';
import { buildTestApp, testConfig, testEnv, extractCookie, establishSession } from './helpers.js';

test('GET /api/session: first visit creates a session cookie and returns a csrf token', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/api/session' });
  assert.equal(res.statusCode, 200);

  const body = JSON.parse(res.body);
  assert.equal(typeof body.csrf, 'string');
  assert.ok(body.csrf.length > 0);
  assert.equal(body.user, null);
  assert.equal(body.lang, 'en');

  const cookie = extractCookie(res, 'gg_session');
  assert.ok(cookie);
  const payload = verifySession(cookie, testEnv().SESSION_SECRET);
  assert.equal(payload.csrf, body.csrf);
});

test('GET /api/session: reusing the cookie returns the same csrf, does not re-issue a cookie', async () => {
  const app = buildTestApp({});
  const first = await establishSession(app);

  const second = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: first.cookieHeader } });
  assert.equal(JSON.parse(second.body).csrf, first.csrf);
  assert.equal(extractCookie(second, 'gg_session'), null); // not re-set when nothing changed
});

test('GET /api/session: logged-in session (steamid) returns the user row', async () => {
  const db = {
    query: async () => [],
    one: async (sql, params) => {
      assert.match(sql, /FROM users WHERE steamid = \?/);
      assert.deepEqual(params, ['76561198000000010']);
      return { steamid: '76561198000000010', name: 'Tester', avatar: 'a.png', level: 3, status: 'normal' };
    },
  };
  const app = buildTestApp({ db });

  // Forge a session with a steamid directly rather than going through /auth/steam/callback here —
  // that flow is covered in tests/api/auth.test.js.
  const { signSession, createSessionPayload } = await import('../../src/lib/session.js');
  const payload = createSessionPayload({ steamid: '76561198000000010' });
  const cookie = signSession(payload, testEnv().SESSION_SECRET);

  const res = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: `gg_session=${cookie}` } });
  const body = JSON.parse(res.body);
  assert.deepEqual(body.user, {
    steamid: '76561198000000010',
    name: 'Tester',
    avatar: 'a.png',
    level: 3,
    status: 'normal',
    admin: false, // testConfig()'s admins list is empty by default
  });
});

test('GET /api/session: user.admin is true when the session steamid is in config.admins', async () => {
  const db = {
    query: async () => [],
    one: async () => ({ steamid: '76561198000000010', name: 'Tester', avatar: null, level: null, status: 'normal' }),
  };
  const config = testConfig({ admins: ['76561198000000010'] });
  const app = buildTestApp({ db, config });

  const { signSession, createSessionPayload } = await import('../../src/lib/session.js');
  const payload = createSessionPayload({ steamid: '76561198000000010' });
  const cookie = signSession(payload, testEnv().SESSION_SECRET);

  const res = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: `gg_session=${cookie}` } });
  assert.equal(JSON.parse(res.body).user.admin, true);
});

test('GET /api/session: no user (anonymous) has no admin flag at all', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/api/session' });
  const body = JSON.parse(res.body);
  assert.equal(body.user, null);
});

test('GET /api/session: a tampered cookie is treated as no session (new one is issued)', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: 'gg_session=garbage.garbage' } });
  assert.equal(res.statusCode, 200);
  const cookie = extractCookie(res, 'gg_session');
  assert.ok(cookie); // a fresh session was created
});

test('GET /api/session: ?lang= updates and persists the session language', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/api/session?lang=ru' });
  assert.equal(JSON.parse(res.body).lang, 'ru');
  const cookie = extractCookie(res, 'gg_session');
  const payload = verifySession(cookie, testEnv().SESSION_SECRET);
  assert.equal(payload.lang, 'ru');
});

test('GET /api/session: rejects an unknown lang value (schema validation)', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/api/session?lang=xx' });
  assert.equal(res.statusCode, 400);
});

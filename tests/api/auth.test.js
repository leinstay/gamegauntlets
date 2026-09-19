import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifySession } from '../../src/lib/session.js';
import { buildTestApp, testEnv, extractCookie, establishSession } from './helpers.js';

const STEAMID = '76561198000000010';
const PUBLIC_ORIGIN = 'https://gamegauntlets.com';
const CALLBACK = `${PUBLIC_ORIGIN}/api/auth/steam/callback`;

function validCallbackQuery(overrides = {}) {
  const claimedId = `https://steamcommunity.com/openid/id/${STEAMID}`;
  return {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': claimedId,
    'openid.identity': claimedId,
    'openid.return_to': CALLBACK,
    'openid.response_nonce': '2026-09-19T00:00:00Znonce',
    'openid.assoc_handle': 'handle',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'sig==',
    ...overrides,
  };
}

function toQueryString(query) {
  return Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

test('GET /api/auth/steam: redirects to Steam with our callback as return_to', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/api/auth/steam' });
  assert.equal(res.statusCode, 302);
  const location = new URL(res.headers.location);
  assert.equal(location.origin, 'https://steamcommunity.com');
  assert.equal(location.searchParams.get('openid.return_to'), CALLBACK);
  assert.equal(location.searchParams.get('openid.realm'), PUBLIC_ORIGIN);
});

test('GET /api/auth/steam/callback: valid assertion for a new user creates the user, logs a login, sets a fresh session, redirects home', async () => {
  const inserted = { users: [], logins: [], updates: [] };
  const db = {
    query: async (sql, params) => {
      if (/^INSERT INTO users/.test(sql)) inserted.users.push(params);
      else if (/^INSERT INTO user_logins/.test(sql)) inserted.logins.push(params);
      else if (/^UPDATE users SET last_login_at/.test(sql)) inserted.updates.push(params);
      else throw new Error(`unexpected query: ${sql}`);
      return {};
    },
    one: async (sql, params) => {
      assert.match(sql, /FROM users WHERE steamid = \?/);
      assert.deepEqual(params, [STEAMID]);
      return null; // new user
    },
  };
  const fetch = async (url, opts) => {
    if (url.includes('/openid/login')) {
      return { ok: true, text: async () => 'is_valid:true' };
    }
    if (url.includes('GetPlayerSummaries')) {
      return { ok: true, json: async () => ({ response: { players: [{ personaname: 'Tester', avatarfull: 'a.png', profileurl: 'p' }] } }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const app = buildTestApp({ db, fetch });

  const res = await app.inject({ method: 'GET', url: `/api/auth/steam/callback?${toQueryString(validCallbackQuery())}` });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, `${PUBLIC_ORIGIN}/`);

  assert.equal(inserted.users.length, 1);
  assert.deepEqual(inserted.users[0], [STEAMID, 'Tester', 'a.png', 'p']);
  assert.deepEqual(inserted.logins[0], [STEAMID]);

  const cookie = extractCookie(res, 'gg_session');
  const payload = verifySession(cookie, testEnv().SESSION_SECRET);
  assert.equal(payload.steamid, STEAMID);
});

test('GET /api/auth/steam/callback: valid assertion for an existing user does not re-insert', async () => {
  let insertedUser = false;
  const db = {
    query: async (sql) => {
      if (/^INSERT INTO users/.test(sql)) insertedUser = true;
      return {};
    },
    one: async () => ({ steamid: STEAMID }),
  };
  const fetch = async (url) => {
    if (url.includes('/openid/login')) return { ok: true, text: async () => 'is_valid:true' };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const app = buildTestApp({ db, fetch });

  const res = await app.inject({ method: 'GET', url: `/api/auth/steam/callback?${toQueryString(validCallbackQuery())}` });
  assert.equal(res.statusCode, 302);
  assert.equal(insertedUser, false);
});

test('GET /api/auth/steam/callback: invalid assertion (Steam says is_valid:false) does not log in', async () => {
  const db = { query: async () => { throw new Error('must not write to the db'); }, one: async () => { throw new Error('must not read the db'); } };
  const fetch = async () => ({ ok: true, text: async () => 'is_valid:false' });
  const app = buildTestApp({ db, fetch });

  const res = await app.inject({ method: 'GET', url: `/api/auth/steam/callback?${toQueryString(validCallbackQuery())}` });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, `${PUBLIC_ORIGIN}/`);
  assert.equal(extractCookie(res, 'gg_session'), null);
});

test('GET /api/auth/steam/callback: forged claimed_id (not steamcommunity.com) is rejected before touching Steam or the db', async () => {
  const db = { query: async () => { throw new Error('must not write to the db'); }, one: async () => { throw new Error('must not read the db'); } };
  const fetch = async () => { throw new Error('must not call Steam'); };
  const app = buildTestApp({ db, fetch });

  const forged = 'https://evil.example/openid/id/76561198000000010';
  const query = validCallbackQuery({ 'openid.claimed_id': forged, 'openid.identity': forged });
  const res = await app.inject({ method: 'GET', url: `/api/auth/steam/callback?${toQueryString(query)}` });
  assert.equal(res.statusCode, 302);
  assert.equal(extractCookie(res, 'gg_session'), null);
});

test('GET /api/auth/steam/callback: return_to mismatch is rejected before touching Steam or the db', async () => {
  const db = { query: async () => { throw new Error('must not write to the db'); }, one: async () => { throw new Error('must not read the db'); } };
  const fetch = async () => { throw new Error('must not call Steam'); };
  const app = buildTestApp({ db, fetch });

  const query = validCallbackQuery({ 'openid.return_to': 'https://evil.example/cb' });
  const res = await app.inject({ method: 'GET', url: `/api/auth/steam/callback?${toQueryString(query)}` });
  assert.equal(res.statusCode, 302);
  assert.equal(extractCookie(res, 'gg_session'), null);
});

test('POST /api/auth/logout: rotates the session (new csrf) and clears steamid', async () => {
  const { signSession, createSessionPayload } = await import('../../src/lib/session.js');
  const payload = createSessionPayload({ steamid: STEAMID });
  const cookie = signSession(payload, testEnv().SESSION_SECRET);
  const app = buildTestApp({});

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: {
      cookie: `gg_session=${cookie}`,
      origin: PUBLIC_ORIGIN,
      'x-csrf-token': payload.csrf,
      'content-type': 'application/json',
    },
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });

  const newCookie = extractCookie(res, 'gg_session');
  const newPayload = verifySession(newCookie, testEnv().SESSION_SECRET);
  assert.equal('steamid' in newPayload, false);
  assert.notEqual(newPayload.csrf, payload.csrf);
});

test('POST /api/auth/logout: still requires CSRF like any other POST', async () => {
  const app = buildTestApp({});
  const session = await establishSession(app);
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { cookie: session.cookieHeader, origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
    payload: {},
  });
  assert.equal(res.statusCode, 403);
});

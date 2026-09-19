import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTestApp, testConfig, testEnv, establishSession } from './helpers.js';

const WHEEL_DB = {
  query: async (sql) => (/^SELECT games\.id/.test(sql) ? [{ id: 1 }] : []),
  one: async () => null,
};

test('POST /api/wheel: missing CSRF header is rejected (403), even with a valid session cookie', async () => {
  const app = buildTestApp({ db: WHEEL_DB });
  const { cookieHeader } = await establishSession(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/wheel',
    headers: { cookie: cookieHeader, origin: 'https://gamegauntlets.com', 'content-type': 'application/json' },
    payload: { segments: 6 },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'forbidden_csrf');
});

test('POST /api/wheel: wrong CSRF token is rejected (403)', async () => {
  const app = buildTestApp({ db: WHEEL_DB });
  const { cookieHeader } = await establishSession(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/wheel',
    headers: {
      cookie: cookieHeader,
      origin: 'https://gamegauntlets.com',
      'x-csrf-token': 'not-the-real-token',
      'content-type': 'application/json',
    },
    payload: { segments: 6 },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'forbidden_csrf');
});

test('POST /api/wheel: no session at all is rejected (403) even with a made-up csrf header', async () => {
  const app = buildTestApp({ db: WHEEL_DB });
  const res = await app.inject({
    method: 'POST',
    url: '/api/wheel',
    headers: { origin: 'https://gamegauntlets.com', 'x-csrf-token': 'whatever', 'content-type': 'application/json' },
    payload: { segments: 6 },
  });
  assert.equal(res.statusCode, 403);
});

test('POST /api/wheel: foreign Origin is rejected (403) even with a correct CSRF token', async () => {
  const app = buildTestApp({ db: WHEEL_DB });
  const { csrf, cookieHeader } = await establishSession(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/wheel',
    headers: {
      cookie: cookieHeader,
      origin: 'https://evil.example',
      'x-csrf-token': csrf,
      'content-type': 'application/json',
    },
    payload: { segments: 6 },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'forbidden_origin');
});

test('POST /api/wheel: no Origin, foreign Referer is rejected (403)', async () => {
  const app = buildTestApp({ db: WHEEL_DB });
  const { csrf, cookieHeader } = await establishSession(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/wheel',
    headers: {
      cookie: cookieHeader,
      referer: 'https://evil.example/somepage',
      'x-csrf-token': csrf,
      'content-type': 'application/json',
    },
    payload: { segments: 6 },
  });
  assert.equal(res.statusCode, 403);
});

test('POST /api/wheel: correct Origin + CSRF + session succeeds', async () => {
  const app = buildTestApp({ db: WHEEL_DB });
  const { csrf, cookieHeader } = await establishSession(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/wheel',
    headers: {
      cookie: cookieHeader,
      origin: 'https://gamegauntlets.com',
      'x-csrf-token': csrf,
      'content-type': 'application/json',
    },
    payload: { segments: 6 },
  });
  assert.equal(res.statusCode, 200);
});

test('POST /api/wheel: the configured preview origin is also accepted', async () => {
  const config = testConfig({
    site: { origin: 'https://gamegauntlets.com', languages: ['en'], previewOrigins: ['https://203.0.113.10'] },
  });
  const app = buildTestApp({ db: WHEEL_DB, config });
  const { csrf, cookieHeader } = await establishSession(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/wheel',
    headers: {
      cookie: cookieHeader,
      origin: 'https://203.0.113.10',
      'x-csrf-token': csrf,
      'content-type': 'application/json',
    },
    payload: { segments: 6 },
  });
  assert.equal(res.statusCode, 200);
});

test('GET requests are never subject to the CSRF/Origin check (session bootstrap must work cross-navigation)', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/api/session', headers: { origin: 'https://evil.example' } });
  assert.equal(res.statusCode, 200);
});

test('schema validation: unknown top-level body property is rejected (additionalProperties: false)', async () => {
  const app = buildTestApp({ db: WHEEL_DB });
  const { csrf, cookieHeader } = await establishSession(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/wheel',
    headers: {
      cookie: cookieHeader,
      origin: 'https://gamegauntlets.com',
      'x-csrf-token': csrf,
      'content-type': 'application/json',
    },
    payload: { segments: 6, evilExtraField: 'x' },
  });
  assert.equal(res.statusCode, 400);
});

test('schema validation: unknown filter-group property is rejected', async () => {
  const app = buildTestApp({ db: WHEEL_DB });
  const { csrf, cookieHeader } = await establishSession(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/wheel',
    headers: {
      cookie: cookieHeader,
      origin: 'https://gamegauntlets.com',
      'x-csrf-token': csrf,
      'content-type': 'application/json',
    },
    payload: { segments: 6, filters: { include: { genres: ['RPG'], notAField: ['x'] } } },
  });
  assert.equal(res.statusCode, 400);
});

test('schema validation: a filter list over 16 items is rejected', async () => {
  const app = buildTestApp({ db: WHEEL_DB });
  const { csrf, cookieHeader } = await establishSession(app);

  const genres = Array.from({ length: 17 }, (_, i) => `G${i}`);
  const res = await app.inject({
    method: 'POST',
    url: '/api/wheel',
    headers: {
      cookie: cookieHeader,
      origin: 'https://gamegauntlets.com',
      'x-csrf-token': csrf,
      'content-type': 'application/json',
    },
    payload: { segments: 6, filters: { include: { genres } } },
  });
  assert.equal(res.statusCode, 400);
});

test('schema validation: segments out of [1,16] range is rejected', async () => {
  const app = buildTestApp({ db: WHEEL_DB });
  const { csrf, cookieHeader } = await establishSession(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/wheel',
    headers: {
      cookie: cookieHeader,
      origin: 'https://gamegauntlets.com',
      'x-csrf-token': csrf,
      'content-type': 'application/json',
    },
    payload: { segments: 17 },
  });
  assert.equal(res.statusCode, 400);
});

test('rate limit: the 61st /api/wheel request within a minute from one IP is throttled', async () => {
  const app = buildTestApp({ db: WHEEL_DB });
  const { csrf, cookieHeader } = await establishSession(app);
  const headers = {
    cookie: cookieHeader,
    origin: 'https://gamegauntlets.com',
    'x-csrf-token': csrf,
    'content-type': 'application/json',
  };

  let lastStatus;
  for (let i = 0; i < 61; i++) {
    const res = await app.inject({ method: 'POST', url: '/api/wheel', headers, payload: { segments: 6 } });
    lastStatus = res.statusCode;
  }
  assert.equal(lastStatus, 429);
});

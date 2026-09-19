// Shared test scaffolding for tests/api/*.test.js. Not a *.test.js file itself (node --test won't
// pick it up), just plain helpers.

import { buildApp } from '../../src/api.js';

export const PUBLIC_ORIGIN = 'https://gamegauntlets.com';

export function testConfig(overrides = {}) {
  return {
    site: { origin: PUBLIC_ORIGIN, languages: ['en', 'ru', 'de', 'fr'], previewOrigins: [] },
    admins: [],
    wheel: { minSegments: 1, maxSegments: 16, defaultSegments: 12, marblesDailyLimit: 100 },
    ...overrides,
  };
}

export function testEnv(overrides = {}) {
  return {
    SESSION_SECRET: 'test-secret-do-not-use-in-prod',
    PUBLIC_ORIGIN,
    STEAM_API_KEY: 'test-steam-api-key',
    ...overrides,
  };
}

/** A fetch stub that fails any test relying on real network access if actually called unexpectedly. */
export function unusedFetch() {
  return async () => {
    throw new Error('unexpected network call in test');
  };
}

/**
 * Build a Fastify app wired to a fake db for tests. `db` only needs whatever `query`/`one` behavior
 * the test under it exercises.
 */
export function buildTestApp({ db, config, env, fetch } = {}) {
  return buildApp({
    db: db || { query: async () => [], one: async () => null },
    config: config || testConfig(),
    env: env || testEnv(),
    fetch: fetch || unusedFetch(),
  });
}

/** Pull the value of one Set-Cookie header (by cookie name) out of an inject() response. */
export function extractCookie(response, name) {
  const raw = response.cookies?.find((c) => c.name === name);
  if (raw) return raw.value;
  const headers = response.headers['set-cookie'];
  if (!headers) return null;
  const list = Array.isArray(headers) ? headers : [headers];
  for (const header of list) {
    const match = header.match(new RegExp(`${name}=([^;]+)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

/** GET /api/session and return { csrf, cookieHeader } ready to reuse on a follow-up request. */
export async function establishSession(app) {
  const res = await app.inject({ method: 'GET', url: '/api/session' });
  const sessionCookie = extractCookie(res, 'gg_session');
  const body = JSON.parse(res.body);
  return { csrf: body.csrf, cookieHeader: `gg_session=${sessionCookie}`, body };
}

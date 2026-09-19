import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTestApp } from './helpers.js';

test('GET /api/games/search: normalizes the query and LIKEs name_normalized, capped at 20', async () => {
  let captured = null;
  const db = {
    query: async (sql, params) => {
      captured = { sql, params };
      return [
        { id: 1, name: 'Portal 2', image: 'p2.jpg' },
        { id: 2, name: 'Portal', image: null },
      ];
    },
    one: async () => null,
  };
  const app = buildTestApp({ db });

  const res = await app.inject({ method: 'GET', url: '/api/games/search?q=Portal!!' });
  assert.equal(res.statusCode, 200);
  assert.match(captured.sql, /name_normalized LIKE/);
  assert.match(captured.sql, /LIMIT 20/);
  assert.match(captured.sql, /non_game IS NULL/); // migrations/004_non_game.sql: never surfaced by search
  assert.match(captured.sql, /purchasable = 1/); // migrations/005_purchasable.sql: same for unbuyable games
  // normalizeName() (src/lib/names.js) strips punctuation but preserves case and inter-word
  // spaces; matching is case-insensitive in MySQL's default collation regardless.
  assert.deepEqual(captured.params, ['Portal', 'Portal', 'Portal', 'Portal']);
  assert.match(captured.sql, /owners_estimate/); // popularity ranking after exact/prefix/word matches

  const body = JSON.parse(res.body);
  assert.deepEqual(body, [
    { id: 1, name: 'Portal 2', image: 'p2.jpg' },
    { id: 2, name: 'Portal', image: null },
  ]);
});

test('GET /api/games/search: empty/whitespace-only query short-circuits to [] without querying', async () => {
  let queried = false;
  const db = { query: async () => { queried = true; return []; }, one: async () => null };
  const app = buildTestApp({ db });

  const res = await app.inject({ method: 'GET', url: '/api/games/search?q=%20%20' });
  assert.deepEqual(JSON.parse(res.body), []);
  assert.equal(queried, false);
});

test('GET /api/games/search: missing q param is a schema validation error', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/api/games/search' });
  assert.equal(res.statusCode, 400);
});

test('GET /api/games/:id: returns a GameCard with links', async () => {
  const db = {
    query: async (sql) => {
      if (/game_links/.test(sql)) return [{ source: 'steam', url: 'https://store.steampowered.com/app/1' }];
      return [];
    },
    one: async (sql, params) => {
      assert.deepEqual(params, [42]);
      return { id: 42, name: 'Portal 2', description_en: 'desc', platforms: 'WIN', genres: null, tags: null };
    },
  };
  const app = buildTestApp({ db });

  const res = await app.inject({ method: 'GET', url: '/api/games/42' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.id, 42);
  assert.equal(body.links.steam, 'https://store.steampowered.com/app/1');
});

test('GET /api/games/:id: unknown id returns 404 {error: "not_found"}', async () => {
  const db = { query: async () => [], one: async () => null };
  const app = buildTestApp({ db });

  const res = await app.inject({ method: 'GET', url: '/api/games/999999' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'not_found' });
});

test('GET /api/games/:id: non-integer id is a schema validation error', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/api/games/not-a-number' });
  assert.equal(res.statusCode, 400);
});

test('GET /api/games/:id: accepts every configured UI language (schema enum from config.json)', async () => {
  const db = {
    query: async () => [],
    one: async () => ({ id: 1, name: 'Portal 2', description_en: 'desc', platforms: 'WIN', genres: null, tags: null }),
  };
  const app = buildTestApp({ db });

  const res = await app.inject({ method: 'GET', url: '/api/games/1?lang=ja' });
  assert.equal(res.statusCode, 200);
});

test('GET /api/games/:id: cisPrices is ignored (forced off) when lang is not "ru"', async () => {
  const db = {
    query: async () => [],
    one: async () => ({
      id: 1,
      name: 'Portal 2',
      description_en: 'desc',
      platforms: 'WIN',
      genres: null,
      tags: null,
      price_usd: 999,
      price_final_usd: 999,
      price_cis_usd: 111,
      price_final_cis_usd: 111,
    }),
  };
  const app = buildTestApp({ db });

  const res = await app.inject({ method: 'GET', url: '/api/games/1?lang=en&cisPrices=true' });
  const body = JSON.parse(res.body);
  assert.equal(body.price.currency, 'USD');
  assert.equal(body.price.final, 999);
});

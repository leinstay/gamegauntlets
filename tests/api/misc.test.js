import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTestApp, testConfig } from './helpers.js';
import { _resetCacheForTests as resetStatsCache } from '../../src/api/stats.js';

test('GET /api/dictionaries/:field: splits pipe-list columns into a sorted, deduplicated value set', async () => {
  let calls = 0;
  const db = {
    query: async (sql) => {
      calls++;
      assert.match(sql, /SELECT genres AS v FROM games/);
      return [{ v: '|Action|RPG|' }, { v: '|RPG|Indie|' }, { v: '|Action|' }];
    },
    one: async () => null,
  };
  const app = buildTestApp({ db });

  const res = await app.inject({ method: 'GET', url: '/api/dictionaries/genres' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), [
    { value: 'Action', name: 'Action' },
    { value: 'Indie', name: 'Indie' },
    { value: 'RPG', name: 'RPG' },
  ]);
  assert.equal(calls, 1);
});

test('GET /api/dictionaries/:field: result is cached (second call within TTL does not re-query)', async () => {
  let calls = 0;
  const db = { query: async () => { calls++; return [{ v: '|Action|' }]; }, one: async () => null };
  const app = buildTestApp({ db });

  await app.inject({ method: 'GET', url: '/api/dictionaries/tags' });
  await app.inject({ method: 'GET', url: '/api/dictionaries/tags' });
  assert.equal(calls, 1);
});

test('GET /api/dictionaries/:field: lang is part of the cache key', async () => {
  // Uses a field ('categories') no other test in this file touches — the dictionaries cache is
  // module-level (by design, shared across requests/apps), so reusing a field name another test
  // already warmed would make this assert on a stale cache entry instead of a fresh one.
  let calls = 0;
  const db = { query: async () => { calls++; return [{ v: '|Action|' }]; }, one: async () => null };
  const app = buildTestApp({ db });

  await app.inject({ method: 'GET', url: '/api/dictionaries/categories?lang=en' });
  await app.inject({ method: 'GET', url: '/api/dictionaries/categories?lang=ru' });
  assert.equal(calls, 2);
});

test('GET /api/dictionaries/difficulty: plain DISTINCT, no pipe-splitting', async () => {
  const db = {
    query: async (sql) => {
      assert.match(sql, /DISTINCT difficulty/);
      return [{ v: 'Easy' }, { v: 'Tough' }];
    },
    one: async () => null,
  };
  const app = buildTestApp({ db });

  const res = await app.inject({ method: 'GET', url: '/api/dictionaries/difficulty' });
  assert.deepEqual(JSON.parse(res.body), [
    { value: 'Easy', name: 'Easy' },
    { value: 'Tough', name: 'Tough' },
  ]);
});

test('GET /api/dictionaries/presets: id/name straight from the presets table', async () => {
  const db = {
    query: async (sql) => {
      assert.match(sql, /FROM presets/);
      return [{ id: 1, name: 'Roguelikes' }];
    },
    one: async () => null,
  };
  const app = buildTestApp({ db });

  const res = await app.inject({ method: 'GET', url: '/api/dictionaries/presets' });
  assert.deepEqual(JSON.parse(res.body), [{ value: 1, name: 'Roguelikes' }]);
});

test('GET /api/dictionaries/:field: unknown field is 404', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/api/dictionaries/steam_appid' });
  assert.equal(res.statusCode, 404);
});

test('GET /api/stats: aggregates the three counts and caches the result', async () => {
  resetStatsCache();
  let calls = 0;
  const db = {
    query: async () => [],
    one: async (sql) => {
      calls++;
      if (/FROM roll_log/.test(sql)) return { c: 123 };
      if (/FROM users/.test(sql)) return { c: 45 };
      if (/FROM games/.test(sql)) return { c: 6789 };
      return { c: 0 };
    },
  };
  const app = buildTestApp({ db });

  const res = await app.inject({ method: 'GET', url: '/api/stats' });
  assert.deepEqual(JSON.parse(res.body), { rolls: 123, users: 45, games: 6789 });

  await app.inject({ method: 'GET', url: '/api/stats' });
  assert.equal(calls, 3); // not 6 — second call served from the 60s cache
});

test('GET /api/stats: rolls carries the legacy all-time count via config stats.rollsOffset', async () => {
  resetStatsCache();
  const db = {
    query: async () => [],
    one: async (sql) => {
      if (/FROM roll_log/.test(sql)) return { c: 249705 };
      if (/FROM users/.test(sql)) return { c: 45 };
      if (/FROM games/.test(sql)) return { c: 6789 };
      return { c: 0 };
    },
  };
  const app = buildTestApp({ db, config: testConfig({ stats: { rollsOffset: 3546988 } }) });

  const res = await app.inject({ method: 'GET', url: '/api/stats' });
  assert.deepEqual(JSON.parse(res.body), { rolls: 3796693, users: 45, games: 6789 });
});

test('GET /api/stats: rolls offset defaults to 0 when stats.rollsOffset is missing from config', async () => {
  resetStatsCache();
  const db = {
    query: async () => [],
    one: async (sql) => {
      if (/FROM roll_log/.test(sql)) return { c: 123 };
      return { c: 0 };
    },
  };
  const app = buildTestApp({ db, config: testConfig() }); // testConfig() has no `stats` key

  const res = await app.inject({ method: 'GET', url: '/api/stats' });
  assert.equal(JSON.parse(res.body).rolls, 123);
});

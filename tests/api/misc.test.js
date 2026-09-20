import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTestApp, testConfig } from './helpers.js';
import { _resetCacheForTests as resetStatsCache } from '../../src/api/stats.js';
import { _resetCacheForTests as resetDictionariesCache } from '../../src/api/dictionaries.js';

test('GET /api/dictionaries/:field: splits pipe-list columns into a sorted, deduplicated value set', async () => {
  resetDictionariesCache();
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
  resetDictionariesCache();
  let calls = 0;
  const db = { query: async () => { calls++; return [{ v: '|Action|' }]; }, one: async () => null };
  const app = buildTestApp({ db });

  await app.inject({ method: 'GET', url: '/api/dictionaries/tags' });
  await app.inject({ method: 'GET', url: '/api/dictionaries/tags' });
  assert.equal(calls, 1);
});

test('GET /api/dictionaries/:field: lang is part of the cache key', async () => {
  resetDictionariesCache();
  let calls = 0;
  const db = { query: async () => { calls++; return [{ v: '|Action|' }]; }, one: async () => null };
  const app = buildTestApp({ db });

  await app.inject({ method: 'GET', url: '/api/dictionaries/categories?lang=en' });
  await app.inject({ method: 'GET', url: '/api/dictionaries/categories?lang=ru' });
  assert.equal(calls, 2);
});

test('GET /api/dictionaries/difficulty: plain DISTINCT, no pipe-splitting', async () => {
  resetDictionariesCache();
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
  resetDictionariesCache();
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

test('GET /api/dictionaries/developers: ordered by number of games, ties alphabetical', async () => {
  resetDictionariesCache();
  const db = {
    query: async () => [
      { v: '|!CyberApps|' },
      { v: '|Valve|' },
      { v: '|Valve|Hidden Path|' },
      { v: '|Valve|Valve|' }, // the same name twice on one game counts once
      { v: '|Hidden Path|' },
      { v: '|Aardvark|' },
    ],
    one: async () => null,
  };
  const app = buildTestApp({ db });
  const res = await app.inject({ method: 'GET', url: '/api/dictionaries/developers' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).map((x) => x.value), ['Valve', 'Hidden Path', '!CyberApps', 'Aardvark']);
});

test('GET /api/dictionaries/publishers: case-insensitive spellings merge into one entry, counts add up, most frequent spelling wins', async () => {
  resetDictionariesCache();
  const db = {
    query: async () => [
      { v: '|8floor|' },
      { v: '|8FLOOR|' },
      { v: '|8FLOOR|' }, // "8FLOOR" (2 games) outnumbers "8floor" (1 game) -> displayed spelling
      { v: '|Devolver Digital|' },
    ],
    one: async () => null,
  };
  const app = buildTestApp({ db });
  const res = await app.inject({ method: 'GET', url: '/api/dictionaries/publishers' });
  const body = JSON.parse(res.body);
  // One merged entry, not two -- "8floor" must not appear separately.
  assert.equal(body.filter((x) => /^8floor$/i.test(x.value)).length, 1);
  const merged = body.find((x) => /^8floor$/i.test(x.value));
  assert.equal(merged.value, '8FLOOR');
  assert.equal(merged.name, '8FLOOR');
});

test('GET /api/dictionaries/developers: case-merge tie-break on equal counts picks the spelling with more lower-case letters', async () => {
  resetDictionariesCache();
  const db = {
    query: async () => [
      { v: '|ABC Studio|' }, // 1 game, 0 lower-case letters in the varying part
      { v: '|Abc Studio|' }, // 1 game, 2 lower-case letters ("bc") -> wins the tie
    ],
    one: async () => null,
  };
  const app = buildTestApp({ db });
  const res = await app.inject({ method: 'GET', url: '/api/dictionaries/developers' });
  const body = JSON.parse(res.body);
  assert.equal(body.length, 1);
  assert.equal(body[0].value, 'Abc Studio');
});

test('GET /api/dictionaries/developers: without `q`, only the top TOP_LIMIT (2000) by game count are returned', async () => {
  resetDictionariesCache();
  const rows = [];
  for (let i = 0; i < 2005; i++) {
    // Zero-padded so alphabetical tie-break order matches numeric order (every name appears once, so
    // all counts tie at 1 and the alphabetical tie-break decides the order).
    rows.push({ v: '|Dev' + String(i).padStart(4, '0') + '|' });
  }
  const db = { query: async () => rows, one: async () => null };
  const app = buildTestApp({ db });
  const res = await app.inject({ method: 'GET', url: '/api/dictionaries/developers' });
  const body = JSON.parse(res.body);
  assert.equal(body.length, 2000);
  assert.equal(body[0].value, 'Dev0000');
  assert.equal(body[1999].value, 'Dev1999');
});

test('GET /api/dictionaries/developers?q=: ranks exact > starts-with > word-start > contains, then by game count within a rank', async () => {
  resetDictionariesCache();
  const db = {
    query: async () => [
      { v: '|Valve|' }, // exact match -> rank 0
      { v: '|Valve Software|' }, { v: '|Valve Software|' }, { v: '|Valve Software|' }, // starts-with, count 3
      { v: '|Valve Studios|' }, // starts-with, count 1 -> after "Valve Software" (lower count)
      { v: '|Big Valve Games|' }, // word-start (not first word) -> rank 2
      { v: '|Somethingvalveesque|' }, // mid-word contains -> rank 3
      { v: '|Unrelated|' }, // no match at all -> excluded
    ],
    one: async () => null,
  };
  const app = buildTestApp({ db });
  const res = await app.inject({ method: 'GET', url: '/api/dictionaries/developers?q=valve' });
  assert.equal(res.statusCode, 200);
  const values = JSON.parse(res.body).map((x) => x.value);
  assert.deepEqual(values, ['Valve', 'Valve Software', 'Valve Studios', 'Big Valve Games', 'Somethingvalveesque']);
});

test('GET /api/dictionaries/developers?q=: matches up to 50, over the full list not just the top 2000', async () => {
  resetDictionariesCache();
  const rows = [];
  // 2010 unrelated names (so the plain "top" list would cut this developer off) plus one match.
  for (let i = 0; i < 2010; i++) rows.push({ v: '|Zzz' + String(i).padStart(4, '0') + '|' });
  rows.push({ v: '|Needle In The Haystack|' });
  const db = { query: async () => rows, one: async () => null };
  const app = buildTestApp({ db });
  const res = await app.inject({ method: 'GET', url: '/api/dictionaries/developers?q=needle' });
  const values = JSON.parse(res.body).map((x) => x.value);
  assert.deepEqual(values, ['Needle In The Haystack']);
});

test('GET /api/dictionaries/genres?q=: `q` is ignored for fields other than developers/publishers', async () => {
  resetDictionariesCache();
  const db = { query: async () => [{ v: '|Action|RPG|Indie|' }], one: async () => null };
  const app = buildTestApp({ db });
  const withoutQ = await app.inject({ method: 'GET', url: '/api/dictionaries/genres' });
  const withQ = await app.inject({ method: 'GET', url: '/api/dictionaries/genres?q=RPG' });
  assert.deepEqual(JSON.parse(withQ.body), JSON.parse(withoutQ.body));
});

test('GET /api/dictionaries/developers?q=...: schema rejects an empty q', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/api/dictionaries/developers?q=' });
  assert.equal(res.statusCode, 400);
});

test('GET /api/dictionaries/developers?q=...: schema rejects a q longer than 64 characters', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/api/dictionaries/developers?q=' + 'a'.repeat(65) });
  assert.equal(res.statusCode, 400);
});

test('GET /api/dictionaries/developers?q=...: served from the cached full list, does not re-query the DB', async () => {
  resetDictionariesCache();
  let calls = 0;
  const db = {
    query: async () => { calls++; return [{ v: '|Valve|' }, { v: '|Valve Software|' }]; },
    one: async () => null,
  };
  const app = buildTestApp({ db });
  await app.inject({ method: 'GET', url: '/api/dictionaries/developers' });
  await app.inject({ method: 'GET', url: '/api/dictionaries/developers?q=valve' });
  await app.inject({ method: 'GET', url: '/api/dictionaries/developers?q=va' });
  assert.equal(calls, 1);
});

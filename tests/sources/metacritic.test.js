import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  name,
  rateLimit,
  metacriticSlug,
  normalizeMetacriticExternalId,
  parseMetacriticPage,
  matchesMetacriticPage,
  extract,
  pauseSource,
  checkAndMaybeResume,
  discover,
  fetchOne,
  isGamePage,
} from '../../src/sources/metacritic.js';
import { log } from '../../src/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../fixtures/metacritic');

function loadText(file) {
  return fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
}

const portal2Html = loadText('portal2.html');
const rimworldHtml = loadText('rimworld.html');
const tbdHtml = loadText('showa-tbd.html');
const blockedHtml = '<html><body>Checking your browser before accessing... Just a moment... challenge-platform</body></html>';

// --- module shape ------------------------------------------------------

test('module: exports name/rateLimit per the source module interface', () => {
  assert.equal(name, 'metacritic');
  assert.deepEqual(rateLimit, { max: 1, duration: 2500 });
});

// --- metacriticSlug (pure, live-verified rules — see the module header) ---

describe('metacriticSlug', () => {
  test('simple title', () => {
    assert.equal(metacriticSlug('Portal 2'), 'portal-2');
  });

  test('apostrophe dropped, not replaced with a separator', () => {
    assert.equal(metacriticSlug("Baldur's Gate 3"), 'baldurs-gate-3');
    assert.equal(metacriticSlug("Mirror's Edge"), 'mirrors-edge');
  });

  test('apostrophe inside a longer possessive', () => {
    assert.equal(metacriticSlug("Tom Clancy's Rainbow Six Siege"), 'tom-clancys-rainbow-six-siege');
  });

  test('colon collapses to a single hyphen with the surrounding space', () => {
    assert.equal(metacriticSlug('NieR: Automata'), 'nier-automata');
  });

  test('colon + subtitle', () => {
    assert.equal(metacriticSlug('Pokemon Legends: Arceus'), 'pokemon-legends-arceus');
  });

  test('ampersand becomes "and"', () => {
    assert.equal(metacriticSlug('Sam & Max: Save the World'), 'sam-and-max-save-the-world');
  });

  test('roman numerals are left untouched (not converted to digits)', () => {
    assert.equal(metacriticSlug('Kingdom Hearts III'), 'kingdom-hearts-iii');
  });

  test('roman numeral with a colon subtitle', () => {
    assert.equal(metacriticSlug('Divinity: Original Sin II'), 'divinity-original-sin-ii');
  });

  test('hyphen already in the title is kept as a hyphen', () => {
    assert.equal(metacriticSlug("Marvel's Spider-Man 2"), 'marvels-spider-man-2');
  });

  test('accented characters transliterated to ASCII (NFD strip)', () => {
    assert.equal(metacriticSlug('Pokémon Café'), 'pokemon-cafe');
    assert.equal(metacriticSlug('Über Soldier'), 'uber-soldier');
  });

  test('multiple consecutive punctuation/space runs collapse to one hyphen', () => {
    assert.equal(metacriticSlug('Half-Life  2:  Episode One'), 'half-life-2-episode-one');
  });

  test('leading/trailing punctuation is trimmed, not left as a stray hyphen', () => {
    assert.equal(metacriticSlug('  Doom!  '), 'doom');
    assert.equal(metacriticSlug('Doom (2016)'), 'doom-2016');
  });

  test('empty/nullish input', () => {
    assert.equal(metacriticSlug(''), '');
    assert.equal(metacriticSlug(null), '');
  });
});

// --- normalizeMetacriticExternalId (the three stored forms) --------------

describe('normalizeMetacriticExternalId', () => {
  test('legacy: external_id is already a bare slug', () => {
    assert.equal(normalizeMetacriticExternalId('portal-2'), 'portal-2');
  });

  test('wikidata: external_id "game/<slug>"', () => {
    assert.equal(normalizeMetacriticExternalId('game/portal-2'), 'portal-2');
  });

  test('wikidata: external_id "game/pc/<slug>"', () => {
    assert.equal(normalizeMetacriticExternalId('game/pc/portal-2'), 'portal-2');
  });

  test('legacy OLD url scheme: "https://www.metacritic.com/game/pc/<slug>"', () => {
    assert.equal(normalizeMetacriticExternalId('https://www.metacritic.com/game/pc/portal-2'), 'portal-2');
  });

  test('this module\'s own current url scheme: "https://www.metacritic.com/game/<slug>/"', () => {
    assert.equal(normalizeMetacriticExternalId('https://www.metacritic.com/game/portal-2/'), 'portal-2');
  });

  test('null/empty', () => {
    assert.equal(normalizeMetacriticExternalId(null), null);
    assert.equal(normalizeMetacriticExternalId(''), null);
  });
});

// --- parseMetacriticPage (pure, real trimmed fixtures) --------------------

describe('parseMetacriticPage', () => {
  test('multi-platform game: prefers the PC platform card over the JSON-LD default (Xbox lead)', () => {
    const parsed = parseMetacriticPage(portal2Html);
    assert.equal(parsed.name, 'Portal 2');
    assert.equal(parsed.datePublished, '2011-04-19');
    // JSON-LD default (page's lead platform, Xbox 360) is reviewCount 66;
    // the PC-specific card is reviewCount 52 with the same 95 score - proof
    // the PC card won, not the JSON-LD default.
    assert.equal(parsed.metascore, 95);
    assert.equal(parsed.criticReviews, 52);
    assert.equal(parsed.platform, 'pc');
    assert.equal(parsed.userScore, 89);
    assert.equal(parsed.userRatings, 4109);
  });

  test('single-platform (PC) game: platform card and JSON-LD default agree', () => {
    const parsed = parseMetacriticPage(rimworldHtml);
    assert.equal(parsed.name, 'RimWorld');
    assert.equal(parsed.metascore, 87);
    assert.equal(parsed.criticReviews, 9);
    assert.equal(parsed.platform, 'pc');
    assert.equal(parsed.userScore, 88);
    assert.equal(parsed.userRatings, 958);
  });

  test('tbd page (fewer than 4 critic reviews): valid page, no score, no platform card', () => {
    const parsed = parseMetacriticPage(tbdHtml);
    assert.equal(parsed.name, 'Showa American Story');
    assert.equal(parsed.datePublished, null);
    assert.equal(parsed.metascore, null);
    assert.equal(parsed.criticReviews, null);
    assert.equal(parsed.platform, 'default');
    assert.equal(parsed.userScore, null);
    assert.equal(parsed.userRatings, null);
  });

  test('malformed/missing JSON-LD -> everything null, does not throw', () => {
    const parsed = parseMetacriticPage('<html><body>nothing here</body></html>');
    assert.equal(parsed.name, null);
    assert.equal(parsed.metascore, null);
  });
});

// --- matchesMetacriticPage (pure) -----------------------------------------

describe('matchesMetacriticPage', () => {
  test('exact name + year within tolerance -> ok', () => {
    const decision = matchesMetacriticPage(
      { name: 'Portal 2', datePublished: '2011-04-19' },
      { name: 'Portal 2', release_date: '2011-04-19' },
    );
    assert.equal(decision.status, 'ok');
  });

  test('name matches only after stripping a subtitle -> ok', () => {
    const decision = matchesMetacriticPage(
      { name: 'Divinity', datePublished: '2017-09-14' },
      { name: 'Divinity: Original Sin II', release_date: '2017-09-14' },
    );
    assert.equal(decision.status, 'ok');
  });

  test('name matches, year differs by more than tolerance -> year_mismatch', () => {
    const decision = matchesMetacriticPage(
      { name: 'Prey', datePublished: '2006-07-11' },
      { name: 'Prey', release_date: '2017-05-05' },
    );
    assert.equal(decision.status, 'year_mismatch');
    assert.equal(decision.gameYear, 2017);
    assert.equal(decision.pageYear, 2006);
  });

  test('year unknown on one side -> not enough to reject, still ok', () => {
    const decision = matchesMetacriticPage({ name: 'Portal 2', datePublished: null }, { name: 'Portal 2', release_date: '2011-04-19' });
    assert.equal(decision.status, 'ok');
  });

  test('name does not match -> no_match', () => {
    const decision = matchesMetacriticPage({ name: 'Portal 2' }, { name: 'Some Totally Different Game' });
    assert.equal(decision.status, 'no_match');
  });

  test('no page name at all -> no_match', () => {
    const decision = matchesMetacriticPage({ name: null }, { name: 'Portal 2' });
    assert.equal(decision.status, 'no_match');
  });
});

// --- extract() -------------------------------------------------------------

describe('extract', () => {
  test('full payload -> all vocabulary fields', () => {
    const out = extract({
      slug: 'portal-2',
      url: 'https://www.metacritic.com/game/portal-2/',
      name: 'Portal 2',
      datePublished: '2011-04-19',
      metascore: 95,
      criticReviews: 52,
      userScore: 89,
      userRatings: 4109,
      platform: 'pc',
      fetchedVia: 'link',
    });
    assert.equal(out.scoreCritics, 95);
    assert.equal(out.scoreCriticsCount, 52);
    assert.equal(out.scoreCriticsSource, 'metacritic');
    assert.equal(out.scoreUsersMetacritic, 89);
    assert.deepEqual(out.release, { date: '2011-04-19', precision: 'day' });
    assert.deepEqual(out.links, { metacritic: { id: 'portal-2', url: 'https://www.metacritic.com/game/portal-2/' } });
  });

  test('tbd payload (null score/user score/date) -> those keys are omitted, link still reported', () => {
    const out = extract({
      slug: 'showa-american-story',
      url: 'https://www.metacritic.com/game/showa-american-story/',
      name: 'Showa American Story',
      datePublished: null,
      metascore: null,
      criticReviews: null,
      userScore: null,
      userRatings: null,
      platform: 'default',
      fetchedVia: 'slug-guess',
    });
    assert.equal('scoreCritics' in out, false);
    assert.equal('scoreCriticsSource' in out, false);
    assert.equal('scoreUsersMetacritic' in out, false);
    assert.equal('release' in out, false);
    assert.deepEqual(out.links, { metacritic: { id: 'showa-american-story', url: 'https://www.metacritic.com/game/showa-american-story/' } });
  });

  test('null/empty payload -> {}', () => {
    assert.deepEqual(extract(null), {});
    assert.deepEqual(extract(undefined), {});
  });
});

// --- pauseSource / checkAndMaybeResume -------------------------------------

function fakeStateDb({ paused = 0, cursor_state = null } = {}) {
  let row = { paused, cursor_state };
  const calls = [];
  const db = {
    one: async (sql) => {
      if (sql.includes('paused, cursor_state')) return { paused: row.paused, cursor_state: row.cursor_state };
      if (sql.includes('cursor_state')) return { cursor_state: row.cursor_state };
      return row;
    },
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith('INSERT INTO source_state')) {
        row = { paused: 1, cursor_state: params[1] };
      } else if (sql.startsWith('UPDATE source_state')) {
        row = { paused: 0, cursor_state: params[0] };
      }
      return [];
    },
  };
  return { db, calls, row: () => row };
}

test('pauseSource: sets paused=1 and a pausedUntil ~24h out', async () => {
  const state = fakeStateDb();
  const now = () => Date.parse('2026-09-19T00:00:00Z');
  await pauseSource({ db: state.db }, 'blocked while fetching portal-2', { now });
  assert.equal(state.row().paused, 1);
  const cursorState = JSON.parse(state.row().cursor_state);
  assert.equal(cursorState.pausedUntil, '2026-09-20T00:00:00.000Z');
});

test('checkAndMaybeResume: still within the pause window -> stays paused', async () => {
  const state = fakeStateDb({ paused: 1, cursor_state: JSON.stringify({ pausedUntil: '2026-09-20T00:00:00.000Z' }) });
  const now = () => Date.parse('2026-09-19T12:00:00Z');
  const result = await checkAndMaybeResume({ db: state.db }, { now });
  assert.equal(result.paused, true);
  assert.equal(result.pausedUntil, '2026-09-20T00:00:00.000Z');
});

test('checkAndMaybeResume: past the pause window -> resumes', async () => {
  const state = fakeStateDb({ paused: 1, cursor_state: JSON.stringify({ pausedUntil: '2026-09-20T00:00:00.000Z' }) });
  const now = () => Date.parse('2026-09-21T00:00:00Z');
  const result = await checkAndMaybeResume({ db: state.db }, { now });
  assert.equal(result.paused, false);
  assert.equal(state.row().paused, 0);
});

test('checkAndMaybeResume: not paused -> reports not paused without touching the row', async () => {
  const state = fakeStateDb({ paused: 0, cursor_state: null });
  const result = await checkAndMaybeResume({ db: state.db });
  assert.equal(result.paused, false);
});

// --- discover() ------------------------------------------------------------

function fakeDiscoverCtx({ paused = false, candidateRows = [], sourceConfig = {} } = {}) {
  const enqueued = [];
  const queries = [];
  const db = {
    one: async (sql) => {
      if (sql.includes('paused, cursor_state')) return { paused: paused ? 1 : 0, cursor_state: null };
      if (sql.includes('FROM source_state')) return { paused: paused ? 1 : 0 };
      return null;
    },
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.startsWith('INSERT INTO source_state')) return [];
      if (sql.includes('LEFT JOIN source_records')) return candidateRows;
      if (sql.startsWith('UPDATE source_state')) return [];
      return [];
    },
  };
  return {
    ctx: { db, log, config: { sources: { metacritic: sourceConfig } }, enqueue: async (source, data) => enqueued.push({ source, data }) },
    enqueued,
    queries,
  };
}

test('discover: enqueues a job per candidate game, popular-first via the query order', async () => {
  const { ctx, enqueued } = fakeDiscoverCtx({ candidateRows: [{ id: 10 }, { id: 20 }, { id: 30 }] });
  const result = await discover(ctx);
  assert.equal(result.enqueued, 3);
  assert.deepEqual(
    enqueued.map((e) => e.data.gameId),
    [10, 20, 30],
  );
  assert.equal(enqueued[0].source, 'metacritic');
});

test('discover: orders by score_steam_votes DESC (not owners_estimate, per the task)', async () => {
  const { ctx, queries } = fakeDiscoverCtx({ candidateRows: [] });
  await discover(ctx);
  const candidateQuery = queries.find((q) => q.sql.includes('LEFT JOIN source_records'));
  assert.match(candidateQuery.sql, /ORDER BY g\.score_steam_votes DESC/);
});

test('discover: passes refreshDays/retryDays/dailyCap from config', async () => {
  const { ctx, queries } = fakeDiscoverCtx({ candidateRows: [], sourceConfig: { refreshDays: 12, retryDays: 34, dailyCap: 56 } });
  await discover(ctx);
  const candidateQuery = queries.find((q) => q.sql.includes('LEFT JOIN source_records'));
  assert.deepEqual(candidateQuery.params, ['metacritic', 12, 34, 56]);
});

test('discover: skips (and does not query candidates) while paused', async () => {
  const { ctx, enqueued } = fakeDiscoverCtx({ paused: true, candidateRows: [{ id: 1 }] });
  const result = await discover(ctx);
  assert.equal(result.skipped, true);
  assert.equal(result.paused, true);
  assert.equal(enqueued.length, 0);
});

test('discover: skips entirely when disabled in config', async () => {
  const { ctx, enqueued } = fakeDiscoverCtx({ candidateRows: [{ id: 1 }], sourceConfig: { enabled: false } });
  const result = await discover(ctx);
  assert.equal(result.skipped, true);
  assert.equal(enqueued.length, 0);
});

// --- fetchOne(): DB + HTTP facing logic, fake ctx --------------------------

function fakeHttp({ pages = {} } = {}) {
  return {
    getText: async (url) => {
      const p = new URL(url).pathname;
      if (!Object.prototype.hasOwnProperty.call(pages, p)) {
        throw new Error(`fakeHttp: unexpected page path ${p}`);
      }
      const entry = pages[p];
      if (entry === null) {
        const err = new Error('not found');
        err.statusCode = 404;
        throw err;
      }
      if (entry?.blocked) {
        const err = new Error('blocked');
        err.statusCode = 403;
        err.body = blockedHtml;
        throw err;
      }
      return entry;
    },
  };
}

function fakeFetchCtx({ game, existingLink = null, upsertRecordCalls = [], upsertLinkCalls = [], enqueueResolveCalls = [], conflictCalls = [], pauseCalls = [], http }) {
  const db = {
    one: async (sql) => {
      if (sql.includes('FROM games WHERE id')) return game;
      if (sql.includes('FROM game_links')) return existingLink;
      if (sql.includes('FROM source_state')) return null;
      return null;
    },
    query: async (sql, params) => {
      if (sql.startsWith('INSERT INTO conflicts')) conflictCalls.push(params);
      if (sql.startsWith('INSERT INTO source_state')) pauseCalls.push(params);
      return [];
    },
  };
  return {
    http,
    log,
    env: {},
    config: {},
    db,
    upsertRecord: async (source, externalId, opts) => upsertRecordCalls.push({ source, externalId, opts }),
    upsertLink: async (gameId, source, externalId, opts) => upsertLinkCalls.push({ gameId, source, externalId, opts }),
    enqueueResolve: async (gameId) => enqueueResolveCalls.push(gameId),
  };
}

test('fetchOne: existing legacy link (bare slug) -> fetches directly, no guess', async () => {
  const http = fakeHttp({ pages: { '/game/portal-2/': portal2Html } });
  const upsertRecordCalls = [];
  const upsertLinkCalls = [];
  const enqueueResolveCalls = [];
  const ctx = fakeFetchCtx({
    http,
    game: { id: 5, name: 'Portal 2', release_date: '2011-04-19' },
    existingLink: { external_id: 'portal-2', url: 'https://www.metacritic.com/game/pc/portal-2', match_method: 'legacy', confidence: 100 },
    upsertRecordCalls,
    upsertLinkCalls,
    enqueueResolveCalls,
  });
  const result = await fetchOne(ctx, { data: { gameId: 5 } });
  assert.equal(result.status, 'ok');
  assert.equal(result.externalId, 'portal-2');
  assert.equal(upsertRecordCalls[0].opts.status, 'ok');
  assert.equal(upsertRecordCalls[0].opts.payload.platform, 'pc');
  assert.equal(upsertLinkCalls[0].opts.method, 'legacy');
  assert.equal(upsertLinkCalls[0].opts.url, 'https://www.metacritic.com/game/portal-2/');
  assert.deepEqual(enqueueResolveCalls, [5]);
});

test('fetchOne: existing wikidata-style link ("game/pc/<slug>") -> normalises before fetching', async () => {
  const http = fakeHttp({ pages: { '/game/portal-2/': portal2Html } });
  const upsertLinkCalls = [];
  const ctx = fakeFetchCtx({
    http,
    game: { id: 5, name: 'Portal 2', release_date: '2011-04-19' },
    existingLink: { external_id: 'game/pc/portal-2', url: null, match_method: 'wikidata', confidence: 95 },
    upsertLinkCalls,
  });
  const result = await fetchOne(ctx, { data: { gameId: 5 } });
  assert.equal(result.status, 'ok');
  assert.equal(result.externalId, 'portal-2');
  assert.equal(upsertLinkCalls[0].opts.method, 'wikidata');
});

test('fetchOne: no existing link -> guesses the slug, name/year match -> links as "name"', async () => {
  const http = fakeHttp({ pages: { '/game/portal-2/': portal2Html } });
  const upsertLinkCalls = [];
  const enqueueResolveCalls = [];
  const ctx = fakeFetchCtx({ http, game: { id: 5, name: 'Portal 2', release_date: '2011-04-19' }, existingLink: null, upsertLinkCalls, enqueueResolveCalls });
  const result = await fetchOne(ctx, { data: { gameId: 5 } });
  assert.equal(result.status, 'ok');
  assert.equal(upsertLinkCalls[0].opts.method, 'name');
  assert.equal(upsertLinkCalls[0].opts.confidence, 90);
  assert.deepEqual(enqueueResolveCalls, [5]);
});

test('fetchOne: no existing link, slug guess resolves to a different game -> not_found, no link', async () => {
  const upsertRecordCalls = [];
  const upsertLinkCalls = [];
  const ctx = fakeFetchCtx({
    // The slug guessed from "Some Other Game" happens to serve the Portal 2
    // fixture page here (unrelated title) - exercising the no_match branch
    // of matchesMetacriticPage, where the page's own JSON-LD name ("Portal
    // 2") never matches the game we were looking for.
    http: fakeHttp({ pages: { '/game/some-other-game/': portal2Html } }),
    game: { id: 9, name: 'Some Other Game', release_date: null },
    existingLink: null,
    upsertRecordCalls,
    upsertLinkCalls,
  });
  const result = await fetchOne(ctx, { data: { gameId: 9 } });
  assert.equal(result.status, 'not_found');
  assert.equal(upsertRecordCalls[0].opts.status, 'not_found');
  assert.equal(upsertLinkCalls.length, 0);
});

test('fetchOne: no existing link, name matches but year differs beyond tolerance -> conflict, not_found', async () => {
  const http = fakeHttp({ pages: { '/game/portal-2/': portal2Html } });
  const conflictCalls = [];
  const upsertRecordCalls = [];
  const upsertLinkCalls = [];
  const enqueueResolveCalls = [];
  const ctx = fakeFetchCtx({
    http,
    game: { id: 5, name: 'Portal 2', release_date: '1990-01-01' },
    existingLink: null,
    conflictCalls,
    upsertRecordCalls,
    upsertLinkCalls,
    enqueueResolveCalls,
  });
  const result = await fetchOne(ctx, { data: { gameId: 5 } });
  assert.equal(result.status, 'year_mismatch');
  assert.equal(conflictCalls.length, 1);
  assert.equal(upsertRecordCalls[0].opts.status, 'not_found');
  assert.equal(upsertLinkCalls.length, 0);
  assert.equal(enqueueResolveCalls.length, 0);
});

test('fetchOne: legacy link 404s -> falls through to a fresh slug guess', async () => {
  const http = fakeHttp({ pages: { '/game/old-rotted-slug/': null, '/game/portal-2/': portal2Html } });
  const upsertLinkCalls = [];
  const ctx = fakeFetchCtx({
    http,
    game: { id: 5, name: 'Portal 2', release_date: '2011-04-19' },
    existingLink: { external_id: 'old-rotted-slug', url: null, match_method: 'legacy', confidence: 100 },
    upsertLinkCalls,
  });
  const result = await fetchOne(ctx, { data: { gameId: 5 } });
  assert.equal(result.status, 'ok');
  assert.equal(result.externalId, 'portal-2');
  assert.equal(upsertLinkCalls[0].opts.method, 'name');
});

test('fetchOne: a non-legacy link (wikidata/name/manual) that 404s does NOT fall through', async () => {
  const http = fakeHttp({ pages: { '/game/gone-slug/': null } });
  const upsertRecordCalls = [];
  const ctx = fakeFetchCtx({
    http,
    game: { id: 5, name: 'Portal 2', release_date: '2011-04-19' },
    existingLink: { external_id: 'gone-slug', url: null, match_method: 'name', confidence: 90 },
    upsertRecordCalls,
  });
  const result = await fetchOne(ctx, { data: { gameId: 5 } });
  assert.equal(result.status, 'not_found');
  assert.equal(upsertRecordCalls[0].opts.status, 'not_found');
});

test('fetchOne: blocked -> pauses the source and throws (so BullMQ retries later)', async () => {
  const http = fakeHttp({ pages: { '/game/portal-2/': { blocked: true } } });
  const upsertRecordCalls = [];
  const pauseCalls = [];
  const ctx = fakeFetchCtx({
    http,
    game: { id: 5, name: 'Portal 2', release_date: '2011-04-19' },
    existingLink: { external_id: 'portal-2', url: null, match_method: 'legacy', confidence: 100 },
    upsertRecordCalls,
    pauseCalls,
  });
  await assert.rejects(() => fetchOne(ctx, { data: { gameId: 5 } }), /blocked/);
  assert.equal(pauseCalls.length, 1);
  const [pausedSource, cursorState] = pauseCalls[0];
  assert.equal(pausedSource, 'metacritic');
  assert.match(JSON.parse(cursorState).pausedUntil, /^\d{4}-\d{2}-\d{2}T/);
});

test('fetchOne: tbd page (no score yet) -> still links, payload has null score fields', async () => {
  const http = fakeHttp({ pages: { '/game/showa-american-story/': tbdHtml } });
  const upsertRecordCalls = [];
  const upsertLinkCalls = [];
  const ctx = fakeFetchCtx({
    http,
    game: { id: 8, name: 'Showa American Story', release_date: null },
    existingLink: null,
    upsertRecordCalls,
    upsertLinkCalls,
  });
  const result = await fetchOne(ctx, { data: { gameId: 8 } });
  assert.equal(result.status, 'ok');
  assert.equal(result.payload.metascore, null);
  assert.equal(upsertLinkCalls[0].opts.method, 'name');
});

test('fetchOne: unknown gameId -> not_found without touching HTTP', async () => {
  const http = fakeHttp({});
  const ctx = fakeFetchCtx({ http, game: null, existingLink: null });
  const result = await fetchOne(ctx, { data: { gameId: 999 } });
  assert.equal(result.status, 'not_found');
});

test('fetchOne: missing gameId throws synchronously', async () => {
  const ctx = fakeFetchCtx({ http: fakeHttp({}), game: null });
  await assert.rejects(() => fetchOne(ctx, { data: {} }), /gameId is required/);
});

test('isGamePage: a real page that embeds the Cloudflare challenge-platform script is not a block', () => {
  const html = loadText('portal2.html') + '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>';
  assert.equal(isGamePage(html), true);
  assert.equal(isGamePage(blockedHtml), false);
});

test('matchesMetacriticPage: page dated up to 3 years after the catalog year is accepted (Early Access), earlier or later is not', () => {
  const page = (y) => ({ name: 'Hades', datePublished: y + '-09-17' });
  assert.equal(matchesMetacriticPage(page(2020), { name: 'Hades', release_date: '2018-12-06' }).status, 'ok');
  assert.equal(matchesMetacriticPage(page(2021), { name: 'Hades', release_date: '2018-12-06' }).status, 'ok');
  assert.equal(matchesMetacriticPage(page(2023), { name: 'Hades', release_date: '2018-12-06' }).status, 'year_mismatch');
  assert.equal(matchesMetacriticPage(page(2016), { name: 'Hades', release_date: '2018-12-06' }).status, 'year_mismatch');
});

test('parseMetacriticPage: PC still tbd -> falls back to the headline (lead platform) Metascore', () => {
  const parsed = parseMetacriticPage(loadText('phasmophobia-pc-tbd.html'));
  assert.equal(parsed.name, 'Phasmophobia');
  assert.equal(parsed.metascore, 76);
  assert.equal(parsed.criticReviews, 9);
  assert.equal(parsed.platform, 'default');
  assert.equal(parsed.userScore, null);
});

test('metacriticSlug: periods are dropped (BeamNG.drive, S.T.A.L.K.E.R., Dr. Mario)', () => {
  assert.equal(metacriticSlug('BeamNG.drive'), 'beamngdrive');
  assert.equal(metacriticSlug('S.T.A.L.K.E.R.: Shadow of Chernobyl'), 'stalker-shadow-of-chernobyl');
  assert.equal(metacriticSlug('Dr. Mario'), 'dr-mario');
});

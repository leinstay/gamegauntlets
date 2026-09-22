import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  name,
  rateLimit,
  toAscii,
  isBlockedBody,
  isBlockedResponse,
  platsIncludePc,
  matchGamefaqsCandidate,
  findPcAlternateUrl,
  pidFromUrl,
  parseGamefaqsPage,
  extract,
  locateGamefaqsProduct,
  pauseSource,
  checkAndMaybeResume,
  discover,
  fetchOne,
} from '../../src/sources/gamefaqs.js';
import { log } from '../../src/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '../fixtures/gamefaqs');

function loadText(file) {
  return fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
}
function loadJson(file) {
  return JSON.parse(loadText(file));
}

const witcher3Search = loadJson('search-witcher3.json');
const acodSearch = loadJson('search-acod.json');
const portal2FullSearch = loadJson('search-portal2-full.json');
const portal2StrippedSearch = loadJson('search-portal2-stripped.json');
const portalPcHtml = loadText('portal-pc.html');
const acodPcHtml = loadText('acod-pc.html');
const acodPs4DefaultHtml = loadText('acod-ps4-default.html');
const legendsUnratedHtml = loadText('legends-of-elysium-unrated.html');
const cloudflareBlockHtml = loadText('cloudflare-block.html');

// --- module shape ------------------------------------------------------

test('module: exports name/rateLimit per the source module interface', () => {
  assert.equal(name, 'gamefaqs');
  assert.deepEqual(rateLimit, { max: 1, duration: 3000 });
});

// --- toAscii -------------------------------------------------------------

test('toAscii: folds curly quotes/dashes/ellipsis to ASCII', () => {
  assert.equal(toAscii('‘Doom’ – 2016'), "'Doom' - 2016");
  assert.equal(toAscii('Wait…'), 'Wait...');
  assert.equal(toAscii(null), '');
});

// --- block detection (real, recorded Cloudflare interstitial) -----------

test('isBlockedBody: recognises the real Cloudflare "Just a moment..." interstitial', () => {
  assert.equal(isBlockedBody(cloudflareBlockHtml), true);
});

test('isBlockedBody: false for a normal game page', () => {
  assert.equal(isBlockedBody(portalPcHtml), false);
});

test('isBlockedBody: recognises the legacy IP-ban wording', () => {
  assert.equal(isBlockedBody('Your IP address has been temporarily blocked'), true);
  assert.equal(isBlockedBody('503 Service Temporarily Unavailable'), true);
  assert.equal(isBlockedBody(''), false);
  assert.equal(isBlockedBody(null), false);
});

test('isBlockedResponse: 403/503 status codes are always a block regardless of body', () => {
  assert.equal(isBlockedResponse(403, 'anything'), true);
  assert.equal(isBlockedResponse(503, ''), true);
  assert.equal(isBlockedResponse(404, 'not found'), false);
  assert.equal(isBlockedResponse(200, cloudflareBlockHtml), true);
});

// --- platsIncludePc --------------------------------------------------------

test('platsIncludePc: reads the comma-separated plats field', () => {
  assert.equal(platsIncludePc({ plats: 'MAC, NS, PC, PS4' }), true);
  assert.equal(platsIncludePc({ plats: 'PS4, XONE' }), false);
  assert.equal(platsIncludePc({}), false);
});

// --- matchGamefaqsCandidate (pure, real search fixtures) -----------------

test('matchGamefaqsCandidate: exact match confirmed by year (Witcher 3, already the PC product)', () => {
  const decision = matchGamefaqsCandidate('The Witcher 3: Wild Hunt', witcher3Search, { year: 2015 });
  assert.equal(decision.status, 'ok');
  assert.equal(decision.candidate.pid, '699808');
  assert.equal(decision.candidate.platform_url, 'pc');
});

test('matchGamefaqsCandidate: without a year, a same-named cross-platform bundle row makes it ambiguous', () => {
  // normalizeName() truncates at "/" (legacy simpleName()'s own behaviour), so
  // "The Witcher 3: Wild Hunt / Dark Souls III Double Pack" normalizes to the
  // exact same key as the base game — a real quirk seen in the live search
  // fixture, not a synthetic case.
  const decision = matchGamefaqsCandidate('The Witcher 3: Wild Hunt', witcher3Search);
  assert.equal(decision.status, 'ambiguous');
  assert.equal(decision.candidates.length, 2);
});

test('matchGamefaqsCandidate: exact single match whose default product is NOT the PC platform', () => {
  const decision = matchGamefaqsCandidate("Assassin's Creed Odyssey", acodSearch);
  assert.equal(decision.status, 'ok');
  assert.equal(decision.candidate.pid, '240205');
  assert.equal(decision.candidate.platform_url, 'ps4');
  assert.equal(platsIncludePc(decision.candidate), true);
});

test('matchGamefaqsCandidate: no exact match when the query still carries a subtitle GameFAQs does not have', () => {
  const decision = matchGamefaqsCandidate('Portal 2: Perpetual Testing Initiative', portal2FullSearch);
  assert.equal(decision.status, 'none');
});

test('matchGamefaqsCandidate: exact match once the subtitle is stripped (the legacy-bug-fix query)', () => {
  const decision = matchGamefaqsCandidate('Portal 2', portal2StrippedSearch);
  assert.equal(decision.status, 'ok');
  assert.equal(decision.candidate.pid, '991073');
});

test('matchGamefaqsCandidate: an inexact title with no year to confirm it stays "none" — fuzzy alone is not enough', () => {
  const decision = matchGamefaqsCandidate('The Witcher 3', witcher3Search);
  assert.equal(decision.status, 'none');
});

// --- matchGamefaqsCandidate: fuzzy fallback (confirmed by release year) ---

test('matchGamefaqsCandidate: no exact match, but a high-similarity title confirmed by year -> ok, fuzzy:true', () => {
  const results = [{ pid: '1', game_name: 'Baldurs Gate 3', plats: 'PC', date_released: '2023-08-03' }];
  const decision = matchGamefaqsCandidate("Baldur's Gate 3", results, { year: 2023 });
  assert.equal(decision.status, 'ok');
  assert.equal(decision.candidate.pid, '1');
  assert.equal(decision.fuzzy, true);
});

test('matchGamefaqsCandidate: fuzzy title but release year off by more than the tolerance -> none', () => {
  const results = [{ pid: '1', game_name: 'Baldurs Gate 3', plats: 'PC', date_released: '2023-08-03' }];
  const decision = matchGamefaqsCandidate("Baldur's Gate 3", results, { year: 2020 });
  assert.equal(decision.status, 'none');
});

test('matchGamefaqsCandidate: fuzzy title with no year known on either side -> none (year confirmation is mandatory)', () => {
  const results = [{ pid: '1', game_name: 'Baldurs Gate 3', plats: 'PC', date_released: '2023-08-03' }];
  const decision = matchGamefaqsCandidate("Baldur's Gate 3", results);
  assert.equal(decision.status, 'none');
});

test('matchGamefaqsCandidate: two fuzzy candidates confirmed by the same year -> ambiguous', () => {
  const results = [
    { pid: '1', game_name: 'Baldurs Gate 3', plats: 'PC', date_released: '2023-08-03' },
    { pid: '2', game_name: 'Baldurs Gate3', plats: 'PC', date_released: '2023-08-03' },
  ];
  const decision = matchGamefaqsCandidate("Baldur's Gate 3", results, { year: 2023 });
  assert.equal(decision.status, 'ambiguous');
  assert.equal(decision.candidates.length, 2);
});

test('matchGamefaqsCandidate: similarity below FUZZY_MIN_SIM never qualifies, even with a matching year (Yakuza 3 vs Yakuza 5)', () => {
  const results = [{ pid: '1', game_name: 'Yakuza 5', plats: 'PC', date_released: '2012-12-06' }];
  const decision = matchGamefaqsCandidate('Yakuza 3', results, { year: 2012 });
  assert.equal(decision.status, 'none');
});

test('matchGamefaqsCandidate: similarity below FUZZY_MIN_SIM never qualifies, even with a matching year (Doom vs Doom 3)', () => {
  const results = [{ pid: '1', game_name: 'Doom 3', plats: 'PC', date_released: '2004-08-13' }];
  const decision = matchGamefaqsCandidate('Doom', results, { year: 2004 });
  assert.equal(decision.status, 'none');
});

test('matchGamefaqsCandidate: two exact matches, confirmed by year -> ok', () => {
  const results = [
    { pid: '1', game_name: 'Doom', plats: 'PC', date_released: '1993-12-10', footer: false },
    { pid: '2', game_name: 'Doom', plats: 'PC', date_released: '2016-05-13', footer: false },
  ];
  const decision = matchGamefaqsCandidate('Doom', results, { year: 1993 });
  assert.equal(decision.status, 'ok');
  assert.equal(decision.candidate.pid, '1');
});

test('matchGamefaqsCandidate: two exact matches, no year available -> ambiguous', () => {
  const results = [
    { pid: '1', game_name: 'Doom', plats: 'PC', date_released: '1993-12-10' },
    { pid: '2', game_name: 'Doom', plats: 'PC', date_released: '2016-05-13' },
  ];
  const decision = matchGamefaqsCandidate('Doom', results);
  assert.equal(decision.status, 'ambiguous');
  assert.equal(decision.candidates.length, 2);
});

test('matchGamefaqsCandidate: two exact matches, year confirms neither/both -> ambiguous', () => {
  const results = [
    { pid: '1', game_name: 'Doom', plats: 'PC', date_released: '1993-12-10' },
    { pid: '2', game_name: 'Doom', plats: 'PC', date_released: '2016-05-13' },
  ];
  const decision = matchGamefaqsCandidate('Doom', results, { year: 2005 });
  assert.equal(decision.status, 'ambiguous');
});

test('matchGamefaqsCandidate: drops the trailing {footer:true} row', () => {
  const decision = matchGamefaqsCandidate('The Witcher 3: Wild Hunt', witcher3Search);
  assert.notEqual(decision.candidate?.footer, true);
});

// --- findPcAlternateUrl / pidFromUrl (pure, real page fixtures) ----------

test('findPcAlternateUrl: finds the PC cross-link on a non-PC default-platform page', () => {
  const href = findPcAlternateUrl(acodPs4DefaultHtml);
  assert.equal(href, '/pc/241126-assassins-creed-odyssey');
});

test('findPcAlternateUrl: null when already on the PC page (no "PC" entry in its own switcher)', () => {
  const href = findPcAlternateUrl(portalPcHtml);
  assert.equal(href, null);
});

test('pidFromUrl: extracts the numeric id from a platform/pid-slug path', () => {
  assert.equal(pidFromUrl('/pc/241126-assassins-creed-odyssey'), '241126');
  assert.equal(pidFromUrl('/pc/934386-portal'), '934386');
  assert.equal(pidFromUrl(null), null);
  assert.equal(pidFromUrl('/not-a-product-path'), null);
});

// --- parseGamefaqsPage (pure, real page fixtures) -------------------------

test('parseGamefaqsPage: Portal (PC) — full stats + release', () => {
  const parsed = parseGamefaqsPage(portalPcHtml);
  assert.equal(parsed.pageName, 'Portal');
  assert.equal(parsed.difficultyLabel, 'Just Right');
  assert.equal(parsed.ratingTitle, 'Average: 4.31 stars from 4105 users');
  assert.equal(parsed.lengthTitle, 'Average: 9 hours from 2444 users');
  assert.equal(parsed.releaseRaw, 'October 10, 2007');
});

test('parseGamefaqsPage: Assassin\'s Creed Odyssey (PC) — "Over 80 Hours" style length', () => {
  const parsed = parseGamefaqsPage(acodPcHtml);
  assert.equal(parsed.difficultyLabel, 'Just Right');
  assert.equal(parsed.ratingTitle, 'Average: 3.77 stars from 316 users');
  assert.equal(parsed.lengthTitle, 'Average: 80+ hours from 228 users');
  assert.match(parsed.releaseRaw, /October\s+2, 2018/);
});

test('parseGamefaqsPage: "Unrated" stats (no submissions yet) are reported as absent, not as text', () => {
  const parsed = parseGamefaqsPage(legendsUnratedHtml);
  assert.equal(parsed.difficultyLabel, null);
  assert.equal(parsed.ratingTitle, null);
  assert.equal(parsed.lengthTitle, null);
  assert.equal(parsed.releaseRaw, 'March 26, 2025');
});

// --- extract() (pure) ------------------------------------------------------

test('extract: maps a fully-rated payload to the vocabulary', () => {
  const payload = {
    pid: '934386',
    url: 'https://gamefaqs.gamespot.com/pc/934386-portal',
    ...parseGamefaqsPage(portalPcHtml),
  };
  const fields = extract(payload);
  assert.equal(fields.difficulty, 'Just Right');
  assert.equal(fields.scoreGamefaqs, 4.31);
  assert.equal(fields.timeGamefaqs, 9);
  assert.deepEqual(fields.release, { date: '2007-10-10', precision: 'day' });
  assert.deepEqual(fields.links, { gamefaqs: { id: '934386', url: 'https://gamefaqs.gamespot.com/pc/934386-portal' } });
});

test('extract: "Over 80 Hours" / "80+ hours" style length -> numeric 80', () => {
  const payload = { pid: '241126', url: 'https://gamefaqs.gamespot.com/pc/241126-x', ...parseGamefaqsPage(acodPcHtml) };
  const fields = extract(payload);
  assert.equal(fields.timeGamefaqs, 80);
});

test('extract: an unrated payload contributes no difficulty/score/time, but still resolves the release date', () => {
  const payload = { pid: '515984', url: 'https://gamefaqs.gamespot.com/pc/515984-x', ...parseGamefaqsPage(legendsUnratedHtml) };
  const fields = extract(payload);
  assert.equal(fields.difficulty, undefined);
  assert.equal(fields.scoreGamefaqs, undefined);
  assert.equal(fields.timeGamefaqs, undefined);
  assert.deepEqual(fields.release, { date: '2025-03-26', precision: 'day' });
});

test('extract: empty/missing payload -> empty fields, never throws', () => {
  assert.deepEqual(extract(null), {});
  assert.deepEqual(extract({}), {});
});

// --- locateGamefaqsProduct (search + optional cross-link) -----------------

const BASE = 'https://gamefaqs.gamespot.com';

function fakeHttp({ search = {}, pages = {} } = {}) {
  return {
    getJson: async (url) => {
      const term = new URL(url).searchParams.get('term');
      if (!Object.prototype.hasOwnProperty.call(search, term)) {
        throw new Error(`fakeHttp: unexpected search term ${JSON.stringify(term)}`);
      }
      const entry = search[term];
      if (entry.blocked) {
        const err = new Error('blocked');
        err.statusCode = 403;
        err.body = cloudflareBlockHtml;
        throw err;
      }
      return entry;
    },
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
        err.body = cloudflareBlockHtml;
        throw err;
      }
      return entry;
    },
  };
}

function fakeCtx({ http, env = {} }) {
  return { http, env, log };
}

test('locateGamefaqsProduct: exact match already on the PC platform — no extra page fetch needed', async () => {
  const http = fakeHttp({ search: { 'Witcher 3 Wild Hunt': witcher3Search } });
  const located = await locateGamefaqsProduct(fakeCtx({ http }), { name: 'The Witcher 3: Wild Hunt', release_date: '2015-05-19' });
  assert.equal(located.status, 'ok');
  assert.equal(located.pid, '699808');
  assert.equal(located.url, `${BASE}/pc/699808-the-witcher-3-wild-hunt`);
});

test('locateGamefaqsProduct: default platform is not PC — follows the header cross-link to the real PC product', async () => {
  const http = fakeHttp({
    search: { 'Assassin s Creed Odyssey': acodSearch },
    pages: { '/ps4/240205-assassins-creed-odyssey': acodPs4DefaultHtml },
  });
  const located = await locateGamefaqsProduct(fakeCtx({ http }), { name: "Assassin's Creed Odyssey", release_date: '2018-10-05' });
  assert.equal(located.status, 'ok');
  assert.equal(located.pid, '241126');
  assert.equal(located.url, `${BASE}/pc/241126-assassins-creed-odyssey`);
});

test('locateGamefaqsProduct: first query (full name) misses, retries with the subtitle stripped', async () => {
  const http = fakeHttp({
    search: {
      'Portal 2 Perpetual Testing Initiative': portal2FullSearch,
      'Portal 2': portal2StrippedSearch,
    },
  });
  const located = await locateGamefaqsProduct(fakeCtx({ http }), { name: 'Portal 2: Perpetual Testing Initiative', release_date: null });
  assert.equal(located.status, 'ok');
  assert.equal(located.pid, '991073');
});

test('locateGamefaqsProduct: first query (full name + marketing suffix) misses, second variant ("Gauntlet") matches by year among several same-named rows', async () => {
  // Real case from the 2026-09-22 report: "Gauntlet™ Slayer Edition" ->
  // normalizeName gives "Gauntlet Slayer Edition" (GameFAQs has no such
  // title); searchNameVariants' 2nd entry strips the "Slayer Edition"
  // marketing suffix down to "Gauntlet", which matches GameFAQs' "Gauntlet
  // (2014)" once the release year (2014) picks it out from older Gauntlet
  // entries GameFAQs also carries.
  const gauntletResults = [
    { pid: '1', game_name: 'Gauntlet', plats: 'PC', platform_url: 'pc', url: '/pc/1-gauntlet', date_released: '1985-01-01' },
    { pid: '2', game_name: 'Gauntlet', plats: 'PC', platform_url: 'pc', url: '/pc/2-gauntlet-2014', date_released: '2014-09-23' },
  ];
  const http = fakeHttp({
    search: {
      'Gauntlet Slayer Edition': [{ footer: true }],
      Gauntlet: gauntletResults,
    },
  });
  const located = await locateGamefaqsProduct(fakeCtx({ http }), { name: 'Gauntlet™ Slayer Edition', release_date: '2014-09-23' });
  assert.equal(located.status, 'ok');
  assert.equal(located.pid, '2');
  assert.equal(located.url, `${BASE}/pc/2-gauntlet-2014`);
});

test('locateGamefaqsProduct: no exact match, but a fuzzy title confirmed by year -> ok, fuzzy:true', async () => {
  const fuzzyResults = [{ pid: '1', game_name: 'Baldurs Gate 3', plats: 'PC', platform_url: 'pc', url: '/pc/1-baldurs-gate-3', date_released: '2023-08-03' }];
  const http = fakeHttp({ search: { "Baldur s Gate 3": fuzzyResults } });
  const located = await locateGamefaqsProduct(fakeCtx({ http }), { name: "Baldur's Gate 3", release_date: '2023-08-03' });
  assert.equal(located.status, 'ok');
  assert.equal(located.pid, '1');
  assert.equal(located.fuzzy, true);
});

test('locateGamefaqsProduct: no match at all -> "none"', async () => {
  const empty = [{ footer: true, search_string: 'x' }];
  const http = fakeHttp({ search: { 'Some Totally Unknown Game': empty, 'Some Totally Unknown Game': empty } });
  const located = await locateGamefaqsProduct(fakeCtx({ http }), { name: 'Some Totally Unknown Game', release_date: null });
  assert.equal(located.status, 'none');
});

test('locateGamefaqsProduct: search blocked -> "blocked"', async () => {
  const http = fakeHttp({ search: { 'Witcher 3 Wild Hunt': { blocked: true } } });
  const located = await locateGamefaqsProduct(fakeCtx({ http }), { name: 'The Witcher 3: Wild Hunt', release_date: null });
  assert.equal(located.status, 'blocked');
});

test('locateGamefaqsProduct: blocked while following the PC cross-link page -> "blocked"', async () => {
  const http = fakeHttp({
    search: { 'Assassin s Creed Odyssey': acodSearch },
    pages: { '/ps4/240205-assassins-creed-odyssey': { blocked: true } },
  });
  const located = await locateGamefaqsProduct(fakeCtx({ http }), { name: "Assassin's Creed Odyssey", release_date: null });
  assert.equal(located.status, 'blocked');
});

// --- pauseSource / checkAndMaybeResume (24h block cooldown) ---------------

function fakeStateDb(initial = null) {
  let row = initial;
  return {
    row: () => row,
    db: {
      one: async (sql) => {
        if (sql.includes('FROM source_state')) return row;
        return null;
      },
      query: async (sql, params) => {
        if (sql.startsWith('INSERT INTO source_state')) {
          // VALUES (?, 1, ?, ?, NOW()) — `1` is a literal, so params are [source, cursorState, lastError].
          const [, cursorState, lastError] = params;
          row = { paused: 1, cursor_state: cursorState, last_error: lastError };
        } else if (sql.startsWith('UPDATE source_state SET paused')) {
          const [cursorState] = params;
          row = { ...row, paused: 0, cursor_state: cursorState };
        }
        return [];
      },
    },
  };
}

test('pauseSource: sets paused=1 and a resume time 24h out', async () => {
  const state = fakeStateDb(null);
  const now = () => Date.UTC(2026, 0, 1, 0, 0, 0);
  await pauseSource({ db: state.db }, 'blocked while testing', { now });
  const row = state.row();
  assert.equal(row.paused, 1);
  const cursorState = JSON.parse(row.cursor_state);
  assert.equal(cursorState.pausedUntil, new Date(now() + 24 * 60 * 60 * 1000).toISOString());
  assert.equal(row.last_error, 'blocked while testing');
});

test('checkAndMaybeResume: stays paused before the resume time', async () => {
  const now = () => Date.UTC(2026, 0, 1, 0, 0, 0);
  const state = fakeStateDb({ paused: 1, cursor_state: JSON.stringify({ pausedUntil: new Date(now() + 60_000).toISOString() }) });
  const result = await checkAndMaybeResume({ db: state.db }, { now });
  assert.equal(result.paused, true);
});

test('checkAndMaybeResume: clears the pause once the resume time has passed', async () => {
  const now = () => Date.UTC(2026, 0, 2, 0, 0, 0);
  const state = fakeStateDb({ paused: 1, cursor_state: JSON.stringify({ pausedUntil: new Date(now() - 60_000).toISOString() }) });
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
  const updates = [];
  const db = {
    one: async (sql) => {
      if (sql.includes('paused, cursor_state')) return { paused: paused ? 1 : 0, cursor_state: null };
      if (sql.includes('FROM source_state')) return { paused: paused ? 1 : 0 };
      return null;
    },
    query: async (sql, params) => {
      if (sql.startsWith('INSERT INTO source_state')) return [];
      if (sql.includes('LEFT JOIN source_records')) return candidateRows;
      if (sql.startsWith('UPDATE source_state')) {
        updates.push(params);
        return [];
      }
      return [];
    },
  };
  return {
    ctx: {
      db,
      log,
      config: { sources: { gamefaqs: sourceConfig } },
      enqueue: async (source, data) => enqueued.push({ source, data }),
    },
    enqueued,
    updates,
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
  assert.equal(enqueued[0].source, 'gamefaqs');
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

function fakeFetchCtx({ http, game, existingLink = null, enqueueResolveCalls = [], upsertRecordCalls = [], upsertLinkCalls = [], conflictCalls = [], pauseCalls = [] }) {
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

test('fetchOne: existing game_links row with a stored URL -> fetches it directly, no search', async () => {
  const http = fakeHttp({ pages: { '/pc/934386-portal': portalPcHtml } });
  const upsertRecordCalls = [];
  const upsertLinkCalls = [];
  const enqueueResolveCalls = [];
  const ctx = fakeFetchCtx({
    http,
    game: { id: 5, name: 'Portal', release_date: '2007-10-10' },
    existingLink: { external_id: '934386', url: `${BASE}/pc/934386-portal`, match_method: 'legacy', confidence: 100 },
    upsertRecordCalls,
    upsertLinkCalls,
    enqueueResolveCalls,
  });
  const result = await fetchOne(ctx, { data: { gameId: 5 } });
  assert.equal(result.status, 'ok');
  assert.equal(result.externalId, '934386');
  assert.equal(upsertRecordCalls.length, 1);
  assert.equal(upsertRecordCalls[0].opts.status, 'ok');
  assert.equal(upsertLinkCalls.length, 1);
  assert.equal(upsertLinkCalls[0].opts.method, 'legacy');
  assert.deepEqual(enqueueResolveCalls, [5]);
});

test('fetchOne: existing link known only by pid (Wikidata-style) -> builds the redirect URL', async () => {
  const http = fakeHttp({ pages: { '/-/934386-': portalPcHtml } });
  const upsertLinkCalls = [];
  const ctx = fakeFetchCtx({
    http,
    game: { id: 5, name: 'Portal', release_date: '2007-10-10' },
    existingLink: { external_id: '934386', url: null, match_method: 'wikidata', confidence: 95 },
    upsertLinkCalls,
  });
  const result = await fetchOne(ctx, { data: { gameId: 5 } });
  assert.equal(result.status, 'ok');
  assert.equal(upsertLinkCalls[0].opts.method, 'wikidata');
});

test('fetchOne: no existing link -> searches, matches, fetches the PC page, upserts + enqueues resolve', async () => {
  const http = fakeHttp({
    search: { 'Witcher 3 Wild Hunt': witcher3Search },
    pages: { '/pc/699808-the-witcher-3-wild-hunt': portalPcHtml.replace('Portal', 'The Witcher 3: Wild Hunt') },
  });
  const upsertRecordCalls = [];
  const upsertLinkCalls = [];
  const enqueueResolveCalls = [];
  const ctx = fakeFetchCtx({
    http,
    game: { id: 42, name: 'The Witcher 3: Wild Hunt', release_date: '2015-05-19' },
    existingLink: null,
    upsertRecordCalls,
    upsertLinkCalls,
    enqueueResolveCalls,
  });
  const result = await fetchOne(ctx, { data: { gameId: 42 } });
  assert.equal(result.status, 'ok');
  assert.equal(result.externalId, '699808');
  assert.equal(upsertLinkCalls[0].opts.method, 'name');
  assert.deepEqual(enqueueResolveCalls, [42]);
});

test('fetchOne: no existing link, only a fuzzy match found -> stores the link at confidence 60', async () => {
  const fuzzyResults = [{ pid: '1', game_name: 'Baldurs Gate 3', plats: 'PC', platform_url: 'pc', url: '/pc/1-baldurs-gate-3', date_released: '2023-08-03' }];
  const http = fakeHttp({
    search: { "Baldur s Gate 3": fuzzyResults },
    pages: { '/pc/1-baldurs-gate-3': portalPcHtml.replace('Portal', "Baldur's Gate 3") },
  });
  const upsertLinkCalls = [];
  const ctx = fakeFetchCtx({
    http,
    game: { id: 43, name: "Baldur's Gate 3", release_date: '2023-08-03' },
    existingLink: null,
    upsertLinkCalls,
  });
  const result = await fetchOne(ctx, { data: { gameId: 43 } });
  assert.equal(result.status, 'ok');
  assert.equal(result.externalId, '1');
  assert.equal(upsertLinkCalls[0].opts.method, 'name');
  assert.equal(upsertLinkCalls[0].opts.confidence, 60);
});

test('fetchOne: no match found -> not_found, records the miss, does not throw', async () => {
  const http = fakeHttp({ search: { 'Some Totally Unknown Game': [{ footer: true }] } });
  const upsertRecordCalls = [];
  const ctx = fakeFetchCtx({
    http,
    game: { id: 7, name: 'Some Totally Unknown Game', release_date: null },
    existingLink: null,
    upsertRecordCalls,
  });
  const result = await fetchOne(ctx, { data: { gameId: 7 } });
  assert.equal(result.status, 'not_found');
  assert.equal(upsertRecordCalls[0].opts.status, 'not_found');
});

test('fetchOne: ambiguous match -> writes a conflicts row, does not link/enqueue', async () => {
  const results = [
    { pid: '1', game_name: 'Doom', plats: 'PC', date_released: '1993-12-10' },
    { pid: '2', game_name: 'Doom', plats: 'PC', date_released: '2016-05-13' },
  ];
  const http = fakeHttp({ search: { Doom: results } });
  const conflictCalls = [];
  const enqueueResolveCalls = [];
  const ctx = fakeFetchCtx({
    http,
    game: { id: 9, name: 'Doom', release_date: null },
    existingLink: null,
    conflictCalls,
    enqueueResolveCalls,
  });
  const result = await fetchOne(ctx, { data: { gameId: 9 } });
  assert.equal(result.status, 'ambiguous');
  assert.equal(conflictCalls.length, 1);
  assert.equal(enqueueResolveCalls.length, 0);
});

test('fetchOne: blocked while fetching the page -> records an error, pauses the source, and throws (so BullMQ retries later)', async () => {
  const http = fakeHttp({ pages: { '/pc/934386-portal': { blocked: true } } });
  const upsertRecordCalls = [];
  const pauseCalls = [];
  const ctx = fakeFetchCtx({
    http,
    game: { id: 5, name: 'Portal', release_date: '2007-10-10' },
    existingLink: { external_id: '934386', url: `${BASE}/pc/934386-portal`, match_method: 'legacy', confidence: 100 },
    upsertRecordCalls,
    pauseCalls,
  });
  await assert.rejects(() => fetchOne(ctx, { data: { gameId: 5 } }), /blocked/);
  assert.equal(upsertRecordCalls[0].opts.status, 'error');
  assert.equal(pauseCalls.length, 1);
  const [pausedSource, cursorState] = pauseCalls[0];
  assert.equal(pausedSource, 'gamefaqs');
  assert.match(JSON.parse(cursorState).pausedUntil, /^\d{4}-\d{2}-\d{2}T/);
});

test('fetchOne: blocked while searching -> pauses the source and throws before any record is written', async () => {
  const http = fakeHttp({ search: { Portal: { blocked: true } } });
  const upsertRecordCalls = [];
  const pauseCalls = [];
  const ctx = fakeFetchCtx({
    http,
    game: { id: 5, name: 'Portal', release_date: null },
    existingLink: null,
    upsertRecordCalls,
    pauseCalls,
  });
  await assert.rejects(() => fetchOne(ctx, { data: { gameId: 5 } }), /blocked/);
  assert.equal(pauseCalls.length, 1);
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

test('isBlockedBody: a normal page carrying the Cloudflare challenge-platform script is not a block', () => {
  assert.equal(isBlockedBody('<html><title>Portal 2 for PC - GameFAQs</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></html>'), false);
  assert.equal(isBlockedBody('<html><title>Just a moment...</title></html>'), true);
});

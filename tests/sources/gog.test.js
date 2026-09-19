import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  name,
  rateLimit,
  extract,
  matchSteamGame,
  mapPlatforms,
  mapLanguages,
  stripHtml,
  extractPriceBlock,
  catalogSignature,
  isKeepablePack,
  toAscii,
  discover,
  fetchOne,
} from '../../src/sources/gog.js';
import { log } from '../../src/log.js';

// Every test below drives gog.js through injected fakes (fake db, fake http)
// so nothing here touches MySQL or the network. `extract()`/`matchSteamGame()`
// are pure and are fed recorded fixtures (tests/fixtures/gog/*.json - real
// `GET /v2/games/{id}` + `GET /products/{id}/prices` bodies fetched live on
// 2026-09-19, trimmed of unused fields).

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'gog');

function loadFixture(fileName) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, fileName), 'utf8'));
}

const homm3 = loadFixture('homm3.json'); // GOG-exclusive-ish paid game
const horn = loadFixture('horn.json'); // free game
const witcher3 = loadFixture('witcher3.json'); // also on Steam (name-matchable)

// --- module shape -----------------------------------------------------------

test('module: exports name and a conservative default rate limit', () => {
  assert.equal(name, 'gog');
  assert.deepEqual(rateLimit, { max: 1, duration: 1000 });
});

// --- extract(): homm3 (GOG-exclusive paid game) -----------------------------

test('extract: homm3 - name, ids, release, price, platforms, developers', () => {
  const fields = extract(homm3);
  assert.equal(fields.name, 'Heroes of Might and Magic® 3: Complete');
  assert.equal(fields.gogId, '1207658787');
  assert.equal(fields.gogSlug, 'heroes_of_might_and_magic_3_complete_edition');
  assert.deepEqual(fields.storeRelease, { date: '1999-06-01', precision: 'day' });
  assert.deepEqual(fields.platforms, ['WIN']);
  assert.deepEqual(fields.developers, ['New World Computing, Inc.']);
  assert.ok(fields.prices.usd);
  assert.equal(fields.prices.usd.initial, 999);
  assert.equal(fields.prices.usd.final, 499);
  assert.equal(fields.prices.usd.discount, 50);
  assert.equal(fields.prices.rub.final, 44499);
  assert.equal(fields.isFree, false);
  assert.ok(fields.links.gog.url.includes('heroes_of_might_and_magic_3_complete_edition'));
});

test('extract: homm3 - descriptions are HTML-free', () => {
  const fields = extract(homm3);
  assert.ok(fields.descriptionEn && fields.descriptionEn.length > 0);
  assert.ok(!fields.descriptionEn.includes('<'));
  assert.ok(!fields.descriptionEn.includes('>'));
  assert.ok(fields.descriptionRu && !fields.descriptionRu.includes('<'));
});

test('extract: homm3 - genres/tags/categories/languages are non-empty string arrays', () => {
  const fields = extract(homm3);
  assert.ok(Array.isArray(fields.genres) && fields.genres.length > 0);
  assert.ok(Array.isArray(fields.tags) && fields.tags.length > 0);
  assert.ok(Array.isArray(fields.categories) && fields.categories.length > 0);
  assert.ok(Array.isArray(fields.languages) && fields.languages.includes('English'));
});

// --- extract(): horn (free game) --------------------------------------------

test('extract: horn - isFree true, zero-cost prices', () => {
  const fields = extract(horn);
  assert.equal(fields.name, 'Heroes of Might and Magic III: Horn of the Abyss');
  assert.equal(fields.isFree, true);
  assert.equal(fields.prices.usd.final, 0);
  assert.equal(fields.prices.usd.discount, 0);
});

// --- extract(): witcher3 (also on Steam) ------------------------------------

test('extract: witcher3 - name matches the Steam title after normalisation', () => {
  const fields = extract(witcher3);
  assert.equal(fields.name, 'The Witcher 3: Wild Hunt - Complete Edition');
  assert.equal(fields.gogId, '1640424747');
  assert.deepEqual(fields.developers, ['CD PROJEKT RED']);
  assert.equal(fields.storeRelease.date.slice(0, 4), '2016');
});

test('extract: payload missing the English product -> empty fields, no throw', () => {
  assert.deepEqual(extract({}), {});
  assert.deepEqual(extract({ en: { _embedded: {} } }), {});
});

// --- extract(): gogPurchasable (games.purchasable - migrations/005_purchasable.sql, src/lib/purchasable.js) ---

test('extract: gogPurchasable true from a real price (homm3 fixture)', () => {
  assert.equal(extract(homm3).gogPurchasable, true);
});

test('extract: gogPurchasable true for a free game (horn fixture)', () => {
  assert.equal(extract(horn).gogPurchasable, true);
});

test('extract: gogPurchasable false - not free, no price in either region, isAvailableForSale false', () => {
  const payload = {
    en: {
      _embedded: {
        product: { id: 999, title: 'Some Delisted GOG Game', isAvailableForSale: false, isPreorder: false },
      },
    },
  };
  assert.equal(extract(payload).gogPurchasable, false);
});

test('extract: gogPurchasable true when isPreorder (not released yet), even with isAvailableForSale false and no price', () => {
  const payload = {
    en: {
      _embedded: {
        product: { id: 999, title: 'Some Upcoming GOG Game', isAvailableForSale: false, isPreorder: true },
      },
    },
  };
  assert.equal(extract(payload).gogPurchasable, true);
});

test('extract: gogPurchasable is omitted (undefined), not false, when isAvailableForSale is absent (old payload shape) and no price', () => {
  const payload = {
    en: {
      _embedded: {
        product: { id: 999, title: 'Some Old GOG Record' },
      },
    },
  };
  assert.equal(extract(payload).gogPurchasable, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(extract(payload), 'gogPurchasable'));
});

// --- small pure helpers ------------------------------------------------------

test('mapPlatforms: maps GOG os names to WIN/MAC/LNX, dedupes, drops unknown', () => {
  assert.deepEqual(mapPlatforms(['windows', 'osx', 'osx', 'bogus']), ['WIN', 'MAC']);
  assert.deepEqual(
    mapPlatforms([{ operatingSystem: { name: 'windows' } }, { operatingSystem: { name: 'linux' } }]),
    ['WIN', 'LNX'],
  );
  assert.equal(mapPlatforms([]), undefined);
  assert.equal(mapPlatforms(undefined), undefined);
});

test('mapLanguages: splits text vs audio localizations', () => {
  const localizations = [
    { _embedded: { language: { name: 'English' }, localizationScope: { type: 'text' } } },
    { _embedded: { language: { name: 'English' }, localizationScope: { type: 'audio' } } },
    { _embedded: { language: { name: 'German' }, localizationScope: { type: 'text' } } },
  ];
  assert.deepEqual(mapLanguages(localizations), { languages: ['English', 'German'], voiceovers: ['English'] });
  assert.deepEqual(mapLanguages([]), {});
});

test('stripHtml: removes tags, keeps line breaks for block elements, decodes entities', () => {
  assert.equal(stripHtml('<p>Hello &amp; welcome</p><ul><li>One</li><li>Two</li></ul>'), 'Hello & welcome\n- One\n- Two');
  assert.equal(stripHtml(null), null);
  assert.equal(stripHtml(''), null);
  assert.equal(stripHtml('   '), null);
});

test('extractPriceBlock: parses "<amount> <CCY>" strings into cents + discount', () => {
  const prices = { _embedded: { prices: [{ currency: { code: 'USD' }, basePrice: '1999 USD', finalPrice: '999 USD' }] } };
  assert.deepEqual(extractPriceBlock(prices, 'USD'), { initial: 1999, final: 999, discount: 50 });
  assert.equal(extractPriceBlock(prices, 'RUB'), null);
  assert.equal(extractPriceBlock({ message: 'PRICES_NOT_FOUND' }, 'USD'), null);
});

test('catalogSignature: stable for identical input, differs when price/title changes', () => {
  const a = { title: 'Foo', releaseDate: '2020.01.01', developers: ['Bar'], price: { final: '$9.99', discount: null } };
  const b = { ...a };
  const c = { ...a, price: { final: '$4.99', discount: '-50%' } };
  assert.equal(catalogSignature(a), catalogSignature(b));
  assert.notEqual(catalogSignature(a), catalogSignature(c));
});

// --- isKeepablePack(): pack vs DLC/addon heuristic --------------------------

test('isKeepablePack: a plain "game" product always passes', () => {
  assert.equal(isKeepablePack({ productType: 'game', title: 'Anything at all' }, new Set()), true);
});

test('isKeepablePack: a repackaged base game with no separate "game" listing is kept', () => {
  // Real case: GOG only sells this as a pack now (verified live 2026-09-19),
  // there is no plain "game"-typed "The Witcher 3: Wild Hunt" entry.
  const product = { productType: 'pack', title: 'The Witcher 3: Wild Hunt - Complete Edition' };
  assert.equal(isKeepablePack(product, new Set()), true);
});

test('isKeepablePack: a soundtrack pack is dropped by keyword', () => {
  const product = { productType: 'pack', title: 'The Witcher 3: Wild Hunt - Soundtrack' };
  assert.equal(isKeepablePack(product, new Set()), false);
});

test('isKeepablePack: a season pass is dropped by keyword', () => {
  const product = { productType: 'pack', title: 'Cyberpunk 2077 Season Pass' };
  assert.equal(isKeepablePack(product, new Set()), false);
});

test('isKeepablePack: other addon keywords (dlc, expansion, upgrade, bonus, costume, skin, artbook) are dropped', () => {
  for (const title of ['Some Game DLC', 'Some Game: Expansion', 'Some Game Digital Upgrade', 'Some Game Bonus Content', 'Some Game Costume Pack', 'Some Game Skin Pack', 'Some Game Artbook']) {
    assert.equal(isKeepablePack({ productType: 'pack', title }, new Set()), false, `expected "${title}" to be dropped`);
  }
});

test('isKeepablePack: dropped when a separate "game" product shares its normalized base title', () => {
  // normalizeName() strips a literal "Deluxe Edition" suffix, so this pack's
  // normalized title is the same as the plain base-game title below.
  const gameTitleNormSet = new Set(['some bundled game']);
  const product = { productType: 'pack', title: 'Some Bundled Game - Deluxe Edition' };
  assert.equal(isKeepablePack(product, gameTitleNormSet), false);
});

// --- matchSteamGame(): pure decision, fake candidate rows -------------------

test('matchSteamGame: no candidates -> none', () => {
  assert.deepEqual(matchSteamGame({ name: 'Some Game' }, []), { status: 'none' });
});

test('matchSteamGame: single exact normalized match -> attach with confidence 100', () => {
  const candidates = [{ id: 10, name: 'The Witcher 3: Wild Hunt', name_normalized: 'Witcher 3 Wild Hunt' }];
  const result = matchSteamGame({ name: 'The Witcher 3: Wild Hunt - Complete Edition' }, candidates);
  assert.deepEqual(result, { status: 'attach', gameId: 10, confidence: 100 });
});

test('matchSteamGame: single fuzzy match (>=95), confirmed by release year -> attach', () => {
  // A typo'd Steam title: close enough (simpleSim ~98) but not an exact
  // normalized match, so this exercises the similarity branch rather than
  // the exact-match branch. Confirmed by a matching release year.
  const candidates = [{ id: 11, name: 'Sekiro Shadows Die Twicee', name_normalized: 'Sekiro Shadows Die Twicee', release_date: '2019-03-22' }];
  const fields = { name: 'Sekiro: Shadows Die Twice', storeRelease: { date: '2019-03-22' } };
  const result = matchSteamGame(fields, candidates);
  assert.equal(result.status, 'attach');
  assert.equal(result.gameId, 11);
  assert.ok(result.confidence >= 95 && result.confidence < 100, `expected 95<=confidence<100, got ${result.confidence}`);
});

test('matchSteamGame: single fuzzy match (>=95) but unconfirmed -> ambiguous (log a conflict, do not attach)', () => {
  // Same near-miss title as above, but nothing to confirm it with (no
  // release year or developer overlap) - per the stricter matching rule, a
  // non-exact single candidate must not be attached blindly.
  const candidates = [{ id: 11, name: 'Sekiro Shadows Die Twicee', name_normalized: 'Sekiro Shadows Die Twicee' }];
  const result = matchSteamGame({ name: 'Sekiro: Shadows Die Twice' }, candidates);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.bestCandidateId, 11);
  assert.match(result.reason, /Unconfirmed/);
  assert.equal(result.candidates.length, 1);
});

test('matchSteamGame: typographic quotes/dashes are folded to ASCII before comparing', () => {
  // Curly apostrophe + em dash on the GOG side, straight quote + hyphen on
  // the Steam side - still an exact normalized match.
  const candidates = [{ id: 60, name: "Marvel's Spider-Man Remastered", name_normalized: 'Marvel s Spider Man Remastered' }];
  const result = matchSteamGame({ name: 'Marvel’s Spider—Man Remastered' }, candidates);
  assert.deepEqual(result, { status: 'attach', gameId: 60, confidence: 100 });
});

test('toAscii: folds curly quotes, dashes and ellipsis to ASCII', () => {
  assert.equal(toAscii('‘a’ “b” – — …'), "'a' \"b\" - - ...");
  assert.equal(toAscii(null), '');
  assert.equal(toAscii(undefined), '');
});

test('matchSteamGame: below the similarity threshold -> none', () => {
  const candidates = [{ id: 12, name: 'Completely Different Title', name_normalized: 'Completely Different Title' }];
  assert.deepEqual(matchSteamGame({ name: 'Some Other Game' }, candidates), { status: 'none' });
});

test('matchSteamGame: two name-matching candidates, confirmed by release year -> attach the confirmed one', () => {
  const fields = { name: 'Doom', storeRelease: { date: '2016-05-13' } };
  const candidates = [
    { id: 20, name: 'Doom', name_normalized: 'Doom', release_date: '1993-12-10' },
    { id: 21, name: 'Doom', name_normalized: 'Doom', release_date: '2016-05-13' },
  ];
  const result = matchSteamGame(fields, candidates);
  assert.deepEqual(result, { status: 'attach', gameId: 21, confidence: 100 });
});

test('matchSteamGame: two exact-name ties with no release year on either side -> ambiguous even with a matching developer', () => {
  // Exact-title ties are disambiguated strictly by release year (reboots
  // commonly share a developer/publisher too, so that signal isn't trusted
  // here) - with no year data at all, this must stay ambiguous rather than
  // attach on the developer overlap alone.
  const fields = { name: 'Doom', developers: ['id Software'] };
  const candidates = [
    { id: 30, name: 'Doom', name_normalized: 'Doom', developers: '|Bethesda Game Studios|' },
    { id: 31, name: 'Doom', name_normalized: 'Doom', developers: '|id Software|' },
  ];
  const result = matchSteamGame(fields, candidates);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.bestCandidateId, 30);
  assert.equal(result.candidates.length, 2);
});

test('matchSteamGame: single fuzzy (non-exact) candidate confirmed by overlapping developer -> attach', () => {
  // Developer overlap still resolves a *non-exact* fuzzy match when no
  // release year is available - only exact-title ties/singles are held to
  // the stricter year-only rule.
  const fields = { name: 'Sekiro: Shadows Die Twice', developers: ['FromSoftware'] };
  const candidates = [{ id: 12, name: 'Sekiro Shadows Die Twicee', name_normalized: 'Sekiro Shadows Die Twicee', developers: '|FromSoftware|' }];
  const result = matchSteamGame(fields, candidates);
  assert.equal(result.status, 'attach');
  assert.equal(result.gameId, 12);
});

// --- matchSteamGame(): exact-title reboots/remakes (Doom, Prey, ...) -------

test('matchSteamGame: single exact match, Prey 2017 vs a lone Prey 2006 candidate (11y gap) -> ambiguous, not attached', () => {
  const fields = { name: 'Prey', storeRelease: { date: '2017-05-05' } };
  const candidates = [{ id: 70, name: 'Prey', name_normalized: 'Prey', release_date: '2006-07-11' }];
  const result = matchSteamGame(fields, candidates);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.bestCandidateId, 70);
  assert.match(result.reason, /differ by 11 years/);
  assert.deepEqual(result.candidates, [{ gameId: 70, name: 'Prey', sim: 100, exact: true }]);
});

test('matchSteamGame: single exact match with a small (<=3y) release-year gap still attaches', () => {
  // Not every gap means a remake - e.g. an early-access date vs. the 1.0
  // release, or a delisted/relisted game. Only a "large" gap is suspicious.
  const fields = { name: 'Prey', storeRelease: { date: '2017-05-05' } };
  const candidates = [{ id: 71, name: 'Prey', name_normalized: 'Prey', release_date: '2015-01-01' }];
  const result = matchSteamGame(fields, candidates);
  assert.deepEqual(result, { status: 'attach', gameId: 71, confidence: 100 });
});

test('matchSteamGame: single exact match with an unknown release year on either side still attaches', () => {
  const withUnknownSteamYear = matchSteamGame({ name: 'Prey', storeRelease: { date: '2017-05-05' } }, [
    { id: 72, name: 'Prey', name_normalized: 'Prey' },
  ]);
  assert.deepEqual(withUnknownSteamYear, { status: 'attach', gameId: 72, confidence: 100 });

  const withUnknownGogYear = matchSteamGame({ name: 'Prey' }, [{ id: 72, name: 'Prey', name_normalized: 'Prey', release_date: '2017-05-05' }]);
  assert.deepEqual(withUnknownGogYear, { status: 'attach', gameId: 72, confidence: 100 });
});

test('matchSteamGame: two exact ties (Doom 1993/2016), GOG year matches the 2016 one -> attach it', () => {
  const fields = { name: 'Doom', storeRelease: { date: '2016-05-13' } };
  const candidates = [
    { id: 80, name: 'Doom', name_normalized: 'Doom', release_date: '1993-12-10' },
    { id: 81, name: 'Doom', name_normalized: 'Doom', release_date: '2016-05-13' },
  ];
  const result = matchSteamGame(fields, candidates);
  assert.deepEqual(result, { status: 'attach', gameId: 81, confidence: 100 });
});

test('matchSteamGame: two exact ties (Doom 1993/2016), GOG year matches neither -> ambiguous', () => {
  const fields = { name: 'Doom', storeRelease: { date: '2004-08-03' } }; // Doom 3
  const candidates = [
    { id: 82, name: 'Doom', name_normalized: 'Doom', release_date: '1993-12-10' },
    { id: 83, name: 'Doom', name_normalized: 'Doom', release_date: '2016-05-13' },
  ];
  const result = matchSteamGame(fields, candidates);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.bestCandidateId, 82);
});

test('matchSteamGame: ambiguous when nothing confirms a single candidate -> conflict candidates listed', () => {
  const fields = { name: 'Doom' };
  const candidates = [
    { id: 40, name: 'Doom', name_normalized: 'Doom' },
    { id: 41, name: 'Doom', name_normalized: 'Doom' },
  ];
  const result = matchSteamGame(fields, candidates);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.bestCandidateId, 40);
  assert.equal(result.candidates.length, 2);
});

test('matchSteamGame: ambiguous when year disagrees for every candidate -> stays ambiguous, not "none"', () => {
  const fields = { name: 'Doom', storeRelease: { date: '2020-01-01' } };
  const candidates = [
    { id: 50, name: 'Doom', name_normalized: 'Doom', release_date: '1993-12-10' },
    { id: 51, name: 'Doom', name_normalized: 'Doom', release_date: '2016-05-13' },
  ];
  const result = matchSteamGame(fields, candidates);
  assert.equal(result.status, 'ambiguous');
});

// --- fetchOne(): DB-facing logic, fake ctx ----------------------------------

function fakeHttp({ en, ru, pricesUsd, pricesRub }) {
  return {
    getJson: async (url) => {
      if (url.includes('locale=en-US')) return en;
      if (url.includes('locale=ru-RU')) return ru;
      if (url.includes('countryCode=US')) return pricesUsd;
      if (url.includes('countryCode=RU')) return pricesRub;
      throw new Error(`fakeHttp: unexpected url ${url}`);
    },
  };
}

function fakeCtx({ http, dbRouter, enqueueResolveCalls = [], upsertRecordCalls = [], upsertLinkCalls = [], upsertLinkResult = undefined }) {
  return {
    http,
    log,
    config: {},
    db: {
      one: async (sql, params) => dbRouter.one(sql, params),
      query: async (sql, params) => dbRouter.query(sql, params),
    },
    upsertRecord: async (source, externalId, opts) => {
      upsertRecordCalls.push({ source, externalId, opts });
    },
    upsertLink: async (gameId, source, externalId, opts) => {
      upsertLinkCalls.push({ gameId, source, externalId, opts });
      return upsertLinkResult;
    },
    enqueueResolve: async (gameId) => {
      enqueueResolveCalls.push(gameId);
    },
  };
}

test('fetchOne: product not found on GOG -> not_found, no DB writes', async () => {
  const upsertRecordCalls = [];
  const ctx = fakeCtx({
    http: { getJson: async () => ({ message: 'not found' }) },
    dbRouter: { one: async () => null, query: async () => [] },
    upsertRecordCalls,
  });
  const result = await fetchOne(ctx, { data: { externalId: '999' } });
  assert.equal(result.status, 'not_found');
  assert.equal(upsertRecordCalls.length, 1);
  assert.equal(upsertRecordCalls[0].opts.status, 'not_found');
});

test('fetchOne: games row already has this gog_id -> reuses it, link only (no insert)', async () => {
  const http = fakeHttp(homm3);
  const upsertLinkCalls = [];
  const enqueueResolveCalls = [];
  const insertCalls = [];
  const dbRouter = {
    one: async (sql) => {
      if (sql.includes('WHERE gog_id = ?')) return { id: 777 };
      return null;
    },
    query: async (sql, params) => {
      if (sql.startsWith('INSERT INTO games')) insertCalls.push(params);
      return [];
    },
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls, enqueueResolveCalls });
  const result = await fetchOne(ctx, { data: { externalId: '1207658787' } });
  assert.equal(result.status, 'ok');
  assert.equal(result.gameId, 777);
  assert.equal(insertCalls.length, 0, 'must not create a new games row when one is already linked');
  assert.equal(upsertLinkCalls.length, 1);
  assert.equal(upsertLinkCalls[0].gameId, 777);
  assert.deepEqual(enqueueResolveCalls, [777]);
});

test('fetchOne: upsertLink reports the matched game was deleted (game-gone) -> does not enqueue a resolve for it', async () => {
  const http = fakeHttp(homm3);
  const enqueueResolveCalls = [];
  const dbRouter = {
    one: async (sql) => (sql.includes('WHERE gog_id = ?') ? { id: 777 } : null),
    query: async () => [],
  };
  const ctx = fakeCtx({ http, dbRouter, enqueueResolveCalls, upsertLinkResult: { status: 'skipped', reason: 'game-gone' } });

  const result = await fetchOne(ctx, { data: { externalId: '1207658787' } });

  assert.equal(result.status, 'ok');
  assert.equal(result.gameId, null);
  assert.equal(result.reason, 'game-gone');
  assert.deepEqual(enqueueResolveCalls, [], 'must not enqueue a resolve for a game that no longer exists');
});

test('fetchOne: GOG prices endpoint 400s (product no longer sold) -> treated as "no price", record still stored ok', async () => {
  const http = {
    getJson: async (url) => {
      if (url.includes('locale=en-US')) return homm3.en;
      if (url.includes('locale=ru-RU')) return homm3.ru;
      if (url.includes('/prices')) {
        const err = new Error(`HTTP 400 for ${url}`);
        err.statusCode = 400;
        throw err;
      }
      throw new Error(`fakeHttp: unexpected url ${url}`);
    },
  };
  const upsertLinkCalls = [];
  const upsertRecordCalls = [];
  const dbRouter = {
    one: async (sql) => (sql.includes('WHERE gog_id = ?') ? { id: 777 } : null),
    query: async () => [],
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls, upsertRecordCalls });

  const result = await fetchOne(ctx, { data: { externalId: '1207658787' } });

  assert.equal(result.status, 'ok');
  assert.equal(result.gameId, 777);
  assert.equal(upsertRecordCalls.length, 1);
  assert.equal(upsertRecordCalls[0].opts.status, 'ok');
  assert.equal(upsertRecordCalls[0].opts.payload.pricesUsd, null);
  assert.equal(upsertRecordCalls[0].opts.payload.pricesRub, null);
  // extract() must simply see no price data rather than blowing up on a null prices response.
  assert.equal(upsertRecordCalls[0].opts.payload.pricesUsd, null);
});

test('fetchOne: existing wikidata-derived game_links row -> attaches to that game', async () => {
  const http = fakeHttp(witcher3);
  const upsertLinkCalls = [];
  const updateCalls = [];
  const dbRouter = {
    one: async (sql) => {
      if (sql.includes('WHERE gog_id = ?')) return null;
      if (sql.includes('WHERE gog_slug = ?')) return null;
      if (sql.includes('FROM game_links')) return { game_id: 555, match_method: 'wikidata' };
      if (sql.includes('SELECT id, gog_id FROM games WHERE id = ?')) return { id: 555, gog_id: null };
      return null;
    },
    query: async (sql, params) => {
      if (sql.startsWith('UPDATE games')) updateCalls.push({ sql, params });
      return [];
    },
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls });
  const result = await fetchOne(ctx, { data: { externalId: '1640424747' } });
  assert.equal(result.gameId, 555);
  assert.equal(result.method, 'wikidata');
  assert.equal(upsertLinkCalls[0].opts.method, 'wikidata');
  assert.equal(updateCalls.length, 1);
});

test('fetchOne: matched by games.gog_slug (wikidata backfilled the slug but not gog_id) -> attaches, sets gog_id', async () => {
  const http = fakeHttp(witcher3); // gogSlug: 'the_witcher_3_wild_hunt_game_of_the_year_edition'
  const upsertLinkCalls = [];
  const updateCalls = [];
  const dbRouter = {
    one: async (sql, params) => {
      if (sql.includes('WHERE gog_id = ?')) return null;
      if (sql.includes('WHERE gog_slug = ?')) {
        assert.equal(params[0], 'the_witcher_3_wild_hunt_game_of_the_year_edition');
        return { id: 555, gog_id: null };
      }
      if (sql.includes('FROM game_links')) return null;
      return null;
    },
    query: async (sql, params) => {
      if (sql.startsWith('UPDATE games')) updateCalls.push({ sql, params });
      return [];
    },
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls });
  const result = await fetchOne(ctx, { data: { externalId: '1640424747' } });
  assert.equal(result.gameId, 555);
  assert.equal(result.method, 'store');
  assert.equal(updateCalls.length, 1, 'backfills gog_id onto the slug-matched row');
  assert.equal(updateCalls[0].params[0], '1640424747');
});

test('fetchOne: matched via a game_links(source=gog) row keyed by slug (as wikidata.js writes it) -> attaches', async () => {
  const http = fakeHttp(witcher3);
  const upsertLinkCalls = [];
  const dbRouter = {
    one: async (sql, params) => {
      if (sql.includes('WHERE gog_id = ?')) return null;
      if (sql.includes('WHERE gog_slug = ?')) return null;
      if (sql.includes('FROM game_links')) {
        // wikidata.js stores the bare slug as external_id, never the numeric id.
        assert.deepEqual(params, ['1640424747', 'the_witcher_3_wild_hunt_game_of_the_year_edition']);
        return { game_id: 555, match_method: 'wikidata' };
      }
      if (sql.includes('SELECT id, gog_id FROM games WHERE id = ?')) return { id: 555, gog_id: null };
      return null;
    },
    query: async () => [],
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls });
  const result = await fetchOne(ctx, { data: { externalId: '1640424747' } });
  assert.equal(result.gameId, 555);
  assert.equal(result.method, 'wikidata');
  assert.equal(upsertLinkCalls[0].opts.method, 'wikidata');
});

test('fetchOne: one-to-one - slug-matched game already has a different gog_id -> conflict, no attach', async () => {
  const http = fakeHttp(witcher3);
  const upsertLinkCalls = [];
  const enqueueResolveCalls = [];
  const conflictCalls = [];
  const insertCalls = [];
  const dbRouter = {
    one: async (sql) => {
      if (sql.includes('WHERE gog_id = ?')) return null;
      if (sql.includes('WHERE gog_slug = ?')) return { id: 555, gog_id: '999999' }; // a different GOG product
      return null;
    },
    query: async (sql, params) => {
      if (sql.startsWith('INSERT INTO conflicts')) {
        conflictCalls.push(params);
        return [];
      }
      if (sql.startsWith('INSERT INTO games')) {
        insertCalls.push(params);
        return { insertId: 999 };
      }
      return [];
    },
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls, enqueueResolveCalls });
  const result = await fetchOne(ctx, { data: { externalId: '1640424747' } });
  assert.equal(result.ambiguous, true);
  assert.equal(result.gameId, null);
  assert.equal(conflictCalls.length, 1);
  assert.equal(conflictCalls[0][0], 555, 'conflict references the already-linked game');
  assert.match(conflictCalls[0][2], /differs from/);
  assert.equal(insertCalls.length, 0, 'must not create a new game on a one-to-one conflict');
  assert.equal(upsertLinkCalls.length, 0);
  assert.equal(enqueueResolveCalls.length, 0);
});

test('fetchOne: no existing link, confident Steam name match -> attaches via name', async () => {
  const http = fakeHttp(witcher3);
  const upsertLinkCalls = [];
  const updateCalls = [];
  const dbRouter = {
    one: async (sql) => {
      if (sql.includes('WHERE gog_id = ?')) return null;
      if (sql.includes('FROM game_links')) return null;
      return null;
    },
    query: async (sql, params) => {
      if (sql.includes('FROM games') && sql.includes("kind = 'steam'")) {
        return [{ id: 321, name: 'The Witcher 3: Wild Hunt', name_normalized: 'Witcher 3 Wild Hunt', release_date: '2015-05-19', developers: '|CD PROJEKT RED|' }];
      }
      if (sql.startsWith('UPDATE games')) {
        updateCalls.push({ sql, params });
        return [];
      }
      return [];
    },
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls });
  const result = await fetchOne(ctx, { data: { externalId: '1640424747' } });
  assert.equal(result.gameId, 321);
  assert.equal(result.method, 'name');
  assert.equal(updateCalls.length, 1, 'attaches gog_id to the matched Steam row');
  assert.equal(upsertLinkCalls[0].opts.confidence, 100);
});

test('fetchOne: ambiguous name match -> writes a conflict row, creates/links nothing', async () => {
  const http = fakeHttp(witcher3);
  const upsertLinkCalls = [];
  const enqueueResolveCalls = [];
  const insertCalls = [];
  const conflictCalls = [];
  const dbRouter = {
    one: async () => null,
    query: async (sql, params) => {
      if (sql.includes('FROM games') && sql.includes("kind = 'steam'")) {
        return [
          { id: 1, name: 'The Witcher 3: Wild Hunt', name_normalized: 'Witcher 3 Wild Hunt' },
          { id: 2, name: 'The Witcher 3: Wild Hunt', name_normalized: 'Witcher 3 Wild Hunt' },
        ];
      }
      if (sql.startsWith('INSERT INTO conflicts')) {
        conflictCalls.push(params);
        return [];
      }
      if (sql.startsWith('INSERT INTO games')) {
        insertCalls.push(params);
        return { insertId: 999 };
      }
      return [];
    },
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls, enqueueResolveCalls });
  const result = await fetchOne(ctx, { data: { externalId: '1640424747' } });
  assert.equal(result.ambiguous, true);
  assert.equal(result.gameId, null);
  assert.equal(conflictCalls.length, 1);
  assert.equal(conflictCalls[0][0], 1, 'conflict references the best candidate game_id');
  const conflictCandidates = JSON.parse(conflictCalls[0][1]);
  assert.equal(conflictCandidates.length, 2);
  assert.equal(conflictCalls[0][2].includes('Ambiguous'), true);
  assert.equal(insertCalls.length, 0);
  assert.equal(upsertLinkCalls.length, 0);
  assert.equal(enqueueResolveCalls.length, 0);
});

test('fetchOne: no match at all -> creates a gog_exclusive games row', async () => {
  const http = fakeHttp(homm3);
  const upsertLinkCalls = [];
  const enqueueResolveCalls = [];
  const dbRouter = {
    one: async () => null,
    query: async (sql, params) => {
      if (sql.includes('FROM games') && sql.includes("kind = 'steam'")) return [];
      if (sql.startsWith('INSERT INTO games')) return { insertId: 4242 };
      return [];
    },
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls, enqueueResolveCalls });
  const result = await fetchOne(ctx, { data: { externalId: '1207658787' } });
  assert.equal(result.gameId, 4242);
  assert.equal(result.method, 'store');
  assert.deepEqual(enqueueResolveCalls, [4242]);
  assert.equal(upsertLinkCalls[0].opts.confidence, 100);
});

// --- fetchOne: purge-non-games integration (creation-time guards, src/pipeline/purge-non-games.js) -----

test('fetchOne: a purged external id (source_records tombstone) is never recreated', async () => {
  const http = fakeHttp(homm3);
  const calls = [];
  const existingPayload = { purged: true, class: 'dlc', name: 'Old GOG DLC' };
  const dbRouter = {
    one: async (sql, params) => {
      calls.push({ sql, params, one: true });
      if (sql === 'SELECT payload FROM source_records WHERE source = ? AND external_id = ?') {
        return { payload: JSON.stringify(existingPayload) };
      }
      return null;
    },
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM games') && sql.includes("kind = 'steam'")) return [];
      if (sql.startsWith('INSERT INTO games')) throw new Error('must not create a new games row for a purged external id');
      return [];
    },
  };
  const upsertRecordCalls = [];
  const ctx = fakeCtx({ http, dbRouter, upsertRecordCalls });
  const result = await fetchOne(ctx, { data: { externalId: '1207658787' } });

  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'purged');
  assert.equal(upsertRecordCalls.length, 1);
  assert.equal(upsertRecordCalls[0].opts.status, 'not_found');
  assert.deepEqual(upsertRecordCalls[0].opts.payload, existingPayload);
});

test('fetchOne: a brand-new external id whose title classifies as non-game is never created, tombstoned instead', async () => {
  const soundtrackFixture = structuredClone(homm3);
  soundtrackFixture.en._embedded.product.title = 'Some Game Soundtrack';
  const http = fakeHttp(soundtrackFixture);
  const calls = [];
  const dbRouter = {
    one: async (sql, params) => {
      calls.push({ sql, params, one: true });
      return null; // no tombstone yet, no base-game row found
    },
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM games') && sql.includes("kind = 'steam'")) return [];
      if (sql.startsWith('INSERT INTO games')) throw new Error('must not create a games row for a classified non-game');
      return [];
    },
  };
  const upsertRecordCalls = [];
  const ctx = fakeCtx({ http, dbRouter, upsertRecordCalls });
  const result = await fetchOne(ctx, { data: { externalId: '1207658787' } });

  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'non_game');
  assert.equal(upsertRecordCalls.length, 1);
  assert.equal(upsertRecordCalls[0].opts.status, 'not_found');
  assert.deepEqual(upsertRecordCalls[0].opts.payload, { purged: true, class: 'soundtrack', name: 'Some Game Soundtrack' });
});

test('fetchOne: an explicit job.data.gameId skips matching entirely', async () => {
  const http = fakeHttp(homm3);
  const upsertLinkCalls = [];
  const dbRouter = {
    one: async () => {
      throw new Error('should not query for a match when gameId is already known');
    },
    query: async () => [],
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls });
  const result = await fetchOne(ctx, { data: { externalId: '1207658787', gameId: 88 } });
  assert.equal(result.gameId, 88);
  assert.equal(upsertLinkCalls[0].gameId, 88);
});

// --- discover(): pagination, dedupe-by-signature, resume, fake http/db -----

function fakeDiscoverCtx({ pages, enqueueCalls = [] }) {
  let cursorState = {};
  const stateWrites = [];
  return {
    calls: { enqueueCalls, stateWrites },
    ctx: {
      http: {
        getJson: async (url) => {
          const m = url.match(/page=(\d+)/);
          const page = Number(m[1]);
          return pages[page - 1];
        },
      },
      log,
      config: { sources: { gog: { rateLimit: { max: 1, duration: 0 } } } },
      db: {
        one: async () => (Object.keys(cursorState).length ? { cursor_state: JSON.stringify(cursorState) } : null),
        query: async (sql, params) => {
          if (sql.startsWith('INSERT INTO source_state')) {
            cursorState = JSON.parse(params[1]);
            stateWrites.push({ page: params[1], lastFullPassAt: params[2] });
          }
          return [];
        },
      },
      enqueue: async (source, data) => {
        enqueueCalls.push({ source, data });
      },
    },
  };
}

test('discover: enqueues every new product across all pages, skips demos', async () => {
  const pages = [
    {
      pages: 2,
      products: [
        { id: '1', title: 'Alpha', slug: 'alpha', releaseDate: '2020.01.01', developers: ['Dev A'], price: { final: '$9.99' } },
        { id: '2', title: 'Beta Demo', slug: 'beta-demo', releaseDate: '2020.01.01', developers: ['Dev B'], price: null },
      ],
    },
    {
      pages: 2,
      products: [{ id: '3', title: 'Gamma', slug: 'gamma', releaseDate: '2020.01.01', developers: ['Dev C'], price: { final: '$4.99' } }],
    },
  ];
  const { ctx, calls } = fakeDiscoverCtx({ pages });
  const result = await discover(ctx);
  assert.equal(result.seen, 3);
  assert.equal(result.skippedDemo, 1);
  assert.equal(result.enqueued, 2);
  assert.deepEqual(
    calls.enqueueCalls.map((c) => c.data.externalId),
    ['1', '3'],
  );
});

test('discover: keeps a repackaged base-game pack, drops a DLC pack, keeps plain games', async () => {
  const pages = [
    {
      pages: 1,
      products: [
        { id: '1', productType: 'game', title: 'Alpha', slug: 'alpha', releaseDate: '2020.01.01', developers: ['Dev A'], price: { final: '$9.99' } },
        // No plain "game" product shares this pack's base title -> kept.
        { id: '2', productType: 'pack', title: 'Beta - Complete Edition', slug: 'beta-complete', releaseDate: '2020.01.01', developers: ['Dev B'], price: { final: '$19.99' } },
        // Keyword match -> dropped regardless of whether a base game exists
        // (a title ending in "Season Pass" so isDemo() doesn't also catch it).
        { id: '3', productType: 'pack', title: 'Alpha Season Pass', slug: 'alpha-season-pass', releaseDate: '2020.01.01', developers: ['Dev A'], price: { final: '$4.99' } },
      ],
    },
  ];
  const { ctx, calls } = fakeDiscoverCtx({ pages });
  const result = await discover(ctx);
  assert.equal(result.seen, 3);
  assert.equal(result.skippedPack, 1);
  assert.equal(result.enqueued, 2);
  assert.deepEqual(
    calls.enqueueCalls.map((c) => c.data.externalId),
    ['1', '2'],
  );
});

test('discover: a second pass with unchanged catalog data enqueues nothing', async () => {
  const page = {
    pages: 1,
    products: [{ id: '1', title: 'Alpha', slug: 'alpha', releaseDate: '2020.01.01', developers: ['Dev A'], price: { final: '$9.99' } }],
  };
  const { ctx, calls } = fakeDiscoverCtx({ pages: [page] });

  const first = await discover(ctx);
  assert.equal(first.enqueued, 1);

  const second = await discover(ctx);
  assert.equal(second.enqueued, 0);
  assert.equal(second.skippedUnchanged, 1);
  assert.equal(calls.enqueueCalls.length, 1, 'still only the one call from the first pass');
});

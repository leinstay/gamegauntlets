import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  name,
  rateLimit,
  extract,
  mapSearchCandidates,
  scoreCandidate,
  decideLink,
  buildSearchPayload,
  parseNextData,
  fetchDetail,
  fetchOne,
  planRefresh,
  discover,
  _resetCaches,
} from '../../src/sources/hltb.js';
import { log } from '../../src/log.js';

// Every test below drives hltb.js through injected fakes (fake db, fake http)
// so nothing here touches MySQL or the network. `extract()`/`mapSearchCandidates()`/
// `scoreCandidate()`/`decideLink()` are pure and are fed recorded fixtures
// (tests/fixtures/hltb/*.json - real /api/search/site + /_next/data/<buildId>/
// game/<id>.json bodies fetched live on 2026-09-19).

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'hltb');

function loadFixture(fileName) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, fileName), 'utf8'));
}

const searchPortal2 = loadFixture('search-portal2.json'); // real /api/search/site body for "Portal 2"
const portal2 = loadFixture('portal2.json'); // real detail payload, id 7231 (on Steam: profile_steam 620)
const ultima7 = loadFixture('ultima7.json'); // real detail payload, id 10770 (GOG-only: profile_steam 0)

// --- module shape ------------------------------------------------------------

test('module: exports name and the 1 req / 2s default rate limit', () => {
  assert.equal(name, 'hltb');
  assert.deepEqual(rateLimit, { max: 1, duration: 2000 });
});

test('module: discover is planRefresh (worker.js/queue.js schedule discover, not a catalog crawl)', () => {
  assert.equal(discover, planRefresh);
});

// --- extract() ----------------------------------------------------------------

test('extract: portal2 - timeMain/timeComplete in hours, release, links.steam', () => {
  const fields = extract(portal2);
  assert.equal(fields.timeMain, 8.6); // 30897s / 3600 = 8.58... -> 8.6
  assert.equal(fields.timeComplete, 23); // 82634s / 3600 = 22.95... -> 23.0
  assert.deepEqual(fields.release, { date: '2011-04-18', precision: 'day' });
  assert.deepEqual(fields.links, { steam: { id: '620', url: 'https://store.steampowered.com/app/620' } });
});

test('extract: ultima7 - GOG-only (profile_steam 0) -> no links.steam, release/time still present', () => {
  const fields = extract(ultima7);
  assert.equal(fields.links, undefined);
  assert.deepEqual(fields.release, { date: '1992-04-16', precision: 'day' });
  assert.equal(fields.timeMain, Math.round((134627 / 3600) * 10) / 10);
  assert.equal(fields.timeComplete, Math.round((346115 / 3600) * 10) / 10);
});

test('extract: comp_main/comp_100 of 0 ("no data" on HLTB) -> timeMain/timeComplete omitted', () => {
  const fields = extract({ ...portal2, comp_main: 0, comp_100: 0 });
  assert.equal(fields.timeMain, undefined);
  assert.equal(fields.timeComplete, undefined);
});

test('extract: garbage/empty payload -> {}', () => {
  assert.deepEqual(extract(null), {});
  assert.deepEqual(extract(undefined), {});
  assert.deepEqual(extract({}), {});
});

// --- mapSearchCandidates() / scoreCandidate() ---------------------------------

test('mapSearchCandidates: keeps only game_type "game", maps id/name/year', () => {
  const rows = mapSearchCandidates(searchPortal2.data);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['7231', '27601'], // the dlc (7232) and mod (150928) rows are dropped
  );
  assert.equal(rows[0].name, 'Portal 2');
  assert.equal(rows[0].year, 2011);
});

test('mapSearchCandidates: tolerates missing/empty rows', () => {
  assert.deepEqual(mapSearchCandidates(undefined), []);
  assert.deepEqual(mapSearchCandidates([]), []);
  assert.deepEqual(mapSearchCandidates([{ game_type: 'dlc', game_id: 1, game_name: 'x' }]), []);
});

test('mapSearchCandidates: keeps "endless" and "multi" titles (online games), drops every add-on kind', () => {
  const rows = mapSearchCandidates([
    { game_type: 'endless', game_id: 174520, game_name: 'R.E.P.O.', release_world: 2025 },
    { game_type: 'multi', game_id: 2, game_name: 'Cuisine Royale', release_world: 2018 },
    { game_type: 'mod', game_id: 3, game_name: 'x' },
    { game_type: 'pack', game_id: 4, game_name: 'y' },
    { game_type: 'compilation', game_id: 5, game_name: 'z' },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['174520', '2']);
});

test('scoreCandidate: exact normalized match vs a fuzzy one', () => {
  const exact = scoreCandidate('Portal 2', 'Portal 2');
  assert.equal(exact.exact, true);
  assert.equal(exact.sim, 100);

  const fuzzy = scoreCandidate('Portal 2: Sixense Perceptual Pack', 'Portal 2');
  assert.equal(fuzzy.exact, false);
  assert.ok(fuzzy.sim < 100);
});

// --- decideLink() - pure, fed fake candidates ---------------------------------

test('decideLink: profile_steam match wins even when the HLTB title differs a lot', () => {
  const candidates = [
    { id: '1', name: 'Some Totally Different Title', year: 2011, detail: { profile_steam: 620, release_world: '2011-04-18' } },
    { id: '2', name: 'Portal 2', year: 2011, detail: undefined },
  ];
  const decision = decideLink(candidates, { name: 'Portal 2', steamAppid: 620, releaseYear: 2011 });
  assert.deepEqual(decision, { status: 'strong', id: '1', confidence: 100 });
});

test('decideLink: no steam id available -> falls back to exact-name + release-year (+/-1) -> weak', () => {
  const candidates = [{ id: '10770', name: 'Ultima VII: The Black Gate', year: 1992, detail: { profile_steam: 0, release_world: '1992-04-16' } }];
  const decision = decideLink(candidates, { name: 'Ultima VII: The Black Gate', steamAppid: null, releaseYear: 1992 });
  assert.deepEqual(decision, { status: 'weak', id: '10770', confidence: 70 });
});

test('decideLink: exact name but release year outside tolerance -> not_found', () => {
  const candidates = [{ id: '5', name: 'Doom', year: 2016, detail: { profile_steam: 0, release_world: '2016-05-13' } }];
  const decision = decideLink(candidates, { name: 'Doom', steamAppid: null, releaseYear: 1993 });
  assert.deepEqual(decision, { status: 'not_found' });
});

test('decideLink: no exact match, no steam id -> not_found (fuzzy alone never qualifies for weak)', () => {
  const candidates = [{ id: '2', name: 'Portal 2: Sixense Perceptual Pack', year: 2013, detail: undefined }];
  const decision = decideLink(candidates, { name: 'Portal 2', steamAppid: null, releaseYear: 2011 });
  assert.deepEqual(decision, { status: 'not_found' });
});

test('decideLink: near-identical title (sim >= 90) confirmed by year -> weak (confidence 60)', () => {
  const candidates = [
    { id: '7', name: 'Yakuza 5', year: 2012, detail: undefined },
    { id: '8', name: 'Frozen Free Fall: Snowball Fights', year: 2015, detail: undefined },
  ];
  const decision = decideLink(candidates, { name: 'Frozen Free Fall: Snowball Fight', steamAppid: null, releaseYear: 2015 });
  assert.deepEqual(decision, { status: 'weak', id: '8', confidence: 60 });
});

test('decideLink: near-identical title but wrong year -> not_found', () => {
  const candidates = [{ id: '8', name: 'Frozen Free Fall: Snowball Fights', year: 2015, detail: undefined }];
  const decision = decideLink(candidates, { name: 'Frozen Free Fall: Snowball Fight', steamAppid: null, releaseYear: 2001 });
  assert.deepEqual(decision, { status: 'not_found' });
});

test('decideLink: empty candidate list -> not_found', () => {
  assert.deepEqual(decideLink([], { name: 'Anything', steamAppid: 1, releaseYear: 2020 }), { status: 'not_found' });
});

// --- buildSearchPayload() ------------------------------------------------------

test('buildSearchPayload: fixed search shape + the dynamic hpKey/hpVal body field', () => {
  const body = buildSearchPayload(['Portal', '2'], { token: 't', hpKey: 'ign_abc', hpVal: 'val123' });
  assert.deepEqual(body.searchTerms, ['Portal', '2']);
  assert.equal(body.searchType, 'games');
  assert.equal(body.searchPage, 1);
  assert.equal(body.size, 20);
  assert.equal(body.useCache, true);
  assert.equal(body.ign_abc, 'val123'); // the dynamic field name IS the hpKey value itself
});

test('buildSearchPayload: no token yet -> no dynamic field added', () => {
  const body = buildSearchPayload(['Foo'], null);
  assert.equal(Object.keys(body).includes('undefined'), false);
});

// --- parseNextData() ------------------------------------------------------------

test('parseNextData: extracts game[0] out of a __NEXT_DATA__ script tag', () => {
  const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { game: { data: { game: [portal2] } } } },
  })}</script></body></html>`;
  const game = parseNextData(html);
  assert.equal(game.game_id, 7231);
});

test('parseNextData: no tag / malformed JSON -> null', () => {
  assert.equal(parseNextData('<html></html>'), null);
  assert.equal(parseNextData('<script id="__NEXT_DATA__" type="application/json">{not json</script>'), null);
});

// --- fetchDetail() - buildId caching + automatic refresh on 404 ---------------

test('fetchDetail: derives buildId from the homepage once, then reuses it', async () => {
  _resetCaches();
  const getTextCalls = [];
  const getJsonCalls = [];
  const http = {
    getText: async (url) => {
      getTextCalls.push(url);
      return '<html>"buildId":"build-abc"</html>';
    },
    getJson: async (url) => {
      getJsonCalls.push(url);
      assert.ok(url.includes('/_next/data/build-abc/game/7231.json'));
      return { pageProps: { game: { data: { game: [portal2] } } } };
    },
  };
  const result = await fetchDetail(http, '7231');
  assert.equal(result.game_id, 7231);

  // second call: buildId is cached, no extra homepage fetch
  const result2 = await fetchDetail(http, '7231');
  assert.equal(result2.game_id, 7231);
  assert.equal(getTextCalls.length, 1);
  assert.equal(getJsonCalls.length, 2);
});

test('fetchDetail: a 404 (stale buildId after a new HLTB deploy) refreshes the buildId once and retries', async () => {
  _resetCaches();
  let homepageCalls = 0;
  const http = {
    getText: async () => {
      homepageCalls += 1;
      return `<html>"buildId":"build-${homepageCalls}"</html>`;
    },
    getJson: async (url) => {
      if (url.includes('build-1')) {
        const err = new Error('HTTP 404');
        err.statusCode = 404;
        throw err;
      }
      return { pageProps: { game: { data: { game: [portal2] } } } };
    },
  };
  const result = await fetchDetail(http, '7231');
  assert.equal(result.game_id, 7231);
  assert.equal(homepageCalls, 2);
});

test('fetchDetail: still 404 after a buildId refresh -> falls back to __NEXT_DATA__ on the game page', async () => {
  _resetCaches();
  const nextDataHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { game: { data: { game: [portal2] } } } },
  })}</script>`;
  const http = {
    getText: async (url) => {
      if (url.includes('/game/')) return nextDataHtml;
      return '<html>"buildId":"build-x"</html>';
    },
    getJson: async () => {
      const err = new Error('HTTP 404');
      err.statusCode = 404;
      throw err;
    },
  };
  const result = await fetchDetail(http, '7231');
  assert.equal(result.game_id, 7231);
});

test('fetchDetail: a genuine miss everywhere -> null', async () => {
  _resetCaches();
  const http = {
    getText: async (url) => (url.includes('/game/') ? '<html>no next data here</html>' : '<html>"buildId":"build-x"</html>'),
    getJson: async () => {
      const err = new Error('HTTP 404');
      err.statusCode = 404;
      throw err;
    },
  };
  const result = await fetchDetail(http, '999999');
  assert.equal(result, null);
});

// --- fetchOne(): DB-facing logic, fake ctx ------------------------------------

function fakeCtx({ http, dbRouter, config = {}, enqueueResolveCalls = [], upsertRecordCalls = [], upsertLinkCalls = [] }) {
  return {
    http,
    log,
    config,
    db: {
      one: async (sql, params) => dbRouter.one(sql, params),
      query: async (sql, params) => (dbRouter.query ? dbRouter.query(sql, params) : []),
    },
    upsertRecord: async (source, externalId, opts) => {
      upsertRecordCalls.push({ source, externalId, opts });
    },
    upsertLink: async (gameId, source, externalId, opts) => {
      upsertLinkCalls.push({ gameId, source, externalId, opts });
    },
    enqueueResolve: async (gameId) => {
      enqueueResolveCalls.push(gameId);
    },
  };
}

function fakeHttpWithBuildIdAndDetail(detailById) {
  return {
    getText: async (url) => {
      if (url.includes('/game/')) return '<html>no next data here</html>';
      return '<html>"buildId":"build-x"</html>';
    },
    getJson: async (url) => {
      if (url.includes('/api/search/site/init')) return { token: 'tok', hpKey: 'ign_x', hpVal: 'val' };
      const m = url.match(/\/game\/([^./]+)\.json/);
      const id = m?.[1];
      if (id && detailById[id]) return { pageProps: { game: { data: { game: [detailById[id]] } } } };
      const err = new Error('HTTP 404');
      err.statusCode = 404;
      throw err;
    },
  };
}

test('fetchOne: existing hltb link -> fetches by id directly, keeps method/confidence, no search', async () => {
  _resetCaches();
  const http = fakeHttpWithBuildIdAndDetail({ 7231: portal2 });
  http.postJson = async () => {
    throw new Error('must not search when a link already exists');
  };
  const upsertLinkCalls = [];
  const upsertRecordCalls = [];
  const enqueueResolveCalls = [];
  const dbRouter = {
    one: async (sql) => {
      if (sql.includes('FROM games WHERE id')) return { id: 5, name: 'Portal 2', steam_appid: 620, release_date: '2011-04-18' };
      if (sql.includes('FROM game_links')) return { external_id: '7231', match_method: 'legacy', confidence: 95 };
      return null;
    },
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls, upsertRecordCalls, enqueueResolveCalls });
  const result = await fetchOne(ctx, { data: { gameId: 5 } });
  assert.equal(result.status, 'ok');
  assert.equal(result.externalId, '7231');
  assert.equal(upsertRecordCalls[0].opts.status, 'ok');
  assert.equal(upsertLinkCalls[0].opts.method, 'legacy');
  assert.equal(upsertLinkCalls[0].opts.confidence, 95);
  assert.deepEqual(enqueueResolveCalls, [5]);
});

test('fetchOne: existing hltb link but HLTB no longer has it, search finds nothing -> per-game not_found, no link', async () => {
  _resetCaches();
  const http = fakeHttpWithBuildIdAndDetail({});
  http.postJson = async () => ({ data: [] });
  const upsertLinkCalls = [];
  const upsertRecordCalls = [];
  const enqueueResolveCalls = [];
  const dbRouter = {
    one: async (sql) => {
      if (sql.includes('FROM games WHERE id')) return { id: 5, name: 'Some Game', steam_appid: null, release_date: null };
      if (sql.includes('FROM game_links')) return { external_id: '999999', match_method: 'legacy', confidence: 95 };
      return null;
    },
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls, upsertRecordCalls, enqueueResolveCalls });
  const result = await fetchOne(ctx, { data: { gameId: 5 } });
  assert.equal(result.status, 'not_found');
  assert.equal(upsertRecordCalls.length, 1);
  assert.equal(upsertRecordCalls[0].externalId, 'game-5');
  assert.equal(upsertRecordCalls[0].opts.status, 'not_found');
  assert.equal(upsertLinkCalls.length, 0);
  assert.equal(enqueueResolveCalls.length, 0);
});

test('fetchOne: existing hltb link that 404s, search finds the game under a new id -> relinked by name', async () => {
  _resetCaches();
  const http = fakeHttpWithBuildIdAndDetail({ 7231: portal2 }); // the old id 999999 has no detail
  http.postJson = async () => searchPortal2;
  const upsertLinkCalls = [];
  const upsertRecordCalls = [];
  const enqueueResolveCalls = [];
  const dbRouter = {
    one: async (sql) => {
      if (sql.includes('FROM games WHERE id')) return { id: 5, name: 'Portal 2', steam_appid: 620, release_date: '2011-04-18' };
      if (sql.includes('FROM game_links')) return { external_id: '999999', match_method: 'wikidata', confidence: 95 };
      return null;
    },
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls, upsertRecordCalls, enqueueResolveCalls });
  const result = await fetchOne(ctx, { data: { gameId: 5 } });
  assert.equal(result.status, 'ok');
  assert.equal(result.externalId, '7231');
  assert.equal(upsertRecordCalls.length, 1);
  assert.equal(upsertRecordCalls[0].opts.status, 'ok');
  assert.equal(upsertLinkCalls[0].externalId, '7231');
  assert.equal(upsertLinkCalls[0].opts.method, 'name');
  assert.deepEqual(enqueueResolveCalls, [5]);
});

test('fetchOne: no existing link, search finds a profile_steam match -> strong attach', async () => {
  _resetCaches();
  const http = fakeHttpWithBuildIdAndDetail({ 7231: portal2 });
  http.postJson = async (url, body) => {
    assert.equal(url, 'https://howlongtobeat.com/api/search/site');
    assert.deepEqual(body.searchTerms, ['Portal', '2']);
    return searchPortal2;
  };
  const upsertLinkCalls = [];
  const upsertRecordCalls = [];
  const enqueueResolveCalls = [];
  const dbRouter = {
    one: async (sql) => {
      if (sql.includes('FROM games WHERE id')) return { id: 5, name: 'Portal 2', steam_appid: 620, release_date: '2011-04-18' };
      if (sql.includes('FROM game_links')) return null; // no existing link
      return null;
    },
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls, upsertRecordCalls, enqueueResolveCalls });
  const result = await fetchOne(ctx, { data: { gameId: 5 } });
  assert.equal(result.status, 'ok');
  assert.equal(result.externalId, '7231');
  assert.equal(result.confidence, 100);
  assert.equal(upsertLinkCalls[0].opts.method, 'name');
  assert.equal(upsertLinkCalls[0].opts.confidence, 100);
  assert.deepEqual(enqueueResolveCalls, [5]);
});

test('fetchOne: no existing link, no steam id, exact name + year -> weak attach (confidence 70)', async () => {
  _resetCaches();
  const http = fakeHttpWithBuildIdAndDetail({ 10770: ultima7 });
  http.postJson = async () => ({
    count: 1,
    data: [{ game_id: 10770, game_name: 'Ultima VII: The Black Gate', game_type: 'game', release_world: 1992 }],
  });
  const upsertLinkCalls = [];
  const upsertRecordCalls = [];
  const enqueueResolveCalls = [];
  const dbRouter = {
    one: async (sql) => {
      if (sql.includes('FROM games WHERE id')) {
        return { id: 9, name: 'Ultima VII: The Black Gate', steam_appid: null, release_date: '1992-04-16' };
      }
      if (sql.includes('FROM game_links')) return null;
      return null;
    },
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls, upsertRecordCalls, enqueueResolveCalls });
  const result = await fetchOne(ctx, { data: { gameId: 9 } });
  assert.equal(result.status, 'ok');
  assert.equal(result.externalId, '10770');
  assert.equal(result.confidence, 70);
  assert.equal(upsertLinkCalls[0].opts.confidence, 70);
  assert.deepEqual(enqueueResolveCalls, [9]);
});

test('fetchOne: literal + normalized searches miss, a searchNameVariants fallback ("Nioh 2") finds the game', async () => {
  // Real case from the 2026-09-22 report: "Nioh 2 – The Complete Edition"
  // literal words and its normalized form ("Nioh 2 The") both miss on HLTB;
  // searchNameVariants' 2nd entry ("Nioh 2", the marketing suffix stripped)
  // is the title HLTB actually carries.
  _resetCaches();
  const http = fakeHttpWithBuildIdAndDetail({ 999: { game_id: 999, game_name: 'Nioh 2', profile_steam: 0, release_world: '2020-03-12' } });
  const searchedTerms = [];
  http.postJson = async (url, body) => {
    searchedTerms.push(body.searchTerms.join(' '));
    if (body.searchTerms.join(' ').toLowerCase() === 'nioh 2') {
      return { count: 1, data: [{ game_id: 999, game_name: 'Nioh 2', game_type: 'game', release_world: 2020 }] };
    }
    return { count: 0, data: [] };
  };
  const upsertLinkCalls = [];
  const upsertRecordCalls = [];
  const enqueueResolveCalls = [];
  const dbRouter = {
    one: async (sql) => {
      if (sql.includes('FROM games WHERE id')) {
        return { id: 77, name: 'Nioh 2 – The Complete Edition', steam_appid: null, release_date: '2020-03-12' };
      }
      if (sql.includes('FROM game_links')) return null;
      return null;
    },
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls, upsertRecordCalls, enqueueResolveCalls });
  const result = await fetchOne(ctx, { data: { gameId: 77 } });
  assert.equal(result.status, 'ok');
  assert.equal(result.externalId, '999');
  assert.equal(result.confidence, 70); // weak: exact match against the "Nioh 2" variant + year confirmed
  assert.equal(upsertLinkCalls[0].opts.confidence, 70);
  assert.deepEqual(enqueueResolveCalls, [77]);
  // literal words, the normalized fallback, and the "Nioh 2" variant were all tried, in that order
  assert.deepEqual(
    searchedTerms.map((t) => t.toLowerCase()),
    ['nioh 2 - the complete edition', 'nioh 2 the', 'nioh 2'],
  );
});

test('fetchOne: no existing link, nothing matches -> not_found record only, no link/resolve', async () => {
  _resetCaches();
  const http = fakeHttpWithBuildIdAndDetail({});
  http.postJson = async () => ({ count: 0, data: [] });
  const upsertLinkCalls = [];
  const upsertRecordCalls = [];
  const enqueueResolveCalls = [];
  const dbRouter = {
    one: async (sql) => {
      if (sql.includes('FROM games WHERE id')) return { id: 42, name: 'Totally Obscure Game', steam_appid: null, release_date: null };
      if (sql.includes('FROM game_links')) return null;
      return null;
    },
  };
  const ctx = fakeCtx({ http, dbRouter, upsertLinkCalls, upsertRecordCalls, enqueueResolveCalls });
  const result = await fetchOne(ctx, { data: { gameId: 42 } });
  assert.equal(result.status, 'not_found');
  assert.equal(upsertRecordCalls.length, 1);
  assert.equal(upsertRecordCalls[0].opts.status, 'not_found');
  assert.equal(upsertLinkCalls.length, 0);
  assert.equal(enqueueResolveCalls.length, 0);
});

test('fetchOne: throws when the game row itself does not exist (bad premise, not a "not_found" outcome)', async () => {
  const ctx = fakeCtx({ http: {}, dbRouter: { one: async () => null } });
  await assert.rejects(() => fetchOne(ctx, { data: { gameId: 404 } }), /not found/);
});

// --- planRefresh() / discover() ------------------------------------------------

function fakePlanRefreshCtx({ rows, config = {} }) {
  const enqueueCalls = [];
  const selectParams = [];
  const stateWrites = [];
  return {
    calls: { enqueueCalls, selectParams, stateWrites },
    ctx: {
      config,
      log,
      db: {
        query: async (sql, params) => {
          if (sql.includes('FROM games g')) {
            selectParams.push(params);
            return rows;
          }
          if (sql.startsWith('INSERT INTO source_state')) {
            stateWrites.push(params);
            return [];
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

test('planRefresh: defaults refreshDays=60/dailyCap=3000 when config.sources.hltb is absent', async () => {
  const { ctx, calls } = fakePlanRefreshCtx({ rows: [{ gameId: 1 }, { gameId: 2 }] });
  const result = await planRefresh(ctx);
  assert.deepEqual(calls.selectParams[0], [60, 3000]);
  assert.equal(result.refreshDays, 60);
  assert.equal(result.dailyCap, 3000);
  assert.deepEqual(
    calls.enqueueCalls.map((c) => c.data.gameId),
    [1, 2],
  );
  assert.equal(calls.enqueueCalls[0].source, 'hltb');
  assert.equal(calls.stateWrites.length, 1);
});

test('planRefresh: config.sources.hltb.refreshDays/dailyCap override the defaults', async () => {
  const { ctx, calls } = fakePlanRefreshCtx({
    rows: [{ gameId: 7 }],
    config: { sources: { hltb: { refreshDays: 30, dailyCap: 10 } } },
  });
  const result = await planRefresh(ctx);
  assert.deepEqual(calls.selectParams[0], [30, 10]);
  assert.equal(result.enqueued, 1);
});

test('planRefresh: no candidates -> enqueues nothing, still records source_state', async () => {
  const { ctx, calls } = fakePlanRefreshCtx({ rows: [] });
  const result = await planRefresh(ctx);
  assert.equal(result.enqueued, 0);
  assert.equal(calls.enqueueCalls.length, 0);
  assert.equal(calls.stateWrites.length, 1);
});

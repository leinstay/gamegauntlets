import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  name,
  rateLimit,
  buildMainQuery,
  buildGogOnlyQuery,
  buildRefreshQueryByQid,
  buildRefreshQueryBySteamAppid,
  qidFromUri,
  parseGogValue,
  parsePubDates,
  parseList,
  parseBinding,
  mapPrecision,
  dateForPrecision,
  earliestRelease,
  collectLinks,
  extract,
  upsertLinkGuarded,
  applyRecord,
  discover,
  fetchOne,
} from '../../src/sources/wikidata.js';
import { createContext } from '../../src/pipeline/context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Recorded once from the live WDQS endpoint (query.wikidata.org/sparql) on
// 2026-09-19, using exactly the queries `buildMainQuery`/`buildGogOnlyQuery`
// produce (VALUES-restricted to a handful of well-known items instead of a
// full appid range, so the fixture is small but the shape is identical to
// what a real paged query returns). See the task report for the full
// verification transcript and the paged-query timings measured against the
// live endpoint.
function loadFixture(file) {
  return JSON.parse(readFileSync(path.join(__dirname, '../fixtures/wikidata', file), 'utf8'));
}

const mainFixture = loadFixture('main-page.json');
const gogOnlyFixture = loadFixture('gog-only.json');

function bindingFor(fixture, matcher) {
  const found = fixture.results.bindings.find(matcher);
  assert.ok(found, 'fixture binding not found');
  return found;
}

const halfLifeBinding = bindingFor(mainFixture, (b) => b.steamId?.value === '70');
const witcher3Binding = bindingFor(mainFixture, (b) => b.steamId?.value === '292030');
const csBinding = bindingFor(mainFixture, (b) => b.steamId?.value === '10');
const witcherGogBinding = gogOnlyFixture.results.bindings[0];

// --- module shape -----------------------------------------------------

test('module: exports name/rateLimit per the source module interface', () => {
  assert.equal(name, 'wikidata');
  assert.deepEqual(rateLimit, { max: 1, duration: 1000 });
});

// --- query builders (pure) ----------------------------------------------

describe('buildMainQuery', () => {
  test('embeds the appid range as a bound integer FILTER', () => {
    const q = buildMainQuery(0, 50000);
    assert.match(q, /FILTER\(xsd:integer\(\?steamId\) >= 0 && xsd:integer\(\?steamId\) < 50000\)/);
    assert.match(q, /\?item wdt:P1733 \?steamId/);
    assert.match(q, /GROUP BY \?item \?steamId/);
  });

  test('coerces numeric-looking strings and truncates floats', () => {
    const q = buildMainQuery('10', 20.9);
    assert.match(q, />= 10 && xsd:integer\(\?steamId\) < 20\)/);
  });

  test('throws on non-numeric bounds', () => {
    assert.throws(() => buildMainQuery('abc', 100), /finite number/);
  });
});

describe('buildGogOnlyQuery', () => {
  test('has no Steam-id FILTER, excludes items that have one, and embeds LIMIT', () => {
    const q = buildGogOnlyQuery(1234);
    assert.match(q, /\?item wdt:P2725 \?gogId/);
    assert.match(q, /MINUS \{ \?item wdt:P1733 \?steamIdX \. \}/);
    assert.match(q, /LIMIT 1234$/);
  });

  test('defaults to a LIMIT when called with no argument', () => {
    const q = buildGogOnlyQuery();
    assert.match(q, /LIMIT \d+$/);
  });
});

describe('buildRefreshQueryByQid', () => {
  test('embeds a valid QID via VALUES', () => {
    const q = buildRefreshQueryByQid('Q279744');
    assert.match(q, /VALUES \?item \{ wd:Q279744 \}/);
  });

  test('rejects anything that is not a bare QID (injection guard)', () => {
    assert.throws(() => buildRefreshQueryByQid('Q1; DROP'), /invalid QID/);
    assert.throws(() => buildRefreshQueryByQid('not-a-qid'), /invalid QID/);
    assert.throws(() => buildRefreshQueryByQid(''), /invalid QID/);
  });
});

describe('buildRefreshQueryBySteamAppid', () => {
  test('embeds the appid as a literal-matched steamId and LIMIT 1', () => {
    const q = buildRefreshQueryBySteamAppid(70);
    assert.match(q, /FILTER\(\?steamId = "70"\)/);
    assert.match(q, /LIMIT 1$/);
  });
});

// --- binding parsing (pure, against real fixtures) -----------------------

describe('parseBinding', () => {
  test('Half-Life: ids, wikipedia titles, and raw publication dates', () => {
    const r = parseBinding(halfLifeBinding);
    assert.equal(r.qid, 'Q279744');
    assert.equal(r.steamAppid, 70);
    assert.equal(r.gog, null);
    assert.equal(r.igdbId, 'half-life');
    assert.equal(r.hltbId, '4247');
    assert.equal(r.gamefaqsId, '43362');
    assert.equal(r.wikipediaEn, 'Half-Life (video game)');
    assert.equal(r.wikipediaRu, 'Half-Life');
    // current MobyGames scheme (P11688 = "155") wins over the legacy one.
    assert.equal(r.mobygamesId, '155');
    assert.deepEqual(r.developers, []);
    assert.deepEqual(r.publishers, []);
    assert.deepEqual(
      r.publicationDates.map((d) => d.date),
      ['2013-02-14T00:00:00Z', '2001-11-11T00:00:00Z', '1998-11-19T00:00:00Z'],
    );
    assert.ok(r.publicationDates.every((d) => d.precision === 11));
  });

  test('The Witcher 3: GOG value parsed, current-scheme MobyGames id preferred, dev/publisher lists split', () => {
    const r = parseBinding(witcher3Binding);
    assert.equal(r.steamAppid, 292030);
    assert.deepEqual(r.gog, {
      kind: 'game',
      slug: 'the_witcher_3_wild_hunt_expansion_pass',
      raw: 'game/the_witcher_3_wild_hunt_expansion_pass',
    });
    assert.equal(r.opencriticId, '463');
    // both P11688 (current, "73001") and P1933 (legacy, "witcher-3-wild-hunt")
    // are present in this fixture row -> the current scheme wins.
    assert.equal(r.mobygamesId, '73001');
    assert.deepEqual(r.developers, ['CD Projekt RED']);
    assert.deepEqual(r.publishers, ['Namco', 'cdp.pl', 'CD Projekt RED', 'Warner Bros. Games']);
  });

  test('MobyGames id falls back to the legacy P1933 scheme when P11688 is absent', () => {
    // None of the recorded fixture rows happen to lack the current scheme
    // (Wikidata has migrated most of them already), so this exercises the
    // fallback branch directly against a constructed binding.
    const r = parseBinding({
      item: { value: 'http://www.wikidata.org/entity/Q1' },
      mobyIdOld_: { value: 'legacy-slug' },
    });
    assert.equal(r.mobygamesId, 'legacy-slug');
  });

  test('empty developers/publishers concat strings parse to an empty array, not ["")', () => {
    const r = parseBinding(csBinding);
    assert.deepEqual(r.developers, []);
    assert.deepEqual(r.publishers, ['Nexon']);
  });

  test('GOG-only pass binding: no steamAppid, gog id present, item resolved from the plain (non-aggregated) ?gogId var', () => {
    const r = parseBinding(witcherGogBinding);
    assert.equal(r.qid, 'Q287637');
    assert.equal(r.steamAppid, null);
    assert.deepEqual(r.gog, { kind: 'game', slug: 'the_witcher', raw: 'game/the_witcher' });
    assert.equal(r.igdbId, 'the-witcher');
    assert.deepEqual(r.developers, ['CD Projekt RED']);
    assert.deepEqual(r.publishers, ['Atari, Inc.']);
  });
});

describe('qidFromUri', () => {
  test('extracts the QID from an entity URI', () => {
    assert.equal(qidFromUri('http://www.wikidata.org/entity/Q279744'), 'Q279744');
  });
  test('null passthrough', () => {
    assert.equal(qidFromUri(null), null);
  });
});

describe('parseGogValue', () => {
  test('parses a game/ path', () => {
    assert.deepEqual(parseGogValue('game/the_witcher'), { kind: 'game', slug: 'the_witcher', raw: 'game/the_witcher' });
  });
  test('parses a movie/ path (not a game match)', () => {
    assert.deepEqual(parseGogValue('movie/dark_dungeons'), { kind: 'movie', slug: 'dark_dungeons', raw: 'movie/dark_dungeons' });
  });
  test('null for no value', () => {
    assert.equal(parseGogValue(null), null);
    assert.equal(parseGogValue(''), null);
  });
});

describe('parsePubDates', () => {
  test('splits the "date|precision" GROUP_CONCAT format', () => {
    assert.deepEqual(parsePubDates('1998-11-19T00:00:00Z|11||2001-11-11T00:00:00Z|11'), [
      { date: '1998-11-19T00:00:00Z', precision: 11 },
      { date: '2001-11-11T00:00:00Z', precision: 11 },
    ]);
  });
  test('empty/null -> []', () => {
    assert.deepEqual(parsePubDates(''), []);
    assert.deepEqual(parsePubDates(null), []);
  });
});

describe('parseList', () => {
  test('splits, trims, dedupes, drops empties', () => {
    assert.deepEqual(parseList('a|b|b| a |'), ['a', 'b']);
  });
  test('empty/null -> []', () => {
    assert.deepEqual(parseList(''), []);
    assert.deepEqual(parseList(null), []);
  });
});

// --- release date precision mapping --------------------------------------

describe('mapPrecision / dateForPrecision', () => {
  test('11=day, 10=month, 9=year, anything else unknown', () => {
    assert.equal(mapPrecision(11), 'day');
    assert.equal(mapPrecision(10), 'month');
    assert.equal(mapPrecision(9), 'year');
    assert.equal(mapPrecision(8), 'unknown');
    assert.equal(mapPrecision(14), 'unknown');
  });

  test('truncates the ISO datetime to the right precision', () => {
    assert.equal(dateForPrecision('1998-11-19T00:00:00Z', 'day'), '1998-11-19');
    assert.equal(dateForPrecision('1998-11-19T00:00:00Z', 'month'), '1998-11-01');
    assert.equal(dateForPrecision('1998-11-19T00:00:00Z', 'year'), '1998-01-01');
    assert.equal(dateForPrecision('1998-11-19T00:00:00Z', 'unknown'), null);
  });
});

describe('earliestRelease', () => {
  test('Half-Life: picks 1998-11-19 (day) as the earliest of three candidates', () => {
    const r = parseBinding(halfLifeBinding);
    assert.deepEqual(earliestRelease(r.publicationDates), { date: '1998-11-19', precision: 'day' });
  });

  test('The Witcher 3: earliest across mixed day/year precisions is the day-precision 2015-05-19', () => {
    const r = parseBinding(witcher3Binding);
    assert.deepEqual(earliestRelease(r.publicationDates), { date: '2015-05-19', precision: 'day' });
  });

  test('empty input -> null', () => {
    assert.equal(earliestRelease([]), null);
    assert.equal(earliestRelease(undefined), null);
  });

  test('unsupported precisions are ignored, not treated as valid dates', () => {
    assert.equal(earliestRelease([{ date: '1990-01-01T00:00:00Z', precision: 8 }]), null);
  });
});

// --- links ----------------------------------------------------------------

describe('collectLinks', () => {
  test('Half-Life: no gog (absent), every other present id becomes a link candidate', () => {
    const r = parseBinding(halfLifeBinding);
    const links = collectLinks(r);
    const bySource = Object.fromEntries(links.map((l) => [l.source, l]));
    assert.equal(bySource.wikidata.externalId, 'Q279744');
    assert.equal(bySource.wikidata.url, 'https://www.wikidata.org/wiki/Q279744');
    assert.equal(bySource.gog, undefined);
    assert.equal(bySource.igdb.url, 'https://www.igdb.com/games/half-life');
    assert.equal(bySource.hltb.url, 'https://howlongtobeat.com/game/4247');
    assert.equal(bySource.mobygames.externalId, '155');
    assert.equal(bySource.wikipedia_en.url, 'https://en.wikipedia.org/wiki/Half-Life_(video_game)');
    assert.equal(bySource.wikipedia_ru.url, 'https://ru.wikipedia.org/wiki/Half-Life');
  });

  test('a movie/ GOG value never becomes a "gog" link', () => {
    const r = { qid: 'Q1', gog: { kind: 'movie', slug: 'x', raw: 'movie/x' } };
    const links = collectLinks(r);
    assert.equal(links.some((l) => l.source === 'gog'), false);
  });

  test('The Witcher (GOG-only): gog link uses the raw game/ path in the url, bare slug as externalId', () => {
    const r = parseBinding(witcherGogBinding);
    const links = collectLinks(r);
    const gog = links.find((l) => l.source === 'gog');
    assert.equal(gog.externalId, 'the_witcher');
    assert.equal(gog.url, 'https://www.gog.com/game/the_witcher');
  });
});

// --- extract() --------------------------------------------------------

describe('extract', () => {
  test('Half-Life: release + links, no developers/publishers (none in the fixture)', () => {
    const r = parseBinding(halfLifeBinding);
    const out = extract(r);
    assert.deepEqual(out.release, { date: '1998-11-19', precision: 'day' });
    assert.equal(out.developers, undefined);
    assert.equal(out.publishers, undefined);
    assert.ok(out.links.igdb);
    assert.equal(out.links.wikidata, undefined, 'self-link is omitted from the cross-reference map');
  });

  test('The Witcher 3: release, developers, publishers, and a gog link all present', () => {
    const r = parseBinding(witcher3Binding);
    const out = extract(r);
    assert.deepEqual(out.release, { date: '2015-05-19', precision: 'day' });
    assert.deepEqual(out.developers, ['CD Projekt RED']);
    assert.deepEqual(out.publishers, ['Namco', 'cdp.pl', 'CD Projekt RED', 'Warner Bros. Games']);
    assert.equal(out.links.gog.id, 'the_witcher_3_wild_hunt_expansion_pass');
  });

  test('a payload with nothing extractable returns an object with no keys', () => {
    assert.deepEqual(extract({ qid: 'Q1' }), {});
  });
});

// --- upsertLinkGuarded --------------------------------------------------

function fakeCtxForGuard(existingLink) {
  const upsertCalls = [];
  const ctx = {
    db: { one: async () => existingLink },
    upsertLink: async (gameId, source, externalId, opts) => {
      upsertCalls.push({ gameId, source, externalId, opts });
    },
  };
  return { ctx, upsertCalls };
}

describe('upsertLinkGuarded', () => {
  test('writes when there is no existing link', async () => {
    const { ctx, upsertCalls } = fakeCtxForGuard(null);
    const wrote = await upsertLinkGuarded(ctx, 1, 'hltb', '123', { url: 'u', method: 'wikidata', confidence: 95 });
    assert.equal(wrote, true);
    assert.equal(upsertCalls.length, 1);
  });

  test('never overwrites match_method "store"', async () => {
    const { ctx, upsertCalls } = fakeCtxForGuard({ match_method: 'store', confidence: 50 });
    const wrote = await upsertLinkGuarded(ctx, 1, 'gog', 'x', { url: 'u', method: 'wikidata', confidence: 95 });
    assert.equal(wrote, false);
    assert.equal(upsertCalls.length, 0);
  });

  test('never overwrites match_method "manual"', async () => {
    const { ctx, upsertCalls } = fakeCtxForGuard({ match_method: 'manual', confidence: 10 });
    const wrote = await upsertLinkGuarded(ctx, 1, 'gog', 'x', { url: 'u', method: 'wikidata', confidence: 95 });
    assert.equal(wrote, false);
    assert.equal(upsertCalls.length, 0);
  });

  test('never downgrades to a lower confidence', async () => {
    const { ctx, upsertCalls } = fakeCtxForGuard({ match_method: 'igdb', confidence: 99 });
    const wrote = await upsertLinkGuarded(ctx, 1, 'hltb', 'x', { url: 'u', method: 'wikidata', confidence: 95 });
    assert.equal(wrote, false);
    assert.equal(upsertCalls.length, 0);
  });

  test('overwrites an equal-or-lower-confidence non-protected link', async () => {
    const { ctx, upsertCalls } = fakeCtxForGuard({ match_method: 'name', confidence: 60 });
    const wrote = await upsertLinkGuarded(ctx, 1, 'hltb', 'x', { url: 'u', method: 'wikidata', confidence: 95 });
    assert.equal(wrote, true);
    assert.equal(upsertCalls.length, 1);
  });
});

// --- discover()/fetchOne() integration (fake db + fake http, via the real
// createContext so upsertRecord/upsertLink go through the real SQL) --------

function makeFakeDb({ byAppid = new Map(), byId = new Map(), byGogSlug = new Map(), gogOwners = new Map(), gameLinks = new Map(), stateRow = null } = {}) {
  const calls = { query: [], one: [] };
  return {
    calls,
    query: async (sql, params = []) => {
      calls.query.push({ sql, params });
      return { affectedRows: 1 };
    },
    one: async (sql, params = []) => {
      calls.one.push({ sql, params });
      if (/FROM source_state/.test(sql)) return stateRow;
      if (/FROM games WHERE steam_appid = \?/.test(sql)) return byAppid.get(Number(params[0])) ?? null;
      if (/FROM games WHERE gog_slug = \? AND id != \?/.test(sql)) {
        const [slug, excludeId] = params;
        const ownerId = gogOwners.get(slug);
        return ownerId != null && ownerId !== excludeId ? { id: ownerId } : null;
      }
      if (/FROM games WHERE gog_slug = \?/.test(sql)) return byGogSlug.get(params[0]) ?? null;
      if (/FROM games WHERE id = \?/.test(sql)) return byId.get(Number(params[0])) ?? null;
      if (/FROM game_links WHERE game_id = \? AND source = \?/.test(sql)) {
        return gameLinks.get(`${params[0]}:${params[1]}`) ?? null;
      }
      throw new Error(`makeFakeDb: unexpected db.one query: ${sql}`);
    },
  };
}

function makeFakeHttp(responses) {
  let i = 0;
  const calls = [];
  return {
    calls,
    getJson: async (url, opts) => {
      calls.push({ url, opts });
      const response = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return response;
    },
  };
}

function makeLog() {
  const entries = { info: [], warn: [], error: [] };
  return {
    entries,
    info: (...a) => entries.info.push(a),
    warn: (...a) => entries.warn.push(a),
    error: (...a) => entries.error.push(a),
  };
}

function makeCtx({ db, http, config, log = makeLog() }) {
  const resolves = [];
  const ctx = createContext({
    db,
    http,
    log,
    env: {},
    config,
    enqueue: () => {},
    enqueueResolve: async (gameId) => resolves.push(gameId),
  });
  return { ctx, resolves, log };
}

describe('discover', () => {
  test('a fresh full pass: matches by steam_appid, guards links, backfills gog_slug, skips on collision, enqueues one resolve per changed game', async () => {
    const db = makeFakeDb({
      byAppid: new Map([
        [70, { id: 1, gog_slug: null }], // Half-Life: matched, no gog id in the fixture
        [292030, { id: 2, gog_slug: null }], // Witcher 3: matched, gog id present, collides
        [620, { id: 3, gog_slug: 'already-set' }], // Portal 2: matched, gog_slug already set (n/a here, no gog id anyway)
        // appids 10, 400, 440 intentionally absent from the catalog -> not matched
      ]),
      gogOwners: new Map([['the_witcher_3_wild_hunt_expansion_pass', 999]]), // someone else already owns this slug
      gameLinks: new Map([
        ['1:igdb', { match_method: 'store', confidence: 100 }], // protected, must not be overwritten
        ['1:hltb', { match_method: 'name', confidence: 99 }], // higher confidence than 95, must not be overwritten
      ]),
      byGogSlug: new Map([['the_witcher', { id: 6, gog_slug: null }]]), // for the gog-only pass
    });
    const http = makeFakeHttp([mainFixture, gogOnlyFixture]);
    const config = { sources: { wikidata: { steamPageSize: 1_000_000, maxSteamAppId: 1_000_000, gogOnlyLimit: 10, rateLimit: { duration: 0 } } } };
    const { ctx, resolves, log } = makeCtx({ db, http, config });

    const stats = await discover(ctx);

    assert.equal(http.calls.length, 2, 'one steam-range page + one gog-only pass');
    assert.equal(stats.steamRows, 6);
    assert.equal(stats.steamMatched, 3); // Half-Life (70), Witcher 3 (292030), Portal 2 (620)
    assert.equal(stats.gogOnlyRows, 1);
    assert.equal(stats.gogOnlyMatched, 1);
    assert.equal(stats.gogCollisions, 1);
    assert.equal(stats.gogSlugsSet, 1); // the-witcher gog-only match, not the collided Witcher 3 one

    // resolves: games 1, 2, 3 (steam pass, Portal 2 counts even with no extra ids) + 6 (gog-only) = 4 distinct games
    assert.deepEqual(new Set(resolves), new Set([1, 2, 3, 6]));
    assert.equal(stats.resolvesEnqueued, resolves.length);

    // guarded links: igdb (store) and hltb (higher confidence) for game 1 must not appear as game_links writes.
    const linkInserts = db.calls.query.filter((c) => /INSERT INTO game_links/.test(c.sql));
    const game1Sources = linkInserts.filter((c) => c.params[0] === 1).map((c) => c.params[1]);
    assert.equal(game1Sources.includes('igdb'), false);
    assert.equal(game1Sources.includes('hltb'), false);
    assert.ok(game1Sources.includes('wikidata'));
    assert.ok(game1Sources.includes('mobygames'));

    // collision is logged, and the losing game's gog_slug is never set.
    assert.equal(log.entries.warn.some((args) => /gog_slug collision/.test(args[0])), true);
    const gogSlugUpdates = db.calls.query.filter((c) => /UPDATE games SET gog_slug/.test(c.sql));
    assert.deepEqual(gogSlugUpdates.map((c) => c.params), [['the_witcher', 6]]);

    // cursor cleared and a full-pass timestamp recorded at the end.
    const finalUpdate = db.calls.query.find((c) => /last_full_pass_at = NOW\(\)/.test(c.sql));
    assert.ok(finalUpdate);
    assert.match(finalUpdate.sql, /cursor_state = NULL/); // cursor cleared (literal, not parameterized)
    assert.equal(finalUpdate.params[1], 'wikidata');
  });

  test('pages the Steam-id pass by appid range and persists the cursor between pages', async () => {
    const db = makeFakeDb({});
    const http = makeFakeHttp([{ results: { bindings: [] } }, { results: { bindings: [] } }, { results: { bindings: [] } }]);
    // 3 ranges of width 100 to cover [0,300) -> 3 steam-pass HTTP calls, then 1 gog-only call.
    const config = { sources: { wikidata: { steamPageSize: 100, maxSteamAppId: 300, gogOnlyLimit: 10, rateLimit: { duration: 0 } } } };
    const { ctx } = makeCtx({ db, http, config });

    await discover(ctx);

    assert.equal(http.calls.length, 4);
    const cursorSaves = db.calls.query.filter((c) => /cursor_state = \?, last_run_at/.test(c.sql));
    assert.deepEqual(
      cursorSaves.map((c) => JSON.parse(c.params[0])),
      [
        { phase: 'steam', nextAppid: 100 },
        { phase: 'steam', nextAppid: 200 },
        { phase: 'steam', nextAppid: 300 },
        { phase: 'gogOnly' },
      ],
    );
  });

  test('resumes from a saved cursor instead of rescanning from zero', async () => {
    const db = makeFakeDb({ stateRow: { cursor_state: { phase: 'gogOnly' }, paused: 0 } });
    const http = makeFakeHttp([{ results: { bindings: [] } }]);
    const config = { sources: { wikidata: { steamPageSize: 100, maxSteamAppId: 300, gogOnlyLimit: 10 } } };
    const { ctx } = makeCtx({ db, http, config });

    await discover(ctx);

    assert.equal(http.calls.length, 1, 'the steam pass is skipped entirely, only the gogOnly pass runs');
  });

  test('is a no-op when paused', async () => {
    const db = makeFakeDb({ stateRow: { cursor_state: null, paused: 1 } });
    const http = makeFakeHttp([]);
    const { ctx } = makeCtx({ db, http, config: {} });

    const result = await discover(ctx);
    assert.deepEqual(result, { skipped: true });
    assert.equal(http.calls.length, 0);
  });

  test('is a no-op when the source is disabled in config', async () => {
    const db = makeFakeDb({});
    const http = makeFakeHttp([]);
    const config = { sources: { wikidata: { enabled: false } } };
    const { ctx } = makeCtx({ db, http, config });

    const result = await discover(ctx);
    assert.deepEqual(result, { skipped: true });
    assert.equal(http.calls.length, 0);
  });

  test('a gog-only pass hitting its LIMIT logs a warning', async () => {
    const db = makeFakeDb({});
    const http = makeFakeHttp([{ results: { bindings: [] } }, { results: { bindings: [{ item: { value: 'http://www.wikidata.org/entity/Q1' }, gogId: { value: 'game/x' } }] } }]);
    const config = { sources: { wikidata: { steamPageSize: 100, maxSteamAppId: 100, gogOnlyLimit: 1, rateLimit: { duration: 0 } } } };
    const { ctx, log } = makeCtx({ db, http, config });

    await discover(ctx);
    assert.equal(log.entries.warn.some((args) => /hit its LIMIT/.test(args[0])), true);
  });
});

const halfLifeOnlyResponse = { results: { bindings: [halfLifeBinding] } };

describe('fetchOne', () => {
  test('refreshes by QID when externalId is a QID', async () => {
    const db = makeFakeDb({ byId: new Map([[1, { id: 1, steam_appid: 70, gog_slug: null }]]) });
    const http = makeFakeHttp([halfLifeOnlyResponse]);
    const { ctx, resolves } = makeCtx({ db, http, config: {} });

    const result = await fetchOne(ctx, { data: { gameId: 1, externalId: 'Q279744' } });

    assert.equal(result.status, 'ok');
    assert.equal(result.externalId, 'Q279744');
    assert.deepEqual(resolves, [1]);
    assert.ok(http.calls[0].url.includes('Q279744'), 'the QID is embedded in the query URL');
  });

  test('refreshes by Steam appid when there is no externalId yet', async () => {
    const db = makeFakeDb({ byId: new Map([[1, { id: 1, steam_appid: 70, gog_slug: null }]]) });
    const http = makeFakeHttp([halfLifeOnlyResponse]);
    const { ctx, resolves } = makeCtx({ db, http, config: {} });

    const result = await fetchOne(ctx, { data: { gameId: 1 } });

    assert.equal(result.status, 'ok');
    assert.equal(result.externalId, 'Q279744');
    assert.deepEqual(resolves, [1]);
    assert.ok(http.calls[0].url.includes('70'), 'the steam appid is embedded in the query URL');
  });

  test('not_found when the game does not exist', async () => {
    const db = makeFakeDb({});
    const http = makeFakeHttp([]);
    const { ctx } = makeCtx({ db, http, config: {} });

    const result = await fetchOne(ctx, { data: { gameId: 999 } });
    assert.deepEqual(result, { status: 'not_found', externalId: null, payload: null });
    assert.equal(http.calls.length, 0);
  });

  test('not_found when there is no externalId and no steam_appid to query by', async () => {
    const db = makeFakeDb({ byId: new Map([[1, { id: 1, steam_appid: null, gog_slug: null }]]) });
    const http = makeFakeHttp([]);
    const { ctx } = makeCtx({ db, http, config: {} });

    const result = await fetchOne(ctx, { data: { gameId: 1 } });
    assert.equal(result.status, 'not_found');
    assert.equal(http.calls.length, 0);
  });

  test('not_found when the SPARQL query returns no bindings (e.g. a delisted/unmatched item)', async () => {
    const db = makeFakeDb({ byId: new Map([[1, { id: 1, steam_appid: 999999999, gog_slug: null }]]) });
    const http = makeFakeHttp([{ results: { bindings: [] } }]);
    const { ctx } = makeCtx({ db, http, config: {} });

    const result = await fetchOne(ctx, { data: { gameId: 1 } });
    assert.equal(result.status, 'not_found');
    const recordInsert = db.calls.query.find((c) => /INSERT INTO source_records/.test(c.sql));
    assert.equal(recordInsert.params[3], 'not_found');
  });
});

// --- applyRecord (used directly by both discover() and fetchOne()) --------

describe('applyRecord', () => {
  test('stores the raw record as source_records.payload verbatim', async () => {
    const db = makeFakeDb({});
    const http = makeFakeHttp([]);
    const { ctx } = makeCtx({ db, http, config: {} });
    const record = parseBinding(halfLifeBinding);

    await applyRecord(ctx, { id: 1, gog_slug: null }, record, new Set(), { linksUpserted: 0, gogSlugsSet: 0, gogCollisions: 0 });

    const recordInsert = db.calls.query.find((c) => /INSERT INTO source_records/.test(c.sql));
    assert.equal(recordInsert.params[0], 'wikidata');
    assert.equal(recordInsert.params[1], 'Q279744');
    assert.deepEqual(JSON.parse(recordInsert.params[4]), record);
  });
});

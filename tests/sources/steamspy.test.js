// tests/sources/steamspy.test.js
//
// Fixtures under tests/fixtures/steamspy/ were recorded live from
// https://steamspy.com/api.php on 2026-09-19 (see the task report for the
// verification transcript) except owner-buckets.json, whose two "synthetic"
// entries are called out inline (real format, unobserved exact boundary).
//
// Everything here runs offline: http and db are fakes injected via ctx, per
// the source module interface (docs/plans/2026-09-19-rewrite-plan.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  name as sourceName,
  rateLimit,
  discover,
  fetchOne,
  extract,
  buildAllUrl,
  buildAppDetailsUrl,
  walkAllPages,
  computeSteamScore,
  parseOwnersMidpoint,
} from '../../src/sources/steamspy.js';
import { createContext } from '../../src/pipeline/context.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'steamspy');

function loadFixture(file) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
}

const ALL_PAGE = loadFixture('all-page-trimmed.json');
const PORTAL2 = loadFixture('appdetails-portal2.json');
const PORTAL = loadFixture('appdetails-portal.json');
const DOTA2 = loadFixture('appdetails-dota2.json');
const NOTFOUND = loadFixture('appdetails-notfound.json');
const OWNER_BUCKETS = loadFixture('owner-buckets.json');

// --- module shape -----------------------------------------------------

test('module: exports name/rateLimit matching the source module interface', () => {
  assert.equal(sourceName, 'steamspy');
  assert.equal(typeof rateLimit.max, 'number');
  assert.equal(typeof rateLimit.duration, 'number');
});

// --- buildAllUrl / buildAppDetailsUrl ----------------------------------

test('buildAllUrl: request=all with the page number', () => {
  assert.equal(buildAllUrl(0), 'https://steamspy.com/api.php?request=all&page=0');
  assert.equal(buildAllUrl(42), 'https://steamspy.com/api.php?request=all&page=42');
});

test('buildAppDetailsUrl: request=appdetails with the appid', () => {
  assert.equal(buildAppDetailsUrl(620), 'https://steamspy.com/api.php?request=appdetails&appid=620');
  assert.equal(buildAppDetailsUrl('620'), 'https://steamspy.com/api.php?request=appdetails&appid=620');
});

// --- walkAllPages (paging) ------------------------------------------------

test('walkAllPages: pages sequentially from startPage until an empty page', async () => {
  const pages = [{ 10: { appid: 10 }, 20: { appid: 20 } }, { 30: { appid: 30 } }, {}];
  let call = 0;
  const requested = [];
  const getPage = async (page) => {
    requested.push(page);
    return pages[call++];
  };

  const yielded = [];
  for await (const p of walkAllPages(getPage)) yielded.push(p);

  assert.deepEqual(requested, [0, 1, 2]);
  assert.equal(yielded.length, 2);
  assert.deepEqual(yielded[0].entries.map((e) => e.appid), [10, 20]);
  assert.deepEqual(yielded[1].entries.map((e) => e.appid), [30]);
});

test('walkAllPages: stops silently on a thrown HTTP 500 (SteamSpy\'s out-of-range-page signal)', async () => {
  const pages = [{ 10: { appid: 10 } }];
  let call = 0;
  const getPage = async () => {
    if (call === 0) {
      call += 1;
      return pages[0];
    }
    const err = new Error('HTTP 500 for https://steamspy.com/api.php?request=all&page=1');
    err.statusCode = 500;
    throw err;
  };

  const yielded = [];
  for await (const p of walkAllPages(getPage)) yielded.push(p);
  assert.equal(yielded.length, 1);
});

test('walkAllPages: any other error propagates instead of being treated as "done"', async () => {
  const getPage = async () => {
    throw new Error('network boom');
  };
  const drain = async () => {
    const out = [];
    for await (const p of walkAllPages(getPage)) out.push(p);
    return out;
  };
  await assert.rejects(drain, /network boom/);
});

test('walkAllPages: honors a non-zero startPage', async () => {
  const requested = [];
  const getPage = async (page) => {
    requested.push(page);
    return {};
  };
  const out = [];
  for await (const p of walkAllPages(getPage, { startPage: 7 })) out.push(p);
  assert.deepEqual(requested, [7]);
  assert.equal(out.length, 0);
});

// --- parseOwnersMidpoint (pinned against legacy semantics) ----------------

test('parseOwnersMidpoint: every SteamSpy owners bucket maps to the legacy midpoint', () => {
  for (const { owners, midpoint } of OWNER_BUCKETS) {
    assert.equal(parseOwnersMidpoint(owners), midpoint, `owners=${JSON.stringify(owners)}`);
  }
});

test('parseOwnersMidpoint: matches config.json resolver.ggScore.ownerBuckets values exactly', () => {
  // These are the values the resolver's owner tables key on (config.json,
  // resolver.ggScore.ownerBuckets / resolver.ggp.owners) - if this ever
  // drifts from parseOwnersMidpoint's output, owner-based scoring silently
  // stops matching any bucket.
  const configuredValues = [10000, 35000, 75000, 150000, 350000, 750000, 1500000, 3500000, 7500000, 15000000, 35000000, 75000000, 150000000];
  const produced = OWNER_BUCKETS.map((b) => b.midpoint).sort((a, b) => a - b);
  assert.deepEqual(produced, configuredValues);
});

test('parseOwnersMidpoint: tolerates &nbsp; in place of spaces', () => {
  assert.equal(parseOwnersMidpoint('1,000,000&nbsp;..&nbsp;2,000,000'), 1500000);
});

test('parseOwnersMidpoint: null/undefined/unparsable -> null', () => {
  assert.equal(parseOwnersMidpoint(null), null);
  assert.equal(parseOwnersMidpoint(undefined), null);
  assert.equal(parseOwnersMidpoint(''), null);
  assert.equal(parseOwnersMidpoint('not a range'), null);
  assert.equal(parseOwnersMidpoint('1,000,000'), null);
});

// --- computeSteamScore (legacy quirk) --------------------------------

test('computeSteamScore: Portal 2 real numbers match round(positive/(positive+negative)*100)', () => {
  const { positive, negative } = PORTAL2;
  const result = computeSteamScore(positive, negative);
  assert.equal(result.scoreSteam, Math.round((positive / (positive + negative)) * 100));
  assert.equal(result.scoreSteamVotes, positive + negative);
});

test('computeSteamScore: Dota 2 (huge vote counts) rounds correctly', () => {
  const { positive, negative } = DOTA2;
  const result = computeSteamScore(positive, negative);
  assert.equal(result.scoreSteam, Math.round((positive / (positive + negative)) * 100));
  assert.equal(result.scoreSteamVotes, positive + negative);
});

test('computeSteamScore: both empty -> null (legacy store_uscore = NULL)', () => {
  assert.equal(computeSteamScore(0, 0), null);
  assert.equal(computeSteamScore(null, null), null);
  assert.equal(computeSteamScore(undefined, undefined), null);
});

test('computeSteamScore: legacy quirk - an empty side is coerced to 1 before dividing', () => {
  // positive=0, negative=50 -> legacy sets positive=1 -> round(1/51*100) = 2.
  // scoreSteamVotes uses the raw (uncoerced) total: 0 + 50 = 50.
  const result = computeSteamScore(0, 50);
  assert.equal(result.scoreSteam, Math.round((1 / 51) * 100));
  assert.equal(result.scoreSteamVotes, 50);
});

test('computeSteamScore: negative empty, positive present', () => {
  const result = computeSteamScore(50, 0);
  assert.equal(result.scoreSteam, Math.round((50 / 51) * 100));
  assert.equal(result.scoreSteamVotes, 50);
});

// --- extract() --------------------------------------------------------

test('extract: Portal 2 appdetails - full vocabulary branch including ranked tags', () => {
  const out = extract(PORTAL2);
  assert.equal(out.steamAppid, 620);
  assert.equal(out.ownersEstimate, 7500000); // "5,000,000 .. 10,000,000"
  assert.equal(out.scoreSteam, Math.round((PORTAL2.positive / (PORTAL2.positive + PORTAL2.negative)) * 100));
  assert.equal(out.scoreSteamVotes, PORTAL2.positive + PORTAL2.negative);
  assert.equal(out.tags[0], 'Platformer'); // highest vote count first, per the live-verified ordering
  assert.equal(out.tags.length, Object.keys(PORTAL2.tags).length);
  assert.ok(out.tags.includes('Puzzle'));
});

test('extract: Portal (different owners bucket than Portal 2)', () => {
  const out = extract(PORTAL);
  assert.equal(out.steamAppid, 400);
  assert.equal(out.ownersEstimate, 15000000); // "10,000,000 .. 20,000,000"
});

test('extract: Dota 2 (free, huge vote count) still scores normally', () => {
  const out = extract(DOTA2);
  assert.equal(out.ownersEstimate, 150000000); // "100,000,000 .. 200,000,000"
  assert.ok(out.scoreSteamVotes > 2_000_000);
});

test('extract: a request=all entry (no tags key at all) omits tags entirely', () => {
  const entry = ALL_PAGE['10'];
  const out = extract(entry);
  assert.equal(out.steamAppid, 10);
  assert.equal(out.tags, undefined);
  assert.ok(out.ownersEstimate > 0);
});

test('extract: the "no data for this appid" sentinel (name: null) returns {}', () => {
  assert.deepEqual(extract(NOTFOUND), {});
});

test('extract: returns {} for null/missing/appid-less payloads', () => {
  assert.deepEqual(extract(null), {});
  assert.deepEqual(extract({}), {});
  assert.deepEqual(extract({ appid: null }), {});
});

// --- extract(): playtimeMedianMinutes / playtimeAverageMinutes (games.time_average) ------------------
//
// Every recorded fixture (Portal 2, Portal, Dota 2, a request=all entry) has median_forever = 0 and
// average_forever = 0 - confirming the module header's "SteamSpy's median is 0 for most games" note
// even for some of the most-owned games on Steam - so these use PORTAL2 with the two fields overridden
// rather than a fixture (there is no real recorded fixture with a nonzero value to draw from).

test('extract: playtimeMedianMinutes/playtimeAverageMinutes are omitted when both are 0 (the common case)', () => {
  const out = extract(PORTAL2);
  assert.equal(PORTAL2.median_forever, 0);
  assert.equal(PORTAL2.average_forever, 0);
  assert.equal(out.playtimeMedianMinutes, undefined);
  assert.equal(out.playtimeAverageMinutes, undefined);
});

test('extract: playtimeMedianMinutes is reported when median_forever > 0', () => {
  const out = extract({ ...PORTAL2, median_forever: 654, average_forever: 800 });
  assert.equal(out.playtimeMedianMinutes, 654);
  assert.equal(out.playtimeAverageMinutes, 800);
});

test('extract: playtimeAverageMinutes can be reported alone when the median stays 0', () => {
  const out = extract({ ...PORTAL2, median_forever: 0, average_forever: 800 });
  assert.equal(out.playtimeMedianMinutes, undefined);
  assert.equal(out.playtimeAverageMinutes, 800);
});

// --- discover() -----------------------------------------------------------

function createFakeDb({ gameRows = [], recordRows = [], initialStateRow = null } = {}) {
  const calls = [];
  let stateRow = initialStateRow;
  const upsertedRecords = [];

  return {
    calls,
    upsertedRecords,
    getStateRow: () => stateRow,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/SELECT id, steam_appid FROM games/i.test(sql)) return gameRows;
      if (/SELECT external_id, payload FROM source_records/i.test(sql)) return recordRows;
      if (/INSERT INTO source_state \(source\) VALUES/i.test(sql)) {
        if (!stateRow) stateRow = { cursor_state: null, paused: 0 };
        return { affectedRows: 1 };
      }
      if (/UPDATE source_state SET cursor_state = \?, last_run_at = NOW\(\)/i.test(sql)) {
        stateRow = { ...(stateRow ?? {}), cursor_state: params[0] };
        return { affectedRows: 1 };
      }
      if (/UPDATE source_state SET cursor_state = \?, last_full_pass_at/i.test(sql)) {
        stateRow = { ...(stateRow ?? {}), cursor_state: params[0], stats: params[1] };
        return { affectedRows: 1 };
      }
      if (/UPDATE source_state SET last_error/i.test(sql)) {
        stateRow = { ...(stateRow ?? {}), last_error: params[0] };
        return { affectedRows: 1 };
      }
      if (/INSERT INTO source_records/i.test(sql)) {
        upsertedRecords.push({ source: params[0], externalId: params[1], gameId: params[2], status: params[3], payload: params[4] });
        return { affectedRows: 1 };
      }
      return { affectedRows: 0 };
    },
    one: async (sql, params = []) => {
      calls.push({ sql, params, one: true });
      if (/SELECT cursor_state, paused FROM source_state/i.test(sql)) return stateRow;
      if (/SELECT id FROM games WHERE steam_appid/i.test(sql)) return null;
      return null;
    },
  };
}

function fakeEnqueueResolveTracker() {
  const calls = [];
  return { calls, enqueueResolve: async (gameId) => calls.push(gameId) };
}

function buildCtx({ db, http, config = { sources: { steamspy: {} } }, enqueueResolve }) {
  return createContext({
    db,
    http,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    env: {},
    config,
    enqueue: async () => {},
    enqueueResolve: enqueueResolve ?? (async () => {}),
  });
}

function pageFromEntries(entries) {
  const body = {};
  for (const e of entries) body[String(e.appid)] = e;
  return body;
}

test('discover: stores a record and enqueues resolve only for games we track, skips unknown appids', async () => {
  const entries = Object.values(ALL_PAGE);
  const knownAppid = entries[0].appid; // '10' -> Counter-Strike
  const db = createFakeDb({ gameRows: [{ id: 500, steam_appid: knownAppid }], recordRows: [] });
  const pages = [pageFromEntries(entries), {}];
  let call = 0;
  const http = { getJson: async () => pages[call++] };
  const { calls: resolveCalls, enqueueResolve } = fakeEnqueueResolveTracker();
  const config = { sources: { steamspy: { allPageDelayMs: 0 } } };

  const stats = await discover(buildCtx({ db, http, config, enqueueResolve }));

  assert.equal(stats.pages, 1);
  assert.equal(stats.seen, entries.length);
  assert.equal(stats.matched, 1);
  assert.equal(stats.changed, 1);
  assert.deepEqual(resolveCalls, [500]);

  const rec = db.upsertedRecords.find((r) => r.externalId === String(knownAppid));
  assert.ok(rec, 'expected a source_records upsert for the known appid');
  assert.equal(rec.gameId, 500);
  const storedPayload = JSON.parse(rec.payload);
  assert.equal(storedPayload.appid, knownAppid);
  assert.equal(storedPayload.tags, undefined); // no prior record to carry tags forward from

  // Only one record should have been upserted (the matched appid).
  assert.equal(db.upsertedRecords.length, 1);
});

test('discover: unchanged owners/score for an already-recorded game does not enqueue a resolve', async () => {
  const entry = ALL_PAGE['10'];
  const db = createFakeDb({
    gameRows: [{ id: 500, steam_appid: entry.appid }],
    recordRows: [{ external_id: String(entry.appid), payload: JSON.stringify(entry) }],
  });
  const pages = [pageFromEntries([entry]), {}];
  let call = 0;
  const http = { getJson: async () => pages[call++] };
  const { calls: resolveCalls, enqueueResolve } = fakeEnqueueResolveTracker();
  const config = { sources: { steamspy: { allPageDelayMs: 0 } } };

  const stats = await discover(buildCtx({ db, http, config, enqueueResolve }));

  assert.equal(stats.matched, 1);
  assert.equal(stats.changed, 0);
  assert.deepEqual(resolveCalls, []);
});

test('discover: a changed owners bucket for an already-known game enqueues a resolve', async () => {
  const entry = ALL_PAGE['10'];
  const staleEntry = { ...entry, owners: '5,000,000 .. 10,000,000' }; // was a smaller bucket before
  const db = createFakeDb({
    gameRows: [{ id: 500, steam_appid: entry.appid }],
    recordRows: [{ external_id: String(entry.appid), payload: JSON.stringify(staleEntry) }],
  });
  const pages = [pageFromEntries([entry]), {}];
  let call = 0;
  const http = { getJson: async () => pages[call++] };
  const { calls: resolveCalls, enqueueResolve } = fakeEnqueueResolveTracker();
  const config = { sources: { steamspy: { allPageDelayMs: 0 } } };

  const stats = await discover(buildCtx({ db, http, config, enqueueResolve }));

  assert.equal(stats.changed, 1);
  assert.deepEqual(resolveCalls, [500]);
});

test('discover: carries forward tags from a prior fetchOne-written record instead of dropping them', async () => {
  const entry = ALL_PAGE['10']; // request=all shape - no tags key
  const priorPayload = { ...entry, tags: { Action: 100, FPS: 90 } }; // as if fetchOne() had run before
  const db = createFakeDb({
    gameRows: [{ id: 500, steam_appid: entry.appid }],
    recordRows: [{ external_id: String(entry.appid), payload: JSON.stringify(priorPayload) }],
  });
  const pages = [pageFromEntries([entry]), {}];
  let call = 0;
  const http = { getJson: async () => pages[call++] };
  const config = { sources: { steamspy: { allPageDelayMs: 0 } } };

  await discover(buildCtx({ db, http, config }));

  const rec = db.upsertedRecords.find((r) => r.externalId === String(entry.appid));
  const storedPayload = JSON.parse(rec.payload);
  assert.deepEqual(storedPayload.tags, { Action: 100, FPS: 90 });
});

test('discover: resumes from the persisted page cursor instead of restarting at 0', async () => {
  const db = createFakeDb({ gameRows: [], recordRows: [], initialStateRow: { cursor_state: JSON.stringify({ nextPage: 3 }), paused: 0 } });
  const requestedPages = [];
  const http = {
    getJson: async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      requestedPages.push(page);
      return {};
    },
  };
  const config = { sources: { steamspy: { allPageDelayMs: 0 } } };

  await discover(buildCtx({ db, http, config }));

  assert.deepEqual(requestedPages, [3]);
});

test('discover: persists the page cursor after every page (crash-resume)', async () => {
  const db = createFakeDb({ gameRows: [], recordRows: [] });
  const pages = [pageFromEntries([{ appid: 1, name: 'A', positive: 1, negative: 0, owners: '0 .. 20,000' }]), pageFromEntries([{ appid: 2, name: 'B', positive: 1, negative: 0, owners: '0 .. 20,000' }]), {}];
  let call = 0;
  const http = { getJson: async () => pages[call++] };
  const config = { sources: { steamspy: { allPageDelayMs: 0 } } };

  await discover(buildCtx({ db, http, config }));

  const cursorSaves = db.calls.filter((c) => /UPDATE source_state SET cursor_state = \?, last_run_at = NOW\(\)/.test(c.sql));
  assert.deepEqual(
    cursorSaves.map((c) => JSON.parse(c.params[0])),
    [{ nextPage: 1 }, { nextPage: 2 }],
  );
  // Full-pass completion resets the cursor back to page 0 for next time.
  const finalState = db.getStateRow();
  assert.deepEqual(JSON.parse(finalState.cursor_state), { nextPage: 0 });
});

test('discover: a failure mid-walk records last_error and rethrows without completing the pass', async () => {
  const db = createFakeDb({ gameRows: [], recordRows: [] });
  const http = {
    getJson: async () => {
      throw new Error('boom');
    },
  };
  const config = { sources: { steamspy: { allPageDelayMs: 0 } } };

  await assert.rejects(() => discover(buildCtx({ db, http, config })), /boom/);
  assert.equal(db.getStateRow().last_error, 'boom');
});

test('discover: is a no-op when disabled in config', async () => {
  const db = createFakeDb({});
  const http = { getJson: async () => { throw new Error('should not be called'); } };
  const config = { sources: { steamspy: { enabled: false } } };

  const result = await discover(buildCtx({ db, http, config }));
  assert.deepEqual(result, { skipped: true });
});

test('discover: is a no-op when paused', async () => {
  const db = createFakeDb({ initialStateRow: { cursor_state: null, paused: 1 } });
  const http = { getJson: async () => { throw new Error('should not be called'); } };
  const config = { sources: { steamspy: {} } };

  const result = await discover(buildCtx({ db, http, config }));
  assert.deepEqual(result, { skipped: true });
});

// --- fetchOne() -------------------------------------------------------

function fakeDbForFetchOne({ existingGameId = null } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      return { affectedRows: 1 };
    },
    one: async (sql, params = []) => {
      calls.push({ sql, params, one: true });
      if (/SELECT id FROM games WHERE steam_appid/i.test(sql)) return existingGameId ? { id: existingGameId } : null;
      return null;
    },
  };
}

test('fetchOne: known game - upserts record+link (method=store) and enqueues resolve', async () => {
  const db = fakeDbForFetchOne({ existingGameId: 42 });
  const http = { getJson: async () => PORTAL2 };
  const resolveCalls = [];
  const ctx = buildCtx({ db, http, enqueueResolve: async (id) => resolveCalls.push(id) });

  const result = await fetchOne(ctx, { data: { externalId: '620' } });

  assert.equal(result.status, 'ok');
  const upsertRecord = db.calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  assert.equal(upsertRecord.params[0], 'steamspy');
  assert.equal(upsertRecord.params[1], '620');
  assert.equal(upsertRecord.params[2], 42);
  assert.equal(upsertRecord.params[3], 'ok');

  const upsertLink = db.calls.find((c) => /INSERT INTO game_links/i.test(c.sql));
  assert.equal(upsertLink.params[0], 42);
  assert.equal(upsertLink.params[1], 'steamspy');
  assert.equal(upsertLink.params[2], '620');
  assert.equal(upsertLink.params[4], 'store');

  assert.deepEqual(resolveCalls, [42]);
});

test('fetchOne: gameId supplied in job.data skips the games lookup', async () => {
  const db = fakeDbForFetchOne({ existingGameId: 999 }); // would be wrong if looked up
  const http = { getJson: async () => PORTAL2 };
  const ctx = buildCtx({ db, http });

  await fetchOne(ctx, { data: { gameId: 7, externalId: '620' } });

  assert.equal(db.calls.some((c) => /SELECT id FROM games WHERE steam_appid/i.test(c.sql)), false);
  const upsertLink = db.calls.find((c) => /INSERT INTO game_links/i.test(c.sql));
  assert.equal(upsertLink.params[0], 7);
});

test('fetchOne: the "no data for this appid" sentinel is recorded not_found', async () => {
  const db = fakeDbForFetchOne();
  const http = { getJson: async () => NOTFOUND };
  const ctx = buildCtx({ db, http });

  const result = await fetchOne(ctx, { data: { externalId: '999999999' } });

  assert.equal(result.status, 'not_found');
  const record = db.calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  assert.equal(record.params[3], 'not_found');
  assert.equal(db.calls.some((c) => /INSERT INTO game_links/i.test(c.sql)), false);
});

test('fetchOne: a known appid with no matching games row is recorded not_found and never linked', async () => {
  const db = fakeDbForFetchOne({ existingGameId: null });
  const http = { getJson: async () => PORTAL2 };
  const ctx = buildCtx({ db, http });

  const result = await fetchOne(ctx, { data: { externalId: '620' } });

  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'unmatched');
  assert.equal(db.calls.some((c) => /INSERT INTO game_links/i.test(c.sql)), false);
});

test('fetchOne: a network/HTTP failure records status error and rethrows for BullMQ to retry', async () => {
  const db = fakeDbForFetchOne();
  const http = {
    getJson: async () => {
      throw new Error('boom');
    },
  };
  const ctx = buildCtx({ db, http });

  await assert.rejects(() => fetchOne(ctx, { data: { externalId: '620' } }), /boom/);
  const record = db.calls.find((c) => /INSERT INTO source_records/i.test(c.sql));
  assert.equal(record.params[3], 'error');
});

test('fetchOne: throws when externalId is missing', async () => {
  const ctx = buildCtx({ db: fakeDbForFetchOne(), http: { getJson: async () => ({}) } });
  await assert.rejects(() => fetchOne(ctx, { data: {} }), /externalId/);
});

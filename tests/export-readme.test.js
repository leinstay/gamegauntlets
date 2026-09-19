// src/pipeline/export-readme.js (stats + README generator for the public leinstay/steamdb export).
// Two things covered, matching that file's own split:
//   - renderReadme(stats, opts): pure, snapshot-style assertions against a small hand-built `stats`
//     object — totals, a coverage row with a %, a source row with a "remaining" count, stable
//     ordering (same input -> byte-identical output, and section rows always in FIELD_DEFS/
//     SOURCE_ORDER's fixed order, never whatever order the DB happened to return them in).
//   - collectStats(db): driven against a fake `db.query(sql, params)` that recognises each of the
//     handful of aggregate queries by a distinctive substring and returns canned rows — no real
//     database needed, same style as tests/export.test.js's makeFakeDb.
//
// 2026-09-19 README review: the README was rewritten into a terse, factual dataset README (no
// explanation of how the site works internally, no CIS/RUB/legacy-schema wording, one-time
// legacy_steamdb/gamerankings "snapshot" mentions removed entirely) — see export-readme.js's own
// comments for the reasoning behind each change.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderReadme, collectStats, FIELD_DEFS, SOURCE_ORDER } from '../src/pipeline/export-readme.js';

// --- renderReadme ------------------------------------------------------------------------------

function sampleStats() {
  return {
    totals: {
      gamesInCatalog: 112800,
      steamGames: 108000,
      gogGames: 4800,
      bothStores: 1200,
    },
    coverage: [
      { key: 'sid', source: 'steam', description: 'Steam appid', count: 110000, percent: 97.3 },
      { key: 'meta_score', source: 'metacritic', description: 'critic score', count: 40000, percent: 35.4 },
    ],
    sources: [
      {
        source: 'steam',
        refreshDays: 1,
        ok: 109000,
        notFound: 500,
        error: 10,
        gamesCovered: 109500,
        paused: false,
        lastRunAt: '2026-09-19 03:00:00',
        lastFullPassAt: '2026-09-01 00:00:00',
        remaining: 1234,
      },
      {
        source: 'gog',
        refreshDays: 7,
        ok: 4500,
        notFound: 50,
        error: 0,
        gamesCovered: 4550,
        paused: false,
        lastRunAt: '2026-09-18 04:00:00',
        lastFullPassAt: '2026-09-10 00:00:00',
        remaining: 40,
      },
    ],
    links: [
      { source: 'gamefaqs', games: 40000 },
      { source: 'steam', games: 110000 },
    ],
    files: [
      { name: 'steamdb.json', rows: 108000, size: '210.5 MB' },
      { name: 'steamdb.min.json.gz', rows: 108000, size: '38.2 MB' },
    ],
  };
}

test('renderReadme: title is "Steam Game Database"', () => {
  const md = renderReadme(sampleStats());
  assert.match(md, /^# Steam Game Database/);
});

test('renderReadme: includes the totals table with every metric, no excluded-rows breakdown', () => {
  const md = renderReadme(sampleStats(), { generatedAt: new Date('2026-09-19T23:48:00Z') });
  assert.match(md, /112,800/); // gamesInCatalog, thousands-separated
  assert.match(md, /108,000/); // steamGames
  assert.match(md, /4,800/); // gogGames
  assert.match(md, /1,200/); // bothStores
  assert.doesNotMatch(md, /Excluded/); // excluded-row breakdown was dropped (2026-09-19 README review)
});

test('renderReadme: coverage table has a row with a percentage for every key, in FIELD_DEFS order', () => {
  const stats = sampleStats();
  const md = renderReadme(stats, { generatedAt: new Date() });
  const sidLine = md.split('\n').find((l) => l.includes('`sid`'));
  assert.ok(sidLine, 'sid row must be present');
  assert.match(sidLine, /97\.0%|97\.3%/); // percent formatted to 1 decimal
  assert.match(sidLine, /110,000/);
  assert.match(sidLine, /steam/);

  const metaLine = md.split('\n').find((l) => l.includes('`meta_score`'));
  assert.ok(metaLine);
  assert.match(metaLine, /35\.4%/);

  // Row order in the rendered table follows the order given in stats.coverage.
  const sidIndex = md.indexOf('`sid`');
  const metaIndex = md.indexOf('`meta_score`');
  assert.ok(sidIndex < metaIndex);
});

test('renderReadme: source status table only lists live sources', () => {
  const md = renderReadme(sampleStats(), { generatedAt: new Date() });
  const steamLine = md.split('\n').find((l) => l.startsWith('| steam |'));
  assert.ok(steamLine);
  assert.match(steamLine, /1,234/);
  assert.match(steamLine, /1d/); // refreshDays

  assert.ok(!md.split('\n').some((l) => l.startsWith('| legacy_steamdb |')));
  assert.ok(!md.split('\n').some((l) => l.startsWith('| gamerankings |')));
});

test('renderReadme: links table lists every site with its linked-game count only (no link-row column)', () => {
  const md = renderReadme(sampleStats(), { generatedAt: new Date() });
  assert.match(md, /\| gamefaqs \| 40,000 \|/);
  assert.match(md, /\| steam \| 110,000 \|/);
  assert.doesNotMatch(md, /Total link rows/);
});

test('renderReadme: files table lists the dump files with row counts and sizes', () => {
  const md = renderReadme(sampleStats(), { generatedAt: new Date() });
  assert.match(md, /`steamdb\.json`/);
  assert.match(md, /210\.5 MB/);
  assert.match(md, /`steamdb\.min\.json\.gz`/);
  assert.match(md, /38\.2 MB/);
});

test('renderReadme: no internal table/column names or OpenCritic leak into the text', () => {
  const md = renderReadme(sampleStats());
  assert.doesNotMatch(md, /game_links/);
  assert.doesNotMatch(md, /source_records/);
  assert.doesNotMatch(md, /source_state/);
  assert.doesNotMatch(md, /opencritic/i);
});

test('renderReadme: deterministic — same stats + same generatedAt produce byte-identical output', () => {
  const stats = sampleStats();
  const generatedAt = new Date('2026-09-19T23:48:00Z');
  const first = renderReadme(stats, { generatedAt });
  const second = renderReadme(sampleStats(), { generatedAt });
  assert.equal(first, second);
});

test('renderReadme: links to the live site and mentions the nightly schedule', () => {
  const md = renderReadme(sampleStats(), { generatedAt: new Date() });
  assert.match(md, /https:\/\/gamegauntlets\.com/);
  assert.match(md, /23:48 UTC/);
});

test('renderReadme: "Updated nightly" line is exactly the schedule, no extra explanation', () => {
  const md = renderReadme(sampleStats(), { generatedAt: new Date() });
  const line = md.split('\n').find((l) => l.startsWith('Updated nightly'));
  assert.equal(line, 'Updated nightly at 23:48 UTC.');
});

test('renderReadme: defaults generatedAt to now when not given', () => {
  const md = renderReadme(sampleStats());
  assert.match(md, /_Generated \d{4}-\d{2}-\d{2}T/);
});

test('renderReadme: no chatty filler — explanation of how the export job/regeneration works is gone', () => {
  const md = renderReadme(sampleStats());
  assert.doesNotMatch(md, /export job/i);
  assert.doesNotMatch(md, /regenerated/i);
  assert.doesNotMatch(md, /sitting next to/i);
});

test('renderReadme: no legacy/CIS/RUB/schema-v2 wording anywhere in the generated text', () => {
  const md = renderReadme(sampleStats(), { generatedAt: new Date('2026-09-19T23:48:00Z') });
  const bannedWords = [
    'legacy', 'archived', 'archive', 'snapshot', 'frozen', 'rewrite',
    'original dump', 'schema v2', 'CIS', 'RUB',
  ];
  for (const word of bannedWords) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    assert.doesNotMatch(md, re, `README must not contain the word "${word}"`);
  }
});

// --- collectStats --------------------------------------------------------------------------------

/**
 * Recognises each aggregate query collectStats() issues by a distinctive substring in its SQL and
 * returns canned rows for it — mirrors tests/export.test.js's makeFakeDb style, but keyed by query
 * shape instead of bind params (collectStats issues several structurally different queries, not the
 * same one repeated).
 */
function makeFakeStatsDb() {
  const calls = [];
  async function query(sql, params = []) {
    calls.push({ sql, params });
    if (sql.includes('steam_games')) {
      return [{
        steam_games: 90,
        gog_games: 10,
        both_stores: 3,
      }];
    }
    if (sql.includes('AS `sid`')) {
      // Field coverage: total + one SUM column per FIELD_DEFS entry.
      const row = { total: 94 };
      for (const f of FIELD_DEFS) row[f.key] = f.key === 'sid' ? 90 : 10;
      return [row];
    }
    if (sql.includes('GROUP BY source, status')) {
      return [
        { source: 'steam', status: 'ok', n: 90 },
        { source: 'steam', status: 'not_found', n: 5 },
      ];
    }
    if (sql.includes('WHERE game_id IS NOT NULL GROUP BY source')) {
      return [
        { source: 'steam', games: 90 },
      ];
    }
    if (sql.includes('FROM source_state')) {
      return [{ source: 'steam', paused: 0, last_run_at: '2026-09-19 03:00:00', last_full_pass_at: null }];
    }
    if (sql.includes('remaining')) {
      const [source] = params;
      return [{ remaining: source === 'steam' ? 7 : 3 }];
    }
    if (sql.includes('FROM game_links')) {
      return [{ source: 'steam', games: 90 }];
    }
    throw new Error(`makeFakeStatsDb: unrecognised query:\n${sql}`);
  }
  return { query, calls };
}

test('collectStats: assembles totals, coverage (with %), sources (with remaining) and links', async () => {
  const db = makeFakeStatsDb();
  const stats = await collectStats(db);

  assert.equal(stats.totals.steamGames, 90);
  assert.equal(stats.totals.gogGames, 10);
  assert.equal(stats.totals.gamesInCatalog, 100);
  assert.equal(stats.totals.bothStores, 3);

  const sidCoverage = stats.coverage.find((c) => c.key === 'sid');
  assert.equal(sidCoverage.count, 90);
  assert.equal(sidCoverage.percent, Math.round((90 / 94) * 1000) / 10);

  const steamSource = stats.sources.find((s) => s.source === 'steam');
  assert.equal(steamSource.ok, 90);
  assert.equal(steamSource.notFound, 5);
  assert.equal(steamSource.gamesCovered, 90);
  assert.equal(steamSource.remaining, 7);
  assert.equal(steamSource.refreshDays, 1);

  // A source with no source_state/source_records rows and a configured refreshDays still gets a
  // remaining count (fake db returns 3 for any non-'steam' source param).
  const gogSource = stats.sources.find((s) => s.source === 'gog');
  assert.ok(gogSource);
  assert.equal(gogSource.remaining, 3);
  assert.equal(gogSource.ok, 0);
  assert.equal(gogSource.paused, false);

  assert.deepEqual(stats.links, [{ source: 'steam', games: 90 }]);
  assert.ok(!('snapshots' in stats), 'the one-time-snapshot concept is gone, stats has no snapshots field');
});

test('collectStats: source rows are in the fixed SOURCE_ORDER (live parsers only), not query-return order', async () => {
  const db = makeFakeStatsDb();
  const stats = await collectStats(db);
  assert.deepEqual(stats.sources.map((s) => s.source), SOURCE_ORDER);
  assert.ok(!SOURCE_ORDER.includes('opencritic'), 'OpenCritic is dropped from config.json, so from SOURCE_ORDER too');
  assert.ok(!SOURCE_ORDER.includes('legacy_steamdb'), 'one-time snapshot sources are not in SOURCE_ORDER');
  assert.ok(!SOURCE_ORDER.includes('gamerankings'), 'one-time snapshot sources are not in SOURCE_ORDER');
});

test('collectStats: coverage rows are in FIELD_DEFS order (identity, store data, per-source, derived, updated_at)', async () => {
  const db = makeFakeStatsDb();
  const stats = await collectStats(db);
  assert.deepEqual(stats.coverage.map((c) => c.key), FIELD_DEFS.map((f) => f.key));
});

test('collectStats: excludes opencritic from the links query (OpenCritic dropped 2026-09-19)', async () => {
  const db = makeFakeStatsDb();
  await collectStats(db);
  const linkCall = db.calls.find((c) => c.sql.includes('FROM game_links'));
  assert.ok(linkCall);
  assert.match(linkCall.sql, /opencritic/);
});

test('collectStats: field coverage query no longer joins the frozen legacy_steamdb source_records snapshot', async () => {
  const db = makeFakeStatsDb();
  await collectStats(db);
  const coverageCall = db.calls.find((c) => c.sql.includes('AS `sid`'));
  assert.ok(coverageCall);
  assert.doesNotMatch(coverageCall.sql, /legacy_steamdb/);
  assert.doesNotMatch(coverageCall.sql, /source_records/);
});

// --- FIELD_DEFS -----------------------------------------------------------------------------------

test('FIELD_DEFS: every source value is a plain site name or gamegauntlets, never a compound/legacy label', () => {
  const allowed = new Set([
    'steam', 'gog', 'steamspy', 'gamefaqs', 'hltb', 'metacritic', 'igdb', 'gamerankings', 'wikidata', 'gamegauntlets',
  ]);
  for (const f of FIELD_DEFS) {
    assert.ok(allowed.has(f.source), `FIELD_DEFS[${f.key}].source "${f.source}" is not a plain allowed source name`);
  }
});

test('FIELD_DEFS: no removed key (dropped-legacy-only, frozen snapshots, duplicate grnk_score, CIS/RUB) remains', () => {
  const keys = FIELD_DEFS.map((f) => f.key);
  const removed = [
    'store_promo_url', 'gfq_difficulty_comment', 'gfq_rating_comment', 'gfq_length', 'gfq_length_comment',
    'stsp_mdntime', 'igdb_single', 'igdb_complete', 'igdb_popularity',
    'published_meta', 'published_stsp', 'published_hltb', 'published_igdb',
    'grnk_score',
    'price_cis_usd', 'price_final_cis_usd', 'discount_cis_usd',
    'price_rub', 'price_final_rub', 'discount_rub',
  ];
  for (const key of removed) assert.ok(!keys.includes(key), `${key} must not be in FIELD_DEFS`);
});

test('FIELD_DEFS: descriptions do not mention internal table/column names', () => {
  const internalNames = ['score_critics_source', 'sr.payload', 'source_records', 'game_links', 'games.'];
  for (const f of FIELD_DEFS) {
    for (const name of internalNames) {
      assert.ok(!f.description.includes(name), `FIELD_DEFS[${f.key}].description mentions internal name "${name}"`);
    }
  }
});

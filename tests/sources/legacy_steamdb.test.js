// Fixture-based test of legacy_steamdb.js's extract() (per the source module interface, every source has
// one). No I/O: extract() is pure. tests/fixtures/sources/legacy-steamdb-sample.json holds a full legacy
// `steamdb.games` row shape (fullRow), a GOG row (gogRow) and a mostly-empty row (sparseRow).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { name, extractOnly, extract } from '../../src/sources/legacy_steamdb.js';
import { sources, getSource } from '../../src/sources/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/sources/legacy-steamdb-sample.json'), 'utf8'));

test('module shape: name, extractOnly, no discover/fetchOne', async () => {
  assert.equal(name, 'legacy_steamdb');
  assert.equal(extractOnly, true);
  const mod = await import('../../src/sources/legacy_steamdb.js');
  assert.equal(mod.discover, undefined);
  assert.equal(mod.fetchOne, undefined);
  assert.equal(typeof mod.extract, 'function');
});

test('registry: extract-only modules are skipped by the worker/queue registry but still resolvable by name', () => {
  assert.equal(sources.some((mod) => mod.name === 'legacy_steamdb'), false);
  const mod = getSource('legacy_steamdb');
  assert.ok(mod, 'getSource should find the extract-only module');
  assert.equal(mod.name, 'legacy_steamdb');
  assert.equal(typeof mod.extract, 'function');
});

test('extract: storeRelease comes from published_store', () => {
  const fields = extract(fixture.fullRow);
  assert.deepEqual(fields.storeRelease, { date: '2020-10-27', precision: 'day' });
});

test('extract: releaseCandidates carries one independent candidate per published_* column, correctly labeled', () => {
  const fields = extract(fixture.fullRow);
  assert.deepEqual(fields.releaseCandidates, [
    { source: 'legacy_gamefaqs', kind: 'independent', date: '2020-10-27', precision: 'day' },
    { source: 'legacy_steamspy', kind: 'independent', date: null, precision: 'unknown' },
    { source: 'legacy_hltb', kind: 'independent', date: '2020-10-27', precision: 'day' },
    { source: 'legacy_igdb', kind: 'independent', date: '2020-10-28', precision: 'day' },
  ]);
});

test('extract: frozen scores map from the legacy columns, critics tagged as metacritic', () => {
  const fields = extract(fixture.fullRow);
  assert.equal(fields.scoreSteam, 92);
  assert.equal(fields.scoreCritics, 88);
  assert.equal(fields.scoreCriticsSource, 'metacritic');
  assert.equal(fields.scoreUsersMetacritic, 90);
  assert.equal(fields.scoreGamerankings, 85);
  assert.equal(fields.scoreGamefaqs, 4.5);
  assert.equal(fields.scoreIgdb, 91);
  assert.equal(fields.scoreIgdbUsers, 93);
});

test('extract: scoreCriticsSource is omitted (not just falsy) when there is no meta_score', () => {
  const fields = extract(fixture.sparseRow);
  assert.equal('scoreCriticsSource' in fields, false);
});

test('extract: time to beat maps HLTB to the primary slot and IGDB to the secondary hint', () => {
  const fields = extract(fixture.fullRow);
  assert.equal(fields.timeMain, 6.5);
  assert.equal(fields.timeComplete, 15);
  assert.equal(fields.timeMainIgdb, 8);
  assert.equal(fields.timeCompleteIgdb, 20);
});

test('extract: difficulty and ownersEstimate pass through as-is', () => {
  const fields = extract(fixture.fullRow);
  assert.equal(fields.difficulty, 'Easy');
  assert.equal(fields.ownersEstimate, 10000);
});

test('extract: stsp_mdntime maps to playtimeMedianMinutes (games.time_average legacy fallback)', () => {
  const fields = extract({ ...fixture.fullRow, stsp_mdntime: 654 });
  assert.equal(fields.playtimeMedianMinutes, 654);
});

test('extract: stsp_mdntime of 0/null (fullRow\'s real value) maps to playtimeMedianMinutes: null', () => {
  assert.equal(extract(fixture.fullRow).playtimeMedianMinutes, null); // fixture's fullRow has stsp_mdntime: null
  assert.equal(extract({ ...fixture.fullRow, stsp_mdntime: 0 }).playtimeMedianMinutes, null);
});

test('extract: comma-separated legacy lists become arrays; a blank list is null', () => {
  const fields = extract(fixture.fullRow);
  assert.deepEqual(fields.platforms, ['WIN', 'MAC', 'LNX']);
  assert.deepEqual(fields.developers, ['Toby Fox']);
  assert.deepEqual(fields.genres, ['Casual', 'Strategy', 'Early Access']);
  assert.deepEqual(fields.tags, ['RPG', 'Indie', 'Comedy']);
  assert.equal(fields.voiceovers, null); // '' in the fixture
});

test('extract: supplies name/image/description/achievements as the lowest-priority display fallback', () => {
  const fields = extract(fixture.fullRow);
  assert.equal(fields.name, 'Undertale');
  assert.equal(fields.image, 'https://cdn.example/391540/header.jpg');
  assert.equal(fields.descriptionEn, 'A game about a child who falls into an underground world.');
  assert.equal(fields.descriptionRu, 'Игра о ребёнке, который падает в подземный мир.');
  assert.equal(fields.achievements, 93);
});

test('extract: a Steam row reports a links.steam entry from store_url + sid, and links.metacritic from meta_url', () => {
  const fields = extract(fixture.fullRow);
  assert.deepEqual(fields.links.steam, { id: 391540, url: 'https://store.steampowered.com/app/391540' });
  assert.deepEqual(fields.links.metacritic, { id: null, url: 'https://www.metacritic.com/game/undertale' });
  assert.equal(fields.links.gog, undefined);
});

test('extract: a GOG row reports a links.gog entry instead of links.steam', () => {
  const fields = extract({ ...fixture.gogRow, store_url: 'https://www.gog.com/game/x' });
  assert.deepEqual(fields.links.gog, { id: 1207659091, url: 'https://www.gog.com/game/x' });
  assert.equal(fields.links.steam, undefined);
});

test('extract: prices map price_en/price_ru (+final/discount) to usd/rub; isFree is never reported', () => {
  const fields = extract(fixture.fullRow);
  assert.deepEqual(fields.prices.usd, { initial: 999, final: 999, discount: 0 });
  assert.deepEqual(fields.prices.rub, { initial: 19500, final: 19500, discount: 0 });
  assert.equal('isFree' in fields, false); // legacy has no reliable free flag - deliberately not mapped
  assert.equal(fields.prices.cisUsd, undefined);
});

test('extract: a GOG game reports gogId identity, never isFree', () => {
  const fields = extract(fixture.gogRow);
  assert.equal('isFree' in fields, false);
  assert.equal(fields.gogId, 1207659091);
  assert.equal(fields.steamAppid, undefined);
});

test('extract: a Steam row reports steamAppid from sid', () => {
  const fields = extract(fixture.fullRow);
  assert.equal(fields.steamAppid, 391540);
  assert.equal(fields.gogId, undefined);
});

test('extract: a mostly-empty row never throws and every optional field is absent/null', () => {
  const fields = extract(fixture.sparseRow);
  assert.deepEqual(fields.storeRelease, { date: null, precision: 'unknown' });
  assert.equal(fields.scoreSteam, null);
  assert.equal(fields.prices, undefined);
  assert.equal('isFree' in fields, false);
  assert.equal(fields.steamAppid, undefined);
  assert.equal(fields.platforms, null);
});

test('extract: called with no payload at all does not throw', () => {
  assert.doesNotThrow(() => extract());
});

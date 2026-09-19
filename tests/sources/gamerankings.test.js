// Fixture-free test of gamerankings.js's extract() (pure, per the source module interface). No I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { name, extractOnly, extract, eligibleScore } from '../../src/sources/gamerankings.js';
import { sources, getSource } from '../../src/sources/index.js';

test('module shape: name, extractOnly, no discover/fetchOne', async () => {
  assert.equal(name, 'gamerankings');
  assert.equal(extractOnly, true);
  const mod = await import('../../src/sources/gamerankings.js');
  assert.equal(mod.discover, undefined);
  assert.equal(mod.fetchOne, undefined);
  assert.equal(typeof mod.extract, 'function');
});

test('registry: extract-only module is skipped by the worker/queue registry but still resolvable by name', () => {
  assert.equal(sources.some((mod) => mod.name === 'gamerankings'), false);
  const mod = getSource('gamerankings');
  assert.ok(mod, 'getSource should find the extract-only module');
  assert.equal(mod.name, 'gamerankings');
  assert.equal(typeof mod.extract, 'function');
});

test('eligibleScore: requires at least one review', () => {
  assert.equal(eligibleScore({ score: 90, reviews: 0 }), null);
  assert.equal(eligibleScore({ score: 90, reviews: 1 }), 90);
});

test('eligibleScore: requires a finite 0..100 score', () => {
  assert.equal(eligibleScore({ score: -1, reviews: 5 }), null);
  assert.equal(eligibleScore({ score: 100.4, reviews: 5 }), null);
  assert.equal(eligibleScore({ score: NaN, reviews: 5 }), null);
  assert.equal(eligibleScore({ score: undefined, reviews: 5 }), null);
  assert.equal(eligibleScore({ score: 0, reviews: 5 }), 0);
  assert.equal(eligibleScore({ score: 100, reviews: 5 }), 100);
});

test('eligibleScore: rounds to the nearest integer', () => {
  assert.equal(eligibleScore({ score: 86.65, reviews: 5 }), 87);
  assert.equal(eligibleScore({ score: 97.42, reviews: 5 }), 97);
});

test('extract: reports scoreGamerankings when the row qualifies', () => {
  const fields = extract({ score: 97.64, reviews: 78, platform: 'WII', path: 'wii/915692-super-mario-galaxy', id: '915692' });
  assert.equal(fields.scoreGamerankings, 98);
});

test('extract: omits scoreGamerankings when reviews is 0', () => {
  const fields = extract({ score: 50, reviews: 0, platform: 'PC', path: 'pc/1-x', id: '1' });
  assert.equal('scoreGamerankings' in fields, false);
});

test('extract: omits scoreGamerankings when the score is out of range', () => {
  const fields = extract({ score: 150, reviews: 10, platform: 'PC', path: 'pc/1-x', id: '1' });
  assert.equal('scoreGamerankings' in fields, false);
});

test('extract: links.gamefaqs only for a PC row', () => {
  const pc = extract({ score: 80, reviews: 10, platform: 'PC', path: 'pc/919355-warhammer-40000-dawn-of-war', id: '919355' });
  assert.deepEqual(pc.links, { gamefaqs: { id: '919355', url: 'https://gamefaqs.gamespot.com/pc/919355-warhammer-40000-dawn-of-war' } });

  const nonPc = extract({ score: 80, reviews: 10, platform: 'WII', path: 'wii/915692-super-mario-galaxy', id: '915692' });
  assert.equal('links' in nonPc, false);
});

test('extract: no links when path/id is missing even for a PC row', () => {
  const fields = extract({ score: 80, reviews: 10, platform: 'PC', path: '', id: '1' });
  assert.equal('links' in fields, false);
});

test('extract: an empty payload extracts nothing', () => {
  assert.deepEqual(extract({}), {});
  assert.deepEqual(extract(), {});
});

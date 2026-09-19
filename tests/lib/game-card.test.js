import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toGameCard, buildLinks, cleanDescription, truncateAtSentence } from '../../src/lib/game-card.js';

// T21: cleanDescription()'s HTML-soup tests are fed 3 REAL legacy description_en samples (not
// synthetic) from tests/fixtures/legacy/games-sample.json, picked for a spread of the markup this
// column actually contains: <strong>/<ul><li> lists (Battlefield 3), <p> paragraphs including an
// empty "<p></p>" (Ever 17), and &amp;-entities mixed with messy "<br>\r\n<br>\r\n" runs (Sam & Max
// Hit the Road).
const LEGACY_FIXTURES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'legacy',
  'games-sample.json',
);
const legacyGames = JSON.parse(fs.readFileSync(LEGACY_FIXTURES_PATH, 'utf8'));

function legacyDescription(id) {
  const row = legacyGames.find((g) => g.id === id);
  assert.ok(row, `fixture row id=${id} not found in games-sample.json`);
  return row.description_en;
}

function baseRow(overrides = {}) {
  return {
    id: 42,
    kind: 'steam',
    name: 'Portal 2',
    image: 'https://cdn.example/portal2.jpg',
    description_en: 'A puzzle game.',
    description_ru: 'Игра-головоломка.',
    release_date: '2011-04-19',
    release_precision: 'day',
    gg_score: 95,
    score_steam: 98,
    score_steam_votes: 466905,
    score_steam_recent: 92,
    score_steam_recent_votes: 120,
    score_critics: 95,
    score_critics_source: 'metacritic',
    score_igdb: 90,
    score_gamefaqs: 4.5,
    final_time: 8,
    time_complete: 21.5,
    time_average: 12.3,
    difficulty: 'Just Right',
    ggp: 120,
    price_usd: 999,
    price_final_usd: 999,
    discount_usd: 0,
    price_rub: 49900,
    price_final_rub: 24900,
    discount_rub: 50,
    price_cis_usd: 599,
    price_final_cis_usd: 599,
    discount_cis_usd: 0,
    platforms: 'WIN,MAC,LNX',
    genres: '|Puzzle|Action|',
    tags: '|Co-op|Sci-fi|',
    developers: '|Valve|',
    publishers: '|Valve|',
    categories: '|Single-player|Co-op|',
    languages: '|English|French|',
    voiceovers: '|English|',
    owners_estimate: 15000000,
    achievements: 51,
    ...overrides,
  };
}

test('toGameCard: maps every field of the GameCard shape', () => {
  const card = toGameCard(baseRow(), [], { lang: 'en' });
  assert.equal(card.id, 42);
  assert.equal(card.kind, 'steam');
  assert.equal(card.name, 'Portal 2');
  assert.equal(card.image, 'https://cdn.example/portal2.jpg');
  assert.deepEqual(card.release, { date: '2011-04-19', precision: 'day' });
  assert.equal(card.score, 95);
  assert.deepEqual(card.scores, {
    steam: 98,
    critics: 95,
    criticsSource: 'metacritic',
    igdb: 90,
    gamefaqs: 4.5,
    steamReviews: {
      all: { percent: 98, votes: 466905, label: 'Overwhelmingly Positive' },
      recent: { percent: 92, votes: 120, label: 'Very Positive' },
    },
  });
  assert.deepEqual(card.time, { main: 8, complete: 21.5, average: 12.3 });
  assert.equal(card.difficulty, 'Just Right');
  assert.equal(card.ggp, 120);
  assert.deepEqual(card.platforms, ['WIN', 'MAC', 'LNX']);
  assert.deepEqual(card.genres, ['Puzzle', 'Action']);
  assert.deepEqual(card.tags, ['Co-op', 'Sci-fi']);
  assert.deepEqual(card.developers, ['Valve']);
  assert.deepEqual(card.publishers, ['Valve']);
  assert.deepEqual(card.categories, ['Single-player', 'Co-op']);
  assert.deepEqual(card.languages, ['English', 'French']);
  assert.deepEqual(card.voiceovers, ['English']);
  assert.equal(card.owners, 15000000);
  assert.equal(card.achievements, 51);
});

test('toGameCard: description is English for en/de/fr, Russian (with English fallback) for ru', () => {
  const row = baseRow();
  assert.equal(toGameCard(row, [], { lang: 'en' }).description, 'A puzzle game.');
  assert.equal(toGameCard(row, [], { lang: 'de' }).description, 'A puzzle game.');
  assert.equal(toGameCard(row, [], { lang: 'fr' }).description, 'A puzzle game.');
  assert.equal(toGameCard(row, [], { lang: 'ru' }).description, 'Игра-головоломка.');

  const noRussianText = baseRow({ description_ru: null });
  assert.equal(toGameCard(noRussianText, [], { lang: 'ru' }).description, 'A puzzle game.');
});

test('toGameCard: price picks the column set for lang/cisPrices', () => {
  const row = baseRow();
  assert.deepEqual(toGameCard(row, [], { lang: 'en' }).price, { amount: 999, final: 999, discount: 0, currency: 'USD' });
  assert.deepEqual(toGameCard(row, [], { lang: 'ru' }).price, { amount: 49900, final: 24900, discount: 50, currency: 'RUB' });
  assert.deepEqual(toGameCard(row, [], { lang: 'ru', cisPrices: true }).price, {
    amount: 599,
    final: 599,
    discount: 0,
    currency: 'USD',
  });
});

test('toGameCard: null/missing optional columns become null, not undefined or NaN', () => {
  const sparse = {
    id: 1,
    name: 'Mystery Game',
    platforms: null,
    genres: null,
    tags: null,
    developers: null,
    publishers: null,
    categories: null,
    languages: null,
    voiceovers: null,
    owners_estimate: null,
    achievements: null,
  };
  const card = toGameCard(sparse, [], { lang: 'en' });
  assert.equal(card.image, null);
  assert.equal(card.description, null);
  assert.deepEqual(card.release, { date: null, precision: 'unknown' });
  assert.equal(card.score, null);
  assert.equal(card.time.main, null);
  assert.equal(card.time.average, null);
  assert.deepEqual(card.scores.steamReviews, { all: null, recent: null });
  assert.equal(card.difficulty, null);
  assert.deepEqual(card.platforms, []);
  assert.deepEqual(card.genres, []);
  assert.deepEqual(card.tags, []);
  assert.equal(card.kind, undefined);
  assert.deepEqual(card.developers, []);
  assert.deepEqual(card.publishers, []);
  assert.deepEqual(card.categories, []);
  assert.deepEqual(card.languages, []);
  assert.deepEqual(card.voiceovers, []);
  assert.equal(card.owners, null);
  assert.equal(card.achievements, null);
});

test('toGameCard: scores.steamReviews.recent is null (not just unlabelled) under 10 votes, unlike .all', () => {
  const row = baseRow({
    score_steam: 100,
    score_steam_votes: 5, // < 10 -> Steam shows "N user reviews", no label, but the block itself stays
    score_steam_recent: 100,
    score_steam_recent_votes: 5, // < 10 -> the whole `recent` block is null, per the file header
  });
  const card = toGameCard(row, [], { lang: 'en' });
  assert.deepEqual(card.scores.steamReviews.all, { percent: 100, votes: 5, label: null });
  assert.equal(card.scores.steamReviews.recent, null);
});

test('buildLinks: maps known sources, missing ones are null', () => {
  const links = buildLinks(
    [
      { source: 'steam', url: 'https://store.steampowered.com/app/1' },
      { source: 'gog', url: 'https://gog.com/game/1' },
    ],
    'en',
  );
  assert.equal(links.steam, 'https://store.steampowered.com/app/1');
  assert.equal(links.gog, 'https://gog.com/game/1');
  assert.equal(links.hltb, null);
  assert.equal(links.igdb, null);
  assert.equal(links.gamefaqs, null);
  assert.equal(links.metacritic, null);
  assert.equal('opencritic' in links, false);
});

test('buildLinks: wikipedia prefers the language-matching source, falls back to the other', () => {
  const both = buildLinks(
    [
      { source: 'wikipedia_en', url: 'https://en.wikipedia.org/wiki/X' },
      { source: 'wikipedia_ru', url: 'https://ru.wikipedia.org/wiki/X' },
    ],
    'ru',
  );
  assert.equal(both.wikipedia, 'https://ru.wikipedia.org/wiki/X');

  const onlyEn = buildLinks([{ source: 'wikipedia_en', url: 'https://en.wikipedia.org/wiki/X' }], 'ru');
  assert.equal(onlyEn.wikipedia, 'https://en.wikipedia.org/wiki/X');

  const none = buildLinks([], 'en');
  assert.equal(none.wikipedia, null);
});

test('toGameCard: game-links with no source/garbage entries are ignored, not thrown on', () => {
  const links = buildLinks([null, {}, { source: 'steam', url: null }], 'en');
  assert.equal(links.steam, null);
});

test('toGameCard: description goes through cleanDescription (HTML in, plain text out)', () => {
  const row = { id: 1, name: 'X', description_en: 'A <b>great</b> game.<br>Play it.' };
  assert.equal(toGameCard(row, [], { lang: 'en' }).description, 'A great game.\nPlay it.');
});

// --- cleanDescription() -----------------------------------------------------

test('cleanDescription: null/undefined/blank/tags-only input -> null', () => {
  assert.equal(cleanDescription(null), null);
  assert.equal(cleanDescription(undefined), null);
  assert.equal(cleanDescription(''), null);
  assert.equal(cleanDescription('   '), null);
  assert.equal(cleanDescription('<p></p>'), null); // an empty paragraph has no text, only tags
});

test('cleanDescription: <br>/</p>/<li> become newlines, every other tag is stripped', () => {
  assert.equal(cleanDescription('A <b>great</b> game.<br>Play it.'), 'A great game.\nPlay it.');
  assert.equal(cleanDescription('<p>First.</p><p>Second.</p>'), 'First.\nSecond.');
  assert.equal(cleanDescription('<ul><li>One</li><li>Two</li></ul>'), 'One\nTwo');
  assert.equal(cleanDescription('<img src="x.jpg">Caption text.'), 'Caption text.');
  assert.equal(cleanDescription('Line one<br/>Line two<br />Line three'), 'Line one\nLine two\nLine three');
});

test('cleanDescription: decodes HTML entities (named + numeric)', () => {
  assert.equal(cleanDescription('Sam &amp; Max'), 'Sam & Max');
  assert.equal(cleanDescription('Caf&eacute;? No: caf&#233;.'), 'Caf&eacute;? No: café.'); // only the small curated table (names.js) is decoded, matching the rest of the codebase
  assert.equal(cleanDescription('a&nbsp;&nbsp;b'), 'a b'); // decoded to two regular spaces, then collapsed like any other run of spaces
  assert.equal(cleanDescription("It&#39;s here"), "It's here");
});

test('cleanDescription: collapses 3+ consecutive newlines to a single blank line, trims', () => {
  assert.equal(cleanDescription('  A<br><br><br><br>B  '), 'A\n\nB');
  assert.equal(cleanDescription('<p>A</p><p></p><p>B</p>'), 'A\n\nB');
});

test('cleanDescription: trims leading/trailing whitespace on each resulting line', () => {
  assert.equal(cleanDescription('First.  <br>   Second.'), 'First.\nSecond.');
});

test('cleanDescription: folds a legacy literal "\\r\\n"/"\\n" text artifact into a real newline (not visible backslashes)', () => {
  // The literal 4/2-character sequences below are TEXT, not real control characters — the exact
  // artifact found in tests/fixtures/legacy/games-sample.json id 24623 (see the real-sample test
  // below), where a double-encoding bug left "\r\n" as visible characters next to <br> tags.
  assert.equal(cleanDescription('A<br>\\r\\n<br>\\r\\nB'), 'A\n\nB');
  assert.equal(cleanDescription('A\\nB'), 'A\nB');
});

test('cleanDescription: real legacy sample - Battlefield 3 (id 41061, <strong>/<ul><li> lists)', () => {
  const out = cleanDescription(legacyDescription(41061));
  assert.ok(!/<[a-z]/i.test(out), 'no HTML tags should remain');
  assert.ok(out.includes('Battlefield™ 3'), '™ (a real unicode character, not an HTML entity) is left as-is');
  assert.ok(out.startsWith('Ramp up the intensity'));
  assert.ok(out.includes('Play to your strengths — The 4 player classes'));
  assert.ok(!/\n{3,}/.test(out), 'no run of 3+ newlines should survive');
  assert.equal(out, out.trim());
  assert.ok(out.length <= 1500);
});

test('cleanDescription: real legacy sample - Ever 17 (id 94307, <p> paragraphs incl. an empty one)', () => {
  const out = cleanDescription(legacyDescription(94307));
  assert.equal(
    out,
    'Takeshi Kuranari, an ordinary college student, visits the underwater theme park LeMU. An accident occurs, trapping Takeshi and 6 other individuals inside LeMU, 51 meters below the surface. With no hope of rescue, Takeshi explores LeMU along with the mysterious girl Tsugumi and part-time employee You, searching for a way to escape to the surface.\n' +
      'A theme park of dreams and hopes sunk in the depths of the mysterious blue ocean.\n' +
      'Can dreams and hopes still be found there? Or is there some other mystery lurking?\n' +
      'Overcoming one crisis after another, they search for a way to escape!\n\n' +
      'A masterpiece written by Kotaro Uchikoshi comes to Steam, 22 years after the initial Japanese release!\n' +
      'Gameplay Features\n' +
      'Progress through the story via point-and-click visual novel style gameplay\n\n' +
      'Your choices will affect the outcome of the story with multiple scenarios and endings.',
  );
});

test('cleanDescription: real legacy sample - Sam & Max Hit the Road (id 24623, &amp; entities + "<br>\\r\\n<br>\\r\\n" artifact)', () => {
  const out = cleanDescription(legacyDescription(24623));
  assert.ok(!/<[a-z]/i.test(out), 'no HTML tags should remain');
  assert.ok(!out.includes('\\r') && !out.includes('\\n'), 'the literal backslash-escape artifact must not survive as visible text');
  assert.ok(out.includes('Sam & Max'), 'entities decoded');
  assert.ok(!out.includes('&amp;'));
  assert.ok(out.startsWith('Grab your nightstick'));
  assert.ok(out.includes('• Enjoy edgy animation and twisted humor!'));
  assert.ok(!/\n{3,}/.test(out), 'no run of 3+ newlines should survive');
  assert.equal(out, out.trim());
});

// --- truncateAtSentence() ----------------------------------------------------

test('truncateAtSentence: text at or under the cap is returned unchanged', () => {
  assert.equal(truncateAtSentence('Short.', 1500), 'Short.');
  const exact = 'x'.repeat(1500);
  assert.equal(truncateAtSentence(exact, 1500), exact);
});

test('truncateAtSentence: cuts at the last sentence boundary at or before the cap', () => {
  // Sentences of predictable length so the boundary position is easy to reason about.
  const sentence = 'This is one sentence of a certain fixed length right here. '; // 61 chars incl. trailing space
  const text = sentence.repeat(30); // 1830 chars, well past a 1500 cap
  const out = truncateAtSentence(text, 1500);
  assert.ok(out.length <= 1500);
  assert.ok(out.endsWith('.'), 'cuts right after sentence-ending punctuation, not mid-sentence');
  assert.equal(text.slice(0, out.length), out, 'the kept text is an unmodified prefix of the original');
});

test('truncateAtSentence: no usable sentence boundary near the cap -> hard cut with an ellipsis', () => {
  const text = 'word '.repeat(400); // 2000 chars, no punctuation at all
  const out = truncateAtSentence(text, 1500);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 1501);
});

test('truncateAtSentence: a boundary that would keep less than half the budget is rejected in favour of a hard cut', () => {
  // One sentence ending very early, then a long run-on with no further punctuation.
  const text = `Hi.${'word '.repeat(400)}`;
  const out = truncateAtSentence(text, 1500);
  assert.ok(!out.endsWith('Hi.'), 'must not truncate down to just the first 3 characters');
  assert.ok(out.endsWith('…'));
});

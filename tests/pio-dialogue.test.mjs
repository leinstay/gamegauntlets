// Unit tests for the pure logic in public/js/pio/dialogue.js (the Pio dialogue engine, task T4).
// Run with: node --test tests/
//
// NOTE: this file is outside T4's owned path list (public/pio/**, public/vendor/**, public/js/pio/**,
// public/pio-demo.html) but the rewrite plan's global constraints require pure logic to be unit-tested. It is
// flagged in the implementer report's DEVIATIONS. `public/js/pio/package.json` ({"type":"module"}) was added so
// dialogue.js (which uses `export`) resolves as an ES module even before T1 lands the root package.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDialogueEngine, _internal } from '../public/js/pio/dialogue.js';

test('pluralCase: Russian-style cases', () => {
  const forms = ['час', 'часа', 'часов'];
  assert.equal(_internal.pluralCase(1, forms), 'час');
  assert.equal(_internal.pluralCase(2, forms), 'часа');
  assert.equal(_internal.pluralCase(5, forms), 'часов');
  assert.equal(_internal.pluralCase(11, forms), 'часов'); // teens exception
  assert.equal(_internal.pluralCase(21, forms), 'час');
});

test('inHourRange: plain and wrap-around ranges', () => {
  assert.equal(_internal.inHourRange(10, 7, 13), true);
  assert.equal(_internal.inHourRange(6, 7, 13), false);
  assert.equal(_internal.inHourRange(13, 7, 13), false); // half-open upper bound
  assert.equal(_internal.inHourRange(2, 22, 5), true); // wraps past midnight
  assert.equal(_internal.inHourRange(21, 22, 5), false);
  assert.equal(_internal.inHourRange(0, 0, 0), true); // equal bounds = all day
});

test('matchesWhen: AND across multiple conditions', () => {
  const when = { scoreMin: 80, genre: 'RPG' };
  assert.equal(_internal.matchesWhen(when, { score: 85, genres: ['RPG', 'Action'] }), true);
  assert.equal(_internal.matchesWhen(when, { score: 85, genres: ['Action'] }), false);
  assert.equal(_internal.matchesWhen(when, { score: 50, genres: ['RPG'] }), false);
  assert.equal(_internal.matchesWhen(undefined, {}), true);
});

test('formatText: placeholders and pluralized {hours}/{goodCount}', () => {
  const units = { hours: ['hour', 'hours', 'hours'], games: ['game', 'games', 'games'] };
  assert.equal(_internal.formatText('Hi {game}!', { game: 'Portal' }, units), 'Hi Portal!');
  assert.equal(_internal.formatText('Play for {hours}', { hours: 1 }, units), 'Play for 1 hour');
  assert.equal(_internal.formatText('Play for {hours}', { hours: 5 }, units), 'Play for 5 hours');
  assert.equal(_internal.formatText('{goodCount} found', { goodCount: 3 }, units), '3 games found');
  assert.equal(_internal.formatText('Unknown {nope}', {}, units), 'Unknown {nope}');
});

test('weightedPick: zero/negative weight falls back to 1, always returns a candidate', () => {
  const entries = [{ text: 'a', weight: 0 }, { text: 'b', weight: -5 }];
  for (let i = 0; i < 20; i++) {
    const picked = _internal.weightedPick(entries);
    assert.ok(picked.text === 'a' || picked.text === 'b');
  }
});

test('dialogue engine: pick() respects `when` and formats placeholders', () => {
  const engine = createDialogueEngine({
    lang: 'en',
    pools: {
      en: {
        _meta: { units: { hours: ['hour', 'hour', 'hours'], games: ['game', 'game', 'games'] } },
        'spin:end': [
          { text: 'High score {score} for {game}!', mood: 'happy', when: { scoreMin: 80 } },
          { text: 'Meh, {score} for {game}.', mood: 'unhappy', when: { scoreMax: 40 } },
        ],
      },
    },
  });

  const good = engine.pick('spin:end', { score: 90, game: 'Portal' });
  assert.equal(good.text, 'High score 90 for Portal!');
  assert.equal(good.mood, 'happy');

  const bad = engine.pick('spin:end', { score: 20, game: 'Bad Game' });
  assert.equal(bad.text, 'Meh, 20 for Bad Game.');

  const none = engine.pick('spin:end', { score: 60, game: 'Mid Game' });
  assert.equal(none, null);

  assert.equal(engine.pick('does:not-exist', {}), null);
});

test('dialogue engine: no immediate repeat when an alternative exists', () => {
  const engine = createDialogueEngine({
    lang: 'en',
    pools: { en: { idle: [{ text: 'one' }, { text: 'two' }] } },
  });
  const seen = new Set();
  let prev = null;
  for (let i = 0; i < 10; i++) {
    const picked = engine.pick('idle', {});
    if (prev) assert.notEqual(picked.text, prev);
    prev = picked.text;
    seen.add(picked.text);
  }
  assert.deepEqual([...seen].sort(), ['one', 'two']);
});

test('dialogue engine: string-shorthand pool entries are normalized', () => {
  const engine = createDialogueEngine({ lang: 'en', pools: { en: { 'click:head': ['Ouch!'] } } });
  const picked = engine.pick('click:head', {});
  assert.equal(picked.text, 'Ouch!');
  assert.equal(picked.mood, 'normal');
});

test('dialogue engine: setPool()/hasPool() work after construction', () => {
  const engine = createDialogueEngine({ lang: 'ru' });
  assert.equal(engine.hasPool('ru'), false);
  engine.setPool('ru', { load: ['Привет'] });
  assert.equal(engine.hasPool('ru'), true);
  assert.equal(engine.pick('load', {}).text, 'Привет');
});

test('pick: phrases with placeholders the context cannot fill are never chosen', async () => {
  const { createDialogueEngine } = await import('../public/js/pio/dialogue.js');
  const engine = createDialogueEngine({
    lang: 'en',
    pools: { en: { 'spin:end': [{ text: 'Made by {developers}!' }, { text: '{game} it is.' }] } },
  });
  for (let i = 0; i < 30; i++) {
    const picked = engine.pick('spin:end', { game: 'Portal' });
    assert.equal(picked.text, 'Portal it is.');
  }
  assert.equal(engine.pick('spin:end', {}), null);
});

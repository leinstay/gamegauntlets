// Unit tests for the pure logic in public/js/pio/dialogue.js (the Pio dialogue engine, task T4).
// Run with: node --test tests/
//
// NOTE: this file is outside T4's owned path list (public/pio/**, public/vendor/**, public/js/pio/**,
// public/pio-demo.html) but the rewrite plan's global constraints require pure logic to be unit-tested. It is
// flagged in the implementer report's DEVIATIONS. `public/js/pio/package.json` ({"type":"module"}) was added so
// dialogue.js (which uses `export`) resolves as an ES module even before T1 lands the root package.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDialogueEngine, _internal, KNOWN_EVENTS, KNOWN_WHEN_KEYS, KNOWN_PLACEHOLDERS, MOODS } from '../public/js/pio/dialogue.js';

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

// --- v2 additions (.claude/docs/pio-spec.md, kept outside git) ---

test('exported constant lists for the content validator', () => {
  for (const list of [KNOWN_EVENTS, KNOWN_WHEN_KEYS, KNOWN_PLACEHOLDERS, MOODS]) {
    assert.ok(Array.isArray(list) && list.length > 0);
  }
  assert.ok(KNOWN_EVENTS.includes('spin:end'));
  assert.ok(KNOWN_EVENTS.includes('ambient'));
  assert.ok(KNOWN_EVENTS.includes('spin:streak'));
  assert.ok(KNOWN_EVENTS.includes('hover:gog'));
  assert.ok(!KNOWN_EVENTS.includes('hover:gabestore')); // renamed
  assert.ok(KNOWN_WHEN_KEYS.includes('visitsMin'));
  assert.ok(KNOWN_WHEN_KEYS.includes('difficulty'));
  assert.ok(KNOWN_PLACEHOLDERS.includes('price'));
  assert.ok(KNOWN_PLACEHOLDERS.includes('developers')); // old placeholder, still valid
  assert.deepEqual(MOODS, ['normal', 'happy', 'enjoy', 'unhappy', 'kira', 'deformed']);
});

test('pick: a `text` array is a sequence — first item comes back as `text`, the rest as `sequence`', () => {
  const engine = createDialogueEngine({
    lang: 'en',
    pools: { en: { 'idle:veryLong': [{ text: ['Zzz...', 'still there, {game}?'], mood: 'enjoy' }] } },
  });
  const picked = engine.pick('idle:veryLong', { game: 'Portal' });
  assert.equal(picked.text, 'Zzz...');
  assert.deepEqual(picked.sequence, ['still there, Portal?']);
  assert.equal(picked.mood, 'enjoy');
});

test('pick: a plain string `text` never gets a `sequence` field', () => {
  const engine = createDialogueEngine({ lang: 'en', pools: { en: { idle: [{ text: 'Hi' }] } } });
  const picked = engine.pick('idle', {});
  assert.equal(picked.text, 'Hi');
  assert.equal(picked.sequence, undefined);
});

test('pick: a sequence is only eligible when every item in it is fillable', () => {
  const engine = createDialogueEngine({
    lang: 'en',
    pools: { en: { ambient: [{ text: ['fine', 'needs {nope}'] }, { text: ['fallback', 'also fine'] }] } },
  });
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(engine.pick('ambient', {}).sequence, ['also fine']);
  }
});

test('`once` phrases fire at most once per engine session, others keep cycling', () => {
  const engine = createDialogueEngine({
    lang: 'en',
    pools: { en: { load: [{ text: 'first time here!', once: true }, { text: 'hello again' }] } },
  });
  let onceSeenCount = 0;
  for (let i = 0; i < 50; i++) {
    if (engine.pick('load', {}).text === 'first time here!') onceSeenCount += 1;
  }
  assert.equal(onceSeenCount, 1);
});

test('`once` is independent between different phrases/events', () => {
  const engine = createDialogueEngine({
    lang: 'en',
    pools: {
      en: {
        load: [{ text: 'a', once: true }, { text: 'b', once: true }],
      },
    },
  });
  const seen = new Set([engine.pick('load', {}).text, engine.pick('load', {}).text]);
  assert.deepEqual([...seen].sort(), ['a', 'b']);
  assert.equal(engine.pick('load', {}), null); // both once-phrases already shown
});

test('when: visitsMin/visitsMax and spinsMin/spinsMax', () => {
  const { matchesWhen } = _internal;
  assert.equal(matchesWhen({ visitsMin: 5 }, { visits: 5 }), true);
  assert.equal(matchesWhen({ visitsMin: 5 }, { visits: 4 }), false);
  assert.equal(matchesWhen({ visitsMax: 1 }, { visits: 1 }), true);
  assert.equal(matchesWhen({ visitsMax: 1 }, { visits: 2 }), false);
  assert.equal(matchesWhen({ spinsMin: 10 }, { spins: 10 }), true);
  assert.equal(matchesWhen({ spinsMax: 4 }, { spins: 5 }), false);
});

test('when: dayOfWeek and date accept a single value or an array', () => {
  const { matchesWhen } = _internal;
  assert.equal(matchesWhen({ dayOfWeek: 0 }, { dayOfWeek: 0 }), true);
  assert.equal(matchesWhen({ dayOfWeek: [0, 6] }, { dayOfWeek: 6 }), true);
  assert.equal(matchesWhen({ dayOfWeek: [0, 6] }, { dayOfWeek: 3 }), false);
  assert.equal(matchesWhen({ date: '12-31' }, { date: '12-31' }), true);
  assert.equal(matchesWhen({ date: ['01-01', '12-31'] }, { date: '01-01' }), true);
  assert.equal(matchesWhen({ date: '02-14' }, { date: '02-15' }), false);
});

test('when: noScore, free, difficulty, reviewsMin/Max, loggedIn, mobile', () => {
  const { matchesWhen } = _internal;
  assert.equal(matchesWhen({ noScore: true }, { noScore: true }), true);
  assert.equal(matchesWhen({ noScore: true }, { noScore: false }), false);
  assert.equal(matchesWhen({ free: true }, { free: true }), true);
  assert.equal(matchesWhen({ free: false }, { free: true }), false);
  assert.equal(matchesWhen({ difficulty: 'Unforgiving' }, { difficulty: 'Unforgiving' }), true);
  assert.equal(matchesWhen({ difficulty: 'Unforgiving' }, { difficulty: 'Easy' }), false);
  assert.equal(matchesWhen({ reviewsMin: 80 }, { reviews: 85 }), true);
  assert.equal(matchesWhen({ reviewsMax: 40 }, { reviews: 85 }), false);
  assert.equal(matchesWhen({ loggedIn: true }, { loggedIn: true }), true);
  assert.equal(matchesWhen({ loggedIn: true }, { loggedIn: false }), false);
  assert.equal(matchesWhen({ mobile: false }, { mobile: false }), true);
  assert.equal(matchesWhen({ mobile: false }, { mobile: true }), false);
});

test('when: awayMin/awayMax match context.awaySeconds', () => {
  const { matchesWhen } = _internal;
  assert.equal(matchesWhen({ awayMin: 120 }, { awaySeconds: 150 }), true);
  assert.equal(matchesWhen({ awayMin: 120 }, { awaySeconds: 30 }), false);
  assert.equal(matchesWhen({ awayMax: 60 }, { awaySeconds: 30 }), true);
  assert.equal(matchesWhen({ awayMax: 60 }, { awaySeconds: 90 }), false);
});

test('pick: {awayMinutes} is derived automatically from context.awaySeconds', () => {
  const engine = createDialogueEngine({
    lang: 'en',
    pools: { en: { 'tab:return': [{ text: 'gone for {awayMinutes}m' }] } },
  });
  assert.equal(engine.pick('tab:return', { awaySeconds: 125 }).text, 'gone for 2m');
});

test('pick: {price} is formatted with context.priceSymbol (default "$")', () => {
  const engine = createDialogueEngine({
    lang: 'en',
    pools: { en: { 'spin:end': [{ text: 'only {price}!' }] } },
  });
  assert.equal(engine.pick('spin:end', { price: 19.99, priceSymbol: '€' }).text, 'only 19.99 €!');
  assert.equal(engine.pick('spin:end', { price: 0 }).text, 'only 0 $!');
});

test('pick: {time} is always fillable (filled in from the wall clock when not given explicitly)', () => {
  const engine = createDialogueEngine({ lang: 'en', pools: { en: { ambient: [{ text: 'it is {time} here' }] } } });
  const picked = engine.pick('ambient', {});
  assert.match(picked.text, /^it is \d{2}:\d{2} here$/);
});

test('cross-event recent-phrase memory: the same phrase is avoided right after another event picked it', () => {
  const engine = createDialogueEngine({
    lang: 'en',
    pools: {
      en: {
        ambient: [{ text: 'shared line' }, { text: 'ambient only' }],
        idle: [{ text: 'shared line' }, { text: 'idle only' }],
      },
    },
  });
  // Force 'shared line' to be the one remembered by exhausting ambient's alternative first isn't required --
  // just keep picking from 'idle' after 'ambient' happened to say the shared line, many times, and confirm it
  // is never immediately repeated when idle's own alternative exists.
  let sawSharedFromAmbient = false;
  for (let i = 0; i < 50 && !sawSharedFromAmbient; i++) {
    if (engine.pick('ambient', {}).text === 'shared line') sawSharedFromAmbient = true;
  }
  assert.ok(sawSharedFromAmbient, 'test setup: ambient should be able to pick the shared line');
  assert.equal(engine.pick('idle', {}).text, 'idle only');
});

test('cross-event recent-phrase memory: falls back to a repeat rather than returning null', () => {
  const engine = createDialogueEngine({
    lang: 'en',
    pools: { en: { ambient: [{ text: 'only line' }], idle: [{ text: 'only line' }] } },
  });
  assert.equal(engine.pick('ambient', {}).text, 'only line');
  // 'idle' has no OTHER candidate, so memory is ignored rather than returning null.
  assert.equal(engine.pick('idle', {}).text, 'only line');
});

test('pick() tolerates a missing/absent sessionStorage (Node/non-browser environment)', () => {
  // This whole file runs without a `window` global, and every test above already exercises pick() -- this
  // test just makes the guarantee explicit for the recent-memory/once bookkeeping specifically.
  assert.equal(typeof window, 'undefined');
  const engine = createDialogueEngine({ lang: 'en', pools: { en: { load: [{ text: 'ok', once: true }] } } });
  assert.doesNotThrow(() => engine.pick('load', {}));
});

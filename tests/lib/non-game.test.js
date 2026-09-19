import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyNonGame, bundleBaseName } from '../../src/lib/non-game.js';

function byName(name) {
  return classifyNonGame({ name });
}

// --- name heuristics: real catalog names (positive) --------------------------------------------------

const POSITIVE_NAMES = [
  ['Chained Echoes (Original Game Soundtrack)', 'soundtrack'],
  ['Blades of Fire - Artbook', 'artbook'],
  ['Shadow Gambit: The Cursed Crew - Artbook & Strategy Guide', null], // asserted non-null below, class varies
  ['Up on the Rooftop Soundtrack', 'soundtrack'],
];

for (const [name, expected] of POSITIVE_NAMES) {
  test(`classifyNonGame: flags "${name}"${expected ? ` as ${expected}` : ''}`, () => {
    const result = byName(name);
    assert.notEqual(result, null, `expected "${name}" to be flagged as non-game`);
    if (expected) assert.equal(result, expected);
  });
}

// --- name heuristics: must NOT flag a real game (negative) --------------------------------------------

const NEGATIVE_NAMES = [
  'The Flower Collectors Soundtrack Edition',
  'The Lonesome Guild: Soundtrack Edition',
  'Demolition Simulator',
  "Demon's Souls",
  'Art of Rally',
  'Frostpunk', // "ost" appears mid-word, must not match the standalone OST keyword
  'Ghost of Tsushima', // same "ost" trap, different position
  'The Movies',
  'Game Dev Tycoon',
  'Season Pass Simulator', // ends in "Simulator", not "Season Pass" - not required to flag either way
  'Kingdom Come: Deliverance', // plain ':' separator, no keyword at the end of either clause
  'DOOM Eternal', // must not fire on "DOOM" containing no keyword
  'Tools Up!', // "Tools" (plural) is not the bare "tool" keyword pattern used anywhere in names
  'Artful Escape', // "Art" is a prefix, not a whole "Artbook"/"Art Book" clause-ending phrase
];

for (const name of NEGATIVE_NAMES) {
  test(`classifyNonGame: does not flag "${name}"`, () => {
    assert.equal(byName(name), null);
  });
}

// --- name heuristics: one check per keyword family ------------------------------------------------------

const KEYWORD_CASES = [
  ['Some Game DLC', 'dlc'],
  ['Some Game: Season Pass', 'dlc'],
  ['Some Game - Expansion Pass', 'dlc'],
  ['Some Game Skin Pack', 'dlc'],
  ['Some Game Costume Pack', 'dlc'],
  ['Some Game Upgrade Pack', 'dlc'],
  ['Some Game Supporter Pack', 'dlc'],
  ['Some Game Original Score', 'soundtrack'],
  ['Some Game OST', 'soundtrack'],
  ['Some Game Soundtrack', 'soundtrack'],
  ['Some Game (Original Soundtrack)', 'soundtrack'],
  ['Some Game Digital Artbook', 'artbook'],
  ['Some Game Digital Art', 'artbook'],
  ['Some Game Art Book', 'artbook'],
  ['Some Game Artbook', 'artbook'],
  // "Wallpaper(s)" split off the end of a title by a real separator (` - `/`:`/`(`) is a cosmetic
  // DLC-style extra -> artbook; see the dedicated "whole-title wallpaper app" section below for why an
  // unsplit "<Words> Wallpaper" (no separator at all) is `tool` instead.
  ['Some Game - Wallpapers', 'artbook'],
  ['Some Game - Wallpaper', 'artbook'],
  ['Some Game Dedicated Server', 'tool'],
  ['Some Game SDK', 'tool'],
  ['Some Game Playtest', 'demo'],
  ['Some Game Demo', 'demo'],
  ['Some Game Strategy Guide', 'other'],
];

for (const [name, expected] of KEYWORD_CASES) {
  test(`classifyNonGame: name keyword "${name}" -> ${expected}`, () => {
    assert.equal(byName(name), expected);
  });
}

// --- whole-title "Wallpaper" desktop apps (review follow-up) -> tool, not artbook ------------------------

const WALLPAPER_APP_NAMES = ['Live Waifu Wallpaper', "Cat's Meow Live Wallpaper", 'Anime Girl Wallpaper', 'Desktop Wallpapers'];

for (const name of WALLPAPER_APP_NAMES) {
  test(`classifyNonGame: "${name}" (no separator - the whole title IS "...Wallpaper(s)") -> tool`, () => {
    assert.equal(byName(name), 'tool');
  });
}

// --- "<Base> + <extras>" bundle shapes: real false positives from review, gated by baseGameExists --------
//
// Each of these is a real Steam/GOG listing where a name keyword (DLC/OST/Supporter Pack/...) only shows
// up after a top-level "+" (or, for the "Digital Goods Bundle" one, in that fixed suffix) - flagging any
// of them by that keyword alone would have pulled a real, often sole-listing, game out of the wheel. Each
// is only ever classified `bundle` when the caller (src/pipeline/resolve.js / scripts/report-non-games.js)
// has independently confirmed a separate base-game row exists (`baseGameExists: true`); otherwise it must
// come back null, exactly like an ordinary unflagged game.
const BUNDLE_SHAPED_NAMES = [
  ['KINGDOM HEARTS III + Re Mind (DLC)', 'KINGDOM HEARTS III'],
  ['Rambo The Video Game + Baker Team DLC', 'Rambo The Video Game'],
  ['Soulstone Survivors + Supporter Pack', 'Soulstone Survivors'],
  ['BAD END THEATER - Game + OST', 'BAD END THEATER'],
  ['Chants of Sennaar - Game + OST', 'Chants of Sennaar'],
  ['Lysfanga: The Time Shift Warrior + OST', 'Lysfanga: The Time Shift Warrior'],
  ['Sinless + OST', 'Sinless'],
  ['Twilight Oracle + OST', 'Twilight Oracle'],
  ['Under The Waves + OST', 'Under The Waves'],
  ['TUNIC + TUNIC (Original Game Soundtrack)', 'TUNIC'],
  ['We Happy Few - Soundtrack and Digital Goods Bundle', 'We Happy Few'],
];

for (const [name, base] of BUNDLE_SHAPED_NAMES) {
  test(`bundleBaseName: "${name}" -> "${base}"`, () => {
    assert.equal(bundleBaseName(name), base);
  });

  test(`classifyNonGame: "${name}" is null without a confirmed base game (sole listing, not flagged)`, () => {
    assert.equal(classifyNonGame({ name }), null);
    assert.equal(classifyNonGame({ name, baseGameExists: false }), null);
  });

  test(`classifyNonGame: "${name}" is 'bundle' once baseGameExists is true`, () => {
    assert.equal(classifyNonGame({ name, baseGameExists: true }), 'bundle');
  });
}

test('bundleBaseName: an ordinary title with no "+" and no bundle suffix is null', () => {
  assert.equal(bundleBaseName('Half-Life 2'), null);
  assert.equal(bundleBaseName('Some Game Soundtrack Edition'), null);
});

test('bundleBaseName: a "+" whose tail has no recognised keyword is not treated as a bundle shape', () => {
  assert.equal(bundleBaseName('Salt and Sacrifice + Something Unrelated'), null);
});

test('bundleBaseName: a real title ending in "Game" is not mistaken for the "- Game" bundle glue', () => {
  // "Rambo The Video Game" must keep its real "Game" word - only a `:`/`-`-glued "- Game"/": Game" is
  // stripped (see GAME_SUFFIX_GLUE_RE's doc comment).
  assert.equal(bundleBaseName('Rambo The Video Game + Baker Team DLC'), 'Rambo The Video Game');
});

// --- Steam appdetails `type` (hard signal, highest priority) --------------------------------------------

const STEAM_TYPE_CASES = [
  ['dlc', 'dlc'],
  ['DLC', 'dlc'], // case-insensitive
  ['music', 'soundtrack'],
  ['video', 'video'],
  ['movie', 'video'],
  ['series', 'video'],
  ['episode', 'video'],
  ['demo', 'demo'],
  ['mod', 'other'],
  ['hardware', 'other'],
  ['advertising', 'other'],
  ['tool', 'tool'],
  ['application', 'tool'],
  ['game', null],
  ['config', null], // unrecognised Steam type -> not a hard signal, falls through
];

for (const [steamType, expected] of STEAM_TYPE_CASES) {
  test(`classifyNonGame: steamType "${steamType}" -> ${expected}`, () => {
    assert.equal(classifyNonGame({ name: 'Unrelated Name', steamType }), expected);
  });
}

// --- GOG product type ------------------------------------------------------------------------------------

const GOG_TYPE_CASES = [
  ['dlc', 'dlc'],
  ['DLC', 'dlc'],
  ['extras', 'other'],
  ['pack', null], // isKeepablePack() already filtered non-keepable packs before this ever runs
  ['game', null],
  ['GAME', null],
];

for (const [gogType, expected] of GOG_TYPE_CASES) {
  test(`classifyNonGame: gogType "${gogType}" -> ${expected}`, () => {
    assert.equal(classifyNonGame({ name: 'Unrelated Name', gogType }), expected);
  });
}

// --- priority: Steam type > GOG type > name > genre-only --------------------------------------------------

test('classifyNonGame: steamType wins over a name that would otherwise classify differently', () => {
  assert.equal(classifyNonGame({ name: 'Some Game Soundtrack', steamType: 'dlc' }), 'dlc');
});

test('classifyNonGame: gogType wins over a name that would otherwise classify differently (no steamType)', () => {
  assert.equal(classifyNonGame({ name: 'Some Game Artbook', gogType: 'dlc' }), 'dlc');
});

test('classifyNonGame: name wins over the genre-only fallback', () => {
  assert.equal(classifyNonGame({ name: 'Some Game Demo', genres: ['Action'] }), 'demo');
});

// --- genre-only "software" fallback (only when there is NO game genre at all) -----------------------------

test('classifyNonGame: a pure software genre set with no game genre classifies tool', () => {
  assert.equal(classifyNonGame({ name: 'Some Suite', genres: ['Utilities'] }), 'tool');
});

test('classifyNonGame: several software genres together still classify tool', () => {
  assert.equal(classifyNonGame({ name: 'Some Suite', genres: ['Video Production', 'Audio Production'] }), 'tool');
});

test('classifyNonGame: a real game genre alone is never flagged', () => {
  assert.equal(classifyNonGame({ name: 'Some Game', genres: ['Action'] }), null);
});

test('classifyNonGame: mixing a software genre with a real game genre is not flagged', () => {
  assert.equal(classifyNonGame({ name: 'Some Game', genres: ['Utilities', 'Action'] }), null);
});

test('classifyNonGame: no genres at all is never flagged by the genre-only rule', () => {
  assert.equal(classifyNonGame({ name: 'Some Game', genres: [] }), null);
  assert.equal(classifyNonGame({ name: 'Some Game' }), null);
});

test('classifyNonGame: genres accepted as a pipe-wrapped column string too', () => {
  assert.equal(classifyNonGame({ name: 'Some Suite', genres: '|Utilities|' }), 'tool');
  assert.equal(classifyNonGame({ name: 'Some Game', genres: '|Action|Utilities|' }), null);
});

// --- misc / defensive ---------------------------------------------------------------------------------------

test('classifyNonGame: called with no arguments at all returns null', () => {
  assert.equal(classifyNonGame(), null);
});

test('classifyNonGame: a blank/null name never throws and is not flagged by itself', () => {
  assert.equal(classifyNonGame({ name: null }), null);
  assert.equal(classifyNonGame({ name: '' }), null);
  assert.equal(classifyNonGame({ name: '   ' }), null);
});

test('classifyNonGame: categories is accepted but does not affect the result (no rule uses it yet)', () => {
  assert.equal(classifyNonGame({ name: 'Some Game', categories: ['Single-player'] }), null);
  assert.equal(classifyNonGame({ name: 'Some Game Demo', categories: ['Anything'] }), 'demo');
});

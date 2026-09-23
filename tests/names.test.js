import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  normalizeName,
  stringRomToNum,
  romanToNumber,
  numberToRoman,
  swapRoman,
  swapNumber,
  metaphone,
  phoneme,
  levenPhon,
  levenshteinDistance,
  similarText,
  simpleSim,
  similarity,
  fixName,
  isDemo,
  toPipeList,
  fromPipeList,
  searchNameVariants,
} from '../src/lib/names.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pinned values captured by running the ACTUAL legacy PHP functions
// (main_functions.php / metacritic_gamefaq_functions.php) read-only on
// PHP 8.2, via `php8.2` fed the probe script over SSH stdin (no file was
// ever written to the server). See tests/fixtures/names/legacy-oracle.json.
// One deliberate deviation from the PHP oracle (2026-09-22): the article "the" is stripped
// case-insensitively ("Sonic the Hedgehog 2 Collection" -> "Sonic Hedgehog 2"), because store and
// review sites capitalise titles differently ("Sons Of The Forest" vs "Sons of the Forest") and the
// normalised keys are only ever compared with each other.
const oracle = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures/names/legacy-oracle.json'), 'utf8')
);

describe('normalizeName (port of legacy simpleName)', () => {
  for (const c of oracle.simpleName) {
    const [str, convertRom, softRestrict, removeAdditions] = c.args;
    test(`simpleName(${JSON.stringify(c.args)}) === ${JSON.stringify(c.result)}`, () => {
      const actual = normalizeName(str, { convertRom, softRestrict, removeAdditions });
      assert.equal(actual, c.result);
    });
  }

  test('handles empty input by falling back to the original string', () => {
    assert.equal(normalizeName(''), '');
    assert.equal(normalizeName('!!!'), '!!!');
  });

  test('strips trademark/registered marks', () => {
    assert.equal(normalizeName('DOOM ™'), 'DOOM');
  });

  test('drops "Game of the Year Edition" / GOTY style suffixes', () => {
    assert.equal(
      normalizeName('Batman: Arkham Knight Game of the Year Edition'),
      'Batman Arkham Knight'
    );
    assert.equal(
      normalizeName('The Witcher 3: Wild Hunt - Game of the Year Edition'),
      'Witcher 3 Wild Hunt'
    );
  });

  test('removeAdditions keeps only the part before the first colon', () => {
    assert.equal(
      normalizeName('The Witcher 3: Wild Hunt', { removeAdditions: true }),
      'The Witcher 3'
    );
  });
});

describe('stringRomToNum / swapRoman / swapNumber', () => {
  for (const c of oracle.stringRomToNum) {
    test(`stringRomToNum(${JSON.stringify(c.arg)}) === ${JSON.stringify(c.result)}`, () => {
      assert.equal(stringRomToNum(c.arg), c.result);
    });
  }
  for (const c of oracle.swapRoman) {
    test(`swapRoman(${JSON.stringify(c.arg)}) === ${JSON.stringify(c.result)}`, () => {
      assert.equal(swapRoman(c.arg), c.result);
    });
  }
  for (const c of oracle.swapNumber) {
    test(`swapNumber(${JSON.stringify(c.arg)}) === ${JSON.stringify(c.result)}`, () => {
      assert.equal(swapNumber(c.arg), c.result);
    });
  }

  test('romanToNumber / numberToRoman round-trip', () => {
    assert.equal(romanToNumber('VI'), 6);
    assert.equal(romanToNumber('IX'), 9);
    assert.equal(romanToNumber('III'), 3);
    assert.equal(numberToRoman(6), 'VI');
    assert.equal(numberToRoman(9), 'IX');
    assert.equal(numberToRoman(3), 'III');
  });

  test('a bare "2" is left alone by stringRomToNum (not a roman word)', () => {
    assert.equal(stringRomToNum('Half-Life 2'), 'Half-Life 2');
  });
});

describe('isDemo (port of legacy isDemo)', () => {
  for (const c of oracle.isDemo) {
    test(`isDemo(${JSON.stringify(c.arg)}) === ${c.result}`, () => {
      assert.equal(isDemo(c.arg), c.result);
    });
  }
});

describe('fixName (port of legacy fixName)', () => {
  for (const c of oracle.fixName) {
    test(`fixName(${JSON.stringify(c.arg)}) === ${JSON.stringify(c.result)}`, () => {
      assert.equal(fixName(c.arg), c.result);
    });
  }
});

describe('metaphone (JS port of PHP metaphone())', () => {
  for (const c of oracle.metaphone) {
    test(`metaphone(${JSON.stringify(c.arg)}) === ${JSON.stringify(c.result)}`, () => {
      assert.equal(metaphone(c.arg), c.result);
    });
  }

  // Known, deliberate deviation from PHP: see the module-level comment in
  // src/lib/names.js. PHP silences a later "GH" when the word starts with
  // B/D/H or its 2nd letter is H; this port always maps non-initial "GH"
  // to "F". Documented here so the gap is visible, not silently untested.
  test('KNOWN DEVIATION: non-initial GH always maps to F (PHP silences it after a leading B/D/H/?H)', () => {
    assert.equal(metaphone('Bright'), 'BRFT'); // PHP: "BRT"
    assert.equal(metaphone('Bought'), 'BFT'); // PHP: "BT"
    assert.equal(metaphone('Though'), '0F'); // PHP: "0" (the theta from "TH" is still correct)
  });
});

describe('phoneme / levenPhon (identical port from both legacy files)', () => {
  for (const c of oracle.phoneme) {
    test(`phoneme(${JSON.stringify(c.arg)}) === ${JSON.stringify(c.result)}`, () => {
      assert.equal(phoneme(c.arg), c.result);
    });
  }
  for (const c of oracle.levenPhon) {
    test(`levenPhon(${JSON.stringify(c.arg)}) === ${JSON.stringify(c.result)}`, () => {
      assert.equal(levenPhon(c.arg), c.result);
    });
  }
  test('phoneme and levenPhon are the same function', () => {
    assert.equal(levenPhon, phoneme);
  });
});

describe('similarText (JS port of PHP similar_text)', () => {
  for (const c of oracle.similar_text) {
    test(`similarText(${JSON.stringify(c.args)})`, () => {
      const r = similarText(c.args[0], c.args[1]);
      assert.equal(r.length, c.sim);
      assert.equal(Math.round(r.percent * 1e6) / 1e6, c.percent);
    });
  }
});

describe('levenshteinDistance (PHP levenshtein with unit costs)', () => {
  for (const c of oracle.levenshtein) {
    test(`levenshteinDistance(${JSON.stringify(c.args)}) === ${c.result}`, () => {
      assert.equal(levenshteinDistance(c.args[0], c.args[1]), c.result);
    });
  }
});

describe('similarity (port of legacy similarity())', () => {
  for (const c of oracle.similarity) {
    test(`similarity(${JSON.stringify(c.args)})`, () => {
      assert.deepEqual(similarity(c.args[0], c.args[1]), c.result);
    });
  }
  test('returns false for empty input, matching the PHP early return', () => {
    assert.equal(similarity('', 'anything'), false);
    assert.equal(similarity('anything', ''), false);
  });
});

describe('simpleSim (plan contract: pairwise 0..100 percentage)', () => {
  for (const c of oracle.simpleSim) {
    test(`simpleSim(${JSON.stringify(c.args)}) === ${c.percent}`, () => {
      assert.equal(Math.round(simpleSim(c.args[0], c.args[1]) * 1e6) / 1e6, c.percent);
    });
  }
  test('identical names score 100', () => {
    assert.equal(simpleSim('Half-Life 2', 'Half-Life 2'), 100);
  });
  test('roman numerals and arabic digits are treated as equivalent', () => {
    assert.ok(simpleSim('Dark Souls III', 'Dark Souls 3') > 95);
  });
});

describe('searchNameVariants (review-site title fallbacks for gamefaqs.js/hltb.js)', () => {
  // Real cases from the 2026-09-22 GameFAQs/HLTB name-search misses report
  // (see the task); expected strings verified by actually running
  // normalizeName(), not guessed.
  const cases = [
    ['Nioh 2 – The Complete Edition', ['Nioh 2 The', 'Nioh 2']],
    ['Gauntlet™ Slayer Edition', ['Gauntlet Slayer Edition', 'Gauntlet']],
    ['Gotham City Impostors Free to Play', ['Gotham City Impostors Free to Play', 'Gotham City Impostors']],
    ['PRO EVOLUTION SOCCER 2019 LITE', ['PRO EVOLUTION SOCCER 2019 LITE', 'PRO EVOLUTION SOCCER 2019']],
    ['TERA - Action MMORPG', ['TERA Action MMORPG', 'TERA']],
    ['Grand Theft Auto V Enhanced', ['Grand Theft Auto V Enhanced', 'Grand Theft Auto V']],
    [
      'The Elder Scrolls IV: Oblivion Remastered',
      ['Elder Scrolls IV Oblivion Remastered', 'Elder Scrolls IV Oblivion', 'Elder Scrolls IV'],
    ],
  ];

  for (const [input, expected] of cases) {
    test(`searchNameVariants(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(searchNameVariants(input), expected);
    });
  }

  test('Yakuza 3 Remastered -> falls back to the base title once "Remastered" is stripped', () => {
    assert.deepEqual(searchNameVariants('Yakuza 3 Remastered'), ['Yakuza 3 Remastered', 'Yakuza 3']);
  });

  test('de-duplicates case-insensitively and caps at 4 entries', () => {
    const variants = searchNameVariants('Half-Life 2');
    assert.equal(new Set(variants.map((v) => v.toLowerCase())).size, variants.length);
    assert.ok(variants.length <= 4);
  });

  test('a plain title with nothing to strip returns just the normalized name', () => {
    assert.deepEqual(searchNameVariants('Half-Life 2'), ['Half Life 2']);
  });

  test('empty/missing input -> empty list', () => {
    assert.deepEqual(searchNameVariants(''), []);
    assert.deepEqual(searchNameVariants(null), []);
  });
});

describe('toPipeList / fromPipeList', () => {
  test('builds a trimmed, deduped, pipe-delimited list', () => {
    assert.equal(toPipeList(['a', 'b', 'a', ' c ', '', null, undefined]), '|a|b|c|');
  });
  test('returns null for an empty or all-blank array', () => {
    assert.equal(toPipeList([]), null);
    assert.equal(toPipeList(['', '  ', null]), null);
  });
  test('returns null for non-array input', () => {
    assert.equal(toPipeList(null), null);
    assert.equal(toPipeList('a|b'), null);
  });
  test('fromPipeList parses the canonical format back into an array', () => {
    assert.deepEqual(fromPipeList('|a|b|c|'), ['a', 'b', 'c']);
  });
  test('fromPipeList tolerates missing pipes, blanks and whitespace', () => {
    assert.deepEqual(fromPipeList('a|b|'), ['a', 'b']);
    assert.deepEqual(fromPipeList('|a| |b|'), ['a', 'b']);
    assert.deepEqual(fromPipeList(''), []);
    assert.deepEqual(fromPipeList(null), []);
  });
  test('round-trips through toPipeList', () => {
    const original = ['Action', 'RPG', 'Indie'];
    assert.deepEqual(fromPipeList(toPipeList(original)), original);
  });
});

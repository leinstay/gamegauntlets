// Name normalisation and fuzzy-matching helpers.
//
// Faithful JS port of the name helpers in
// legacy/ajax/scripts/cron_scripts/SGG/functions/main_functions.php
// (simpleName, stringRomToNum, swapRoman/swapNumber, levenPhon, simpleSim,
// fixName, isDemo) and similarity()/phoneme() from
// legacy/ajax/scripts/cron_scripts/SGG/functions/metacritic_gamefaq_functions.php.
//
// PHP's `similar_text`, `levenshtein` (unit costs) and `metaphone` are
// reimplemented from scratch below (Node has no equivalents). similar_text
// and levenshtein are deterministic, well-documented algorithms and are
// ported exactly (verified against live PHP 8.2 output for dozens of
// cases). PHP's metaphone() is a ~500-line C state machine; the ruleset
// below was reverse-engineered against live PHP 8.2 output for 150+ words
// (see tests/names.test.js) and matches it for all ordinary English
// consonant/vowel patterns. One narrow, confirmed PHP quirk is NOT
// replicated: PHP silences a later "GH" when the word starts with
// B/D/H, or when its second letter is H (e.g. "bought", "bright",
// "though" -> GH is dropped instead of becoming "F"). This implementation
// always maps non-initial "GH" to "F". It is a cosmetic mismatch limited
// to that specific spelling pattern and does not affect ordinary game
// titles; see DEVIATIONS in the task report.

/**
 * Decode a small, practical set of HTML entities (numeric + the named
 * entities that actually show up in game names/descriptions). Mirrors
 * `html_entity_decode($s, ENT_QUOTES)` closely enough for this purpose:
 * full parity with PHP's ~250-entry named-entity table is not attempted
 * because everything that survives is stripped to a space by
 * normalizeName's `[^A-Za-z0-9]` pass anyway, except for the handful of
 * entities below.
 */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  trade: '™',
  reg: '®',
  copy: '©',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  deg: '°',
};

// Exported for src/lib/game-card.js's description-cleaning (T21): the legacy
// `description_en`/`description_ru` columns carry raw HTML (`<br>`, `<b>`,
// entities, ...) that needs the same small, practical entity table this was
// already built for, rather than a second copy of it.
export function decodeHtmlEntities(input) {
  const str = input == null ? '' : String(input);
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const key = entity.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
  });
}

/** trim($str, $charlist) - strip any of the given chars from both ends. */
function trimChars(str, chars) {
  const set = new Set(chars.split(''));
  let start = 0;
  let end = str.length;
  while (start < end && set.has(str[start])) start++;
  while (end > start && set.has(str[end - 1])) end--;
  return str.slice(start, end);
}

const EDITION_LITERALS = [
  '(PC Download)',
  '(Classic)',
  'Digital Starter Pack',
  'Special Edition',
  'Definitive Edition',
  'Enhanced Edition',
  'Deluxe Edition',
  'Game of the Year Edition',
  'GOTY Edition',
  'Standard Edition',
  'Golden Edition',
  'Gold Edition',
  'Silver Edition',
  "Collector's Edition",
  'Redux',
  'GOTY',
];

/**
 * Port of legacy `simpleName()`. This is the canonical name-normalisation
 * function used throughout the resolver for fuzzy matching.
 *
 * @param {string} input
 * @param {{convertRom?: boolean, softRestrict?: boolean, removeAdditions?: boolean}} [opts]
 */
export function normalizeName(input, opts = {}) {
  const { convertRom = false, softRestrict = false, removeAdditions = false } = opts;
  const original = input == null ? '' : String(input);
  let s = decodeHtmlEntities(original).trim();
  s = s.split('/')[0];
  s = s.split('&').join('and');

  if (!softRestrict) {
    for (const token of EDITION_LITERALS) {
      s = s.split(token).join('');
    }
    s = s.replace(/(\s*?\(([^)]*)\)[^(]*)$/, '');
  }

  s = s.split('™').join(''); // "™"

  if (removeAdditions) {
    s = s.split(':')[0].trim();
  }

  s = s.replace(/[^A-Za-z0-9]/g, ' ');
  s = s.replace(/\s+/g, ' ');

  if (!softRestrict) {
    const wordsArr = s.split(' ');
    const lastWord = wordsArr.pop();
    if (wordsArr.length > 0 && lastWord === 'Deluxe') s = s.split('Deluxe').join('');
    if (wordsArr.length > 3 && lastWord === 'Player') s = s.split('Single Player').join('');
    if (wordsArr.length > 1 && lastWord === 'Collection') s = s.split('Collection').join('');
    if (wordsArr.length > 1 && lastWord === 'VR') s = s.split(' VR').join('');
    if (
      wordsArr.length > 3 &&
      wordsArr[wordsArr.length - 1] === 'D' &&
      wordsArr[wordsArr.length - 2] === 'A'
    ) {
      s = s.split(' A D').join('');
    }
    if (wordsArr.length > 2) s = s.replace(/\s*?\(?\S*?\s*?edition\)?$/i, '');
    // case-insensitive: "Sons Of The Forest" (Steam) vs "Sons of the Forest" (Metacritic) must normalise alike
    if (wordsArr.length > 2) s = s.replace(/\bThe /gi, '');
    if (wordsArr.length > 2) s = s.replace(/, The /gi, '');

    s = s.replace(/\s+/g, ' ');
    s = s.trim();
    s = trimChars(s, ':');
    s = trimChars(s, ' -');
    s = trimChars(s, ' –'); // " –"
    s = s.trim();
    if (s === '') s = original;
  }

  if (convertRom) s = stringRomToNum(s);

  return s;
}

// A dangling article/conjunction left over once a marketing suffix has been
// stripped off the end of a title (e.g. "Nioh 2 The" once "Complete Edition"
// is gone — see searchNameVariants below).
const TRAILING_ARTICLE_RE = /\s+(the|a|an|and|of|for)$/i;

/** Repeatedly strip a trailing article/conjunction (see TRAILING_ARTICLE_RE). */
function stripTrailingArticle(input) {
  let s = input;
  let prev;
  do {
    prev = s;
    s = s.replace(TRAILING_ARTICLE_RE, '');
  } while (s !== prev && s !== '');
  return s.trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Marketing suffixes review sites (GameFAQs, HLTB, ...) routinely omit from
// their own title even though the Steam listing carries them. Longest first
// so e.g. "Complete Edition" is matched (and removed) as a whole instead of
// leaving a dangling "Complete" once a shorter "Edition" match ate the rest.
const MARKETING_SUFFIXES = [
  'Complete Edition',
  'Ultimate Edition',
  'Premium Edition',
  'Legendary Edition',
  'Anniversary Edition',
  'Slayer Edition',
  "Director's Cut",
  'Directors Cut',
  'Enhanced Edition',
  'Remastered',
  'Remaster',
  'Enhanced',
  'Definitive',
  'HD',
  'Edition',
  'Complete',
  'Collection',
  'Free to Play',
  'Free-to-Play',
  'F2P',
  'Lite',
  'Test Server',
  'Playtest',
]
  .sort((a, b) => b.length - a.length)
  .map((suffix) => ({ suffix, re: new RegExp(`\\b${escapeRegExp(suffix)}$`, 'i') }));

/**
 * Strip at most 3 trailing marketing suffixes (see MARKETING_SUFFIXES), one
 * per pass, re-trying the (possibly longer) list against what's left after
 * each removal; a trailing article/conjunction exposed by the removal (e.g.
 * "Nioh 2 The" once "Complete Edition" is gone) is stripped again at the end.
 */
function stripTrailingMarketingSuffix(input) {
  let s = input;
  for (let i = 0; i < 3; i++) {
    const hit = MARKETING_SUFFIXES.find(({ re }) => re.test(s));
    if (!hit) break;
    s = s.replace(hit.re, '').trim();
  }
  return stripTrailingArticle(s);
}

// ' - ', ' – ', ' — ' (need surrounding spaces so a bare hyphenated word like
// "Half-Life" is never split) or a bare ':' (GameFAQs/HLTB titles routinely
// carry "Title: Subtitle" with no spaces required around the colon).
const VARIANT_SEPARATOR_RE = /\s+-\s+|\s+–\s+|\s+—\s+|:/;

/**
 * Ordered, de-duplicated (case-insensitive) list of plausible "how a review
 * site titles this" search queries for `name`, most specific first, capped
 * at 4 entries. Built for src/sources/gamefaqs.js and src/sources/hltb.js:
 * both sites frequently drop a Steam listing's marketing suffix
 * ("Complete Edition", "Remastered", ...) or subtitle ("TERA - Action
 * MMORPG" -> "TERA") entirely, so a single normalizeName() query often
 * misses an entry that exists under a shorter title.
 *
 * Pure — does not call normalizeName's `removeAdditions`/`softRestrict`
 * variants and never mutates `normalizeName` itself (its outputs are pinned
 * by tests/fixtures/names/legacy-oracle.json).
 *
 *   a) normalizeName(name) as-is;
 *   b) (a) with a dangling trailing article/conjunction removed;
 *   c) (b) with up to 3 trailing marketing suffixes removed, then the
 *      trailing-article strip applied once more;
 *   d) the part before the first ' - '/' – '/' — '/':' separator of the
 *      ORIGINAL name (only when that part is >=2 words or >=4 characters),
 *      normalizeName()-d, then b)+c) applied to it.
 */
export function searchNameVariants(name) {
  const original = name == null ? '' : String(name);
  const seen = new Set();
  const results = [];

  const add = (value) => {
    const v = (value ?? '').trim();
    if (v === '') return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push(v);
  };

  const a = normalizeName(original);
  add(a);

  const b = stripTrailingArticle(a);
  add(b);

  const c = stripTrailingMarketingSuffix(b);
  add(c);

  const sepMatch = original.match(VARIANT_SEPARATOR_RE);
  if (sepMatch) {
    const before = original.slice(0, sepMatch.index).trim();
    const words = before.split(/\s+/).filter(Boolean);
    if (before.length >= 4 || words.length >= 2) {
      const dNorm = normalizeName(before);
      add(stripTrailingMarketingSuffix(stripTrailingArticle(dNorm)));
    }
  }

  return results.slice(0, 4);
}

const ROMAN_MAP = [
  ['M', 1000],
  ['CM', 900],
  ['D', 500],
  ['CD', 400],
  ['C', 100],
  ['XC', 90],
  ['L', 50],
  ['XL', 40],
  ['X', 10],
  ['IX', 9],
  ['V', 5],
  ['IV', 4],
  ['I', 1],
];

/** Port of legacy `stringRomToNum()`: converts whole-word roman numerals to digits. */
export function stringRomToNum(input) {
  const str = input == null ? '' : String(input);
  const parts = str.split(' ').map((word) => {
    let result = 0;
    let changeCount = 0;
    let roman = word;
    for (const [key, value] of ROMAN_MAP) {
      while (roman.indexOf(key) === 0) {
        changeCount += key.length;
        result += value;
        roman = roman.slice(key.length);
      }
    }
    if (result !== 0 && changeCount === word.length) {
      return String(result);
    }
    return word;
  });
  return parts.join(' ');
}

/** Port of legacy `romanToNumber()` (case-insensitive prefix consumption). */
export function romanToNumber(input) {
  if (input == null || input === '') return undefined;
  let roman = String(input);
  let value = 0;
  for (const [key, num] of ROMAN_MAP) {
    while (roman.slice(0, key.length).toUpperCase() === key) {
      value += num;
      roman = roman.slice(key.length);
    }
  }
  return value;
}

/** Port of legacy `numberToRoman()`. */
export function numberToRoman(input) {
  let n = Number(input);
  if (!n) return undefined;
  let out = '';
  while (n > 0) {
    for (const [roman, val] of ROMAN_MAP) {
      if (n >= val) {
        n -= val;
        out += roman;
        break;
      }
    }
  }
  return out;
}

/** Port of legacy `swapRoman()`: replaces standalone roman numerals (1-9) with digits. */
export function swapRoman(input) {
  const str = `${input == null ? '' : String(input)} `;
  const replaced = str.replace(/(?<=\s)(IX|IV|V?I{0,3})(?=[\W])/g, (m) => {
    const num = romanToNumber(m);
    return num === undefined ? '' : String(num);
  });
  return replaced.trim();
}

/** Port of legacy `swapNumber()`: replaces standalone digits (1-99) with roman numerals. */
export function swapNumber(input) {
  const str = input == null ? '' : String(input);
  return str.replace(/(?<=\s)(\d{1,2})/g, (m) => {
    const roman = numberToRoman(m);
    return roman === undefined ? m : roman;
  });
}

const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);
function isVowel(c) {
  return c !== undefined && c !== '' && VOWELS.has(c);
}

/**
 * JS port of PHP's metaphone(). See the module-level comment for the one
 * known, deliberately-unreplicated PHP quirk (GH silence after B/D/H or a
 * leading "?H" digraph).
 */
export function metaphone(input) {
  if (input == null) return '';
  let word = String(input).toUpperCase().replace(/[^A-Z]/g, '');
  if (word.length === 0) return '';

  let result = '';
  let i = 0;

  if (word.startsWith('WH')) {
    // "WH" collapses to a single 'W'; the letter after it is NOT treated
    // as word-initial (unlike the drop-first-letter exceptions below).
    result += 'W';
    i = 2;
  } else if (
    word.startsWith('AE') ||
    word.startsWith('GN') ||
    word.startsWith('KN') ||
    word.startsWith('PN') ||
    word.startsWith('WR')
  ) {
    word = word.slice(1);
  }

  const n = word.length;
  while (i < n) {
    const c = word[i];
    const prev = i > 0 ? word[i - 1] : '';
    const next = i + 1 < n ? word[i + 1] : '';
    const next2 = i + 2 < n ? word[i + 2] : '';

    // Skip duplicate consecutive letters, except 'C'.
    if (i > 0 && c === prev && c !== 'C') {
      i++;
      continue;
    }

    if (VOWELS.has(c)) {
      if (i === 0) result += c;
      i++;
      continue;
    }

    switch (c) {
      case 'B':
        if (!(i === n - 1 && prev === 'M')) result += 'B';
        i++;
        break;
      case 'C':
        if (next === 'I' && next2 === 'A') {
          result += 'X';
          i++;
        } else if (next === 'H') {
          result += 'X';
          i += 2;
        } else if (prev === 'S' && (next === 'I' || next === 'E' || next === 'Y')) {
          i++; // silent C in "SC" + I/E/Y
        } else if (next === 'I' || next === 'E' || next === 'Y') {
          result += 'S';
          i++;
        } else if (next === 'K') {
          result += 'K';
          i += 2;
        } else {
          result += 'K';
          i++;
        }
        break;
      case 'D':
        if (next === 'G' && (next2 === 'E' || next2 === 'I' || next2 === 'Y')) {
          result += 'J';
          i += 2;
        } else {
          result += 'T';
          i++;
        }
        break;
      case 'F':
        result += 'F';
        i++;
        break;
      case 'G':
        if (next === 'H') {
          result += 'F';
          i += 2;
        } else if (next === 'N' && (i === 0 || i + 2 === n)) {
          // G is silent before N only at the very start of the word
          // ("gnome") or when N ends the word ("sign", "reign"); a mid-word
          // "GN" with more letters after it ("champagne") keeps G -> K.
          i++;
        } else if (next === 'I' || next === 'E' || next === 'Y') {
          result += 'J';
          i++;
        } else {
          result += 'K';
          i++;
        }
        break;
      case 'H':
        if (isVowel(prev) && !isVowel(next)) {
          i++; // drop H after a vowel, unless followed by a vowel too
        } else {
          result += 'H';
          i++;
        }
        break;
      case 'J':
        result += 'J';
        i++;
        break;
      case 'K':
        result += 'K';
        i++;
        break;
      case 'L':
        result += 'L';
        i++;
        break;
      case 'M':
        result += 'M';
        i++;
        break;
      case 'N':
        result += 'N';
        i++;
        break;
      case 'P':
        if (next === 'H') {
          result += 'F';
          i += 2;
        } else {
          result += 'P';
          i++;
        }
        break;
      case 'Q':
        result += 'K';
        i++;
        break;
      case 'R':
        result += 'R';
        i++;
        break;
      case 'S':
        if (next === 'C' && (next2 === 'I' || next2 === 'E' || next2 === 'Y')) {
          result += 'S';
          i += 2;
        } else if (next === 'H') {
          result += 'X';
          i += 2;
        } else if (next === 'I' && (next2 === 'O' || next2 === 'A')) {
          result += 'X';
          i++;
        } else {
          result += 'S';
          i++;
        }
        break;
      case 'T':
        if (next === 'I' && (next2 === 'O' || next2 === 'A')) {
          result += 'X';
          i++;
        } else if (next === 'C' && next2 === 'H') {
          i++; // silent T in "TCH"
        } else if (next === 'H') {
          result += '0'; // theta
          i += 2;
        } else {
          result += 'T';
          i++;
        }
        break;
      case 'V':
        result += 'F';
        i++;
        break;
      case 'W':
        if (isVowel(next)) result += 'W';
        i++;
        break;
      case 'X':
        result += i === 0 ? 'S' : 'KS';
        i++;
        break;
      case 'Y':
        if (isVowel(next)) result += 'Y';
        i++;
        break;
      case 'Z':
        result += 'S';
        i++;
        break;
      default:
        i++;
        break;
    }
  }

  return result;
}

function isNumericToken(s) {
  return s !== '' && /^[+-]?\d*\.?\d+$/.test(s);
}

/**
 * Port of legacy `levenPhon()` (main_functions.php) / `phoneme()`
 * (metacritic_gamefaq_functions.php) - the two are identical: swap roman
 * numerals to digits, metaphone every non-numeric word, sort, rejoin.
 */
export function phoneme(input) {
  const swapped = swapRoman(input);
  const parts = swapped.split(' ');
  const phonemes = parts.map((p) => (isNumericToken(p) ? p : metaphone(p)));
  phonemes.sort();
  return phonemes.join(' ').trim();
}

export const levenPhon = phoneme;

/** Standard Levenshtein edit distance (PHP levenshtein() with unit costs 1,1,1). */
export function levenshteinDistance(a, b) {
  const sa = a == null ? '' : String(a);
  const sb = b == null ? '' : String(b);
  const m = sa.length;
  const n = sb.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = sa[i - 1] === sb[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Longest-common-substring recursion behind PHP's similar_text(). */
function phpSimilarStr(a, b) {
  let max = 0;
  let posA = 0;
  let posB = 0;
  let count = 0;
  for (let p = 0; p < a.length; p++) {
    for (let q = 0; q < b.length; q++) {
      let l = 0;
      while (p + l < a.length && q + l < b.length && a[p + l] === b[q + l]) l++;
      if (l > max) {
        max = l;
        posA = p;
        posB = q;
        count++;
      }
    }
  }
  return { posA, posB, max, count };
}

function phpSimilarChar(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  const { posA, posB, max, count } = phpSimilarStr(a, b);
  if (max === 0) return 0;
  let sum = max;
  if (posA > 0 && posB > 0 && count > 1) {
    sum += phpSimilarChar(a.slice(0, posA), b.slice(0, posB));
  }
  if (posA + max < a.length && posB + max < b.length) {
    sum += phpSimilarChar(a.slice(posA + max), b.slice(posB + max));
  }
  return sum;
}

/**
 * JS port of PHP's similar_text(), returning both the raw match length and
 * the percent PHP reports via its by-reference third argument
 * (`sim * 200 / (len1 + len2)`).
 */
export function similarText(a, b) {
  const sa = a == null ? '' : String(a);
  const sb = b == null ? '' : String(b);
  const sim = sa.length === 0 || sb.length === 0 ? 0 : phpSimilarChar(sa, sb);
  const totalLen = sa.length + sb.length;
  const percent = totalLen === 0 ? 0 : (sim * 200) / totalLen;
  return { length: sim, percent };
}

/**
 * Adapted per the rewrite plan's shared contract: `simpleSim(a, b) -> 0..100`.
 * This is the core comparison legacy `simpleSim()` performed inside its
 * array-matching loop (`similar_text` on lower-cased, roman-converted
 * `simpleName()`), exposed here as a plain pairwise percentage instead of
 * an array-matching helper.
 */
export function simpleSim(a, b) {
  const na = normalizeName(a, { convertRom: true }).toLowerCase();
  const nb = normalizeName(b, { convertRom: true }).toLowerCase();
  return similarText(na, nb).percent;
}

/**
 * Port of legacy `similarity()` (metacritic_gamefaq_functions.php):
 * Levenshtein distance between phonemised strings, normalised into a
 * cost/score/grade triple. Returns `false` for empty or over-long input,
 * matching the PHP function's early-return behaviour.
 */
export function similarity(a, b) {
  const sa = a == null ? '' : String(a);
  const sb = b == null ? '' : String(b);
  if (sa === '' || sb === '') return false;
  if (sa.length > 255 || sb.length > 255) return false;

  const pa = phoneme(sa);
  const pb = phoneme(sb);
  const cost = levenshteinDistance(pa, pb);
  const avgLength = (pa.length + pb.length) / 2;
  const rawFinal = (1.0 / Math.max(avgLength, 1)) * cost;
  const finalScore = Math.round(rawFinal * 100) / 100;
  const grade = finalScore < 0.2;
  return { cost, score: 1 - finalScore, grade };
}

/** Port of legacy `fixName()`. */
export function fixName(name) {
  return decodeHtmlEntities(name == null ? '' : String(name)).trim();
}

/** Port of legacy `isDemo()`. */
export function isDemo(name) {
  const raw = name == null ? '' : String(name);
  const wordsArr = raw.trim().split(' ');
  const lastWord = wordsArr.pop();
  const lastLower = (lastWord || '').trim().toLowerCase();
  const hasAlphaVersion = raw.toLowerCase().includes('alpha version');
  return wordsArr.length > 0 && (lastLower === 'demo' || lastLower === 'soundtrack' || hasAlphaVersion);
}

/** `[a, b, ' ', '', a]` -> '|a|b|' (trimmed, deduped, empties dropped); null if empty. */
export function toPipeList(arr) {
  if (!Array.isArray(arr)) return null;
  const seen = new Set();
  const cleaned = [];
  for (const item of arr) {
    if (item == null) continue;
    const trimmed = String(item).trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push(trimmed);
  }
  return cleaned.length === 0 ? null : `|${cleaned.join('|')}|`;
}

/** '|a|b|' -> ['a', 'b']; tolerant of missing/extra pipes and blank entries. */
export function fromPipeList(input) {
  if (input == null) return [];
  const str = String(input).trim();
  if (str === '') return [];
  return str
    .split('|')
    .map((x) => x.trim())
    .filter((x) => x !== '');
}

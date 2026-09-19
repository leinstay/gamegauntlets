// Pure classifier for `games.non_game` (migrations/004_non_game.sql). Never touches the network or the
// database — src/pipeline/resolve.js calls classifyNonGame() with the resolved name/genres/categories
// plus whatever Steam/GOG "this isn't a plain game" hint it could dig up, and writes the result.
//
// Priority (first hit wins): Steam appdetails `type` > GOG product type > name heuristics > "software
// only" Steam genre set. Hard signals (an actual API-reported type) always beat a name guess; a name
// guess always beats the genre-only fallback, since a real game can legitimately have zero genres.

import { fromPipeList } from './names.js';

// --- 1. Steam appdetails `type` (module comment on src/sources/steam.js's not-a-game branch) -----------

// Steam's own enum (verified against appdetails responses) mapped onto our narrower `non_game` enum.
// `game` (and anything not listed here, e.g. an unrecognised future type) -> null, i.e. "not a hard
// signal either way" - falls through to the name/genre heuristics below.
export const STEAM_TYPE_MAP = {
  dlc: 'dlc',
  music: 'soundtrack',
  video: 'video',
  movie: 'video',
  series: 'video',
  episode: 'video',
  demo: 'demo',
  mod: 'other',
  hardware: 'other',
  advertising: 'other',
  tool: 'tool',
  application: 'tool',
};

function classifyBySteamType(steamType) {
  if (!steamType) return null;
  return STEAM_TYPE_MAP[String(steamType).toLowerCase()] ?? null;
}

// --- 2. GOG product type -------------------------------------------------------------------------------

// src/sources/gog.js's discover() only ever enqueues `productType: in:game,pack` (the catalog filter
// itself), and a kept 'pack' has already passed `isKeepablePack()` there - i.e. by the time a game
// resolves with a 'gog' source_records row, a 'pack' is specifically one GOG sells as the *only*
// purchasable form of a real base game (e.g. "The Witcher 3: Wild Hunt - Complete Edition"), not an
// add-on - isKeepablePack() already dropped the add-on packs before they ever became a source_records
// row at all. So 'pack'/'game' are deliberately NOT treated as non-game signals here; only a genuine
// DLC/extras product type (not reachable through the current catalog filter, but kept for forward
// compatibility / a future wider catalog crawl) is.
export const GOG_TYPE_MAP = {
  dlc: 'dlc',
  extras: 'other',
};

function classifyByGogType(gogType) {
  if (!gogType) return null;
  return GOG_TYPE_MAP[String(gogType).toLowerCase()] ?? null;
}

// --- 3. Name heuristics ---------------------------------------------------------------------------------
//
// Applied to the END of a "clause" of the title, never anywhere inside it, so a real game whose name
// merely *contains* one of these words is never touched: "Demolition Simulator" ends in "Simulator",
// "Demon's Souls" ends in "Souls", "Art of Rally" ends in "Rally", "The Movies"/"Game Dev Tycoon" don't
// end in any of these words at all - none of them match.
//
// A "clause" is the title split first on the top-level separators a store title uses to tack on an
// edition/addon suffix (` - `, `:`, `(`/`)`, `+`), then each of those parts split again on `&`/`and`/`,`/`/`
// so "Artbook & Strategy Guide" is checked as ["Artbook", "Strategy Guide"] rather than as one unmatched
// blob. Every clause is checked independently; the first pattern that matches the *end* of any clause
// wins.
const TOP_LEVEL_SEPARATOR_RE = /\s+-\s+|[():+]/g;
const SUB_CLAUSE_SEPARATOR_RE = /\s*(?:&|\/|,|\band\b)\s*/gi;

function nameClauses(name) {
  const clauses = [];
  for (const part of String(name).split(TOP_LEVEL_SEPARATOR_RE)) {
    const trimmedPart = part.trim();
    if (!trimmedPart) continue;
    for (const sub of trimmedPart.split(SUB_CLAUSE_SEPARATOR_RE)) {
      const trimmedSub = sub.trim();
      if (trimmedSub) clauses.push(trimmedSub);
    }
  }
  return clauses;
}

// `Wallpaper(s)` is ambiguous on its own: as the *entire* title ("Live Waifu Wallpaper", "Cat's Meow Live
// Wallpaper") it's a Wallpaper-Engine-style desktop app, i.e. `tool`; as a suffix split off the end of a
// real game's title ("<Game> - Wallpaper Pack") it's a cosmetic DLC-style extra, i.e. `artbook` (closest
// enum fit for "digital cosmetic bonus content"). `cls` may be a class string or, for this one case, a
// `(ctx) => class` function - `ctx.isWholeTitle` is true only when the whole (pre-`+`) name matched as a
// single clause, i.e. no ` - `/`:`/`(`/`+` split it off a base title at all.
//
// Ordered only for readability otherwise - patterns don't overlap in a way that makes order matter (e.g.
// "Original Game Soundtrack" and bare "Soundtrack" both end in "Soundtrack" and map to the same class).
const NAME_KEYWORD_PATTERNS = [
  { re: /\bDedicated Server\b$/i, cls: 'tool' },
  { re: /\bSDK\b$/i, cls: 'tool' },
  { re: /\bPlaytest\b$/i, cls: 'demo' },
  { re: /\bDemo\b$/i, cls: 'demo' },
  { re: /\bStrategy Guide\b$/i, cls: 'other' },
  { re: /\bSeason Pass\b$/i, cls: 'dlc' },
  { re: /\bExpansion Pass\b$/i, cls: 'dlc' },
  { re: /\bSkin Pack\b$/i, cls: 'dlc' },
  { re: /\bCostume Pack\b$/i, cls: 'dlc' },
  { re: /\bUpgrade Pack\b$/i, cls: 'dlc' },
  { re: /\bSupporter Pack\b$/i, cls: 'dlc' },
  { re: /\bDLC\b$/i, cls: 'dlc' },
  { re: /\bOriginal (?:Game )?Soundtrack\b$/i, cls: 'soundtrack' },
  { re: /\bOriginal Score\b$/i, cls: 'soundtrack' },
  { re: /\bSoundtrack\b$/i, cls: 'soundtrack' },
  { re: /\bOST\b$/i, cls: 'soundtrack' },
  { re: /\bDigital Art(?:book)?\b$/i, cls: 'artbook' },
  { re: /\bArt ?Book\b$/i, cls: 'artbook' },
  { re: /\bWallpapers?\b$/i, cls: (ctx) => (ctx.isWholeTitle ? 'tool' : 'artbook') },
];

function matchKeyword(clauses, isWholeTitle) {
  for (const clause of clauses) {
    for (const { re, cls } of NAME_KEYWORD_PATTERNS) {
      if (re.test(clause)) return typeof cls === 'function' ? cls({ isWholeTitle }) : cls;
    }
  }
  return null;
}

// A trailing "- Game"/": Game" glue word GOG/Steam tack onto a bundle listing's base title before the "+"
// (e.g. "BAD END THEATER - Game + OST") - stripped when extracting the base name below. Deliberately
// requires the leading `:`/`-`, NOT just any whitespace, so a real title that itself ends in "Game" (e.g.
// "Rambo The Video Game") is never touched: there's no `:`/`-` directly before its "Game".
const GAME_SUFFIX_GLUE_RE = /[:-]\s*Game\s*$/i;

// "... Soundtrack and Digital Goods Bundle" (e.g. "We Happy Few - Soundtrack and Digital Goods Bundle") -
// the one bundle shape with no "+" at all, so it needs its own check (bundleBaseName's "+" rule below
// can't see it).
const BUNDLE_DIGITAL_GOODS_RE = /^(.*?)\s*-\s*Soundtrack\s+and\s+Digital\s+Goods\s+Bundle\s*$/i;

/**
 * `bundleBaseName(name) -> the base game's name, or null`. A GOG/Steam listing is often "the base game
 * plus something else" sold as a single product - the "something else" alone (DLC/Soundtrack/Supporter
 * Pack/...) must never make classifyByName() flag the listing as that something else, because very often
 * this IS the only way to buy the base game at all (real false positives fixed here: "KINGDOM HEARTS III
 * + Re Mind (DLC)", "Rambo The Video Game + Baker Team DLC", "Soulstone Survivors + Supporter Pack",
 * "BAD END THEATER - Game + OST", "Chants of Sennaar - Game + OST", "Lysfanga: The Time Shift Warrior +
 * OST", "Sinless + OST", "Twilight Oracle + OST", "Under The Waves + OST", "TUNIC + TUNIC (Original Game
 * Soundtrack)", "We Happy Few - Soundtrack and Digital Goods Bundle" - flagging any of these would have
 * pulled a real, often sole-listing, game out of the wheel).
 *
 * Recognises two shapes:
 *   - "<Base> - Soundtrack and Digital Goods Bundle" (no "+" at all).
 *   - "<Base>[ - Game] + <anything ending in a recognised keyword clause>" - covers a repeated-title
 *     bundle ("TUNIC + TUNIC (...)": base = the part before "+", "TUNIC"), a "Game + OST"-style GOG
 *     bundle edition, and a plain "<Base> + <DLC name> DLC/Pack" listing alike - the exact wording after
 *     the "+" doesn't matter, only that it ends in one of the same name keywords classifyByName() already
 *     recognises.
 *
 * This alone is NOT enough to call something a `bundle` - it only says "this title's shape looks like a
 * base game plus extras"; the caller (classifyByName(), gated by `baseGameExists`) still requires a real
 * separate base-game row to exist in the catalog before actually flagging it, so a title that merely
 * *looks* like this pattern but is genuinely the sole listing (no separate base game row) is left alone.
 */
export function bundleBaseName(name) {
  const trimmed = name == null ? '' : String(name).trim();
  if (!trimmed) return null;

  const digitalGoods = trimmed.match(BUNDLE_DIGITAL_GOODS_RE);
  if (digitalGoods) return digitalGoods[1].trim() || null;

  const plusMatch = trimmed.match(/\s\+\s/);
  if (!plusMatch) return null;
  const before = trimmed.slice(0, plusMatch.index).trim();
  const after = trimmed.slice(plusMatch.index + plusMatch[0].length).trim();
  if (!before || !after) return null;
  const afterClauses = nameClauses(after);
  if (!matchKeyword(afterClauses, afterClauses.length === 1 && afterClauses[0] === after)) return null;

  const base = before.replace(GAME_SUFFIX_GLUE_RE, '').trim();
  return base || null;
}

function classifyByName(name, { baseGameExists } = {}) {
  const trimmed = name == null ? '' : String(name).trim();
  if (!trimmed) return null;

  // Bundle shapes first: a keyword that only shows up after a top-level "+" (or in the "Soundtrack and
  // Digital Goods Bundle" suffix) must never resolve to a raw dlc/soundtrack/artbook verdict below - see
  // bundleBaseName()'s header comment for the false positives this prevents.
  const base = bundleBaseName(trimmed);
  if (base !== null) return baseGameExists === true ? 'bundle' : null;

  // Not a recognised bundle shape: only the portion BEFORE a top-level "+" (or the whole title, when
  // there is none) can drive a verdict by name - matches bundleBaseName()'s own "+" handling above, so a
  // keyword stranded after an unrecognised "+" tail (rare, no known real example) still doesn't fire.
  const plusMatch = trimmed.match(/\s\+\s/);
  const scanTarget = plusMatch ? trimmed.slice(0, plusMatch.index).trim() : trimmed;
  if (!scanTarget) return null;

  const clauses = nameClauses(scanTarget);
  return matchKeyword(clauses, clauses.length === 1 && clauses[0] === scanTarget);
}

// --- 4. "Software only" Steam genre set -----------------------------------------------------------------
//
// Only fires when the game has at least one genre and *every* genre it has is one of these - a real game
// with no genre data at all (extremely common right after the legacy migration, before a catalog source
// has re-crawled it) must NOT be flagged just for having an empty genre list.
const SOFTWARE_ONLY_GENRES = new Set([
  'utilities',
  'video production',
  'audio production',
  'design & illustration',
  'animation & modeling',
  'photo editing',
  'web publishing',
  'software training',
  'accounting',
  'education',
]);

function toGenreList(genres) {
  if (Array.isArray(genres)) return genres.filter((g) => typeof g === 'string' && g.trim() !== '');
  if (typeof genres === 'string') return fromPipeList(genres);
  return [];
}

function classifyByGenresOnly(genres) {
  const list = toGenreList(genres);
  if (list.length === 0) return null;
  return list.every((g) => SOFTWARE_ONLY_GENRES.has(g.trim().toLowerCase())) ? 'tool' : null;
}

/**
 * `classifyNonGame({ name, steamType, gogType, categories, genres, baseGameExists }) -> one of the
 * `games.non_game` enum values, or `null` for "this is a real game". Every input is optional; `genres`/
 * `categories` accept either an array of strings or the `|a|b|` pipe-wrapped column format
 * (src/lib/names.js's toPipeList). `categories` isn't used by any rule yet - accepted for forward
 * compatibility / signature stability with the other inputs, and so a future category-based rule doesn't
 * need every call site updated.
 *
 * `baseGameExists`: only meaningful when `bundleBaseName(name)` is non-null (a "<Base> + <extras>"-shaped
 * title, see its doc comment) - `true` means the caller already confirmed a separate real base-game row
 * exists in `games` for that base name, so this listing is classified `bundle`; anything else (including
 * simply omitting it) leaves such a title unflagged (`null`), since without a confirmed separate base row
 * this is most likely the *only* listing of that game (this classifier is pure and never queries the
 * database itself - src/pipeline/resolve.js and scripts/report-non-games.js do that lookup and pass the
 * result in).
 */
export function classifyNonGame({ name, steamType, gogType, categories, genres, baseGameExists } = {}) {
  void categories; // not used by any current rule - see doc comment above
  return (
    classifyBySteamType(steamType) ??
    classifyByGogType(gogType) ??
    classifyByName(name, { baseGameExists }) ??
    classifyByGenresOnly(genres) ??
    null
  );
}

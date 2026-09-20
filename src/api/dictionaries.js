// GET /api/dictionaries/:field — replaces the legacy per-language static files under
// ajax/json/select/{lang}/*.json. Pipe-list fields (genres, tags, ...) are computed by scanning the
// column and splitting every row's '|a|b|' value; `difficulty` is a plain DISTINCT since it's a
// scalar column; `presets` comes straight from the presets table. Results are cached in memory per
// `field:lang` for 10 minutes — cheap enough given the low write rate of `games`, and avoids
// re-scanning ~110k rows on every settings-page load.
//
// `developers`/`publishers` (84k/71k distinct names) are the exception: shipping the whole list on
// every settings-page load is several MB. Without `q`, the endpoint only returns the top TOP_LIMIT
// names by game count; the rest is reachable through `?q=<text>`, which ranks matches over the FULL
// (cached) list server-side and returns at most SEARCH_LIMIT of them — see searchDictionary() below.
// `q` is ignored for every other field (they're small enough to ship whole, same as before).
//
// NEEDS REVIEW: `name` (the display label) currently just mirrors `value` (except for `presets`, whose
// `name` is the preset's real display name) — translating dictionary values into ru/de/fr belongs to
// the frontend i18n files (public/i18n/*.json, owned by T3/T19), not this endpoint. `lang` is accepted
// and used as part of the cache key so wiring real translations in later is a localized change, but
// until then this endpoint returns the same `name` for every lang.

import { SUPPORTED } from '../lib/languages.js';

const PIPE_LIST_FIELDS = new Set(['genres', 'tags', 'categories', 'languages', 'voiceovers', 'developers', 'publishers']);
const VALID_FIELDS = new Set([...PIPE_LIST_FIELDS, 'difficulty', 'presets']);

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // key `${field}:${lang}` -> { at, data: [{ value, name, count? }] }

// Test-only escape hatch (see src/api/stats.js's `_resetCacheForTests` for the same pattern) so
// tests/api/misc.test.js can exercise more than one /api/dictionaries/developers|publishers scenario
// without an earlier test's 10-minute cache leaking into a later one.
export function _resetCacheForTests() {
  cache.clear();
}

// Developers/publishers are tens of thousands of names, most with a single obscure game: alphabetical order put
// junk like "!CyberApps" first. They are ordered by how many games they have (ties alphabetical) so the studios
// people actually look for come first; the short lists (genres, tags, ...) stay alphabetical.
//
// These are also the two fields whose spellings get case-merged (see mergeCaseInsensitiveSpellings()) and
// are searchable/top-limited by the route below — all three behaviours only make sense together (there's
// no point merging "8floor"/"8FLOOR" and then still shipping every other obscure spelling verbatim).
const SORT_BY_GAME_COUNT = new Set(['developers', 'publishers']);

const TOP_LIMIT = 2000;
const SEARCH_LIMIT = 50;

// trim + collapse inner whitespace + Unicode-normalise + lower-case, so "8floor", "8FLOOR" and
// "8  Floor" (stray double space) all fold to the same group/search key.
function normalizeKey(value) {
  return String(value).trim().replace(/\s+/g, ' ').normalize('NFKC').toLowerCase();
}

function lowerCaseLetterCount(value) {
  let n = 0;
  for (const ch of value) if (/\p{Ll}/u.test(ch)) n++;
  return n;
}

// Tie-break rule for which exact spelling represents a case-merged group: most games first, then the
// spelling with more lower-case letters (so "8floor" beats "8FLOOR" on an otherwise-tied count), then
// alphabetically first for full determinism.
function isBetterSpelling(candidate, candidateCount, current, currentCount) {
  if (candidateCount !== currentCount) return candidateCount > currentCount;
  const candidateLower = lowerCaseLetterCount(candidate);
  const currentLower = lowerCaseLetterCount(current);
  if (candidateLower !== currentLower) return candidateLower > currentLower;
  return candidate.localeCompare(current) < 0;
}

// Groups exact spellings by their normalised key ("8floor" and "8FLOOR" merge into one entry), summing
// their game counts and picking the group's most frequent spelling as the display/filter value (see
// isBetterSpelling() for the tie-break). `spellingsBySpelling` is a Map<normalizedKey, Map<spelling, count>>.
function mergeCaseInsensitiveSpellings(spellingCountsByKey) {
  const merged = [];
  for (const spellings of spellingCountsByKey.values()) {
    let total = 0;
    let bestSpelling = null;
    let bestCount = 0;
    for (const [spelling, count] of spellings) {
      total += count;
      if (bestSpelling === null || isBetterSpelling(spelling, count, bestSpelling, bestCount)) {
        bestSpelling = spelling;
        bestCount = count;
      }
    }
    merged.push({ value: bestSpelling, count: total });
  }
  return merged.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

async function loadPipeListValues(db, column) {
  const rows = await db.query(
    `SELECT ${column} AS v FROM games WHERE ${column} IS NOT NULL AND ${column} <> '' AND non_game IS NULL AND purchasable = 1`,
  );

  if (SORT_BY_GAME_COUNT.has(column)) {
    const spellingCountsByKey = new Map();
    for (const row of rows) {
      for (const spelling of new Set(String(row.v).split('|').map((x) => x.trim()).filter(Boolean))) {
        const key = normalizeKey(spelling);
        let spellings = spellingCountsByKey.get(key);
        if (!spellings) spellingCountsByKey.set(key, (spellings = new Map()));
        spellings.set(spelling, (spellings.get(spelling) || 0) + 1);
      }
    }
    return mergeCaseInsensitiveSpellings(spellingCountsByKey);
  }

  const counts = new Map();
  for (const row of rows) {
    for (const part of new Set(String(row.v).split('|').map((x) => x.trim()).filter(Boolean))) {
      counts.set(part, (counts.get(part) || 0) + 1);
    }
  }
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  return names.map((v) => ({ value: v, count: counts.get(v) }));
}

async function loadDifficultyValues(db) {
  const rows = await db.query(
    "SELECT DISTINCT difficulty AS v FROM games WHERE difficulty IS NOT NULL AND difficulty <> '' AND non_game IS NULL AND purchasable = 1 ORDER BY difficulty",
  );
  return rows.map((row) => ({ value: row.v, name: row.v }));
}

async function loadPresets(db) {
  const rows = await db.query('SELECT id, name FROM presets ORDER BY sort_order ASC, name ASC');
  return rows.map((row) => ({ value: row.id, name: row.name }));
}

async function loadFullList(db, field) {
  if (field === 'presets') return loadPresets(db);
  if (field === 'difficulty') return loadDifficultyValues(db);
  return (await loadPipeListValues(db, field)).map((v) => ({ value: v.value, name: v.value, count: v.count }));
}

// Ranks the full cached list against `q` (normalised the same way as the merge keys): exact match
// first, then "starts with", then "some word starts with" (word-boundary match, e.g. "path" finds
// "Hidden Path" but not "Valve" — checked after the plain prefix case so it doesn't re-rank first-word
// prefix matches), then plain substring — each rank ordered by game count, ties broken alphabetically.
// Never touches the DB: `list` is whatever is already sitting in the 10-minute cache.
function searchDictionary(list, q) {
  const nq = normalizeKey(q);
  if (!nq) return [];
  const scored = [];
  for (const item of list) {
    const nv = normalizeKey(item.value);
    let rank;
    if (nv === nq) rank = 0;
    else if (nv.startsWith(nq)) rank = 1;
    else if (nv.split(' ').some((word) => word.startsWith(nq))) rank = 2;
    else if (nv.includes(nq)) rank = 3;
    else continue;
    scored.push({ item, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || (b.item.count || 0) - (a.item.count || 0) || a.item.value.localeCompare(b.item.value));
  return scored.slice(0, SEARCH_LIMIT).map((s) => s.item);
}

function toResponse(item) {
  return { value: item.value, name: item.name };
}

// `lang`'s enum is built per-app from `config.json` site.languages (see dictionariesRoutes() below)
// instead of being hardcoded, so every configured UI language can be requested.
function buildParamsSchema(languages) {
  return {
    params: {
      type: 'object',
      additionalProperties: false,
      required: ['field'],
      properties: { field: { type: 'string' } },
    },
    querystring: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lang: { type: 'string', enum: languages },
        // Only meaningful for developers/publishers (see searchDictionary()); every other field
        // ignores it. Not required — omitting it (or, from the frontend, never sending it while the
        // search box is empty) means "give me the top list".
        q: { type: 'string', minLength: 1, maxLength: 64 },
      },
    },
  };
}

export default async function dictionariesRoutes(app) {
  const languages = Array.isArray(app.appConfig?.site?.languages) && app.appConfig.site.languages.length
    ? app.appConfig.site.languages
    : SUPPORTED;
  const paramsSchema = buildParamsSchema(languages);

  app.get('/dictionaries/:field', { schema: paramsSchema }, async (req, reply) => {
    const { field } = req.params;
    if (!VALID_FIELDS.has(field)) {
      reply.code(404);
      return { error: 'unknown_field' };
    }
    const lang = req.query.lang || 'en';
    const cacheKey = `${field}:${lang}`;
    let cached = cache.get(cacheKey);
    if (!cached || Date.now() - cached.at >= CACHE_TTL_MS) {
      cached = { at: Date.now(), data: await loadFullList(app.db, field) };
      cache.set(cacheKey, cached);
    }

    const searchable = SORT_BY_GAME_COUNT.has(field);
    if (searchable && req.query.q !== undefined) {
      return searchDictionary(cached.data, req.query.q).map(toResponse);
    }
    if (searchable) {
      return cached.data.slice(0, TOP_LIMIT).map(toResponse);
    }
    return cached.data.map(toResponse);
  });
}

// GET /api/dictionaries/:field — replaces the legacy per-language static files under
// ajax/json/select/{lang}/*.json. Pipe-list fields (genres, tags, ...) are computed by scanning the
// column and splitting every row's '|a|b|' value; `difficulty` is a plain DISTINCT since it's a
// scalar column; `presets` comes straight from the presets table. Results are cached in memory per
// `field:lang` for 10 minutes — cheap enough given the low write rate of `games`, and avoids
// re-scanning ~110k rows on every settings-page load.
//
// NEEDS REVIEW: `name` (the display label) currently just mirrors `value` — translating dictionary
// values into ru/de/fr belongs to the frontend i18n files (public/i18n/*.json, owned by T3/T19), not
// this endpoint. `lang` is accepted and used as part of the cache key so wiring real translations in
// later is a localized change, but until then this endpoint returns the same `name` for every lang.

import { SUPPORTED } from '../lib/languages.js';

const PIPE_LIST_FIELDS = new Set(['genres', 'tags', 'categories', 'languages', 'voiceovers', 'developers', 'publishers']);
const VALID_FIELDS = new Set([...PIPE_LIST_FIELDS, 'difficulty', 'presets']);

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // key `${field}:${lang}` -> { at, data }

// Developers/publishers are tens of thousands of names, most with a single obscure game: alphabetical order put
// junk like "!CyberApps" first. They are ordered by how many games they have (ties alphabetical) so the studios
// people actually look for come first; the short lists (genres, tags, ...) stay alphabetical.
const SORT_BY_GAME_COUNT = new Set(['developers', 'publishers']);

async function loadPipeListValues(db, column) {
  const rows = await db.query(
    `SELECT ${column} AS v FROM games WHERE ${column} IS NOT NULL AND ${column} <> '' AND non_game IS NULL AND purchasable = 1`,
  );
  const counts = new Map();
  for (const row of rows) {
    for (const part of new Set(String(row.v).split('|').map((x) => x.trim()).filter(Boolean))) {
      counts.set(part, (counts.get(part) || 0) + 1);
    }
  }
  const names = [...counts.keys()];
  if (SORT_BY_GAME_COUNT.has(column)) {
    return names.sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
  }
  return names.sort((a, b) => a.localeCompare(b));
}

async function loadDifficultyValues(db) {
  const rows = await db.query(
    "SELECT DISTINCT difficulty AS v FROM games WHERE difficulty IS NOT NULL AND difficulty <> '' AND non_game IS NULL AND purchasable = 1 ORDER BY difficulty",
  );
  return rows.map((row) => row.v);
}

async function loadPresets(db) {
  return db.query('SELECT id, name FROM presets ORDER BY sort_order ASC, name ASC');
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
      properties: { lang: { type: 'string', enum: languages } },
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
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

    let data;
    if (field === 'presets') {
      data = (await loadPresets(app.db)).map((row) => ({ value: row.id, name: row.name }));
    } else if (field === 'difficulty') {
      data = (await loadDifficultyValues(app.db)).map((v) => ({ value: v, name: v }));
    } else {
      data = (await loadPipeListValues(app.db, field)).map((v) => ({ value: v, name: v }));
    }

    cache.set(cacheKey, { at: Date.now(), data });
    return data;
  });
}

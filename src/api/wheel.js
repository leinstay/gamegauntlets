// POST /api/wheel, /api/wheel/random, /api/wheel/marbles — the game-selection endpoints (legacy
// ajax/scripts/gateway.php). Every roll (including marbles) logs one roll_log row.

import { randomInt } from 'node:crypto';

import { buildWheelQuery, regionAvailabilityCondition } from '../lib/wheel-query.js';
import { toGameCard } from '../lib/game-card.js';
import { getOwnedGames } from '../lib/steam-openid.js';
import { SUPPORTED } from '../lib/languages.js';

const WHEEL_RATE_LIMIT = { max: 60, timeWindow: '1 minute' };
const MARBLES_MAX = 100;

const listFilter = { type: 'array', items: { type: 'string', minLength: 1, maxLength: 128 }, maxItems: 16 };
const filterGroup = {
  type: 'object',
  additionalProperties: false,
  properties: {
    genres: listFilter,
    tags: listFilter,
    categories: listFilter,
    languages: listFilter,
    voiceovers: listFilter,
    developers: listFilter,
    publishers: listFilter,
    difficulty: listFilter,
  },
};
const numberRange = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
const releasedRange = {
  type: 'array',
  items: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
  minItems: 2,
  maxItems: 2,
};
const filtersSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    include: filterGroup,
    exclude: filterGroup,
    price: { anyOf: [{ type: 'null' }, numberRange] },
    score: { anyOf: [{ type: 'null' }, numberRange] },
    length: { anyOf: [{ type: 'null' }, numberRange] },
    released: { anyOf: [{ type: 'null' }, releasedRange] },
    steamLibrary: { type: 'boolean' },
    allowEmpty: { type: 'boolean' },
    cisPrices: { type: 'boolean' },
    preset: { anyOf: [{ type: 'null' }, { type: 'integer' }] },
    names: { anyOf: [{ type: 'null' }, { type: 'array', items: { type: 'integer' }, maxItems: 16 }] },
  },
};

// NOTE: `{ type: 'null' }` must come FIRST in every anyOf: Fastify's AJV runs with coerceTypes, and an
// earlier integer/array branch would coerce a JSON null into 0 / [null] before the null branch is tried.
// `lang`'s enum is built per-app from `config.json` site.languages (see wheelRoutes() below) instead
// of being hardcoded here, so every configured UI language can be requested.
function buildWheelBodySchema(languages) {
  return {
    body: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lang: { type: 'string', enum: languages },
        segments: { type: 'integer', minimum: 1, maximum: 16 },
        filters: filtersSchema,
      },
    },
  };
}

function buildRandomBodySchema(languages) {
  return {
    body: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lang: { type: 'string', enum: languages },
        cisPrices: { type: 'boolean' },
      },
    },
  };
}

/** Fisher-Yates, stopping after `count` swaps: O(count) instead of shuffling the whole array. */
function samplePartialShuffle(ids, count) {
  const arr = ids.slice();
  const take = Math.min(count, arr.length);
  for (let i = 0; i < take; i++) {
    const j = i + randomInt(arr.length - i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, take);
}

/** Full Fisher-Yates shuffle with crypto.randomInt. */
function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Sample up to `segments` unique ids, then pad by cycling through the sampled set (with
 * repeats) until the result has exactly `segments` entries — mirrors legacy gateway.php's
 * "fill the wheel even when fewer distinct games matched the filter" behaviour. Returns [] when
 * `ids` is empty (callers must have already handled the 'empty' case before calling this).
 */
function sampleForWheel(ids, segments) {
  const selected = samplePartialShuffle(ids, segments);
  if (selected.length === 0) return [];
  const padded = selected.slice();
  let i = 0;
  while (padded.length < segments) {
    padded.push(selected[i % selected.length]);
    i++;
  }
  return shuffle(padded);
}

function clampSegments(config, requested) {
  const cfg = config?.wheel || {};
  const min = cfg.minSegments ?? 1;
  const max = cfg.maxSegments ?? 16;
  const value = requested ?? cfg.defaultSegments ?? 12;
  return Math.min(max, Math.max(min, value));
}

async function fetchGamesById(db, ids) {
  const byId = new Map();
  if (ids.length === 0) return byId;
  const placeholders = ids.map(() => '?').join(', ');
  const [rows, linkRows] = await Promise.all([
    db.query(`SELECT * FROM games WHERE id IN (${placeholders})`, ids),
    db.query(`SELECT game_id, source, url FROM game_links WHERE game_id IN (${placeholders})`, ids),
  ]);
  const linksByGame = new Map();
  for (const link of linkRows) {
    if (!linksByGame.has(link.game_id)) linksByGame.set(link.game_id, []);
    linksByGame.get(link.game_id).push({ source: link.source, url: link.url });
  }
  for (const row of rows) byId.set(row.id, { row, links: linksByGame.get(row.id) || [] });
  return byId;
}

async function logRoll(db, { source, gameIds, steamid, ip }) {
  await db.query('INSERT INTO roll_log (source, game_ids, steamid, ip) VALUES (?, ?, ?, ?)', [
    source,
    gameIds.join(', '),
    steamid ?? null,
    ip,
  ]);
}

/**
 * `filters.steamLibrary` arrives from the client as a boolean ("only games I own"). This resolves it
 * against the *session's* steamid (never a client-supplied one — that would let anyone read anyone
 * else's library) into the array of owned appids buildWheelQuery expects, or reports the Steam
 * privacy error so the route can short-circuit with `{ error: 'privacy' }`.
 */
async function resolveSteamLibrary(app, req, filters) {
  if (filters?.steamLibrary !== true) return { filters, error: null };

  const steamid = req.ggSession?.steamid;
  if (!steamid) {
    // NEEDS REVIEW: not logged in but steamLibrary was requested. The frontend is expected to only
    // ever send this when logged in; rather than error out we just drop the filter so the roll still
    // completes unfiltered by library ownership.
    const { steamLibrary, ...rest } = filters;
    return { filters: rest, error: null };
  }

  const result = await getOwnedGames(steamid, { apiKey: app.appEnv.STEAM_API_KEY, fetch: app.doFetch });
  if (result.error) return { filters, error: result.error };
  return { filters: { ...filters, steamLibrary: result.appids }, error: null };
}

export default async function wheelRoutes(app) {
  const languages = Array.isArray(app.appConfig?.site?.languages) && app.appConfig.site.languages.length
    ? app.appConfig.site.languages
    : SUPPORTED;
  const wheelBodySchema = buildWheelBodySchema(languages);
  const randomBodySchema = buildRandomBodySchema(languages);

  app.post('/wheel', { schema: wheelBodySchema, config: { rateLimit: WHEEL_RATE_LIMIT } }, async (req) => {
    const lang = req.body.lang || req.ggSession?.lang || 'en';
    const segments = clampSegments(app.appConfig, req.body.segments);
    const rawFilters = req.body.filters || {};
    // Defence in depth (owner's rule, "Goal B": CIS prices only ever apply to Russian) - the frontend
    // already only ever sends cisPrices=true when lang is ru (public/js/pgwheel.js cisPricesEnabled()),
    // but a non-ru request must never get the CIS-region SQL branch even if it lies about this flag.
    const cisPrices = lang === 'ru' && !!rawFilters.cisPrices;

    const { filters, error } = await resolveSteamLibrary(app, req, rawFilters);
    if (error) return { error };

    const { sql, params } = buildWheelQuery(filters, { lang, cisPrices, config: app.appConfig });
    const idRows = await app.db.query(sql, params);
    const allIds = idRows.map((r) => r.id);
    if (allIds.length === 0) return { error: 'empty' };

    const finalIds = sampleForWheel(allIds, segments);
    const byId = await fetchGamesById(app.db, [...new Set(finalIds)]);
    const games = finalIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((entry) => toGameCard(entry.row, entry.links, { lang, cisPrices }));

    const source = Array.isArray(rawFilters.names) && rawFilters.names.length > 0 ? 'direct' : 'web';
    await logRoll(app.db, { source, gameIds: finalIds, steamid: req.ggSession?.steamid, ip: req.ip });

    return { games };
  });

  app.post('/wheel/random', { schema: randomBodySchema, config: { rateLimit: WHEEL_RATE_LIMIT } }, async (req) => {
    const lang = req.body?.lang || req.ggSession?.lang || 'en';
    // Same defence in depth as /wheel above.
    const cisPrices = lang === 'ru' && !!req.body?.cisPrices;

    // Same base conditions as buildWheelQuery() (src/lib/wheel-query.js): steam_delisted/non_game/
    // purchasable, plus the regional-availability filter (legacy gateway.php lines ~160-166) - this route
    // has its own hand-written SQL (the MIN/MAX-id random trick below isn't expressible through
    // buildWheelQuery()'s filter object), so it must apply the same conditions independently.
    const region = regionAvailabilityCondition(lang, cisPrices);
    const baseConditions = ['steam_delisted = 0', 'non_game IS NULL', 'purchasable = 1'];
    if (region) baseConditions.push(region);
    const baseWhere = baseConditions.join(' AND ');

    const bounds = await app.db.one(`SELECT MIN(id) AS lo, MAX(id) AS hi FROM games WHERE ${baseWhere}`);
    if (!bounds || bounds.lo == null) return { error: 'empty' };

    // Same trick as legacy: pick a random id within [MIN,MAX] and take the first row at or after
    // it, instead of ORDER BY RAND() LIMIT 1 over the whole table. Falls back to the first row when
    // the random id lands past the last surviving one (gaps from deleted/delisted/non-game rows).
    const pick = randomInt(Number(bounds.lo), Number(bounds.hi) + 1);
    let row = await app.db.one(`SELECT * FROM games WHERE id >= ? AND ${baseWhere} ORDER BY id ASC LIMIT 1`, [pick]);
    if (!row) row = await app.db.one(`SELECT * FROM games WHERE ${baseWhere} ORDER BY id ASC LIMIT 1`);
    if (!row) return { error: 'empty' };

    const links = await app.db.query('SELECT source, url FROM game_links WHERE game_id = ?', [row.id]);
    const game = toGameCard(row, links, { lang, cisPrices });

    await logRoll(app.db, { source: 'random', gameIds: [row.id], steamid: req.ggSession?.steamid, ip: req.ip });
    return { game };
  });

  app.post('/wheel/marbles', { schema: wheelBodySchema, config: { rateLimit: WHEEL_RATE_LIMIT } }, async (req, reply) => {
    const lang = req.body.lang || req.ggSession?.lang || 'en';
    const rawFilters = req.body.filters || {};
    const ip = req.ip;
    const dailyLimit = app.appConfig.wheel?.marblesDailyLimit ?? 100;

    const countRow = await app.db.one(
      "SELECT COUNT(*) AS c FROM roll_log WHERE source = 'list' AND ip = ? AND DATE(created_at) = CURDATE()",
      [ip],
    );
    if (Number(countRow?.c ?? 0) >= dailyLimit) {
      reply.code(429);
      return { error: 'rate_limited' };
    }

    // Same defence in depth as /wheel above.
    const cisPrices = lang === 'ru' && !!rawFilters.cisPrices;

    const { filters, error } = await resolveSteamLibrary(app, req, rawFilters);
    if (error) return { error };

    const { sql, params } = buildWheelQuery(filters, { lang, cisPrices, config: app.appConfig });
    const idRows = await app.db.query(sql, params);
    const allIds = idRows.map((r) => r.id);
    if (allIds.length === 0) return { error: 'empty' };

    const picked = samplePartialShuffle(allIds, MARBLES_MAX);
    const placeholders = picked.map(() => '?').join(', ');
    const rows = await app.db.query(`SELECT id, name FROM games WHERE id IN (${placeholders})`, picked);
    const nameById = new Map(rows.map((r) => [r.id, r.name]));
    const csv = picked.map((id) => nameById.get(id)).filter(Boolean).join('\n');

    await logRoll(app.db, { source: 'list', gameIds: picked, steamid: req.ggSession?.steamid, ip });

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="marbles.csv"');
    return csv;
  });
}

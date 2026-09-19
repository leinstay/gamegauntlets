// IGDB enrichment source (docs/plans/2026-09-19-rewrite-plan.md T12;
// ingestion order/responsibilities: docs/specs/2026-09-19-rewrite-design.md
// §5.4). Not a catalog source in the steam/gog sense: `discover()` never
// creates `games` rows, it only bulk-links existing Steam/GOG games to their
// IGDB id via `external_games`, then enqueues `fetchOne` for the ones that
// are new or stale. Legacy reference (per-game fuzzy name search + inline
// time-to-beat field): legacy/ajax/scripts/cron_scripts/SGG/igdb.php. This
// module intentionally does not port that approach — see the module-level
// deviations note below and the task report.
//
// Auth: Twitch client-credentials grant (`POST id.twitch.tv/oauth2/token`).
// The response's `access_token` is normally valid ~60 days; it is cached
// in-memory (keyed by `ctx.env`, so tests get an isolated cache) and treated
// as expired 1h before its real `expires_in`, per the task. The token is
// never logged.
//
// external_games / external_game_source: verified live against
// https://api-docs.igdb.com/#external-game and
// https://api-docs.igdb.com/#external-game-source on 2026-09-19 (see task
// report for the request/response transcript). IGDB is mid-migration:
// `external_games.category` (the old fixed enum — 1=Steam, 5=GOG, ...) is
// DEPRECATED in favour of `external_games.external_game_source`, a
// *reference id* into the `external_game_sources` table — which happens to
// reuse the exact same numbering (confirmed live: id 1 = "Steam", id 5 =
// "GOG"). In the live data some rows carry only `category` (older rows),
// most Steam/GOG rows today carry only `external_game_source`, and a few
// carry both — so `mapExternalGameSource()` below reads whichever is
// present and never assumes one over the other. Same story for
// `websites.category` (deprecated) vs `websites.type` (reference id into
// `website_types`), confirmed to share the same numbering too (Half-Life's
// Steam website came back `type: 13`, its Wikipedia website `type: 3` —
// exactly the documented `category` enum) — see `mapWebsiteKind()`.
//
// Measured live on 2026-09-19 (see task report): 175,824 Steam-linked +
// 9,344 GOG-linked external_games rows, 185,168 combined.
//
// DEVIATIONS (see task report for detail):
// - `src/lib/http.js` gained one new export, `postText` (raw-string POST,
//   parsed-JSON response), wired into `src/worker.js` and
//   `scripts/run-source.js`'s `ctx.http`. IGDB's `/v4/*` endpoints require
//   the literal Apicalypse query text as the POST body; `ctx.http.postJson`
//   always `JSON.stringify`s its `data` argument, which would wrap the query
//   in an extra layer of quoting and escape every `"..."` string literal in
//   it, corrupting the query. This was the minimum change outside this
//   task's file list; `postJson`'s existing behaviour/tests are untouched.
// - `discover()`'s `external_games` cursor never resets to 0 on a completed
//   pass (unlike steam.js's full-catalog walk). `external_games` rows are
//   effectively append-only, so re-scanning the whole table on every run
//   would mean re-issuing ~185k rate-limited requests daily for no new
//   information; instead the cursor always resumes from the highest `id`
//   seen so far, so each run after the first only sees newly added rows.
//   `last_full_pass_at` is still touched on every completed sweep (there is
//   always "more" only in the sense of "rows added since").
// - `fetchOne`'s time-to-beat request is a real second network call, not an
//   inline field on `/v4/games` (the legacy script read
//   `time_to_beat.normally`/`.completely` directly off the game object; that
//   nested field no longer exists on the current schema — see
//   https://api-docs.igdb.com/#game-time-to-beat, a separate
//   `/v4/game_time_to_beats` endpoint keyed by `game_id`).

import { postText } from '../lib/http.js';

export const name = 'igdb';

// BullMQ limiter default for the `igdb` queue (overridable via
// `config.sources.igdb.rateLimit`) — IGDB's documented limits are 4
// requests/second and 8 concurrent requests per application.
export const rateLimit = { max: 4, duration: 1000 };

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const API_BASE = 'https://api.igdb.com/v4';

// Refresh the cached Twitch token this long before its real expiry, per the
// task ("cache token in memory until ~1 h before expiry").
const TOKEN_REFRESH_BUFFER_MS = 60 * 60 * 1000;

const DEFAULT_DISCOVER_PAGE_LIMIT = 500;
const DEFAULT_REFRESH_DAYS = 30;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value; // mysql2 may already have parsed the JSON column
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// --- Twitch OAuth (client-credentials) -------------------------------

// Cached per `ctx.env` object (not module-global) so unrelated tests/ctxs
// never share a token, while the one long-lived `env` object each real
// process builds (src/config.js) naturally gets one persistent cache entry.
const tokenCache = new WeakMap();

/** Pure: build the Twitch token-exchange URL. Exported for tests. */
export function buildTokenUrl(clientId, clientSecret) {
  const params = new URLSearchParams({
    client_id: clientId ?? '',
    client_secret: clientSecret ?? '',
    grant_type: 'client_credentials',
  });
  return `${TOKEN_URL}?${params.toString()}`;
}

/**
 * Get a valid IGDB/Twitch access token, fetching and caching a new one when
 * there isn't one yet or the cached one is within `TOKEN_REFRESH_BUFFER_MS`
 * of expiry. Never logs the token. `now` is injectable for tests.
 */
export async function getAccessToken(ctx, { now = Date.now } = {}) {
  const clientId = ctx.env?.IGDB_CLIENT_ID;
  const clientSecret = ctx.env?.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('igdb: IGDB_CLIENT_ID/IGDB_CLIENT_SECRET are not set');
  }

  const cached = tokenCache.get(ctx.env);
  if (cached && now() < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return cached.accessToken;
  }

  const body = await ctx.http.postText(buildTokenUrl(clientId, clientSecret), '');
  if (!body?.access_token) {
    throw new Error('igdb: Twitch token exchange failed (no access_token in response)');
  }
  const expiresAt = now() + (Number(body.expires_in) || 0) * 1000;
  tokenCache.set(ctx.env, { accessToken: body.access_token, expiresAt });
  return body.access_token;
}

/** Test-only: forget any cached token for this `env` object. */
export function clearTokenCacheForTests(env) {
  tokenCache.delete(env);
}

/**
 * POST one Apicalypse query to `${API_BASE}/${endpoint}` with the required
 * Client-ID/Authorization headers, retrying once with a freshly-fetched
 * token on a 401 (in case the cached one was revoked/expired early).
 */
async function igdbRequest(ctx, endpoint, body, { retryOn401 = true } = {}) {
  const token = await getAccessToken(ctx);
  try {
    return await ctx.http.postText(`${API_BASE}/${endpoint}`, body, {
      headers: { 'Client-ID': ctx.env.IGDB_CLIENT_ID, Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    if (retryOn401 && err?.statusCode === 401) {
      clearTokenCacheForTests(ctx.env);
      return igdbRequest(ctx, endpoint, body, { retryOn401: false });
    }
    throw err;
  }
}

// --- external_games -> our source ids (category vs external_game_source) --

export const EXTERNAL_GAME_SOURCE_IDS = { steam: 1, gog: 5 };
export const WEBSITE_KIND_IDS = { official: 1, wikipedia: 3, steam: 13, gog: 17 };

/**
 * `steam` | `gog` | `null` for one `external_games` row, reading whichever
 * of `external_game_source` (current) / `category` (deprecated) is present.
 * See the module-level comment for why both are checked.
 */
export function mapExternalGameSource(row) {
  const id = row?.external_game_source ?? row?.category;
  if (id === EXTERNAL_GAME_SOURCE_IDS.steam) return 'steam';
  if (id === EXTERNAL_GAME_SOURCE_IDS.gog) return 'gog';
  return null;
}

/** `official` | `wikipedia` | `steam` | `gog` | `null` for one `websites` row. */
export function mapWebsiteKind(website) {
  const id = website?.type ?? website?.category;
  return Object.keys(WEBSITE_KIND_IDS).find((key) => WEBSITE_KIND_IDS[key] === id) ?? null;
}

// --- discover() ---------------------------------------------------------

/**
 * Pure: build the `external_games` Apicalypse query for one page (Steam +
 * GOG rows only, `id`-cursor pagination — offset pagination degrades badly
 * on large result sets per IGDB's own guidance, and `external_games` rows
 * are practically append-only, so a monotonic `id` cursor is safe and cheap
 * to resume from). Exported for tests.
 */
export function buildExternalGamesQuery(cursor = 0, limit = DEFAULT_DISCOVER_PAGE_LIMIT) {
  const cursorClause = cursor > 0 ? ` & id > ${cursor}` : '';
  return `fields id,uid,game,category,external_game_source; where (category = (1,5) | external_game_source = (1,5))${cursorClause}; sort id asc; limit ${limit};`;
}

/**
 * Page through `getPage(lastId)` (injected so this is unit-testable with a
 * fake http), yielding each page's row array. Stops on an empty page or a
 * page shorter than `pageLimit` (no more results). Pure control flow — no
 * db/log access.
 */
export async function* walkExternalGames(getPage, { cursor = 0, pageLimit = DEFAULT_DISCOVER_PAGE_LIMIT } = {}) {
  let lastId = cursor;
  for (;;) {
    const rows = await getPage(lastId);
    if (!Array.isArray(rows) || rows.length === 0) return;
    yield rows;
    lastId = rows[rows.length - 1]?.id ?? lastId;
    if (rows.length < pageLimit) return;
  }
}

async function ensureStateRow(db) {
  await db.query('INSERT INTO source_state (source) VALUES (?) ON DUPLICATE KEY UPDATE source = source', [name]);
}

async function loadCursor(db) {
  const row = await db.one('SELECT cursor_state, paused FROM source_state WHERE source = ?', [name]);
  const parsed = parseJsonColumn(row?.cursor_state);
  return { lastId: Number(parsed?.lastId) || 0, paused: Boolean(row?.paused) };
}

async function saveCursor(db, lastId) {
  await db.query('UPDATE source_state SET cursor_state = ?, last_run_at = NOW() WHERE source = ?', [JSON.stringify({ lastId }), name]);
}

async function markFullPass(db, stats) {
  await db.query(
    'UPDATE source_state SET last_full_pass_at = NOW(), last_run_at = NOW(), last_error = NULL, stats = ? WHERE source = ?',
    [JSON.stringify(stats), name],
  );
}

async function markError(db, message) {
  await db.query('UPDATE source_state SET last_error = ?, last_run_at = NOW() WHERE source = ?', [String(message).slice(0, 4000), name]);
}

/**
 * Upsert the `game_links('igdb', ...)` row for `gameId`, unless the existing
 * row is a `manual` override or already has strictly higher confidence
 * (mirrors `wikidata.js`'s `upsertLinkGuarded`). Returns whether it wrote.
 */
async function upsertIgdbLink(ctx, gameId, igdbGameId, { url = null, confidence = 95 } = {}) {
  const existing = await ctx.db.one('SELECT match_method, confidence FROM game_links WHERE game_id = ? AND source = ?', [gameId, name]);
  if (existing) {
    if (existing.match_method === 'manual') return false;
    if (existing.confidence > confidence) return false;
  }
  await ctx.upsertLink(gameId, name, String(igdbGameId), { url, method: 'igdb', confidence });
  return true;
}

/**
 * Bulk-link Steam/GOG games to IGDB via `external_games`, and enqueue a
 * `fetchOne` for every linked game whose IGDB record is missing or older
 * than `config.sources.igdb.refreshDays`. See the module-level comment for
 * the cursor/resume design.
 */
export async function discover(ctx) {
  const { db, log, config, env } = ctx;
  const sourceConfig = config?.sources?.igdb ?? {};
  if (sourceConfig.enabled === false) {
    log.info('igdb: discover skipped (source disabled)');
    return { skipped: true };
  }
  if (!env?.IGDB_CLIENT_ID || !env?.IGDB_CLIENT_SECRET) {
    log.error('igdb: discover skipped, IGDB_CLIENT_ID/IGDB_CLIENT_SECRET are not set');
    return { pages: 0, seen: 0, matched: 0, linked: 0, enqueued: 0 };
  }

  await ensureStateRow(db);
  const { lastId: startCursor, paused } = await loadCursor(db);
  if (paused) {
    log.info('igdb: discover skipped (paused)');
    return { skipped: true };
  }

  const pageLimit = sourceConfig.discoverPageLimit ?? DEFAULT_DISCOVER_PAGE_LIMIT;
  const refreshDays = sourceConfig.refreshDays ?? DEFAULT_REFRESH_DAYS;
  const refreshCutoffMs = Date.now() - refreshDays * 24 * 60 * 60 * 1000;
  const limiterMax = sourceConfig.rateLimit?.max ?? rateLimit.max;
  const limiterDurationMs = sourceConfig.rateLimit?.duration ?? rateLimit.duration;
  const pageDelayMs = Math.ceil(limiterDurationMs / Math.max(1, limiterMax));

  const [steamGameRows, gogGameRows, igdbRecordRows] = await Promise.all([
    db.query("SELECT id, steam_appid FROM games WHERE steam_appid IS NOT NULL"),
    db.query('SELECT id, gog_id FROM games WHERE gog_id IS NOT NULL'),
    db.query('SELECT external_id, UNIX_TIMESTAMP(fetched_at) AS fetchedAt FROM source_records WHERE source = ?', [name]),
  ]);
  const steamAppidToGameId = new Map(steamGameRows.map((g) => [String(g.steam_appid), g.id]));
  const gogIdToGameId = new Map(gogGameRows.map((g) => [String(g.gog_id), g.id]));
  const recordTimestamps = new Map(igdbRecordRows.map((r) => [String(r.external_id), Number(r.fetchedAt)]));

  let pages = 0;
  let seen = 0;
  let matched = 0;
  let linked = 0;
  let enqueued = 0;
  let cursor = startCursor;

  const getPage = async (lastId) => {
    if (pages > 0) await sleep(pageDelayMs);
    return igdbRequest(ctx, 'external_games', buildExternalGamesQuery(lastId, pageLimit));
  };

  try {
    for await (const rows of walkExternalGames(getPage, { cursor: startCursor, pageLimit })) {
      pages += 1;
      for (const row of rows) {
        seen += 1;
        const source = mapExternalGameSource(row);
        if (!source || row.uid == null || row.game == null) continue;

        const gameId = source === 'steam' ? steamAppidToGameId.get(String(row.uid)) : gogIdToGameId.get(String(row.uid));
        if (!gameId) continue;
        matched += 1;

        const wrote = await upsertIgdbLink(ctx, gameId, row.game, { confidence: 95 });
        if (wrote) linked += 1;

        const igdbGameId = String(row.game);
        const priorFetchedAt = recordTimestamps.get(igdbGameId);
        const isStale = priorFetchedAt === undefined || priorFetchedAt * 1000 < refreshCutoffMs;
        if (isStale) {
          await ctx.enqueue(name, { gameId, externalId: igdbGameId });
          enqueued += 1;
          recordTimestamps.set(igdbGameId, Date.now() / 1000); // don't re-enqueue twice within this pass
        }
      }
      cursor = rows[rows.length - 1]?.id ?? cursor;
      await saveCursor(db, cursor);
    }

    const stats = { pages, seen, matched, linked, enqueued };
    await markFullPass(db, stats);
    log.info('igdb: discover complete', stats);
    return stats;
  } catch (err) {
    await markError(db, err?.message ?? String(err));
    log.error('igdb: discover failed', { error: err, cursor, pages, seen });
    throw err;
  }
}

// --- fetchOne() -----------------------------------------------------------

const GAME_FIELDS = [
  'name',
  'slug',
  'first_release_date',
  'release_dates.date',
  'release_dates.date_format',
  'release_dates.category',
  'release_dates.platform',
  'aggregated_rating',
  'aggregated_rating_count',
  'rating',
  'rating_count',
  'total_rating',
  'total_rating_count',
  'genres.name',
  'themes.name',
  'involved_companies.company.name',
  'involved_companies.developer',
  'involved_companies.publisher',
  'url',
  'websites.url',
  'websites.category',
  'websites.type',
  'external_games.uid',
  'external_games.category',
  'external_games.external_game_source',
].join(',');

const TIME_TO_BEAT_FIELDS = 'game_id,hastily,normally,completely,count';

/** Pure: the `/v4/games` Apicalypse query for one or several ids. Exported for tests. */
export function buildGamesQuery(ids) {
  const idList = ids.join(',');
  return `fields ${GAME_FIELDS}; where id = (${idList}); limit ${Math.max(ids.length, 1)};`;
}

/** Pure: the `/v4/game_time_to_beats` Apicalypse query for one or several ids. Exported for tests. */
export function buildTimeToBeatQuery(ids) {
  const idList = ids.join(',');
  return `fields ${TIME_TO_BEAT_FIELDS}; where game_id = (${idList}); limit ${Math.max(ids.length, 1)};`;
}

/**
 * Fetch and store one or several IGDB games (`job.data = { gameId,
 * externalId }` for a single id, or `job.data = { igdbIds: [...] }` to batch
 * up to ~50 in one pair of requests). In batch mode (or a single id with no
 * `gameId` given) the owning `gameId` is looked up via `game_links` — safe
 * because `discover()` always links a game before enqueueing its fetch.
 * Returns `{ status, externalId, payload }` for a single id, or `{ status:
 * 'ok', results: [...] }` for a batch.
 */
export async function fetchOne(ctx, job) {
  const { db, log } = ctx;
  const isBatch = Array.isArray(job?.data?.igdbIds) && job.data.igdbIds.length > 0;
  const igdbIds = (isBatch ? job.data.igdbIds : [job?.data?.externalId]).map(String).filter((id) => id && id !== 'undefined' && id !== 'null');
  if (igdbIds.length === 0) throw new Error('igdb.fetchOne: job.data.externalId or job.data.igdbIds is required');

  const singleGameId = job?.data?.gameId || null;
  let gameIdByIgdbId = new Map();
  if (!isBatch && singleGameId) {
    gameIdByIgdbId.set(igdbIds[0], singleGameId);
  } else {
    const rows = await db.query('SELECT external_id, game_id FROM game_links WHERE source = ? AND external_id IN (?)', [name, igdbIds]);
    gameIdByIgdbId = new Map(rows.map((r) => [String(r.external_id), r.game_id]));
  }

  let games;
  let ttbRows;
  try {
    [games, ttbRows] = await Promise.all([
      igdbRequest(ctx, 'games', buildGamesQuery(igdbIds)),
      igdbRequest(ctx, 'game_time_to_beats', buildTimeToBeatQuery(igdbIds)),
    ]);
  } catch (err) {
    for (const igdbId of igdbIds) {
      await ctx.upsertRecord(name, igdbId, { status: 'error', error: String(err?.message ?? err), gameId: gameIdByIgdbId.get(igdbId) ?? null });
    }
    throw err; // let BullMQ retry per DEFAULT_JOB_OPTIONS
  }

  const gamesById = new Map((games ?? []).map((g) => [String(g.id), g]));
  const ttbById = new Map((ttbRows ?? []).map((t) => [String(t.game_id), t]));

  const results = [];
  for (const igdbId of igdbIds) {
    const game = gamesById.get(igdbId);
    const gameId = gameIdByIgdbId.get(igdbId) ?? null;

    if (!game) {
      await ctx.upsertRecord(name, igdbId, { status: 'not_found', error: 'igdb: game id not found', gameId });
      results.push({ status: 'not_found', externalId: igdbId, payload: null });
      continue;
    }

    const payload = { game, timeToBeat: ttbById.get(igdbId) ?? null, fetchedAt: new Date().toISOString() };
    await ctx.upsertRecord(name, igdbId, { status: 'ok', payload, gameId });

    if (gameId) {
      const url = game.url || (game.slug ? `https://www.igdb.com/games/${game.slug}` : null);
      await upsertIgdbLink(ctx, gameId, igdbId, { url, confidence: 95 });
      await ctx.enqueueResolve(gameId);
    } else {
      log.warn('igdb: fetchOne resolved a game with no known gameId (not linked by discover yet)', { igdbId });
    }
    results.push({ status: 'ok', externalId: igdbId, payload });
  }

  return igdbIds.length === 1 ? results[0] : { status: 'ok', results };
}

// --- extract() ------------------------------------------------------------

// `release_dates.date_format` (current) / `.category` (deprecated) share the
// same enum (https://api-docs.igdb.com/#release-date).
const RELEASE_DATE_FORMAT_PRECISION = {
  0: 'day', // YYYYMMMMDD
  1: 'month', // YYYYMMMM
  2: 'year', // YYYY
  3: 'quarter', // YYYYQ1
  4: 'quarter', // YYYYQ2
  5: 'quarter', // YYYYQ3
  6: 'quarter', // YYYYQ4
  7: 'unknown', // TBD
};

function unixToDate(unixSeconds) {
  if (typeof unixSeconds !== 'number' || !Number.isFinite(unixSeconds)) return null;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Precision of `game.first_release_date`: look for a `release_dates` entry
 * with the same date and read its (deprecated) `category` / (current)
 * `date_format`. Per the task, default to `'day'` when IGDB doesn't mark a
 * coarser precision (both fields are frequently absent in current data).
 */
function releasePrecision(game) {
  if (!Array.isArray(game.release_dates)) return 'day';
  const match = game.release_dates.find((r) => r?.date === game.first_release_date);
  const code = match?.date_format ?? match?.category;
  if (code === undefined || code === null) return 'day';
  return RELEASE_DATE_FORMAT_PRECISION[code] ?? 'day';
}

/** Seconds -> hours, rounded to one decimal place; `undefined` for anything non-positive/absent. */
function secondsToHours(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round((seconds / 3600) * 10) / 10;
}

function namesOf(list, key) {
  return Array.isArray(list) ? [...new Set(list.map((x) => x?.[key]).filter((v) => typeof v === 'string' && v.trim() !== ''))] : [];
}

/**
 * Pure: turn a stored `source_records` payload (`{ game, timeToBeat,
 * fetchedAt }`, as written by `fetchOne`) into the extracted-field
 * vocabulary (docs/plans/2026-09-19-rewrite-plan.md, "Extracted-field
 * vocabulary"). Never touches the network or the database.
 */
export function extract(payload) {
  const game = payload?.game;
  if (!game) return {};

  const out = {};

  if (typeof game.name === 'string' && game.name.trim() !== '') out.name = game.name;

  if (typeof game.first_release_date === 'number') {
    out.release = { date: unixToDate(game.first_release_date), precision: releasePrecision(game) };
  }

  if (typeof game.aggregated_rating === 'number') out.scoreIgdb = Math.round(game.aggregated_rating);
  if (typeof game.rating === 'number') out.scoreIgdbUsers = Math.round(game.rating);

  const ttb = payload.timeToBeat;
  const timeMain = secondsToHours(ttb?.normally ?? ttb?.hastily);
  if (timeMain !== undefined) out.timeMain = timeMain;
  const timeComplete = secondsToHours(ttb?.completely);
  if (timeComplete !== undefined) out.timeComplete = timeComplete;

  const genres = namesOf(game.genres, 'name');
  if (genres.length) out.genres = genres;

  if (Array.isArray(game.involved_companies)) {
    const developers = [...new Set(game.involved_companies.filter((c) => c?.developer).map((c) => c.company?.name).filter((n) => typeof n === 'string' && n.trim() !== ''))];
    const publishers = [...new Set(game.involved_companies.filter((c) => c?.publisher).map((c) => c.company?.name).filter((n) => typeof n === 'string' && n.trim() !== ''))];
    if (developers.length) out.developers = developers;
    if (publishers.length) out.publishers = publishers;
  }

  const links = {};
  for (const eg of game.external_games ?? []) {
    const source = mapExternalGameSource(eg);
    if (source === 'steam' && eg.uid && !links.steam) {
      links.steam = { id: eg.uid, url: `https://store.steampowered.com/app/${eg.uid}` };
    }
    if (source === 'gog' && eg.uid && !links.gog) {
      links.gog = { id: eg.uid, url: null }; // filled in below if a matching website is present
    }
  }
  for (const website of game.websites ?? []) {
    const kind = mapWebsiteKind(website);
    if (kind === 'wikipedia' && !links.wikipedia) links.wikipedia = { id: null, url: website.url };
    if (kind === 'official' && !links.official) links.official = { id: null, url: website.url };
    if (kind === 'gog' && links.gog && !links.gog.url) links.gog.url = website.url;
  }
  if (Object.keys(links).length > 0) out.links = links;

  return out;
}

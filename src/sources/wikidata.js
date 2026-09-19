// Wikidata: bulk SPARQL cross-reference source. Not a catalog in the
// steam/gog sense (it doesn't create `games` rows) — it enriches existing
// rows with ids for other sources (GOG, IGDB, HLTB, Metacritic, OpenCritic,
// MobyGames, GameFAQs, Wikipedia) and independent publication dates, using
// Steam application ID (P1733) as the primary join key, plus a second pass
// for GOG-exclusive games matched by GOG slug (P2725) alone.
//
// Property ids verified against https://www.wikidata.org/wiki/Property:P.../
// on 2026-09-19 (see the task report for the verification transcript):
//   P1733 Steam application ID, P2725 GOG application ID (value is a
//   `game/<slug>` or `movie/<slug>` URL path, NOT a numeric id — see
//   `parseGogValue`), P5794 IGDB game ID, P2816 HowLongToBeat ID,
//   P1712 Metacritic ID, P2864 OpenCritic ID, P11688 MobyGames game ID
//   (current scheme) with P1933 as the deprecated fallback scheme,
//   P4769 GameFAQs game ID, P577 publication date, P178 developer,
//   P123 publisher.
//
// Query strategy (measured against the live endpoint while building this
// module — see the task report for timings): ORDER BY on a cast/derived
// expression (e.g. `xsd:integer(?steamId)`) makes Blazegraph materialize and
// sort the whole P1733 result set before LIMIT, which reliably times out
// (502) even for small LIMITs. Filtering by a bound Steam-appid *range*
// (`FILTER(xsd:integer(?steamId) >= lo && < hi)`) is cheap because the
// P1733 triple pattern is already selective, so `discover()` pages the
// Steam-id pass by fixed-width appid ranges (default 50k, ~26s worst case
// observed) and stores the next range's start in `source_state.cursor_state`
// so a restart resumes instead of rescanning. The GOG-only pass (~400 items
// total on Wikidata) is small enough to fetch in one shot with a single
// generous LIMIT.

import { getJson, USER_AGENT } from '../lib/http.js';

export const name = 'wikidata';
export const rateLimit = { max: 1, duration: 1000 };

const ENDPOINT = 'https://query.wikidata.org/sparql';
const QUERY_TIMEOUT_MS = 60_000;

const DEFAULT_STEAM_PAGE_SIZE = 50_000;
const DEFAULT_MAX_STEAM_APPID = 4_000_000;
const DEFAULT_GOG_ONLY_LIMIT = 5_000;

// Extends the shared bot UA (which already carries the project's contact
// URL, per Wikimedia's User-Agent policy for the query service) with a
// component identifier. No personal contact is added here.
export const SPARQL_USER_AGENT = `${USER_AGENT} wikidata-sparql/1.0`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- SPARQL query builders (pure) -------------------------------------

const SHARED_SELECT_AGGREGATES = `
  (SAMPLE(?igdbId) AS ?igdbId_)
  (SAMPLE(?hltbId) AS ?hltbId_)
  (SAMPLE(?metacriticId) AS ?metacriticId_)
  (SAMPLE(?opencriticId) AS ?opencriticId_)
  (SAMPLE(?mobyId) AS ?mobyId_)
  (SAMPLE(?mobyIdOld) AS ?mobyIdOld_)
  (SAMPLE(?gamefaqsId) AS ?gamefaqsId_)
  (SAMPLE(?wikiEnTitle) AS ?wikiEnTitle_)
  (SAMPLE(?wikiRuTitle) AS ?wikiRuTitle_)
  (GROUP_CONCAT(DISTINCT CONCAT(STR(?pubDate), "|", STR(?pubPrecision)); separator="||") AS ?pubDates)
  (GROUP_CONCAT(DISTINCT ?devLabel; separator="|") AS ?developers)
  (GROUP_CONCAT(DISTINCT ?pubLabel; separator="|") AS ?publishers)
`.trim();

const SHARED_OPTIONALS = `
  OPTIONAL { ?item wdt:P5794 ?igdbId . }
  OPTIONAL { ?item wdt:P2816 ?hltbId . }
  OPTIONAL { ?item wdt:P1712 ?metacriticId . }
  OPTIONAL { ?item wdt:P2864 ?opencriticId . }
  OPTIONAL { ?item wdt:P11688 ?mobyId . }
  OPTIONAL { ?item wdt:P1933 ?mobyIdOld . }
  OPTIONAL { ?item wdt:P4769 ?gamefaqsId . }
  OPTIONAL { ?sitelinkEn schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?wikiEnTitle . }
  OPTIONAL { ?sitelinkRu schema:about ?item ; schema:isPartOf <https://ru.wikipedia.org/> ; schema:name ?wikiRuTitle . }
  OPTIONAL {
    ?item p:P577 ?pubStatement .
    ?pubStatement psv:P577 ?pubValue .
    ?pubValue wikibase:timeValue ?pubDate ; wikibase:timePrecision ?pubPrecision .
  }
  OPTIONAL { ?item wdt:P178 ?dev . ?dev rdfs:label ?devLabel . FILTER(LANG(?devLabel) = "en") }
  OPTIONAL { ?item wdt:P123 ?pub . ?pub rdfs:label ?pubLabel . FILTER(LANG(?pubLabel) = "en") }
`.trim();

function assertFiniteInt(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`wikidata: ${label} must be a finite number, got ${value}`);
  return Math.trunc(n);
}

const QID_RE = /^Q[1-9]\d*$/;

function assertQid(qid) {
  if (typeof qid !== 'string' || !QID_RE.test(qid)) {
    throw new Error(`wikidata: invalid QID ${JSON.stringify(qid)}`);
  }
  return qid;
}

/** Steam-id pass, one fixed-width appid range. */
export function buildMainQuery(lo, hi) {
  const loN = assertFiniteInt(lo, 'lo');
  const hiN = assertFiniteInt(hi, 'hi');
  return `SELECT ?item ?steamId (SAMPLE(?gogId) AS ?gogId_) ${SHARED_SELECT_AGGREGATES}
WHERE {
  ?item wdt:P1733 ?steamId .
  FILTER(xsd:integer(?steamId) >= ${loN} && xsd:integer(?steamId) < ${hiN})
  OPTIONAL { ?item wdt:P2725 ?gogId . }
  ${SHARED_OPTIONALS}
}
GROUP BY ?item ?steamId`;
}

/** GOG-exclusive pass: items with a GOG id but no Steam id, single shot. */
export function buildGogOnlyQuery(limit = DEFAULT_GOG_ONLY_LIMIT) {
  const limitN = assertFiniteInt(limit, 'limit');
  return `SELECT ?item ?gogId ${SHARED_SELECT_AGGREGATES}
WHERE {
  ?item wdt:P2725 ?gogId .
  MINUS { ?item wdt:P1733 ?steamIdX . }
  ${SHARED_OPTIONALS}
}
GROUP BY ?item ?gogId
LIMIT ${limitN}`;
}

/** Refresh a single item by its QID (used by fetchOne when the link is already known). */
export function buildRefreshQueryByQid(qid) {
  assertQid(qid);
  return `SELECT ?item ?steamId (SAMPLE(?gogId) AS ?gogId_) ${SHARED_SELECT_AGGREGATES}
WHERE {
  VALUES ?item { wd:${qid} }
  OPTIONAL { ?item wdt:P1733 ?steamId . }
  OPTIONAL { ?item wdt:P2725 ?gogId . }
  ${SHARED_OPTIONALS}
}
GROUP BY ?item ?steamId`;
}

/** Refresh a single item by Steam appid (used by fetchOne before any wikidata link exists). */
export function buildRefreshQueryBySteamAppid(appid) {
  const appidN = assertFiniteInt(appid, 'appid');
  return `SELECT ?item ?steamId (SAMPLE(?gogId) AS ?gogId_) ${SHARED_SELECT_AGGREGATES}
WHERE {
  ?item wdt:P1733 ?steamId .
  FILTER(?steamId = "${appidN}")
  OPTIONAL { ?item wdt:P2725 ?gogId . }
  ${SHARED_OPTIONALS}
}
GROUP BY ?item ?steamId
LIMIT 1`;
}

// --- HTTP -----------------------------------------------------------------

/**
 * Run one SPARQL query against the WDQS endpoint and return its bindings
 * array. `http` is `ctx.http` (or a fake in tests exposing `getJson`).
 */
export async function runQuery(http, sparql, { timeout = QUERY_TIMEOUT_MS } = {}) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('query', sparql);
  const json = await http.getJson(url.toString(), {
    timeout,
    headers: { accept: 'application/sparql-results+json', 'user-agent': SPARQL_USER_AGENT },
  });
  return json.results.bindings;
}

// --- Binding parsing (pure) -------------------------------------------

function bindingValue(binding, key) {
  return binding[key]?.value ?? null;
}

export function qidFromUri(uri) {
  if (!uri) return null;
  const m = /\/(Q[1-9]\d*)$/.exec(uri);
  return m ? m[1] : uri;
}

/** `game/the_witcher` -> { kind: 'game', slug: 'the_witcher', raw }; null for no value. */
export function parseGogValue(raw) {
  if (!raw) return null;
  const m = /^(game|movie)\/(.+)$/.exec(raw);
  if (!m) return { kind: 'unknown', slug: raw, raw };
  return { kind: m[1], slug: m[2], raw };
}

/** `"d1|p1||d2|p2"` -> `[{date:'d1',precision:p1}, ...]`, precision as a number. */
export function parsePubDates(raw) {
  if (!raw) return [];
  return raw
    .split('||')
    .filter(Boolean)
    .map((pair) => {
      const sep = pair.indexOf('|');
      if (sep === -1) return null;
      const date = pair.slice(0, sep);
      const precision = Number(pair.slice(sep + 1));
      if (!date || Number.isNaN(precision)) return null;
      return { date, precision };
    })
    .filter(Boolean);
}

/** `"a|b|b|"` -> `['a','b']` (trim, dedupe order-preserving, drop empties). */
export function parseList(raw) {
  if (!raw) return [];
  const seen = new Set();
  const out = [];
  for (const part of raw.split('|')) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Parse one SPARQL JSON `binding` row (from either the Steam-id pass, the
 * GOG-only pass, or a single-item refresh query — they all share the same
 * aggregate column names) into a normalized, JSON-serializable record. This
 * is exactly what gets stored as `source_records.payload` and later handed
 * to `extract()`.
 */
export function parseBinding(binding) {
  const steamIdRaw = bindingValue(binding, 'steamId');
  const gogRaw = bindingValue(binding, 'gogId_') ?? bindingValue(binding, 'gogId');
  return {
    qid: qidFromUri(bindingValue(binding, 'item')),
    steamAppid: steamIdRaw != null ? Number(steamIdRaw) : null,
    gog: parseGogValue(gogRaw),
    igdbId: bindingValue(binding, 'igdbId_') ?? bindingValue(binding, 'igdbId'),
    hltbId: bindingValue(binding, 'hltbId_') ?? bindingValue(binding, 'hltbId'),
    metacriticId: bindingValue(binding, 'metacriticId_') ?? bindingValue(binding, 'metacriticId'),
    opencriticId: bindingValue(binding, 'opencriticId_') ?? bindingValue(binding, 'opencriticId'),
    // Prefer the current MobyGames scheme (P11688); fall back to the
    // deprecated one (P1933) when only that is present (common: most older
    // items haven't been migrated yet).
    mobygamesId: bindingValue(binding, 'mobyId_') ?? bindingValue(binding, 'mobyIdOld_') ?? bindingValue(binding, 'mobyId') ?? bindingValue(binding, 'mobyIdOld'),
    gamefaqsId: bindingValue(binding, 'gamefaqsId_') ?? bindingValue(binding, 'gamefaqsId'),
    wikipediaEn: bindingValue(binding, 'wikiEnTitle_') ?? bindingValue(binding, 'wikiEnTitle'),
    wikipediaRu: bindingValue(binding, 'wikiRuTitle_') ?? bindingValue(binding, 'wikiRuTitle'),
    publicationDates: parsePubDates(bindingValue(binding, 'pubDates')),
    developers: parseList(bindingValue(binding, 'developers')),
    publishers: parseList(bindingValue(binding, 'publishers')),
  };
}

// --- Release date (Wikidata time precision -> our vocabulary) -------------

/** Wikidata time precision: 11=day, 10=month, 9=year (others unsupported here). */
export function mapPrecision(wdPrecision) {
  if (wdPrecision === 11) return 'day';
  if (wdPrecision === 10) return 'month';
  if (wdPrecision === 9) return 'year';
  return 'unknown';
}

/** `'1998-11-19T00:00:00Z'` + precision -> `'1998-11-19'` / `'1998-11-01'` / `'1998-01-01'` / null. */
export function dateForPrecision(isoDateTime, precision) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDateTime ?? ''));
  if (!m) return null;
  const [, year, month, day] = m;
  if (precision === 'day') return `${year}-${month}-${day}`;
  if (precision === 'month') return `${year}-${month}-01`;
  if (precision === 'year') return `${year}-01-01`;
  return null;
}

/** Earliest resolvable publication date in `payload.publicationDates`, or null. */
export function earliestRelease(publicationDates) {
  if (!Array.isArray(publicationDates) || publicationDates.length === 0) return null;
  const candidates = publicationDates
    .map(({ date, precision }) => {
      const mapped = mapPrecision(precision);
      const iso = dateForPrecision(date, mapped);
      return iso ? { date: iso, precision: mapped } : null;
    })
    .filter(Boolean);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return candidates[0];
}

// --- Links (game_links rows this source can produce) -----------------------

function wikipediaUrl(lang, title) {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /g, '_'))}`;
}

/**
 * Every `game_links` candidate this record supports:
 * `[{ source, externalId, url }]`. `source === 'gog'` is only produced for
 * `kind === 'game'` (a `movie/...` GOG entry is not a game match).
 */
export function collectLinks(record) {
  const links = [{ source: 'wikidata', externalId: record.qid, url: `https://www.wikidata.org/wiki/${record.qid}` }];
  if (record.gog && record.gog.kind === 'game') {
    links.push({ source: 'gog', externalId: record.gog.slug, url: `https://www.gog.com/${record.gog.raw}` });
  }
  if (record.igdbId) links.push({ source: 'igdb', externalId: record.igdbId, url: `https://www.igdb.com/games/${record.igdbId}` });
  if (record.hltbId) links.push({ source: 'hltb', externalId: record.hltbId, url: `https://howlongtobeat.com/game/${record.hltbId}` });
  if (record.metacriticId) links.push({ source: 'metacritic', externalId: record.metacriticId, url: `https://www.metacritic.com/${record.metacriticId}` });
  // OpenCritic is dropped from the project (2026-09-19, config.json's sources.opencritic removed) — the
  // P2864 id is still parsed into `record.opencriticId` above (parseBinding()), just never turned into a
  // game_links row anymore. Left as dead data on the record rather than dropped from parseBinding() too,
  // in case a future admin override wants to read it back off a fresh SPARQL result.
  if (record.mobygamesId) links.push({ source: 'mobygames', externalId: record.mobygamesId, url: `https://www.mobygames.com/game/${record.mobygamesId}/` });
  if (record.gamefaqsId) links.push({ source: 'gamefaqs', externalId: record.gamefaqsId, url: `https://gamefaqs.gamespot.com/-/${record.gamefaqsId}-` });
  if (record.wikipediaEn) links.push({ source: 'wikipedia_en', externalId: record.wikipediaEn, url: wikipediaUrl('en', record.wikipediaEn) });
  if (record.wikipediaRu) links.push({ source: 'wikipedia_ru', externalId: record.wikipediaRu, url: wikipediaUrl('ru', record.wikipediaRu) });
  return links;
}

// --- extract() --------------------------------------------------------

/**
 * Pure: stored `source_records.payload` (a `parseBinding()` record) ->
 * normalized fields for the resolver, per the Extracted-field vocabulary.
 */
export function extract(payload) {
  const result = {};

  const links = {};
  for (const link of collectLinks(payload)) {
    if (link.source === 'wikidata') continue; // self-reference, not useful as a cross-source id
    links[link.source] = { id: link.externalId, url: link.url };
  }
  if (Object.keys(links).length > 0) result.links = links;

  if (payload.developers?.length) result.developers = payload.developers;
  if (payload.publishers?.length) result.publishers = payload.publishers;

  const release = earliestRelease(payload.publicationDates);
  if (release) result.release = release;

  return result;
}

// --- source_state (cursor/progress) -----------------------------------

async function ensureStateRow(db) {
  await db.query('INSERT INTO source_state (source) VALUES (?) ON DUPLICATE KEY UPDATE source = source', [name]);
}

async function loadState(db) {
  return db.one('SELECT cursor_state, paused FROM source_state WHERE source = ?', [name]);
}

function parseCursor(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw; // driver already parsed the JSON column
}

async function saveCursor(db, cursor) {
  await db.query('UPDATE source_state SET cursor_state = ?, last_run_at = NOW() WHERE source = ?', [JSON.stringify(cursor), name]);
}

async function markFullPass(db, stats) {
  await db.query(
    'UPDATE source_state SET cursor_state = NULL, last_full_pass_at = NOW(), last_run_at = NOW(), last_error = NULL, stats = ? WHERE source = ?',
    [JSON.stringify(stats), name],
  );
}

async function markError(db, message) {
  await db.query('UPDATE source_state SET last_error = ?, last_run_at = NOW() WHERE source = ?', [String(message).slice(0, 4000), name]);
}

// --- Matching + upserts -------------------------------------------------

/**
 * Upsert one `game_links` row unless a better/protected link already exists:
 * never overwrite `match_method` 'store' or 'manual', and never downgrade to
 * a lower confidence. Returns true if it wrote, false if it skipped.
 */
export async function upsertLinkGuarded(ctx, gameId, source, externalId, opts) {
  const existing = await ctx.db.one('SELECT match_method, confidence FROM game_links WHERE game_id = ? AND source = ?', [gameId, source]);
  if (existing) {
    if (existing.match_method === 'store' || existing.match_method === 'manual') return false;
    if (existing.confidence > opts.confidence) return false;
  }
  await ctx.upsertLink(gameId, source, externalId, opts);
  return true;
}

/**
 * Apply one parsed record to an already-matched `game` row ({id, gog_slug}):
 * store the raw record, upsert every learned link (guarded), backfill
 * `games.gog_slug` when empty and uncontested, and mark the game changed.
 */
export async function applyRecord(ctx, game, record, changedGameIds, stats) {
  await ctx.upsertRecord(name, record.qid, { payload: record, gameId: game.id });

  for (const link of collectLinks(record)) {
    const wrote = await upsertLinkGuarded(ctx, game.id, link.source, link.externalId, {
      url: link.url,
      method: 'wikidata',
      confidence: 95,
    });
    if (wrote) stats.linksUpserted += 1;
  }

  if (record.gog?.kind === 'game' && !game.gog_slug) {
    const collision = await ctx.db.one('SELECT id FROM games WHERE gog_slug = ? AND id != ?', [record.gog.slug, game.id]);
    if (collision) {
      ctx.log.warn('wikidata: gog_slug collision, leaving unset', {
        gameId: game.id,
        otherGameId: collision.id,
        gogSlug: record.gog.slug,
      });
      stats.gogCollisions += 1;
    } else {
      await ctx.db.query('UPDATE games SET gog_slug = ? WHERE id = ?', [record.gog.slug, game.id]);
      stats.gogSlugsSet += 1;
    }
  }

  changedGameIds.add(game.id);
}

async function applyMainPassRow(ctx, binding, changedGameIds, stats) {
  const record = parseBinding(binding);
  stats.steamRows += 1;
  if (record.steamAppid == null) return;
  const game = await ctx.db.one('SELECT id, gog_slug FROM games WHERE steam_appid = ?', [record.steamAppid]);
  if (!game) return;
  await applyRecord(ctx, game, record, changedGameIds, stats);
  stats.steamMatched += 1;
}

async function applyGogOnlyRow(ctx, binding, changedGameIds, stats) {
  const record = parseBinding(binding);
  stats.gogOnlyRows += 1;
  if (!record.gog || record.gog.kind !== 'game') return;
  const game = await ctx.db.one('SELECT id, gog_slug FROM games WHERE gog_slug = ?', [record.gog.slug]);
  if (!game) return; // GOG-exclusive game not in the catalog yet (owned by the gog source)
  await applyRecord(ctx, game, record, changedGameIds, stats);
  stats.gogOnlyMatched += 1;
}

// --- discover() ---------------------------------------------------------

function freshStats() {
  return {
    pagesRun: 0,
    steamRows: 0,
    steamMatched: 0,
    gogOnlyRows: 0,
    gogOnlyMatched: 0,
    linksUpserted: 0,
    gogSlugsSet: 0,
    gogCollisions: 0,
    resolvesEnqueued: 0,
  };
}

/**
 * Bulk SPARQL sweep: Steam-id pass (paged by appid range, resumable via
 * `source_state.cursor_state`), then a single-shot GOG-only pass. Enqueues a
 * batched resolve for every game touched.
 */
export async function discover(ctx) {
  const { db, http, log, config } = ctx;
  const sourceConfig = config?.sources?.wikidata ?? {};
  if (sourceConfig.enabled === false) {
    log.info('wikidata: discover skipped (source disabled)');
    return { skipped: true };
  }

  await ensureStateRow(db);
  const state = await loadState(db);
  if (state?.paused) {
    log.info('wikidata: discover skipped (paused)');
    return { skipped: true };
  }

  const pageSize = sourceConfig.steamPageSize ?? DEFAULT_STEAM_PAGE_SIZE;
  const maxAppid = sourceConfig.maxSteamAppId ?? DEFAULT_MAX_STEAM_APPID;
  const gogOnlyLimit = sourceConfig.gogOnlyLimit ?? DEFAULT_GOG_ONLY_LIMIT;
  const requestDelayMs = sourceConfig.rateLimit?.duration ?? rateLimit.duration;

  let cursor = parseCursor(state?.cursor_state);
  const stats = freshStats();
  const changedGameIds = new Set();

  try {
    if (!cursor || cursor.phase === 'steam') {
      let nextAppid = cursor?.nextAppid ?? 0;
      while (nextAppid < maxAppid) {
        const hi = Math.min(nextAppid + pageSize, maxAppid);
        const bindings = await runQuery(http, buildMainQuery(nextAppid, hi));
        stats.pagesRun += 1;
        for (const binding of bindings) {
          await applyMainPassRow(ctx, binding, changedGameIds, stats);
        }
        nextAppid = hi;
        cursor = { phase: 'steam', nextAppid };
        await saveCursor(db, cursor);
        if (nextAppid < maxAppid) await sleep(requestDelayMs);
      }
      cursor = { phase: 'gogOnly' };
      await saveCursor(db, cursor);
    }

    if (cursor.phase === 'gogOnly') {
      const bindings = await runQuery(http, buildGogOnlyQuery(gogOnlyLimit));
      stats.pagesRun += 1;
      if (bindings.length >= gogOnlyLimit) {
        log.warn('wikidata: gog-only pass hit its LIMIT, some items may have been missed', { limit: gogOnlyLimit });
      }
      for (const binding of bindings) {
        await applyGogOnlyRow(ctx, binding, changedGameIds, stats);
      }
    }

    for (const gameId of changedGameIds) {
      await ctx.enqueueResolve(gameId);
      stats.resolvesEnqueued += 1;
    }

    await markFullPass(db, stats);
    log.info('wikidata: discover full pass complete', stats);
    return stats;
  } catch (err) {
    await markError(db, err?.message ?? String(err));
    log.error('wikidata: discover failed', { error: err, cursor, stats });
    throw err;
  }
}

// --- fetchOne() -----------------------------------------------------------

function isQid(value) {
  return typeof value === 'string' && QID_RE.test(value);
}

/**
 * Refresh one game: re-query by its known QID (job.data.externalId) or, if
 * not yet linked, by its Steam appid. Used for the periodic refresh
 * (`config.sources.wikidata.refreshDays`) once a game already has a
 * wikidata link, and for a manual "run now" before that link exists.
 */
export async function fetchOne(ctx, job) {
  const { gameId, externalId } = job.data;
  const game = await ctx.db.one('SELECT id, steam_appid, gog_slug FROM games WHERE id = ?', [gameId]);
  if (!game) return { status: 'not_found', externalId: externalId ?? null, payload: null };

  const qid = isQid(externalId) ? externalId : null;
  if (!qid && game.steam_appid == null) {
    return { status: 'not_found', externalId: externalId ?? null, payload: null };
  }

  const query = qid ? buildRefreshQueryByQid(qid) : buildRefreshQueryBySteamAppid(game.steam_appid);
  const bindings = await runQuery(ctx.http, query);

  if (bindings.length === 0) {
    await ctx.upsertRecord(name, qid ?? `steam:${game.steam_appid}`, { status: 'not_found', gameId, payload: null });
    return { status: 'not_found', externalId: qid ?? null, payload: null };
  }

  const record = parseBinding(bindings[0]);
  const changedGameIds = new Set();
  const stats = freshStats();
  await applyRecord(ctx, game, record, changedGameIds, stats);
  for (const changedId of changedGameIds) {
    await ctx.enqueueResolve(changedId);
  }

  return { status: 'ok', externalId: record.qid, payload: record };
}

// HowLongToBeat enrichment source (spec docs/specs/2026-09-19-rewrite-design.md
// §5.4; plan docs/plans/2026-09-19-rewrite-plan.md task T14). Legacy reference:
// legacy/ajax/scripts/cron_scripts/SGG/hltb.php (buildId scraping, the search
// request shape, and the profile_steam confirmation check — all reused below).
//
// HLTB has no official API and actively reworks its anti-scraping defenses, so
// every dynamic bit below (search token, buildId) is isolated in its own small
// function with its own cache, easy to patch in isolation the next time the
// site changes. If any call here starts failing, re-derive it the same way
// this comment does: open https://howlongtobeat.com/ and read the inlined
// `"buildId":"..."` and the fetched `/_next/static/chunks/*.js` bundles.
//
// Mechanics verified LIVE on 2026-09-19:
//
// Search (`searchByName` / `resolveHltbId`):
//   1. GET /api/search/site/init?t=<ms> -> `{ token, hpKey, hpVal }`. A
//      short-lived, IP+UA-fingerprinted anti-bot token. `hpKey` is itself a
//      *dynamic field name* (e.g. "ign_6e333f4d"), not a fixed one: the client
//      must add `{ [hpKey]: hpVal }` to the POST body below, IN ADDITION to
//      sending `hpKey`/`hpVal` as headers - both are checked server-side.
//   2. POST /api/search/site, headers `{ x-auth-token: token, x-hp-key: hpKey,
//      x-hp-val: hpVal }`, JSON body `{ searchType:'games',
//      searchTerms:[...words], searchPage:1, size:20, searchOptions:{ games:
//      {...}, users:{...}, lists:{...}, filter:'', sort:0, randomizer:0 },
//      useCache:true, [hpKey]: hpVal }` -> `{ count, data:[{ game_id,
//      game_name, game_type, comp_main, comp_100, comp_all_count,
//      invested_mp_count, release_world (YEAR ONLY in this response), ... }] }`.
//      A 403 means the token was rejected/expired - re-`init` once and retry.
//      DEVIATION from the 2022 legacy scraper: search results no longer carry
//      `profile_steam` (confirmed 2026-09-19) - only the per-game detail
//      payload does, so a strong Steam-id match now requires fetching detail
//      for the best-name-matching candidates instead of reading it straight
//      out of the search response (see `resolveHltbId`).
//
// Detail (`fetchDetail`):
//   Primary: GET /_next/data/<buildId>/game/<id>.json?gameId=<id> ->
//     `{ pageProps: { game: { data: { game: [ {..., profile_steam,
//     release_world (a full YYYY-MM-DD here, unlike the search response),
//     release_na, release_eu, release_jp, comp_main, comp_100, game_type,
//     comp_all_count, invested_mp_count, ...} ] } } } }`. `buildId` comes from
//     the `"buildId":"..."` embedded in the homepage HTML (same trick the
//     legacy PHP used). A 404 here almost always means the buildId rotated on
//     a new HLTB deploy (verified: an intentionally-stale buildId 404s even
//     for a game id that exists) - refetch the homepage once and retry.
//   Fallback (only once the buildId-refresh retry above still 404s): GET
//     /game/<id> and parse the `<script id="__NEXT_DATA__"
//     type="application/json">` tag - same shape at
//     `.props.pageProps.game.data.game[0]` (verified 2026-09-19: this HTML
//     route keeps working even with a stale/unknown buildId).

import { toAscii } from './gog.js';
import { normalizeName, simpleSim, searchNameVariants } from '../lib/names.js';
import { parseDate } from '../lib/dates.js';

export const name = 'hltb';

// 1 request / 2s by default (config.sources.hltb.rateLimit overrides).
export const rateLimit = { max: 1, duration: 2000 };

const HOME_URL = 'https://howlongtobeat.com/';
const initUrl = () => `https://howlongtobeat.com/api/search/site/init?t=${Date.now()}`;
const SEARCH_URL = 'https://howlongtobeat.com/api/search/site';
const nextDataUrl = (buildId, id) => `https://howlongtobeat.com/_next/data/${buildId}/game/${id}.json?gameId=${id}`;
const gameUrl = (id) => `https://howlongtobeat.com/game/${id}`;

const DEFAULT_REFRESH_DAYS = 60;
const DEFAULT_DAILY_CAP = 3000;
const YEAR_TOLERANCE = 1;
const FUZZY_MIN_SIM = 90; // simpleSim percent a non-exact title needs before the release year may confirm it
// How many name-ranked search candidates get a detail fetch (to check
// profile_steam / a precise release date) per game - bounds the worst-case
// number of HTTP calls a single fetchOne makes.
const CANDIDATE_DETAIL_LOOKUPS = 5;
// Once the literal-words search and the normalized-name fallback both miss
// (or decideLink can't confirm either), try up to this many of the
// remaining searchNameVariants() entries (e.g. "Nioh 2" once "The Complete
// Edition" is stripped) as further /api/search/site searches.
const MAX_VARIANT_SEARCHES = 3;

// ---------------------------------------------------------------------------
// Dynamic-value caches (module state, deliberately tiny). `_resetCaches` is a
// test-only escape hatch so tests/sources/hltb.test.js can start from a clean
// slate without reaching into module internals.
// ---------------------------------------------------------------------------

let cachedToken = null; // { token, hpKey, hpVal }
let cachedBuildId = null;

export function _resetCaches() {
  cachedToken = null;
  cachedBuildId = null;
}

async function fetchSearchToken(http) {
  const body = await http.getJson(initUrl(), {
    headers: { referer: HOME_URL, origin: 'https://howlongtobeat.com' },
  });
  cachedToken = { token: body.token, hpKey: body.hpKey, hpVal: body.hpVal };
  return cachedToken;
}

async function fetchBuildId(http) {
  const html = await http.getText(HOME_URL);
  const m = html.match(/"buildId":"(.*?)"/);
  if (!m) throw new Error('hltb: buildId not found in homepage HTML (site markup changed)');
  cachedBuildId = m[1];
  return cachedBuildId;
}

/** Pure: build the POST body for /api/search/site. Exported for tests. */
export function buildSearchPayload(terms, token) {
  const body = {
    searchType: 'games',
    searchTerms: terms,
    searchPage: 1,
    size: 20,
    searchOptions: {
      games: {
        userId: 0,
        platform: '',
        sortCategory: 'popular',
        rangeCategory: 'main',
        rangeTime: { min: 0, max: 0 },
        gameplay: { perspective: '', flow: '', genre: '', difficulty: '' },
        modifier: '',
      },
      users: { sortCategory: 'postcount' },
      lists: { sortCategory: 'follows' },
      filter: '',
      sort: 0,
      randomizer: 0,
    },
    useCache: true,
  };
  if (token?.hpKey) body[token.hpKey] = token.hpVal;
  return body;
}

/**
 * POST one search, refreshing the token and retrying once on a 403 (expired
 * or rejected token). `http` is `ctx.http` (see src/lib/http.js).
 */
async function searchSite(http, terms) {
  let token = cachedToken ?? (await fetchSearchToken(http));
  const attempt = () =>
    http.postJson(SEARCH_URL, buildSearchPayload(terms, token), {
      headers: {
        'x-auth-token': token.token,
        'x-hp-key': token.hpKey,
        'x-hp-val': token.hpVal,
        referer: HOME_URL,
        origin: 'https://howlongtobeat.com',
      },
    });
  try {
    return await attempt();
  } catch (err) {
    if (err?.statusCode !== 403) throw err;
    token = await fetchSearchToken(http);
    return attempt();
  }
}

/** Pure: `__NEXT_DATA__` script body -> the same `game[0]` shape `fetchDetail()` resolves to. Exported for tests. */
export function parseNextData(html) {
  const m = String(html ?? '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const json = JSON.parse(m[1]);
    return json?.props?.pageProps?.game?.data?.game?.[0] ?? null;
  } catch {
    return null;
  }
}

async function fetchDetailFromGamePage(http, hltbId) {
  try {
    const html = await http.getText(gameUrl(hltbId));
    return parseNextData(html);
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

async function fetchDetailViaNextData(http, buildId, hltbId) {
  try {
    const body = await http.getJson(nextDataUrl(buildId, hltbId));
    return body?.pageProps?.game?.data?.game?.[0] ?? null;
  } catch (err) {
    if (err?.statusCode === 404) return undefined; // sentinel: caller decides whether to retry
    throw err;
  }
}

/**
 * Fetch one game's raw detail payload by HLTB id (the object stored as
 * `source_records.payload` and fed to `extract()`), or `null` when HLTB has
 * nothing at that id. See the module header for the buildId-refresh /
 * `__NEXT_DATA__`-fallback mechanics.
 */
export async function fetchDetail(http, hltbId) {
  const buildId = cachedBuildId ?? (await fetchBuildId(http));
  let result = await fetchDetailViaNextData(http, buildId, hltbId);
  if (result !== undefined) return result;

  // Stale buildId (a new HLTB deploy) - refresh once and retry.
  const freshBuildId = await fetchBuildId(http);
  result = await fetchDetailViaNextData(http, freshBuildId, hltbId);
  if (result !== undefined) return result;

  // Last resort: the plain game page still renders __NEXT_DATA__ even when
  // the Next.js data route 404s (verified 2026-09-19).
  return fetchDetailFromGamePage(http, hltbId);
}

// ---------------------------------------------------------------------------
// Name matching / link decision (pure - fixture/fake-fed tests, no network)
// ---------------------------------------------------------------------------

function normKey(raw) {
  return normalizeName(toAscii(raw ?? ''), { convertRom: true }).toLowerCase();
}

// HLTB types a title as 'game', 'endless' (online/no-ending: R.E.P.O., Cuisine Royale, SteamVR...) or 'multi'
// besides the add-on kinds below; only the add-ons are never what we want to link. Accepting 'game' alone
// silently lost every online game (found 2026-09-23: R.E.P.O. came back as the single search row, typed 'endless').
const HLTB_ADDON_TYPES = new Set(['dlc', 'mod', 'pack', 'compilation']);

/** `search.data` rows -> `{ id, name, year }`, standalone titles only (see HLTB_ADDON_TYPES). Exported for tests. */
export function mapSearchCandidates(rows) {
  return (rows ?? [])
    .filter((r) => r?.game_id != null && !HLTB_ADDON_TYPES.has(String(r?.game_type ?? '').toLowerCase()))
    .map((r) => ({
      id: String(r.game_id),
      name: r.game_name,
      year: yearOf(r.release_world),
    }));
}

function yearOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).slice(0, 4));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** `{ exact, sim }` of `candidateName` against `targetName` - same shape as gog.js's matching. Exported for tests. */
export function scoreCandidate(candidateName, targetName) {
  const candNorm = normKey(candidateName);
  const targetNorm = normKey(targetName);
  const exact = candNorm !== '' && candNorm === targetNorm;
  const sim = simpleSim(toAscii(targetName ?? ''), toAscii(candidateName ?? ''));
  return { exact, sim };
}

/**
 * Pure link decision. `candidates`: `[{ id, name, year, detail? }]` (`detail`
 * is the `fetchDetail()` payload already fetched for that candidate, or
 * omitted/null when not fetched). `target`: `{ name, steamAppid, releaseYear }`.
 *
 * Rules (plan T14):
 *   - any candidate whose `detail.profile_steam` equals `target.steamAppid`
 *     -> `{ status: 'strong', confidence: 100 }` (checked across *all*
 *     candidates with a fetched detail, regardless of name similarity - a
 *     Steam id match is authoritative even when HLTB's title differs).
 *   - else the best exact-normalized-name candidate confirmed by release
 *     year (+/-`yearTolerance`, default 1) -> `{ status: 'weak', confidence:
 *     70 }`. The year comes from the candidate's own detail (`release_world`
 *     is a full date there) when fetched, else the search row's year
 *     (`release_world` is year-only in search results).
 *   - else the most similar candidate with `sim >= FUZZY_MIN_SIM` (90) confirmed
 *     by release year the same way -> `{ status: 'weak', confidence: 60 }`.
 *   - otherwise `{ status: 'not_found' }`.
 *
 * Exported for tests: fed fake candidates, no network involved.
 */
export function decideLink(candidates, target, opts = {}) {
  const yearTolerance = opts.yearTolerance ?? YEAR_TOLERANCE;
  const steamAppid = target?.steamAppid ?? null;
  const targetYear = target?.releaseYear ?? null;

  const scored = (candidates ?? []).map((c) => ({ ...c, ...scoreCandidate(c.name, target?.name) }));

  if (steamAppid) {
    const strong = scored.find((c) => c.detail && Number(c.detail.profile_steam) === Number(steamAppid));
    if (strong) return { status: 'strong', id: strong.id, confidence: 100 };
  }

  const exactConfirmed = scored.find((c) => {
    if (!c.exact) return false;
    const candidateYear = c.detail?.release_world ? yearOf(c.detail.release_world) : c.year;
    return targetYear != null && candidateYear != null && Math.abs(candidateYear - targetYear) <= yearTolerance;
  });
  if (exactConfirmed) return { status: 'weak', id: exactConfirmed.id, confidence: 70 };

  // Near-identical title (subtitle punctuation, a dropped article, "Remastered" spelled differently)
  // confirmed by the release year: the sequel/DLC neighbours score far lower (Yakuza 3 vs 5: 59,
  // "Dark Alley Elf" vs "Dark Elf": 73), so the bar stays high. Owner asked for this (2026-09-22).
  const fuzzyConfirmed = [...scored]
    .sort((a, b) => b.sim - a.sim)
    .find((c) => {
      if (c.sim < FUZZY_MIN_SIM) return false;
      const candidateYear = c.detail?.release_world ? yearOf(c.detail.release_world) : c.year;
      return targetYear != null && candidateYear != null && Math.abs(candidateYear - targetYear) <= yearTolerance;
    });
  if (fuzzyConfirmed) return { status: 'weak', id: fuzzyConfirmed.id, confidence: 60 };

  return { status: 'not_found' };
}

/**
 * Rank `rows` by name closeness to `target.name` (best chance of an early
 * strong/weak match), fetch detail for up to `CANDIDATE_DETAIL_LOOKUPS` of
 * them - stopping as soon as a Steam-id match is confirmed - and return
 * `decideLink`'s decision plus the looked-up candidates (so the caller can
 * resolve `decision.id` back to its fetched `detail`).
 */
async function rankAndDecide(http, rows, target) {
  const ordered = [...rows].sort((a, b) => {
    const sa = scoreCandidate(a.name, target.name);
    const sb = scoreCandidate(b.name, target.name);
    return Number(sb.exact) - Number(sa.exact) || sb.sim - sa.sim;
  });

  const lookups = ordered.slice(0, CANDIDATE_DETAIL_LOOKUPS);
  for (const candidate of lookups) {
    candidate.detail = await fetchDetail(http, candidate.id);
    if (target.steamAppid && Number(candidate.detail?.profile_steam) === Number(target.steamAppid)) break;
  }

  return { decision: decideLink(lookups, target), lookups };
}

/**
 * Search by name and resolve to one HLTB id (or `not_found`). Orchestrates
 * `searchSite`/`fetchDetail`/`decideLink` across up to three tiers of
 * queries, each tier only tried once the previous one comes back with no
 * rows or a `decideLink` `not_found`:
 *   1. the literal title, split on whitespace;
 *   2. `normalizeName(name, { convertRom: true })` (drops editions/
 *      punctuation the literal title carries - mirrors the legacy scraper's
 *      multi-attempt strategy for titles HLTB's own search doesn't tokenize
 *      well);
 *   3. up to `MAX_VARIANT_SEARCHES` of the remaining `searchNameVariants(name)`
 *      entries (a dangling article stripped, a marketing suffix like
 *      "Complete Edition"/"Remastered" stripped, the part before a
 *      subtitle/edition separator) - each of these is matched against the
 *      VARIANT string itself, not the original name, since a HLTB entry
 *      found under "Nioh 2" was, by construction, never going to carry the
 *      "The Complete Edition" suffix that query no longer has.
 * Every tier keeps the same Steam id / release year for `decideLink`.
 */
async function resolveHltbId(http, game) {
  const targetName = game.name;
  const target = {
    name: targetName,
    steamAppid: game.steam_appid ?? null,
    releaseYear: game.release_date ? yearOf(game.release_date) : null,
  };

  const primaryTerms = toAscii(targetName).trim().split(/\s+/).filter(Boolean);
  if (primaryTerms.length === 0) return { status: 'not_found' };

  const triedQueries = new Set([primaryTerms.join(' ').toLowerCase()]);

  let rows = mapSearchCandidates((await searchSite(http, primaryTerms))?.data);
  let result = rows.length > 0 ? await rankAndDecide(http, rows, target) : null;

  if (!result || result.decision.status === 'not_found') {
    const altTerms = normalizeName(targetName, { convertRom: true }).split(' ').filter(Boolean);
    const altKey = altTerms.join(' ').toLowerCase();
    if (altTerms.length > 0 && !triedQueries.has(altKey)) {
      triedQueries.add(altKey);
      const altRows = mapSearchCandidates((await searchSite(http, altTerms))?.data);
      if (altRows.length > 0) {
        const altResult = await rankAndDecide(http, altRows, target);
        if (!result || altResult.decision.status !== 'not_found') result = altResult;
      }
    }
  }

  if (!result || result.decision.status === 'not_found') {
    let variantSearches = 0;
    for (const variant of searchNameVariants(targetName)) {
      if (variantSearches >= MAX_VARIANT_SEARCHES) break;
      const key = variant.toLowerCase();
      if (triedQueries.has(key)) continue;
      triedQueries.add(key);
      variantSearches += 1;

      const variantTerms = variant.split(/\s+/).filter(Boolean);
      if (variantTerms.length === 0) continue;
      const variantRows = mapSearchCandidates((await searchSite(http, variantTerms))?.data);
      if (variantRows.length === 0) continue;

      // Compare candidates against the VARIANT string, not the original
      // name - a candidate found under "Nioh 2" is an exact match for the
      // "Nioh 2" query, not for "Nioh 2 - The Complete Edition".
      const variantTarget = { ...target, name: variant };
      const variantResult = await rankAndDecide(http, variantRows, variantTarget);
      if (variantResult.decision.status !== 'not_found') {
        result = variantResult;
        break;
      }
      result = result ?? variantResult;
    }
  }

  if (!result || result.decision.status === 'not_found') return { status: 'not_found' };
  const { decision, lookups } = result;
  const chosen = lookups.find((c) => c.id === decision.id);
  return { status: decision.status, id: decision.id, confidence: decision.confidence, detail: chosen?.detail ?? null };
}

// ---------------------------------------------------------------------------
// extract() - pure: stored payload -> vocabulary fields
// ---------------------------------------------------------------------------

/** Seconds -> hours, 1 decimal; `null` for missing/zero (HLTB uses 0 for "no data"). */
function toHours(seconds) {
  if (!seconds) return null;
  return Math.round((seconds / 3600) * 10) / 10;
}

/**
 * Pure: `payload` is the raw HLTB detail `game[0]` object as stored by
 * `fetchOne` (see the module header for its shape).
 */
export function extract(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};

  const releaseRaw = payload.release_world ?? payload.release_na ?? payload.release_eu ?? payload.release_jp ?? null;
  const release = parseDate(releaseRaw);
  if (release.date) out.release = release;

  const timeMain = toHours(payload.comp_main);
  if (timeMain !== null) out.timeMain = timeMain;
  const timeComplete = toHours(payload.comp_100);
  if (timeComplete !== null) out.timeComplete = timeComplete;

  if (payload.profile_steam) {
    out.links = {
      steam: { id: String(payload.profile_steam), url: `https://store.steampowered.com/app/${payload.profile_steam}` },
    };
  }

  return out;
}

// ---------------------------------------------------------------------------
// fetchOne() - load the game, link (or reuse the link), upsert, enqueue resolve
// ---------------------------------------------------------------------------

export async function fetchOne(ctx, job) {
  const db = ctx.db;
  const http = ctx.http;
  const gameId = Number(job.data.gameId);

  const game = await db.one(
    `SELECT id, name, steam_appid, release_date FROM games WHERE id = ? LIMIT 1`,
    [gameId],
  );
  if (!game) {
    throw new Error(`hltb: games.id=${gameId} not found`);
  }

  const existingLink = await db.one(
    `SELECT external_id, match_method, confidence FROM game_links WHERE game_id = ? AND source = 'hltb' LIMIT 1`,
    [gameId],
  );

  let hltbId = existingLink?.external_id ?? null;
  let method = existingLink?.match_method ?? 'name';
  let confidence = existingLink?.confidence ?? 100;
  let detail;

  if (hltbId) {
    // Already linked (legacy migration or Wikidata P2816): fetch by id
    // directly, no search, and keep the existing method/confidence.
    detail = await fetchDetail(http, hltbId);
    if (!detail) {
      // HLTB renumbers/merges pages: 68 of the first 18k games (Mortal Kombat X, Guilty Gear Strive, ...)
      // carried a Wikidata/legacy id that 404s while the game is still there under a new id (2026-09-22).
      // Fall through to the name search and relink instead of giving up.
      hltbId = null;
    }
  }
  if (!hltbId) {
    const decision = await resolveHltbId(http, game);
    if (decision.status === 'not_found') {
      // Recorded under a per-game key (no HLTB id exists) so planRefresh() stops re-picking the same
      // unmatched games every day - they pushed the real backlog out of the daily cap (seen 2026-09-22:
      // half of the 8000 slots went to games already searched the day before).
      await ctx.upsertRecord(name, `game-${gameId}`, { status: 'not_found', gameId, error: 'hltb: no match by name' });
      return { status: 'not_found', gameId };
    }
    hltbId = decision.id;
    detail = decision.detail;
    method = 'name';
    confidence = decision.confidence;
  }

  await ctx.upsertRecord(name, hltbId, { status: 'ok', payload: detail, gameId });
  await ctx.upsertLink(gameId, name, hltbId, {
    url: gameUrl(hltbId),
    method,
    confidence,
  });
  await ctx.enqueueResolve(gameId);

  return { status: 'ok', externalId: hltbId, gameId, method, confidence };
}

// ---------------------------------------------------------------------------
// planRefresh() / discover() - daily schedule: enqueue stale/missing games
// ---------------------------------------------------------------------------

/**
 * Not a catalog source (HLTB has no browsable list worth crawling) - instead,
 * this is what the daily `discover` schedule (src/queue.js
 * `scheduleRepeatables`) runs: enqueue a `fetch` job for every game with no
 * `hltb` `source_records` row, or whose row is older than
 * `config.sources.hltb.refreshDays` (default 60), popular games first
 * (`owners_estimate DESC`, NULLs last), capped at
 * `config.sources.hltb.dailyCap` per run (default 3000). Re-enqueuing a game
 * that already has a pending job is a no-op (`enqueue()` dedupes by jobId -
 * see src/queue.js).
 */
export async function planRefresh(ctx) {
  const db = ctx.db;
  const sourceConfig = ctx.config?.sources?.[name] ?? {};
  const refreshDays = sourceConfig.refreshDays ?? DEFAULT_REFRESH_DAYS;
  const dailyCap = Number(sourceConfig.dailyCap ?? DEFAULT_DAILY_CAP);

  const rows = await db.query(
    `SELECT g.id AS gameId
     FROM games g
     LEFT JOIN source_records sr ON sr.source = 'hltb' AND sr.game_id = g.id
     WHERE sr.id IS NULL OR sr.fetched_at < DATE_SUB(NOW(), INTERVAL ? DAY)
     ORDER BY g.owners_estimate DESC
     LIMIT ?`,
    [refreshDays, dailyCap],
  );

  let enqueued = 0;
  for (const row of rows ?? []) {
    await ctx.enqueue(name, { gameId: row.gameId });
    enqueued += 1;
  }

  await db.query(
    `INSERT INTO source_state (source, last_run_at, stats)
     VALUES (?, NOW(), ?)
     ON DUPLICATE KEY UPDATE last_run_at = VALUES(last_run_at), stats = VALUES(stats)`,
    [name, JSON.stringify({ candidates: rows?.length ?? 0, enqueued, refreshDays, dailyCap })],
  );

  ctx.log?.info?.('hltb: planRefresh complete', { candidates: rows?.length ?? 0, enqueued, refreshDays, dailyCap });
  return { candidates: rows?.length ?? 0, enqueued, refreshDays, dailyCap };
}

// src/queue.js/src/worker.js schedule/run whatever a module exports as
// `discover` - HLTB's "discovery" is this refresh plan, not a catalog crawl.
export const discover = planRefresh;

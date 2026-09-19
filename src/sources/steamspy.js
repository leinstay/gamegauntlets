// SteamSpy: bulk owner/score refresh + per-app tag enrichment (plan
// docs/plans/2026-09-19-rewrite-plan.md task T13). Legacy reference:
// legacy/ajax/scripts/cron_scripts/SGG/steamspy.php.
//
// Endpoints (verified live against https://steamspy.com/api.php on
// 2026-09-19 - see the task report for the verification transcript):
//
//   - `request=all&page=N`: an object keyed by appid, 1000 entries/page,
//     pages ordered by owners descending (page 0 = the most-owned apps).
//     Every entry carries `owners`/`positive`/`negative`/`userscore` but
//     never `tags` (that key is simply absent, not empty) - `request=all`
//     is a lightweight bulk snapshot, not the same payload as `appdetails`.
//     Documented limit: 1 request/60s. There is no `have_more`-style field
//     or total-page count in the response; requesting a page past the end
//     of SteamSpy's own data returns HTTP 500 with an empty body (confirmed
//     live: page 85 -> 200 OK, page 92 -> 500; this is the only way to know
//     the walk is done). Because a rate-limit violation would presumably
//     also come back as a 5xx, `discover()` cannot tell "we hit the end of
//     the catalog" apart from "our own pacing was too aggressive" - the
//     mitigation is simply to keep `allPageDelayMs` at least as large as the
//     documented 60s limit (see the config comment below) so the ambiguity
//     essentially never triggers, and to accept that a false positive only
//     costs the rest of *that day's* pass (a "full pass" always restarts
//     paging from 0, so nothing is permanently missed).
//   - `request=appdetails&appid=N`: one app, always HTTP 200. A "no data for
//     this appid" response still has `appid` set but `name: null` (and
//     `tags: []` - an array, not the usual object - plus every other field
//     zeroed/nulled); a *known* app's response has `tags` as an object
//     keyed by tag name -> vote count, already ordered by vote count
//     descending (confirmed live: Portal 2's top tag is "Platformer" at
//     7477 votes, strictly decreasing after). Documented limit: 1
//     request/second.
//
// Owners bucket semantics (IMPORTANT, see parseOwnersMidpoint): legacy
// stored the *midpoint* of SteamSpy's "lo .. hi" owners range (e.g.
// "1,000,000 .. 2,000,000" -> 1500000), not either bound - see
// legacy/ajax/scripts/cron_scripts/SGG/steamspy.php lines 97-103. The
// resolver's `resolver.ggScore.ownerBuckets` / `resolver.ggp.owners` tables
// (config.json) key on exactly these midpoint values, so this module must
// reproduce that formula bit-for-bit rather than inventing its own bucketing.
//
// scoreSteam replicates a legacy quirk (steamspy.php lines 108-115): when
// computing positive/(positive+negative), an empty (0/null/missing) side is
// coerced to 1 before dividing - so an app with a few negative reviews and
// literally zero positive ones still gets a small nonzero score instead of
// a hard 0. `scoreSteamVotes` is new (not a legacy column) and uses the
// *raw* positive+negative instead, so a genuinely review-less app has no
// score/votes at all rather than a synthetic "2 votes".
//
// discover() vs fetchOne(): `request=all` already carries everything needed
// for `ownersEstimate`/`scoreSteam`/`scoreSteamVotes`, so discover() writes
// `source_records` directly from the bulk page for every appid we already
// track (`games.steam_appid`) - no per-app queueing, matching how
// src/sources/wikidata.js's SPARQL sweep applies records directly instead of
// enqueueing `fetch` jobs. `fetchOne()` (request=appdetails, 1/s) is for a
// single game's `tags` and is only ever queued explicitly (new game refresh,
// admin "run now", periodic per-game refreshDays) - `discover()` never
// enqueues it. Since a discover() pass can overwrite a game's
// `source_records` row that fetchOne() had previously enriched with tags,
// discover() carries the previous `tags` value forward into the new record
// so a routine bulk refresh never silently drops tags a prior fetchOne
// already learned (see the `tags: prevPayload?.tags` line below).

export const name = 'steamspy';

// BullMQ limiter for the `fetchOne` (appdetails) queue - SteamSpy documents
// 1 request/second for appdetails; overridable via
// config.sources.steamspy.rateLimit. This is unrelated to `allPageDelayMs`
// below, which paces discover()'s own `request=all` walk (a much slower,
// separately-documented limit) rather than queued jobs.
export const rateLimit = { max: 1, duration: 1500 };

const ALL_URL = 'https://steamspy.com/api.php?request=all';
const APPDETAILS_URL = 'https://steamspy.com/api.php?request=appdetails';

// Conservative pacing between `request=all&page=N` calls - the documented
// limit is 1/60s; overridable via config.sources.steamspy.allPageDelayMs.
const DEFAULT_ALL_PAGE_DELAY_MS = 60_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildAllUrl(page) {
  return `${ALL_URL}&page=${Number(page)}`;
}

export function buildAppDetailsUrl(appid) {
  return `${APPDETAILS_URL}&appid=${encodeURIComponent(String(appid))}`;
}

// --- walkAllPages (paging) -------------------------------------------

/**
 * Walk `request=all` starting at `startPage`, yielding `{ page, entries }`
 * (`entries` = `Object.values()` of the page's appid-keyed body) until a page
 * comes back empty or `getPage` throws an HTTP 500 (SteamSpy's documented
 * out-of-range-page signal - see the module header). Any other thrown error
 * propagates so a real failure aborts the walk instead of being mistaken for
 * "done". Pure control flow (no db/log access) - `getPage` is injected so
 * this is unit-testable without touching the network, mirroring
 * src/sources/steam.js's `walkAppList`.
 */
export async function* walkAllPages(getPage, { startPage = 0 } = {}) {
  let page = startPage;
  for (;;) {
    let body;
    try {
      body = await getPage(page);
    } catch (err) {
      if (err?.statusCode === 500) return;
      throw err;
    }
    const entries = Object.values(body ?? {});
    if (entries.length === 0) return;
    yield { page, entries };
    page += 1;
  }
}

// --- source_state (cursor/progress) -----------------------------------

function parseJsonColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value; // mysql2 may already have parsed the JSON column
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function ensureStateRow(db) {
  await db.query('INSERT INTO source_state (source) VALUES (?) ON DUPLICATE KEY UPDATE source = source', [name]);
}

async function loadState(db) {
  return db.one('SELECT cursor_state, paused FROM source_state WHERE source = ?', [name]);
}

async function saveCursor(db, cursorState) {
  await db.query('UPDATE source_state SET cursor_state = ?, last_run_at = NOW() WHERE source = ?', [JSON.stringify(cursorState), name]);
}

async function markFullPass(db, stats) {
  await db.query(
    'UPDATE source_state SET cursor_state = ?, last_full_pass_at = NOW(), last_run_at = NOW(), last_error = NULL, stats = ? WHERE source = ?',
    [JSON.stringify({ nextPage: 0 }), JSON.stringify(stats), name],
  );
}

async function markError(db, message) {
  await db.query('UPDATE source_state SET last_error = ?, last_run_at = NOW() WHERE source = ?', [String(message).slice(0, 4000), name]);
}

// --- discover() ---------------------------------------------------------

function fieldsEqual(a, b) {
  return a.ownersEstimate === b.ownersEstimate && a.scoreSteam === b.scoreSteam && a.scoreSteamVotes === b.scoreSteamVotes;
}

/**
 * Bulk refresh: walk `request=all` from the persisted page cursor (or 0),
 * and for every entry whose appid matches a `games.steam_appid` we already
 * track, store it as `source_records('steamspy', appid)` (carrying forward
 * any `tags` a prior `fetchOne()` learned - see the module header) and
 * enqueue a resolve only when `ownersEstimate`/`scoreSteam`/`scoreSteamVotes`
 * actually changed. The page cursor is saved after every page so a crash/
 * restart resumes instead of re-walking from page 0; only a pass that runs
 * to completion (or errors) resets it back to 0 for the next scheduled run.
 */
export async function discover(ctx) {
  const { db, http, log, config } = ctx;
  const sourceConfig = config?.sources?.steamspy ?? {};
  if (sourceConfig.enabled === false) {
    log.info('steamspy: discover skipped (source disabled)');
    return { skipped: true };
  }

  await ensureStateRow(db);
  const state = await loadState(db);
  if (state?.paused) {
    log.info('steamspy: discover skipped (paused)');
    return { skipped: true };
  }

  const pageDelayMs = sourceConfig.allPageDelayMs ?? DEFAULT_ALL_PAGE_DELAY_MS;
  const cursor = parseJsonColumn(state?.cursor_state);
  const startPage = Number.isInteger(cursor?.nextPage) ? cursor.nextPage : 0;

  const [gameRows, recordRows] = await Promise.all([
    db.query("SELECT id, steam_appid FROM games WHERE kind = 'steam' AND steam_appid IS NOT NULL"),
    db.query('SELECT external_id, payload FROM source_records WHERE source = ?', [name]),
  ]);
  const gameIdByAppid = new Map(gameRows.map((row) => [String(row.steam_appid), row.id]));
  const prevPayloadByAppid = new Map(recordRows.map((row) => [String(row.external_id), parseJsonColumn(row.payload)]));

  const stats = { pages: 0, seen: 0, matched: 0, changed: 0, resolvesEnqueued: 0 };

  let firstRequest = true;
  const getPage = async (page) => {
    if (!firstRequest) await sleep(pageDelayMs);
    firstRequest = false;
    // retries: 0 - a page past the end of SteamSpy's data reliably 500s (see
    // the module header); retrying that a default 3 times would just waste
    // ~15s of backoff on every routine full pass for a result we already
    // know how to interpret. A genuine transient error one page earlier
    // would otherwise have been retried by http.js before reaching here.
    return http.getJson(buildAllUrl(page), { retries: 0 });
  };

  try {
    for await (const { page, entries } of walkAllPages(getPage, { startPage })) {
      stats.pages += 1;
      for (const entry of entries) {
        stats.seen += 1;
        const appid = String(entry.appid);
        const gameId = gameIdByAppid.get(appid);
        if (gameId === undefined) continue; // not a game we track - the steam source owns catalog discovery
        stats.matched += 1;

        const prevPayload = prevPayloadByAppid.get(appid) ?? null;
        const payload = { ...entry, tags: prevPayload?.tags };
        const changed = !prevPayload || !fieldsEqual(extract(prevPayload), extract(payload));

        await ctx.upsertRecord(name, appid, { status: 'ok', payload, gameId });
        prevPayloadByAppid.set(appid, payload);

        if (changed) {
          await ctx.enqueueResolve(gameId);
          stats.changed += 1;
          stats.resolvesEnqueued += 1;
        }
      }
      await saveCursor(db, { nextPage: page + 1 });
    }
  } catch (err) {
    await markError(db, err?.message ?? String(err));
    log.error('steamspy: discover failed', { error: err, stats });
    throw err;
  }

  await markFullPass(db, stats);
  log.info('steamspy: discover full pass complete', stats);
  return stats;
}

// --- fetchOne() -------------------------------------------------------

/**
 * Fetch and store one app's `request=appdetails` payload (tags + a fresher
 * owners/score reading). Never creates a `games` row - SteamSpy only
 * enriches a Steam game the `steam` source already catalogued.
 */
export async function fetchOne(ctx, job) {
  const { db, http, log } = ctx;
  const externalId = String(job?.data?.externalId ?? '');
  const jobGameId = job?.data?.gameId || null;
  if (!externalId) throw new Error('steamspy.fetchOne: job.data.externalId is required');

  let body;
  try {
    body = await http.getJson(buildAppDetailsUrl(externalId));
  } catch (err) {
    await ctx.upsertRecord(name, externalId, { status: 'error', error: String(err?.message ?? err), gameId: jobGameId });
    throw err; // let BullMQ retry per DEFAULT_JOB_OPTIONS
  }

  if (!body || body.name === null || body.name === undefined) {
    await ctx.upsertRecord(name, externalId, { status: 'not_found', error: 'steamspy: no data for this appid', gameId: jobGameId });
    return { status: 'not_found', externalId };
  }

  let gameId = jobGameId;
  if (!gameId) {
    const existing = await db.one('SELECT id FROM games WHERE steam_appid = ? LIMIT 1', [externalId]);
    gameId = existing?.id ?? null;
  }
  if (!gameId) {
    await ctx.upsertRecord(name, externalId, { status: 'not_found', error: 'no matching games row for this steam appid', gameId: null });
    log.warn('steamspy: fetchOne has no matching games row', { externalId });
    return { status: 'not_found', externalId, reason: 'unmatched' };
  }

  await ctx.upsertRecord(name, externalId, { status: 'ok', payload: body, gameId });
  await ctx.upsertLink(gameId, name, externalId, {
    url: `https://steamspy.com/app/${externalId}`,
    method: 'store',
    confidence: 100,
  });
  await ctx.enqueueResolve(gameId);

  return { status: 'ok', externalId, payload: body };
}

// --- extract() ------------------------------------------------------------

function isEmptyLike(value) {
  return value === undefined || value === null || value === '' || value === 0 || (typeof value === 'number' && Number.isNaN(value));
}

/**
 * Replicates legacy/ajax/scripts/cron_scripts/SGG/steamspy.php lines
 * 108-115 exactly, including its quirk of coercing an empty side to 1
 * before dividing (see the module header). Returns `null` when both
 * `positive` and `negative` are empty (no review data at all - legacy's
 * `store_uscore = NULL`). `scoreSteamVotes` is new: the raw (uncoerced)
 * total, so a review-less app has no votes rather than a synthetic 2.
 */
export function computeSteamScore(positiveRaw, negativeRaw) {
  if (isEmptyLike(positiveRaw) && isEmptyLike(negativeRaw)) return null;
  const positive = isEmptyLike(positiveRaw) ? 1 : Number(positiveRaw);
  const negative = isEmptyLike(negativeRaw) ? 1 : Number(negativeRaw);
  const scoreSteam = Math.round((positive / (positive + negative)) * 100);
  const rawPositive = isEmptyLike(positiveRaw) ? 0 : Number(positiveRaw);
  const rawNegative = isEmptyLike(negativeRaw) ? 0 : Number(negativeRaw);
  return { scoreSteam, scoreSteamVotes: rawPositive + rawNegative };
}

/**
 * `"1,000,000 .. 2,000,000"` -> `1500000` (the midpoint of the range),
 * replicating legacy/ajax/scripts/cron_scripts/SGG/steamspy.php lines
 * 97-103 bit-for-bit (strip `&nbsp;`/spaces/commas, split on `..`, average
 * the two bounds) - see the module header for why this must be the midpoint
 * and not either bound. Returns `null` for anything that doesn't parse into
 * exactly two numeric bounds.
 */
export function parseOwnersMidpoint(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/&nbsp;/gi, '').replace(/[\s,]/g, '');
  const parts = cleaned.split('..');
  if (parts.length !== 2) return null;
  const lo = parseInt(parts[0], 10);
  const hi = parseInt(parts[1], 10);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return Math.round((lo + hi) / 2);
}

/**
 * Pure: a stored `source_records` payload (either a `request=all` entry, a
 * `request=appdetails` response, or discover()'s merge of the two - see the
 * module header) -> the extracted-field vocabulary
 * (docs/plans/2026-09-19-rewrite-plan.md, "Extracted-field vocabulary").
 * Never touches the network or the database.
 *
 * `playtimeMedianMinutes`/`playtimeAverageMinutes` (added for games.time_average -
 * see src/lib/resolver/time.js's resolveAveragePlaytime) come straight out of
 * `median_forever`/`average_forever`, already present on every payload this
 * module ever stores (both `request=all` and `request=appdetails` carry them) -
 * no new request, so a stored source_records row can be re-extracted for free.
 * Both are 0, not absent, on SteamSpy's own "no data" sentinel and for the
 * (very common) case of a small/unreviewed game SteamSpy has no playtime
 * sample for at all - `isEmptyLike`-style zero-filtering (only emit when > 0)
 * keeps a genuine "unknown" from resolving to "0 hours".
 */
export function extract(payload) {
  if (!payload) return {};
  const appid = payload.appid;
  if (appid === undefined || appid === null) return {};
  if (payload.name === null || payload.name === undefined) return {}; // SteamSpy's own "no data" sentinel

  const out = {};
  out.steamAppid = Number(appid);

  const ownersEstimate = parseOwnersMidpoint(payload.owners);
  if (ownersEstimate !== null) out.ownersEstimate = ownersEstimate;

  const score = computeSteamScore(payload.positive, payload.negative);
  if (score) {
    out.scoreSteam = score.scoreSteam;
    out.scoreSteamVotes = score.scoreSteamVotes;
  }

  const medianForever = Number(payload.median_forever);
  if (Number.isFinite(medianForever) && medianForever > 0) out.playtimeMedianMinutes = medianForever;
  const averageForever = Number(payload.average_forever);
  if (Number.isFinite(averageForever) && averageForever > 0) out.playtimeAverageMinutes = averageForever;

  // `tags` is an object (name -> vote count, already ranked) on a known app,
  // but an empty *array* on SteamSpy's "no data" sentinel - Array.isArray
  // guards that even though the sentinel is already filtered out above.
  if (payload.tags && typeof payload.tags === 'object' && !Array.isArray(payload.tags)) {
    const tagNames = Object.keys(payload.tags);
    if (tagNames.length) out.tags = tagNames;
  }

  return out;
}

// Steam catalog source (docs/plans/2026-09-19-rewrite-plan.md T8; ingestion
// order/responsibilities: docs/specs/2026-09-19-rewrite-design.md §5.1).
//
// `ISteamApps/GetAppList/v2` (used by the legacy site, see
// legacy/ajax/scripts/cron_scripts/SGG/steam_main.php) is deprecated by
// Valve and now returns HTTP 404 ("Method 'GetAppList' not found in
// interface 'ISteamApps'", confirmed live 2026-09-19); catalog discovery
// uses `IStoreService/GetAppList/v1` instead (verified live against
// https://api.steampowered.com/IStoreService/GetAppList/v1/ and
// https://partner.steamgames.com/doc/webapi/IStoreService while building
// this module - response shape:
// `{ response: { apps: [{appid, name, last_modified, price_change_number}],
// have_more_results, last_appid } }`). Per-app detail comes from the public
// (undocumented but stable, and the one the legacy site already relies on)
// `store.steampowered.com/api/appdetails` endpoint:
// `{ "<appid>": { success, data } }`, `data` missing/absent when
// `success` is false.
//
// ROOT CAUSE of the T8b delisting incident (5,890 live games marked
// `steam_delisted = 1` after two `discover()` passes): `discover()` used to
// treat "appid absent from two consecutive GetAppList passes" as sufficient
// evidence of delisting and wrote `games.steam_delisted = 1` directly for
// every such appid. That signal is not reliable - confirmed empirically
// (2026-09-19, server-side, key from `/opt/gg/.env`, never printed) by
// paging `IStoreService/GetAppList/v1` to completion (`have_more_results`
// false, matching this module's own `walkAppList()` cursor logic) twice:
// once with this module's exact request params (`include_games=1`,
// `include_dlc/software/videos/hardware=0`) - 187,175 apps across 4 pages -
// and once with every `include_*` flag set to `1` - 252,462 apps across 6
// pages. Neither walk contains GTA V (271590, "Grand Theft Auto V Legacy"),
// Half-Life 2: Lost Coast (340), Fall Guys (1097150), EA SPORTS FIFA 23
// (1811260), Half-Life 2: Episode Two (420), or Forza Horizon 4 (1293830) -
// while `appdetails?appids=<id>&l=english&cc=us` returns `success:true`,
// `data.type:'game'` and a normal, current `release_date` for all six. So
// this isn't a paging bug, a wrong `include_*` flag, or a type/region
// mismatch in this module's request: `GetAppList` itself silently omits
// some titles (observed: old Valve tech-demo/legacy apps and some
// third-party AAA titles) from its enumerable catalog while they stay fully
// live and reachable by direct appid - a known gap in this endpoint, not a
// delisting signal. Fix: `discover()` no longer writes `steam_delisted` at
// all (bulk or otherwise); GetAppList absence only ever triggers a
// `fetchOne` re-check, and only two independently-timed `appdetails`
// failures (see `fetchOne` below) can mark a game delisted.
//
// ROLLING-BATCH REDESIGN (2026-09-19 OOM incident): `discover()` used to walk
// the ENTIRE current catalog on EVERY run (`walkAppList`, still below, and
// still used - just no longer unconditionally, see PART A) and `enqueue()` a
// `fetch` job for every appid that looked new or changed - on a freshly
// cut-over DB where almost nothing had a `source_records` row yet, that meant
// ~187k jobs added to Redis in one `discover()` call. Redis (`maxmemory
// 900mb`, `noeviction`) hit its limit (106k "OOM command not allowed" errors
// in 12h) and every *other* source's enqueue calls started failing too,
// while the `steam` queue itself only drains at its configured rate limit (1
// job / 6s by default) - so >99% of those jobs would have just sat in Redis
// for two weeks regardless.
//
// `discover()` runs often (`config.sources.steam.discoverCron`, default
// every 2 hours) but keeps most of that Redis exposure bounded, in two
// independent parts:
//
// PART A - daily catalog walk (brand-new appids + the missing/delisting
// recheck; review follow-up after the first cut of this redesign dropped it
// entirely - see git history for that iteration's own reasoning, since
// superseded): once every `config.sources.steam.catalogWalkHours` (default
// 24h, gated on `cursor_state.lastCatalogWalkAt`), `discover()` walks the
// FULL current catalog with the existing `walkAppList`/`buildAppListUrl`
// exactly as before - a handful of `IStoreService/GetAppList/v1` requests,
// cheap - holding the catalog's ~190k appids in a couple of JS `Set`s for
// the duration of that one call (a few MB; fine - what actually caused the
// OOM incident was *enqueueing* everything into Redis, not walking the
// catalog in memory once). From that walk:
//   - "new" appid = in the catalog but with NEITHER a `games.steam_appid`
//     row NOR ANY `source_records` row (any status) for source `steam` with
//     that external_id - i.e. truly never touched, not a DLC/non-game we
//     already recorded `not_found` for and not a stale-but-known game. These
//     are enqueued FIRST, before anything in part B, with a distinguished
//     BullMQ `priority` (`NEW_APPID_JOB_PRIORITY`) so they're eligible to run
//     ahead of undifferentiated jobs already waiting - and they bypass part
//     B's "queue already full" gate entirely, since in steady state there
//     are only a handful of genuinely new Steam apps per day. The very first
//     walk after a cutover (or a long gap) can find many at once though, so
//     this is still capped at `batchSize` per run (newest appid first); any
//     remainder is simply left for the next run to pick up - nothing about
//     the remainder is persisted beyond its count in `stats` - and
//     `cursor_state.lastCatalogWalkAt` (the gate above) is only stamped once
//     a walk's remainder is 0, so an oversized backlog of new appids drives
//     a walk on every 2-hourly `discover()` call (catching up fast) instead
//     of waiting the full 24h between walks.
//   - the two-consecutive-walks "missing from the catalog" recheck is
//     restored with its pre-existing semantics (see the ROOT CAUSE note
//     below - this was never a delisting signal on its own): appids known
//     from `games` but absent from this walk are compared against
//     `cursor_state.missingAppids` (the small list left by the *previous*
//     walk); anything missing on both walks gets an ordinary `fetch` job
//     (no special priority), gated by `config.sources.steam.
//     missingRefreshDays` against that appid's own last `source_records`
//     fetch so this doesn't hammer `appdetails` for it daily.  The new
//     `missingAppids` list then replaces the old one in `cursor_state`.
//
// PART B - rolling SQL-priority batch (unchanged from the first cut of this
// redesign): reads the `steam` queue's `waiting`+`delayed` count
// (`ctx.queueCounts('steam')`, adjusted for whatever part A just enqueued),
// skips entirely once that is above half of `config.sources.steam.batchSize`
// (default 5000), trims an oversized existing backlog first via
// `ctx.trimQueue('steam', batchSize)` when `waiting` alone is more than 2x
// `batchSize` (nothing lost - the SQL query below re-derives candidates from
// `source_records`/`games`, not from Redis), then selects the next
// `batchSize` candidates via one SQL query (`CANDIDATE_SQL`), ordered
// (a) `games.kind='steam'` rows with no `source_records` row at all (never
// fetched even once) - newest `steam_appid` first, then (b) rows whose
// `source_records.fetched_at` is older than `config.sources.steam.
// refreshDays` - oldest-fetched first. No appid list is held in memory
// across calls for this part.
//
// - Delisting is decided entirely inside `fetchOne`, from `appdetails`
//   itself, never from catalog absence: a fetch whose `appdetails` calls
//   report `success:false` in *both* `l=english&cc=us` and `l=russian&cc=ru`
//   is one "failed check", recorded compactly as `payload.delistCheck` on
//   that appid's own `source_records` row (no new table). `games.
//   steam_delisted` only flips to `1` once a *second* failed check lands at
//   least `DELIST_RECHECK_GAP_MS` (24h) after the first - two independently
//   scheduled fetches agreeing, not two requests seconds apart in the same
//   job. Any later fetch where `en/us` succeeds clears the delisted flag and
//   the whole `delistCheck` state (the next successful payload overwrites
//   it). A fetch where `en/us` fails but `ru/ru` succeeds is treated as
//   inconclusive (not a failed check, not a clear) - Steam is known to be
//   inconsistent per-locale for a small number of apps.

import { normalizeName } from '../lib/names.js';
import { parseDate } from '../lib/dates.js';
import { classifyNonGame, bundleBaseName } from '../lib/non-game.js';
import { isPurgedTombstone, buildTombstonePayload } from '../pipeline/purge-non-games.js';

export const name = 'steam';

// BullMQ limiter default for the `steam` queue (overridable via
// `config.sources.steam.rateLimit`). `store.steampowered.com/api/appdetails`
// has no documented quota, but is known in practice to throttle a single IP
// at roughly 200 requests / 5 minutes (~1 per 1500ms sustained); 1600ms
// leaves a small margin. `fetchOne` itself makes up to 4 requests against
// that endpoint per job (en/ru/az/reviews) and pauses briefly between them
// (`requestDelayMs`) so one job execution doesn't burst past that budget on
// its own.
export const rateLimit = { max: 1, duration: 1600 };

const APPLIST_URL = 'https://api.steampowered.com/IStoreService/GetAppList/v1/';
const APPDETAILS_URL = 'https://store.steampowered.com/api/appdetails';
const APPREVIEWS_URL = 'https://store.steampowered.com/appreviews';
const APPREVIEWHISTOGRAM_URL = 'https://store.steampowered.com/appreviewhistogram';

const DEFAULT_MAX_RESULTS = 50000;
const DEFAULT_REQUEST_DELAY_MS = 350;
const EARLY_ACCESS_GENRE_ID = '70';

// discover()'s rolling-batch defaults (see the module-level comment, PART
// B) - overridable via `config.sources.steam.batchSize`/`refreshDays`.
// Exported so tests don't hardcode the magic numbers.
export const DEFAULT_BATCH_SIZE = 5000;
export const DEFAULT_REFRESH_DAYS = 3;

// How often discover() re-walks the full GetAppList catalog (PART A) -
// overridable via `config.sources.steam.catalogWalkHours`.
export const DEFAULT_CATALOG_WALK_HOURS = 24;

// Cadence at which the catalog walk re-enqueues a fetchOne for a known appid
// that has been missing from GetAppList for two or more consecutive walks -
// slower than a brand-new appid's immediate enqueue, since these titles need
// periodic refreshing (see the module-level comment) but aren't worth
// hitting the appdetails budget for every single day.
const DEFAULT_MISSING_REFRESH_DAYS = 3;

// BullMQ job priority passed as `enqueue()`'s job option for a brand-new
// appid's first fetch job (lower number = higher priority among prioritized
// jobs). Exported for tests, and NEEDS REVIEW: this bullmq version (6.x)
// actually drains its plain "wait" list before ever looking at prioritized
// jobs at all (see `moveToActive-11.lua` - RPOPLPUSH from wait, and only
// once that's empty does it fall back to the prioritized set), so an
// existing backlog of ordinary rolling-batch jobs is NOT jumped by this -
// it only wins over other *explicitly prioritized* jobs, and matters once
// the wait list is short/drained. Achieving a true "ahead of everything
// already waiting" would need a different mechanism (e.g. `lifo: true`, or
// giving every rolling-batch job an explicit lower priority too); flagged
// for the lead rather than guessed at here.
export const NEW_APPID_JOB_PRIORITY = 1;

// Minimum gap between two failed appdetails checks (see fetchOne) required
// to confirm a delisting. Exported so tests don't hardcode the magic number.
export const DELIST_RECHECK_GAP_MS = 24 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- discover() -------------------------------------------------------

/**
 * Build the IStoreService/GetAppList/v1 URL. `ifModifiedSince` is accepted
 * (per the documented parameter) but never set by `discover()` itself - see
 * the module-level comment for why.
 */
export function buildAppListUrl({ apiKey, lastAppid, maxResults = DEFAULT_MAX_RESULTS, ifModifiedSince } = {}) {
  const params = new URLSearchParams({
    key: apiKey,
    include_games: '1',
    include_dlc: '0',
    include_software: '0',
    include_videos: '0',
    include_hardware: '0',
    max_results: String(maxResults),
  });
  if (lastAppid) params.set('last_appid', String(lastAppid));
  if (ifModifiedSince) params.set('if_modified_since', String(ifModifiedSince));
  return `${APPLIST_URL}?${params.toString()}`;
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

async function readSourceState(db) {
  const row = await db.one('SELECT cursor_state, stats FROM source_state WHERE source = ?', [name]);
  if (!row) return { cursorState: null, stats: null };
  return { cursorState: parseJsonColumn(row.cursor_state), stats: parseJsonColumn(row.stats) };
}

async function writeSourceState(db, { cursorState, stats, touchLastRun = false, touchFullPass = false } = {}) {
  await db.query(
    `INSERT INTO source_state (source, cursor_state, stats, last_run_at, last_full_pass_at)
     VALUES (?, ?, ?, ${touchLastRun ? 'NOW()' : 'NULL'}, ${touchFullPass ? 'NOW()' : 'NULL'})
     ON DUPLICATE KEY UPDATE
       cursor_state = COALESCE(VALUES(cursor_state), source_state.cursor_state),
       stats = COALESCE(VALUES(stats), source_state.stats),
       last_run_at = COALESCE(VALUES(last_run_at), source_state.last_run_at),
       last_full_pass_at = COALESCE(VALUES(last_full_pass_at), source_state.last_full_pass_at)`,
    [name, cursorState === undefined ? null : JSON.stringify(cursorState), stats === undefined ? null : JSON.stringify(stats)],
  );
}

/**
 * Fetch every page of IStoreService/GetAppList/v1 via `getPage(lastAppid)`
 * (injected so this loop is unit-testable with a fake http), yielding each
 * page's `apps` array. Stops when `have_more_results` is falsy or a page
 * comes back empty. Pure control flow - no db/log access - so it is
 * reusable and separately testable from the db/enqueue side-effects in
 * `discover()`.
 */
export async function* walkAppList(getPage, { lastAppid = null, onPage } = {}) {
  let cursor = lastAppid;
  for (;;) {
    const res = await getPage(cursor);
    const body = res?.response ?? {};
    const apps = body.apps ?? [];
    yield apps;
    cursor = body.last_appid ?? cursor;
    if (onPage) await onPage({ cursor, haveMore: Boolean(body.have_more_results), count: apps.length });
    if (!body.have_more_results || apps.length === 0) break;
  }
}

// Selects the next batch of steam candidates straight from `games`/
// `source_records` (PART B - see the module-level comment). Priority is a
// single ORDER BY expression rather than two separate queries so the LIMIT
// applies to the combined, correctly-ordered set in one round trip:
//   - group 0 (`sr.id IS NULL`, never fetched even once): ordered by
//     `-g.steam_appid` ascending, i.e. `steam_appid` descending (newest
//     first);
//   - group 1 (has a `source_records` row older than `refreshDays`):
//     ordered by that row's `fetched_at` ascending (oldest-fetched first).
// `CASE WHEN sr.id IS NULL THEN 0 ELSE 1 END` sorts every group-0 row before
// every group-1 row regardless of the second column's value.
const CANDIDATE_SQL = `
  SELECT g.id AS gameId, g.steam_appid AS appid
  FROM games g
  LEFT JOIN source_records sr ON sr.source = ? AND sr.game_id = g.id
  WHERE g.kind = 'steam' AND g.steam_appid IS NOT NULL
    AND (sr.id IS NULL OR sr.fetched_at < DATE_SUB(NOW(), INTERVAL ? DAY))
  ORDER BY
    CASE WHEN sr.id IS NULL THEN 0 ELSE 1 END ASC,
    CASE WHEN sr.id IS NULL THEN -g.steam_appid ELSE UNIX_TIMESTAMP(sr.fetched_at) END ASC
  LIMIT ?
`;

/**
 * PART A helper: walk the full GetAppList catalog once, holding it (and
 * everything it's diffed against) in memory only for the duration of this
 * one call - see the module-level comment for why that's fine. Pure
 * side-effecting orchestration (db reads, the walk itself, `enqueue()`);
 * kept separate from `discover()` so that function stays readable.
 *
 * Returns `{ pages, seen, newFound, newAppidsEnqueued, newRemainder,
 * missingNow, missingVerifyEnqueued }` - `missingNow` is the small list of
 * appids known to `games` but absent from this walk, meant to be persisted
 * into `cursor_state.missingAppids` by the caller and compared against on
 * the *next* walk.
 */
async function runCatalogWalk(ctx, { apiKey, maxResults, batchSize, missingRefreshMs, previousMissing }) {
  const { db, http, log, enqueue } = ctx;

  const [gameRows, recordRows] = await Promise.all([
    db.query("SELECT steam_appid FROM games WHERE kind = 'steam' AND steam_appid IS NOT NULL"),
    db.query('SELECT external_id, UNIX_TIMESTAMP(fetched_at) AS fetchedAt FROM source_records WHERE source = ?', [name]),
  ]);

  const knownGameAppids = new Set(gameRows.map((row) => Number(row.steam_appid)));
  const recordedAppids = new Set(recordRows.map((r) => String(r.external_id)));
  const recordTimestamps = new Map(recordRows.map((r) => [String(r.external_id), Number(r.fetchedAt)]));

  const seen = new Set();
  const newCandidates = [];
  let pages = 0;

  const getPage = (lastAppid) => http.getJson(buildAppListUrl({ apiKey, lastAppid, maxResults }));
  for await (const apps of walkAppList(getPage)) {
    pages += 1;
    for (const app of apps) {
      const appid = Number(app.appid);
      if (!Number.isFinite(appid)) continue;
      seen.add(appid);
      // "new" = neither a games.steam_appid row nor ANY source_records row
      // (any status - this is what excludes DLC/non-games we already
      // recorded 'not_found' for, and any other already-touched appid).
      if (!knownGameAppids.has(appid) && !recordedAppids.has(String(appid))) {
        newCandidates.push(appid);
      }
    }
  }

  // Newest first, same priority convention as CANDIDATE_SQL's never-fetched
  // group; capped at batchSize, remainder left for a later walk (see the
  // module-level comment - nothing about it is persisted but its count).
  newCandidates.sort((a, b) => b - a);
  const toEnqueue = newCandidates.slice(0, batchSize);
  for (const appid of toEnqueue) {
    // `lifo` puts the job at the head of the wait list: with bullmq 5/6 a `priority` job only runs once the plain
    // wait list is empty, i.e. AFTER the rolling batch, which is the opposite of what new releases need.
    await enqueue(name, { externalId: String(appid) }, { lifo: true });
  }
  const newRemainder = newCandidates.length - toEnqueue.length;

  // Missing-from-catalog handling (restored pre-existing semantics - NOT a
  // delisting signal on its own, see the module-level ROOT CAUSE note).
  const missingNow = [...knownGameAppids].filter((appid) => !seen.has(appid));
  const previousMissingSet = new Set((previousMissing ?? []).map(Number));
  const missingTwice = missingNow.filter((appid) => previousMissingSet.has(appid));

  const nowMs = Date.now();
  let missingVerifyEnqueued = 0;
  for (const appid of missingTwice) {
    const priorFetchedAt = recordTimestamps.get(String(appid));
    const dueForRecheck = priorFetchedAt === undefined || nowMs - priorFetchedAt * 1000 >= missingRefreshMs;
    if (!dueForRecheck) continue;
    await enqueue(name, { externalId: String(appid) });
    missingVerifyEnqueued += 1;
  }

  log.info('steam: catalog walk complete', {
    pages, seen: seen.size, newFound: newCandidates.length, newEnqueued: toEnqueue.length, newRemainder,
    missing: missingNow.length, missingVerifyEnqueued,
  });

  return {
    pages,
    seen: seen.size,
    newFound: newCandidates.length,
    newAppidsEnqueued: toEnqueue.length,
    newRemainder,
    missingNow,
    missingVerifyEnqueued,
  };
}

/**
 * discover() - see the module-level comment for PART A (daily catalog walk:
 * brand-new appids + the missing/delisting recheck) and PART B (the
 * always-on rolling SQL-priority batch). Never writes `games.steam_delisted`
 * itself - see the module-level ROOT CAUSE note and `fetchOne`, which is the
 * only place a delisting is ever confirmed.
 */
export async function discover(ctx) {
  const { db, log, env, config, enqueue, queueCounts, trimQueue } = ctx;
  const sourceConfig = config?.sources?.steam ?? {};
  const batchSize = Math.max(1, Number(sourceConfig.batchSize ?? DEFAULT_BATCH_SIZE));
  const refreshDays = sourceConfig.refreshDays ?? DEFAULT_REFRESH_DAYS;
  const maxResults = sourceConfig.discoverMaxResults ?? DEFAULT_MAX_RESULTS;
  const catalogWalkMs = (sourceConfig.catalogWalkHours ?? DEFAULT_CATALOG_WALK_HOURS) * 60 * 60 * 1000;
  const missingRefreshMs = (sourceConfig.missingRefreshDays ?? DEFAULT_MISSING_REFRESH_DAYS) * 24 * 60 * 60 * 1000;

  const { cursorState } = await readSourceState(db);
  const nowMs = Date.now();
  const lastWalkAtMs = cursorState?.lastCatalogWalkAt ? Date.parse(cursorState.lastCatalogWalkAt) : NaN;
  const dueForWalk = !Number.isFinite(lastWalkAtMs) || nowMs - lastWalkAtMs >= catalogWalkMs;

  const counts = (await queueCounts?.(name)) ?? {};
  let waiting = Number(counts.waiting ?? 0);
  const delayed = Number(counts.delayed ?? 0);

  // --- PART A: daily (gated) catalog walk - bypasses PART B's queue-full gate. ---
  let walk = null;
  if (dueForWalk) {
    const apiKey = env?.STEAM_API_KEY;
    if (!apiKey) {
      log.error('steam: catalog walk skipped, STEAM_API_KEY is not set');
    } else {
      walk = await runCatalogWalk(ctx, { apiKey, maxResults, batchSize, missingRefreshMs, previousMissing: cursorState?.missingAppids });
      // PART B's own gate below should see the jobs PART A just added.
      waiting += walk.newAppidsEnqueued;
    }
  }

  // --- PART B: rolling SQL-priority batch, gated by queue fullness. ---
  let trimmed = 0;
  if (waiting > batchSize * 2) {
    trimmed = (await trimQueue?.(name, batchSize)) ?? 0;
    waiting = Math.max(0, waiting - trimmed);
    log.info('steam: discover trimmed an oversized backlog', { trimmed, waiting, batchSize });
  }

  const pending = waiting + delayed;
  const skipped = pending > batchSize / 2;
  let candidates = 0;
  let enqueued = 0;
  if (!skipped) {
    const rows = await db.query(CANDIDATE_SQL, [name, refreshDays, batchSize]);
    candidates = rows.length;
    for (const row of rows) {
      await enqueue(name, { gameId: row.gameId, externalId: String(row.appid) });
      enqueued += 1;
    }
  } else {
    log.info('steam: rolling batch skipped, queue not drained enough yet', { waiting, delayed, batchSize });
  }

  // --- persist state: one write, cursor_state only touched when the walk ran. ---
  const caughtUp = walk !== null && walk.newRemainder === 0;
  await writeSourceState(db, {
    cursorState: walk
      ? {
          lastCatalogWalkAt: caughtUp ? new Date(nowMs).toISOString() : (cursorState?.lastCatalogWalkAt ?? null),
          missingAppids: walk.missingNow,
        }
      : undefined,
    stats: {
      batchSize, refreshDays, waiting, delayed, trimmed, skipped, candidates, enqueued,
      ...(walk
        ? {
            walk: {
              pages: walk.pages, seen: walk.seen, newFound: walk.newFound, newEnqueued: walk.newAppidsEnqueued,
              newRemainder: walk.newRemainder, missing: walk.missingNow.length, missingVerifyEnqueued: walk.missingVerifyEnqueued,
            },
          }
        : {}),
    },
    touchLastRun: true,
    touchFullPass: walk !== null,
  });

  const result = {
    skipped: skipped || undefined,
    candidates,
    enqueued,
    batchSize,
    refreshDays,
    waiting,
    delayed,
    trimmed,
    ...(walk
      ? {
          newFound: walk.newFound,
          newAppidsEnqueued: walk.newAppidsEnqueued,
          newRemainder: walk.newRemainder,
          missing: walk.missingNow.length,
          missingVerifyEnqueued: walk.missingVerifyEnqueued,
        }
      : {}),
  };

  log.info('steam: discover complete', result);

  return result;
}

// --- fetchOne() ---------------------------------------------------------

function appDetailsUrl(appid, { l, cc, filters } = {}) {
  const params = new URLSearchParams({ appids: String(appid) });
  if (l) params.set('l', l);
  if (cc) params.set('cc', cc);
  if (filters) params.set('filters', filters);
  return `${APPDETAILS_URL}?${params.toString()}`;
}

// One page (100, the API's max) of helpfulness-ranked, all-time reviews (filter='all', NOT 'recent') -
// still exactly one HTTP request; `query_summary` (num_reviews/review_score/total_positive/
// total_negative/total_reviews) is confirmed live (2026-09-19) to be byte-for-byte identical whether
// num_per_page is 0 or 100 - it is always the all-time summary, unaffected by the page size - so the
// existing scoreSteam/scoreSteamVotes handling below needs no changes. See
// summarizeReviewPlaytime()/reduceReviewsResponse() for what's kept from the page before it's stored
// (never the review texts/authors - only a compact playtime summary).
function appReviewsUrl(appid) {
  const params = new URLSearchParams({
    json: '1',
    language: 'all',
    purchase_type: 'all',
    filter: 'all',
    review_type: 'all',
    num_per_page: '100',
  });
  return `${APPREVIEWS_URL}/${appid}?${params.toString()}`;
}

/** `sorted` ascending, non-empty -> the value at percentile `p` (0..100), linearly interpolated between ranks. */
function percentileOf(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function medianOf(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Reduce one appreviews page's `reviews` array to a compact playtime summary, in minutes:
 * `{ count, medianAtReview, p25AtReview, p75AtReview, medianForever }`, or `null` when no review has
 * any usable playtime at all.
 *
 * Bias note (see time.js's resolveAveragePlaytime for the fuller version of this note next to where
 * the result is actually consumed): Steam reviewers skew towards more-engaged players than the player
 * base as a whole, the page is helpfulness-ranked rather than a random sample, and
 * `playtime_at_review` records time *at the moment the review was written* rather than lifetime
 * playtime - the median of that series is nonetheless the most stable "typical playtime" estimate
 * available (less skewed by a handful of no-lifers than a mean would be), and it is presented as an
 * "average playtime" engagement indicator, not a completion time - legacy's SteamSpy-based row never
 * claimed to be one either.
 *
 * Per review: prefer `author.playtime_at_review`, falling back to `author.playtime_forever` when
 * `playtime_at_review` is missing or 0 (many older reviews predate that field); `medianForever` is a
 * separate series built only from reviews that actually have a nonzero `playtime_forever`, reported
 * alongside the primary at-review median for comparison/debugging (not itself consumed by the
 * resolver). A review with no usable minutes at all (both fields missing/0) is ignored outright, on
 * both series.
 */
export function summarizeReviewPlaytime(reviews) {
  if (!Array.isArray(reviews) || reviews.length === 0) return null;

  const atReview = [];
  const forever = [];
  for (const review of reviews) {
    const author = review?.author || {};
    const rawAtReview = Number(author.playtime_at_review);
    const rawForever = Number(author.playtime_forever);
    const hasAtReview = Number.isFinite(rawAtReview) && rawAtReview > 0;
    const hasForever = Number.isFinite(rawForever) && rawForever > 0;

    if (hasAtReview) atReview.push(rawAtReview);
    else if (hasForever) atReview.push(rawForever); // fallback per the doc above

    if (hasForever) forever.push(rawForever);
  }

  if (atReview.length === 0) return null;

  atReview.sort((a, b) => a - b);
  forever.sort((a, b) => a - b);

  return {
    count: atReview.length,
    medianAtReview: medianOf(atReview),
    p25AtReview: percentileOf(atReview, 25),
    p75AtReview: percentileOf(atReview, 75),
    medianForever: medianOf(forever),
  };
}

/**
 * `fetchOne`'s appreviews response -> what actually gets stored in `source_records.payload.reviews`:
 * just `success`/`query_summary` (already consumed by extract() for scoreSteam) - the raw per-review
 * `reviews` array (and `cursor`) is never stored; its only trace is the compact `reviewsPlaytime`
 * summary computed by `summarizeReviewPlaytime()` and stored as a sibling field on the payload (see
 * fetchOne). Passes through unchanged (including `null`, e.g. after a request failure).
 */
export function reduceReviewsResponse(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  return { success: raw.success, query_summary: raw.query_summary };
}

// `appreviewhistogram` (undocumented, same store.steampowered.com family as appdetails/appreviews;
// confirmed live 2026-09-19 for the task report) - `results.recent` is Steam's own last-~30-days daily
// bucket list (`{date, recommendations_up, recommendations_down}`), matching what the store page's
// "Recent Reviews" summary is built from. Verified two ways live: (a) for a busy game (Portal 2,
// appid 620) `results.recent` had exactly 30 entries spanning 2026-08-21..2026-09-19; (b) for a game
// with zero reviews (an unreleased title) `results.recent` was `[]`. Also confirmed live that
// `appreviews`'s own `query_summary` does NOT change with `day_range`/`filter=recent` - it is always
// the all-time summary regardless of those params (day_range/filter only affect which individual
// reviews `reviews[]` returns) - so the histogram endpoint is the only way to get a real 30-day
// aggregate. This is one extra HTTP request per steam.fetchOne call (see the task report).
function appReviewHistogramUrl(appid) {
  const params = new URLSearchParams({ l: 'english', review_score_preference: '0' });
  return `${APPREVIEWHISTOGRAM_URL}/${appid}?${params.toString()}`;
}

/**
 * Sum `recommendations_up`/`recommendations_down` across `appreviewhistogram`'s `results.recent`
 * (see `appReviewHistogramUrl`'s doc) into `{ positive, negative }`, or `null` when there's nothing to
 * sum (no recent reviews at all - the common case for an unreleased/delisted/very quiet game).
 */
export function sumRecentHistogram(recent) {
  if (!Array.isArray(recent) || recent.length === 0) return null;
  let positive = 0;
  let negative = 0;
  for (const bucket of recent) {
    const up = Number(bucket?.recommendations_up);
    const down = Number(bucket?.recommendations_down);
    if (Number.isFinite(up)) positive += up;
    if (Number.isFinite(down)) negative += down;
  }
  return positive + negative > 0 ? { positive, negative } : null;
}

async function fetchAppDetails(http, appid, opts) {
  const body = await http.getJson(appDetailsUrl(appid, opts));
  return body?.[String(appid)] ?? null;
}

/** Read this appid's own `source_records` row: its prior `delistCheck` state (if any) and stored `game_id`. */
async function readDelistCheck(db, appid) {
  const row = await db.one('SELECT payload, game_id FROM source_records WHERE source = ? AND external_id = ?', [name, appid]);
  if (!row) return { delistCheck: null, gameId: null };
  const payload = parseJsonColumn(row.payload);
  return { delistCheck: payload?.delistCheck ?? null, gameId: row.game_id ?? null };
}

/**
 * This appid's own `source_records` payload, parsed - used only by the "about to create a brand new
 * games row" branch of fetchOne() below to recognise a src/pipeline/purge-non-games.js tombstone
 * (`isPurgedTombstone()`) before ever inserting. `null` when there is no row yet (a genuinely new appid).
 */
async function readOwnSourceRecordPayload(db, appid) {
  const row = await db.one('SELECT payload FROM source_records WHERE source = ? AND external_id = ?', [name, appid]);
  return row ? parseJsonColumn(row.payload) : null;
}

/**
 * Record one failed appdetails check (`success:false` in both en/us and
 * ru/ru - see fetchOne) for `appid`. Only confirms `games.steam_delisted = 1`
 * when a *prior* failed check is already on file and it is at least
 * `DELIST_RECHECK_GAP_MS` old, i.e. two independently-scheduled fetches
 * agreeing - never two requests seconds apart within the same job. State is
 * kept in this appid's own `source_records.payload.delistCheck` (compact,
 * no new table, self-clearing: a later 'ok' upsert replaces the payload
 * wholesale).
 */
async function recordDelistCheckFailure(ctx, appid, jobGameId) {
  const { db, log } = ctx;
  const { delistCheck: prior, gameId: storedGameId } = await readDelistCheck(db, appid);
  const gameId = jobGameId || storedGameId || null;
  const nowMs = Date.now();
  const priorFailedAtMs = prior?.lastFailedAt ? Date.parse(prior.lastFailedAt) : NaN;
  const confirmed = Number.isFinite(priorFailedAtMs) && nowMs - priorFailedAtMs >= DELIST_RECHECK_GAP_MS;

  const delistCheck = {
    firstFailedAt: prior?.firstFailedAt ?? new Date(nowMs).toISOString(),
    lastFailedAt: new Date(nowMs).toISOString(),
    failCount: (prior?.failCount ?? 0) + 1,
  };
  if (confirmed) delistCheck.confirmedAt = new Date(nowMs).toISOString();

  await ctx.upsertRecord(name, appid, {
    status: 'not_found',
    error: 'appdetails success=false in both en/us and ru/ru',
    payload: { delistCheck },
    gameId,
  });

  if (confirmed && gameId) {
    await db.query('UPDATE games SET steam_delisted = 1 WHERE id = ?', [gameId]);
    log.info('steam: confirmed delisted (two appdetails failures at least 24h apart)', { appid, gameId });
  }

  return { confirmed, gameId };
}

/**
 * Fetch and store one Steam app. `job.data = { gameId?, externalId }`
 * (`externalId` is the Steam appid). See the module-level comment for the
 * en/ru/az/reviews request set, the not-found/non-game handling, and the
 * delisting rule (never decided from GetAppList absence - only from two
 * independently-timed appdetails failures here).
 */
export async function fetchOne(ctx, job) {
  const { db, http, log, config } = ctx;
  const appid = String(job?.data?.externalId ?? '');
  const jobGameId = job?.data?.gameId || null;
  if (!appid) throw new Error('steam.fetchOne: job.data.externalId is required');

  const requestDelayMs = config?.sources?.steam?.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS;

  let enEntry;
  try {
    enEntry = await fetchAppDetails(http, appid, { l: 'english', cc: 'us' });
  } catch (err) {
    await ctx.upsertRecord(name, appid, { status: 'error', error: String(err?.message ?? err), gameId: jobGameId });
    throw err; // let BullMQ retry per DEFAULT_JOB_OPTIONS
  }

  const enFound = Boolean(enEntry?.success && enEntry.data);

  if (!enFound) {
    // en/us alone is NOT a delisting signal (see the module-level ROOT
    // CAUSE note) - confirm with ru/ru before counting this as a failed
    // check at all.
    await sleep(requestDelayMs);
    let ruCheckEntry = null;
    try {
      ruCheckEntry = await fetchAppDetails(http, appid, { l: 'russian', cc: 'ru' });
    } catch (err) {
      log.warn('steam: ru appdetails verify check failed', { appid, error: String(err?.message ?? err) });
    }
    const ruFound = Boolean(ruCheckEntry?.success && ruCheckEntry.data);

    if (ruFound) {
      // Found via ru/ru even though en/us failed: inconclusive, not a
      // failed check and not a clear. We don't have full en data to refresh
      // the record from here; a later fetch (or the catalog's own
      // new/changed path once GetAppList sees it again) will pick it up.
      log.warn('steam: en/us appdetails failed but ru/ru succeeded, not counted as a delisting check', { appid });
      return { status: 'inconclusive', externalId: appid, reason: 'en-failed-ru-ok' };
    }

    const { confirmed } = await recordDelistCheckFailure(ctx, appid, jobGameId);
    return { status: 'not_found', externalId: appid, delisted: confirmed, reason: 'appdetails-failed-both-locales' };
  }

  if (enEntry.data.type !== 'game') {
    // `payload.appType` lets src/pipeline/resolve.js's classifyNonGame() (src/lib/non-game.js,
    // migrations/004_non_game.sql) see Steam's own type for a game this game_id already has - this
    // row's own status stays 'not_found' (never 'ok': a DLC/soundtrack/etc. must never get linked or
    // resolved as if it were a real game), so it's read directly off source_records by resolve.js
    // rather than through the normal extract()-only-runs-for-'ok'-rows path.
    await ctx.upsertRecord(name, appid, {
      status: 'not_found',
      payload: { appType: enEntry.data.type },
      error: `not a game (type=${enEntry.data.type})`,
      gameId: jobGameId,
    });
    return { status: 'not_found', externalId: appid, reason: 'not-a-game' };
  }

  // en/us succeeded: the game is confirmed live. Clear any pending or
  // confirmed delisting (self-healing - see the module-level comment).
  let gameId = jobGameId;
  if (!gameId) {
    const existing = await db.one('SELECT id FROM games WHERE steam_appid = ? LIMIT 1', [appid]);
    gameId = existing?.id ?? null;
  }
  if (gameId) {
    await db.query('UPDATE games SET steam_delisted = 0 WHERE id = ? AND steam_delisted = 1', [gameId]);
  }

  await sleep(requestDelayMs);
  let ruData = null;
  try {
    const ruEntry = await fetchAppDetails(http, appid, { l: 'russian', cc: 'ru' });
    ruData = ruEntry?.success ? ruEntry.data : null;
  } catch (err) {
    log.warn('steam: ru appdetails failed', { appid, error: String(err?.message ?? err) });
  }

  await sleep(requestDelayMs);
  let azData = null;
  try {
    const azEntry = await fetchAppDetails(http, appid, { cc: 'az', filters: 'price_overview' });
    azData = azEntry?.success ? azEntry.data : null;
  } catch (err) {
    log.warn('steam: az price appdetails failed', { appid, error: String(err?.message ?? err) });
  }

  await sleep(requestDelayMs);
  let reviews = null;
  let reviewsPlaytime = null;
  try {
    const reviewsRaw = await http.getJson(appReviewsUrl(appid));
    reviewsPlaytime = summarizeReviewPlaytime(reviewsRaw?.reviews);
    reviews = reduceReviewsResponse(reviewsRaw);
  } catch (err) {
    log.warn('steam: appreviews failed', { appid, error: String(err?.message ?? err) });
  }

  // Recent (last ~30 days) review counts - a second request, kept failure-tolerant exactly like the
  // appreviews call above: a failed histogram fetch must not fail the whole job, it just leaves the
  // recent numbers unset for this pass (see appReviewHistogramUrl's doc for why this endpoint and not
  // appreviews' own day_range param).
  await sleep(requestDelayMs);
  let recentReviews = null;
  try {
    const histogram = await http.getJson(appReviewHistogramUrl(appid));
    recentReviews = sumRecentHistogram(histogram?.results?.recent);
  } catch (err) {
    log.warn('steam: appreviewhistogram failed', { appid, error: String(err?.message ?? err) });
  }

  const payload = {
    appid,
    en: enEntry.data,
    ru: ruData,
    az: azData,
    reviews,
    reviewsPlaytime,
    recentReviews,
    fetchedAt: new Date().toISOString(),
  };

  if (!gameId) {
    // A previously purged appid (src/pipeline/purge-non-games.js) leaves this exact source_records row
    // tombstoned with a {purged:true,...} payload precisely so this "no games row yet" branch never
    // recreates it - discover() itself has no way to tell "purged" apart from "genuinely new" (see its
    // own module comment: an appid absent from `games` is always treated as new).
    const existingPayload = await readOwnSourceRecordPayload(db, appid);
    if (isPurgedTombstone(existingPayload)) {
      log.info('steam: appid was purged as a non-game, refusing to recreate', { appid, class: existingPayload.class });
      await ctx.upsertRecord(name, appid, {
        status: 'not_found',
        error: `purged non-game (${existingPayload.class})`,
        payload: existingPayload,
        gameId: null,
      });
      return { status: 'not_found', externalId: appid, reason: 'purged' };
    }

    const gameName = enEntry.data.name || `Steam App ${appid}`;
    const genreNames = Array.isArray(enEntry.data.genres)
      ? enEntry.data.genres.map((g) => g?.description).filter((d) => typeof d === 'string' && d.trim() !== '')
      : [];
    // src/pipeline/resolve.js's own "does a separate base-game row exist" lookup (classifyNonGame()'s
    // `bundle` class) - imported lazily (dynamic import) to avoid a static import cycle back through
    // resolve.js's own `getSource()` (src/sources/index.js), which loads every source module including
    // this one.
    const { findBaseGameExists } = await import('../pipeline/resolve.js');
    const base = bundleBaseName(gameName);
    const baseGameExists = base ? await findBaseGameExists(db, base) : false;
    const cls = classifyNonGame({ name: gameName, genres: genreNames, baseGameExists });

    if (cls) {
      log.info('steam: new appid classifies as non-game at creation time, not creating a games row', { appid, class: cls });
      await ctx.upsertRecord(name, appid, {
        status: 'not_found',
        error: `purged non-game (${cls})`,
        payload: buildTombstonePayload({ cls, name: gameName }),
        gameId: null,
      });
      return { status: 'not_found', externalId: appid, reason: 'non_game' };
    }

    const insertResult = await db.query(
      "INSERT INTO games (kind, name, name_normalized, steam_appid) VALUES ('steam', ?, ?, ?)",
      [gameName, normalizeName(gameName), appid],
    );
    gameId = insertResult.insertId;
  }

  await ctx.upsertRecord(name, appid, { status: 'ok', payload, gameId });
  await ctx.upsertLink(gameId, name, appid, {
    url: `https://store.steampowered.com/app/${appid}`,
    method: 'store',
    confidence: 100,
  });
  await ctx.enqueueResolve(gameId);

  return { status: 'ok', externalId: appid, payload };
}

// --- extract() ------------------------------------------------------------

const ENTITY_MAP = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  trade: '™',
};

function decodeEntities(input) {
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const key = entity.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITY_MAP, key) ? ENTITY_MAP[key] : match;
  });
}

/**
 * Strip Steam's lightly-HTML-formatted description fields to plain text,
 * keeping paragraph breaks and decoding entities.
 */
export function htmlToText(html) {
  if (!html) return undefined;
  let s = String(html);
  s = s.replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/gi, '\n');
  s = s.replace(/<\s*(p|div|li)[^>]*>/gi, '');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\r\n/g, '\n');
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s === '' ? undefined : s;
}

/**
 * Parse Steam's `supported_languages` field into `{ languages, voiceovers }`.
 * Per-language full-audio-support markers are a literal `*` immediately
 * after the language name (usually wrapped in `<strong>*</strong>`); the
 * trailing "*languages with full audio support" legend is introduced by a
 * `<br>` and is dropped, not read as a per-language marker.
 */
export function parseLanguages(raw) {
  if (!raw) return { languages: [], voiceovers: [] };
  let s = String(raw).replace(/\[/g, '<').replace(/\]/g, '>');
  s = decodeEntities(s);
  const [langPart] = s.split(/<br\s*\/?>/i);
  const stripped = langPart.replace(/<[^>]+>/g, '').replace(/#lang_[^,]*,?/gi, '');

  const languages = [];
  const voiceovers = [];
  for (const rawPart of stripped.split(',')) {
    const hasAudio = rawPart.includes('*');
    const cleaned = rawPart.replace(/\*/g, '').trim();
    if (!cleaned) continue;
    languages.push(cleaned);
    if (hasAudio) voiceovers.push(cleaned);
  }
  return { languages, voiceovers };
}

function extractStoreRelease(releaseDate) {
  if (!releaseDate) return undefined;
  if (releaseDate.coming_soon) return { date: null, precision: 'unknown' };
  if (!releaseDate.date) return undefined;
  return parseDate(releaseDate.date);
}

function isEarlyAccess(genres, categories) {
  const inGenres = Array.isArray(genres) && genres.some((g) => String(g?.id) === EARLY_ACCESS_GENRE_ID);
  const inCategories = Array.isArray(categories) && categories.some((c) => /early access/i.test(c?.description ?? ''));
  return inGenres || inCategories;
}

function extractPriceBlock(priceOverview) {
  if (!priceOverview || typeof priceOverview !== 'object' || Array.isArray(priceOverview)) return undefined;
  const { initial, final, discount_percent: discount } = priceOverview;
  if (typeof initial !== 'number' && typeof final !== 'number') return undefined;
  return {
    initial: typeof initial === 'number' ? initial : undefined,
    final: typeof final === 'number' ? final : undefined,
    discount: typeof discount === 'number' ? discount : 0,
  };
}

function namesOf(list) {
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim() !== '') : undefined;
}

/**
 * `steamPurchasable` (src/lib/purchasable.js, `games.purchasable` - migrations/005_purchasable.sql):
 * `true`/`false` when `en` has enough evidence to decide, `undefined` ("no opinion") when it doesn't -
 * never a hard `false` from missing data alone. Free / priced / not-out-yet all win outright (an upcoming
 * game is never "unbuyable"); only a game that's none of those AND has a `package_groups` array (even
 * empty) reported at all gets a definitive verdict from that array's length - `en.package_groups` being
 * absent entirely (an old stored payload from before this field's callers started reading it, or a Steam
 * response shape we haven't seen) falls through to `undefined` rather than being treated as "confirmed
 * empty", per src/lib/purchasable.js's "tolerate old payloads" rule.
 */
function computeSteamPurchasable(en) {
  if (!en) return undefined;
  if (en.release_date?.coming_soon) return true;
  if (en.is_free) return true;
  const priceOverview = en.price_overview;
  if (priceOverview && (typeof priceOverview.initial === 'number' || typeof priceOverview.final === 'number')) return true;
  if (!Array.isArray(en.package_groups)) return undefined;
  return en.package_groups.length > 0;
}

/**
 * Pure: turn a stored `source_records` payload (`{ en, ru, az, reviews,
 * fetchedAt }`, as written by `fetchOne`) into the extracted-field
 * vocabulary (docs/plans/2026-09-19-rewrite-plan.md, "Extracted-field
 * vocabulary"). Never touches the network or the database.
 */
export function extract(payload) {
  const en = payload?.en;
  if (!en) return {};
  const ru = payload.ru;
  const az = payload.az;
  const reviews = payload.reviews;
  const reviewsPlaytime = payload.reviewsPlaytime;
  const recentReviews = payload.recentReviews;

  const out = {};

  if (typeof en.name === 'string' && en.name.trim() !== '') out.name = en.name;

  const descriptionEn = htmlToText(en.short_description);
  if (descriptionEn) out.descriptionEn = descriptionEn;
  const descriptionRu = htmlToText(ru?.short_description);
  if (descriptionRu) out.descriptionRu = descriptionRu;

  if (en.header_image) out.image = en.header_image;

  const appid = en.steam_appid ?? payload.appid;
  if (appid !== undefined && appid !== null) out.steamAppid = Number(appid);

  const storeRelease = extractStoreRelease(en.release_date);
  if (storeRelease) out.storeRelease = storeRelease;

  if (storeRelease && isEarlyAccess(en.genres, en.categories)) {
    out.earlyAccess = storeRelease;
  }

  out.isFree = Boolean(en.is_free);

  const prices = {};
  const usd = extractPriceBlock(en.price_overview);
  const rub = extractPriceBlock(ru?.price_overview);
  const cisUsd = extractPriceBlock(az?.price_overview);
  if (usd) prices.usd = usd;
  if (rub) prices.rub = rub;
  if (cisUsd) prices.cisUsd = cisUsd;
  if (Object.keys(prices).length > 0) out.prices = prices;

  const steamPurchasable = computeSteamPurchasable(en);
  if (steamPurchasable !== undefined) out.steamPurchasable = steamPurchasable;

  const platforms = [];
  if (en.platforms?.windows) platforms.push('WIN');
  if (en.platforms?.mac) platforms.push('MAC');
  if (en.platforms?.linux) platforms.push('LNX');
  if (platforms.length > 0) out.platforms = platforms;

  const developers = namesOf(en.developers);
  if (developers?.length) out.developers = developers;
  const publishers = namesOf(en.publishers);
  if (publishers?.length) out.publishers = publishers;

  if (Array.isArray(en.genres) && en.genres.length) {
    const genres = en.genres.map((g) => g?.description).filter((d) => typeof d === 'string' && d.trim() !== '');
    if (genres.length) out.genres = genres;
  }
  if (Array.isArray(en.categories) && en.categories.length) {
    const categories = en.categories.map((c) => c?.description).filter((d) => typeof d === 'string' && d.trim() !== '');
    if (categories.length) out.categories = categories;
  }

  const { languages, voiceovers } = parseLanguages(en.supported_languages);
  if (languages.length) out.languages = languages;
  if (voiceovers.length) out.voiceovers = voiceovers;

  if (typeof en.achievements?.total === 'number') out.achievements = en.achievements.total;

  const links = {};
  if (en.metacritic?.url) links.metacritic = { id: null, url: en.metacritic.url };
  if (Object.keys(links).length > 0) out.links = links;

  if (typeof en.metacritic?.score === 'number') {
    out.scoreCritics = en.metacritic.score;
    out.scoreCriticsSource = 'metacritic';
  }

  let scoreSteamVotes;
  if (reviews?.success && reviews.query_summary) {
    const { total_positive: totalPositive, total_reviews: totalReviews } = reviews.query_summary;
    if (typeof totalReviews === 'number' && totalReviews > 0 && typeof totalPositive === 'number') {
      out.scoreSteam = Math.round((totalPositive / totalReviews) * 100);
      scoreSteamVotes = totalReviews;
    }
  }
  if (scoreSteamVotes === undefined && typeof en.recommendations?.total === 'number') {
    scoreSteamVotes = en.recommendations.total;
  }
  if (scoreSteamVotes !== undefined) out.scoreSteamVotes = scoreSteamVotes;

  // Average playtime (games.time_average - see src/lib/resolver/time.js's resolveAveragePlaytime):
  // the median of reviewers' own playtime, computed by summarizeReviewPlaytime() and stored as
  // payload.reviewsPlaytime by fetchOne (never the raw review texts/authors). Only reported once
  // there's at least one usable review; p25/p75 are cheap to carry along and useful for debugging even
  // though the resolver itself only consumes the median + count.
  if (reviewsPlaytime && typeof reviewsPlaytime.count === 'number' && reviewsPlaytime.count > 0) {
    out.playtimeReviewsMedianMinutes = reviewsPlaytime.medianAtReview;
    out.playtimeReviewsCount = reviewsPlaytime.count;
    if (reviewsPlaytime.p25AtReview !== null && reviewsPlaytime.p25AtReview !== undefined) {
      out.playtimeReviewsP25Minutes = reviewsPlaytime.p25AtReview;
    }
    if (reviewsPlaytime.p75AtReview !== null && reviewsPlaytime.p75AtReview !== undefined) {
      out.playtimeReviewsP75Minutes = reviewsPlaytime.p75AtReview;
    }
  }

  // Recent (last ~30 days) review score - games.score_steam_recent/score_steam_recent_votes, mirroring
  // scoreSteam/scoreSteamVotes above but from appReviewHistogramUrl's summed positive/negative (see
  // sumRecentHistogram). Deliberately NOT fed into gg_score (src/lib/resolver/index.js) - it's a
  // separate "Recent reviews" card row (src/lib/steam-review-label.js), not part of the score formula.
  if (recentReviews && Number.isFinite(recentReviews.positive) && Number.isFinite(recentReviews.negative)) {
    const total = recentReviews.positive + recentReviews.negative;
    if (total > 0) {
      out.scoreSteamRecent = Math.round((recentReviews.positive / total) * 100);
      out.scoreSteamRecentVotes = total;
    }
  }

  return out;
}

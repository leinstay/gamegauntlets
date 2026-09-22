// GameFAQs enrichment source (docs/plans/2026-09-19-rewrite-plan.md T15).
// Legacy reference: legacy/ajax/scripts/cron_scripts/SGG/metacritic_gamefaq.php
// + legacy/ajax/scripts/cron_scripts/SGG/functions/metacritic_gamefaq_functions.php
// (gfqUrl(); the GameFAQs half of that file — the Metacritic half, metaUrl(),
// is a different source, not part of this task).
//
// No bulk catalog endpoint exists, so — like a real hltb.js — this module
// only ever fetches by game, one at a time: `discover()` enqueues `{gameId}`
// jobs for games needing (re)fetch, and `fetchOne()` does the linking
// (existing `game_links` row, else a name search) AND the fetch/parse.
//
// Endpoints (verified live 2026-09-19; see the task report for the full
// request/response transcript):
//   - Search: GET https://gamefaqs.gamespot.com/ajax/home_game_search?term=<name>
//     Returns a JSON array, one row per *abstract game* (not one row per
//     platform release) plus a trailing `{footer:true}` row. Each row's
//     `plats` lists every platform that game shipped on (e.g. "MAC, PC,
//     PS4"), but `platform_url`/`url`/`pid` point at ONE specific platform's
//     product page — not necessarily PC (confirmed live: searching
//     "assassins creed odyssey" returns the *PS4* product even though `plats`
//     includes PC). `pid` (== `gs_product_id`) is the id used in the page
//     URL and matches Wikidata's P4769 (confirmed live: gamefaqs.gamespot.com
//     /-/<pid>- 200s straight to that product; the *other* numeric field,
//     `game_id`, is an unrelated internal id and does NOT resolve the same
//     way — verified live, /-/<game_id>- redirected to a completely
//     different, unrelated game).
//   - Product page: GET https://gamefaqs.gamespot.com/<platform>/<pid>-<slug>
//     `#gs_difficulty_avg_hint` / `#gs_rate_avg_hint` / `#gs_length_avg_hint`
//     hold the aggregate label text (e.g. "Just Right (838)"; "Unrated" with
//     zero submissions); each one's *parent* `.gamespace_rate_half` carries a
//     `title="Average: 4.31 stars from 4105 users"` attribute with the actual
//     numeric average — used here for rating/length (cleaner than parsing
//     "Over 80 Hours (643)"; confirmed live the title reads "80+ hours" for
//     that same row). The difficulty *label* itself (not a numeric score) is
//     what the GGP table keys on, so it's read from the hint text, verbatim,
//     matching the legacy string exactly (`explode(' (', ...)[0]`, ported
//     as the same split). Release date lives in the `<aside>` game-info pod,
//     a `<li>` whose `.content` text starts with "Release:".
//   - When a search's default platform isn't PC but the game has a PC
//     release, that page's header carries a platform switcher
//     (`#header_more_menu a > .also_name`, e.g. "PC") linking to the actual
//     PC product page/pid — confirmed live (Assassin's Creed Odyssey: the
//     PS4 product's stats differ from the PC product's, so the switch is not
//     cosmetic). `fetchOne` follows that link before trusting the stats.
//
// Cookie / blocking: `GAMEFAQS_COOKIE` (may be stale) is sent when present,
// alongside a browser-like Accept/Accept-Language and this bot's normal User-
// Agent (src/lib/http.js); confirmed live that both the search endpoint and
// product pages currently answer 200 with NO cookie at all. A real block was
// also reproduced live, transiently, by firing several requests back-to-back
// with a thin header set: HTTP 403 with a Cloudflare "Just a moment..."
// interstitial (`challenge-platform` script) — recognised by
// `isBlockedResponse()`/`isBlockedBody()` below, plus the legacy IP-ban
// wording ("Your IP address has been ... blocked/restricted", "Blocked IP
// Address", "503 Service Temporarily Unavailable"). On a detected block,
// `pauseSource()` sets `source_state.paused = 1` and stashes a resume
// timestamp 24h out in `cursor_state.pausedUntil`; `discover()` clears the
// pause once that time has passed. `src/worker.js` already requeues (10 min
// later) any job for a paused source before calling `fetchOne`, so a single
// blocked request stops that source hammering the site rather than retrying
// immediately.
//
// See the task report for whether live scraping works today with/without
// GAMEFAQS_COOKIE (this workstation has no real cookie value to test with).

import { load } from 'cheerio';
import { normalizeName, simpleSim } from '../lib/names.js';
import { parseDate } from '../lib/dates.js';

export const name = 'gamefaqs';

// Task default: 1 request / 3 seconds. `fetchOne` may issue up to three
// requests per job (search, a default-platform page, the PC page), so the
// *effective* per-game request rate is roughly this limiter's rate x1-3;
// config.sources.gamefaqs.rateLimit overrides this in production.
export const rateLimit = { max: 1, duration: 3000 };

const BASE = 'https://gamefaqs.gamespot.com';
const SEARCH_URL = (term) => `${BASE}/ajax/home_game_search?term=${encodeURIComponent(term)}`;

const DEFAULT_REFRESH_DAYS = 90;
const DEFAULT_DAILY_CAP = 1500;
const BLOCK_PAUSE_HOURS = 24;
const YEAR_TOLERANCE = 1;
const FUZZY_MIN_SIM = 90; // simpleSim percent a non-exact title needs before the release year may confirm it — same bar as hltb.js decideLink
const FUZZY_LINK_CONFIDENCE = 60; // confidence stored for a link resolved via the fuzzy fallback (same tier hltb.js's decideLink uses for its own fuzzy match)

// Typographic punctuation game titles sometimes use in place of the ASCII
// character normalizeName() expects (curly quotes, en/em dash, ellipsis).
// Same table as src/sources/gog.js; kept local per that module's convention
// (each source owns its own toAscii()).
const ASCII_PUNCTUATION = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"',
  '–': '-', '—': '-', '−': '-',
  '…': '...',
};
const ASCII_PUNCTUATION_RE = /[‘’‚‛“”„‟–—−…]/g;

/** Fold typographic quotes/dashes/ellipsis down to their ASCII equivalents. */
export function toAscii(input) {
  if (input === null || input === undefined) return '';
  return String(input).replace(ASCII_PUNCTUATION_RE, (ch) => ASCII_PUNCTUATION[ch] ?? ch);
}

/** ASCII-fold + normalizeName + lowercase — the shared key used for exact-title comparison. */
function normKey(raw) {
  return normalizeName(toAscii(raw), { convertRom: true }).toLowerCase();
}

// ---------------------------------------------------------------------------
// Block detection (search + page fetches both go through this)
// ---------------------------------------------------------------------------

// NOT 'challenge-platform': Cloudflare injects that script into every normal 200 page of GameFAQs and
// Metacritic too (found live 2026-09-19 - the source paused itself on its first successful fetch).
const BLOCK_MARKERS = [
  'just a moment',
  'attention required! | cloudflare',
  'your ip address has been temporarily blocked',
  'your current ip address has been blocked',
  '503 service temporarily unavailable',
  'blocked ip address',
  'your ip address has been restricted',
  'cf-error-details',
];

/** Whether `text` (an HTML or JSON-ish response body) looks like a block/captcha page. */
export function isBlockedBody(text) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return BLOCK_MARKERS.some((marker) => lower.includes(marker));
}

/** Whether an HTTP response (status + body) indicates a block/captcha, not a normal error. */
export function isBlockedResponse(statusCode, bodyText) {
  if (statusCode === 403 || statusCode === 503) return true;
  return isBlockedBody(bodyText);
}

function pageHeaders(ctx) {
  const headers = {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'accept-language': 'en,ru;q=0.9,en-US;q=0.8,ru-RU;q=0.7',
    referer: `${BASE}/`,
  };
  const cookie = ctx?.env?.GAMEFAQS_COOKIE;
  if (cookie) headers.cookie = cookie;
  return headers;
}

function searchHeaders(ctx) {
  return {
    ...pageHeaders(ctx),
    accept: 'application/json, text/javascript, */*; q=0.01',
    'x-requested-with': 'XMLHttpRequest',
  };
}

/** GET one GameFAQs page. Returns `{ blocked, html }` (`html` is `null` on a 404 or a block). */
async function fetchGamefaqsPage(ctx, url) {
  try {
    const html = await ctx.http.getText(url, { headers: pageHeaders(ctx) });
    if (isBlockedBody(html)) return { blocked: true, html: null };
    return { blocked: false, html };
  } catch (err) {
    if (isBlockedResponse(err?.statusCode, err?.body)) return { blocked: true, html: null };
    if (err?.statusCode === 404) return { blocked: false, html: null };
    throw err;
  }
}

/** GET the home_game_search JSON for `term`. Returns `{ blocked, results }`. */
async function searchGamefaqs(ctx, term) {
  try {
    const results = await ctx.http.getJson(SEARCH_URL(term), { headers: searchHeaders(ctx) });
    return { blocked: false, results };
  } catch (err) {
    if (isBlockedResponse(err?.statusCode, err?.body)) return { blocked: true, results: null };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// source_state pause/resume (24h block cooldown)
// ---------------------------------------------------------------------------

function parseJsonColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value; // mysql2 may already have parsed the JSON column
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Pause this source for `BLOCK_PAUSE_HOURS`, recording why and when to try again. */
export async function pauseSource(ctx, reason, { now = () => Date.now() } = {}) {
  const { db } = ctx;
  const row = await db.one('SELECT cursor_state FROM source_state WHERE source = ?', [name]);
  const cursorState = parseJsonColumn(row?.cursor_state) || {};
  const pausedUntil = new Date(now() + BLOCK_PAUSE_HOURS * 60 * 60 * 1000).toISOString();
  await db.query(
    `INSERT INTO source_state (source, paused, cursor_state, last_error, last_run_at)
     VALUES (?, 1, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE paused = 1, cursor_state = VALUES(cursor_state), last_error = VALUES(last_error), last_run_at = NOW()`,
    [name, JSON.stringify({ ...cursorState, pausedUntil }), String(reason).slice(0, 4000)],
  );
}

/**
 * If currently paused, resume once `cursor_state.pausedUntil` has passed.
 * Returns `{ paused, pausedUntil? }` reflecting the state after this call.
 */
export async function checkAndMaybeResume(ctx, { now = () => Date.now() } = {}) {
  const { db } = ctx;
  const row = await db.one('SELECT paused, cursor_state FROM source_state WHERE source = ?', [name]);
  if (!row?.paused) return { paused: false };

  const cursorState = parseJsonColumn(row.cursor_state) || {};
  const pausedUntilMs = cursorState.pausedUntil ? Date.parse(cursorState.pausedUntil) : NaN;
  if (Number.isFinite(pausedUntilMs) && pausedUntilMs <= now()) {
    await db.query('UPDATE source_state SET paused = 0, cursor_state = ? WHERE source = ?', [
      JSON.stringify({ ...cursorState, pausedUntil: null }),
      name,
    ]);
    return { paused: false };
  }
  return { paused: true, pausedUntil: cursorState.pausedUntil ?? null };
}

// ---------------------------------------------------------------------------
// Search result matching (pure)
// ---------------------------------------------------------------------------

/** Drop the trailing `{footer:true}` "see all results" row and anything without a usable id/name. */
function realCandidates(results) {
  if (!Array.isArray(results)) return [];
  return results.filter((row) => row && row.footer !== true && row.pid != null && typeof row.game_name === 'string');
}

/** `"MAC, NS, PC, PS4"` -> true/false for whether "PC" is one of the platforms. */
export function platsIncludePc(candidate) {
  return String(candidate?.plats ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .includes('PC');
}

/** Release year from a search row's `date_released` ("2018-10-02") or `release_date` ("2018"); `null` for "TBA"/"Canceled"/missing. */
function yearOfCandidate(candidate) {
  const full = String(candidate?.date_released ?? '').match(/^(\d{4})-/);
  if (full) return Number(full[1]);
  const y = Number(candidate?.release_date);
  return Number.isInteger(y) && y > 1900 && y < 3000 ? y : null;
}

/**
 * Pick the search result whose normalized title matches `name` exactly
 * (toAscii + normalizeName, per the task), confirmed by release year (±
 * `yearTolerance`, default 1) when more than one exact match exists and a
 * year is known.
 *
 * When no exact match exists, falls back to a similarity match — same rule
 * `decideLink` in `src/sources/hltb.js` uses: `simpleSim(toAscii(queryName),
 * toAscii(c.game_name)) >= FUZZY_MIN_SIM` (90) AND a candidate year
 * (`yearOfCandidate`) within `yearTolerance` of a *known* `opts.year`. Absent
 * a year on either side, a fuzzy candidate never qualifies — without that
 * independent confirmation the bar (90% similarity) alone lets sequel/DLC
 * neighbours through too easily (see hltb.js's comment on `decideLink`).
 * Exactly one qualifying fuzzy candidate -> `ok` with `fuzzy: true`; several
 * -> `ambiguous` (left for a `conflicts` row like an exact ambiguity);
 * none -> `none`, left for the caller's second (subtitle-stripped) query.
 *
 * Returns `{ status: 'none' }` | `{ status: 'ok', candidate, fuzzy? }` |
 * `{ status: 'ambiguous', candidates }`.
 */
export function matchGamefaqsCandidate(queryName, results, opts = {}) {
  const yearTolerance = opts.yearTolerance ?? YEAR_TOLERANCE;
  const year = opts.year ?? null;
  const wantNorm = normKey(queryName);
  const candidates = realCandidates(results);

  const exact = candidates.filter((c) => normKey(c.game_name) === wantNorm);
  if (exact.length === 1) return { status: 'ok', candidate: exact[0] };
  if (exact.length > 1) {
    if (year == null) return { status: 'ambiguous', candidates: exact };
    const withinYear = exact.filter((c) => {
      const cy = yearOfCandidate(c);
      return cy != null && Math.abs(cy - year) <= yearTolerance;
    });
    if (withinYear.length === 1) return { status: 'ok', candidate: withinYear[0] };
    return { status: 'ambiguous', candidates: exact };
  }

  // No exact match: a high-similarity title confirmed by release year.
  if (year != null) {
    const fuzzy = candidates.filter((c) => {
      const sim = simpleSim(toAscii(queryName), toAscii(c.game_name));
      if (sim < FUZZY_MIN_SIM) return false;
      const cy = yearOfCandidate(c);
      return cy != null && Math.abs(cy - year) <= yearTolerance;
    });
    if (fuzzy.length === 1) return { status: 'ok', candidate: fuzzy[0], fuzzy: true };
    if (fuzzy.length > 1) return { status: 'ambiguous', candidates: fuzzy };
  }

  return { status: 'none' };
}

// ---------------------------------------------------------------------------
// Page parsing (pure over an HTML string — no network/DB)
// ---------------------------------------------------------------------------

/** `href` of the `<a>` in `#header_more_menu` whose `.also_name` text is exactly "PC" (case-insensitive), or `null`. */
export function findPcAlternateUrl(html) {
  const $ = load(html);
  let href = null;
  $('#header_more_menu a').each((_, el) => {
    if (href) return;
    const label = $(el).find('.also_name').first().text().trim();
    if (/^pc$/i.test(label)) href = $(el).attr('href') || null;
  });
  return href;
}

/** `"241126"` from `"/pc/241126-assassins-creed-odyssey"`, or `null`. */
export function pidFromUrl(href) {
  const m = String(href ?? '').match(/\/[a-z0-9-]+\/(\d+)-/i);
  return m ? m[1] : null;
}

/** `false` for the "no submissions yet" placeholder GameFAQs shows (`'Unrated'`) or an empty hint. */
function isUsableHint(text) {
  const t = (text ?? '').trim();
  return t !== '' && t.toLowerCase() !== 'unrated';
}

/**
 * Parse one GameFAQs product page into the raw fields `fetchOne` stores as
 * `source_records.payload` (see the module-level comment for the selectors).
 * Pure: takes an HTML string, returns plain data, touches neither the
 * network nor the database — this is what the fixture tests exercise
 * directly. `difficultyLabel` is the verbatim GameFAQs scale string (e.g.
 * "Just Right"); `ratingTitle`/`lengthTitle` are the raw
 * `title="Average: X ... from Y users"` attributes (parsed into numbers by
 * `extract()`, not here, so the stored payload keeps the source's own
 * wording).
 */
export function parseGamefaqsPage(html) {
  const $ = load(html);

  const pageName = $('.page-title').first().text().trim() || null;

  const difficultyHint = $('#gs_difficulty_avg_hint').first().text().trim();
  const difficultyLabel = isUsableHint(difficultyHint) ? difficultyHint.split(' (')[0].trim() : null;

  const ratingHint = $('#gs_rate_avg_hint').first().text().trim();
  const ratingTitle = isUsableHint(ratingHint) ? $('#gs_rate_avg_hint').parent().attr('title') ?? null : null;

  const lengthHint = $('#gs_length_avg_hint').first().text().trim();
  const lengthTitle = isUsableHint(lengthHint) ? $('#gs_length_avg_hint').parent().attr('title') ?? null : null;

  let releaseRaw = null;
  $('aside .content').each((_, el) => {
    if (releaseRaw) return;
    const text = $(el).text();
    if (/Release:/i.test(text)) {
      const link = $(el).find('a').first().text().trim();
      releaseRaw = link !== '' ? link : null;
    }
  });

  return { pageName, difficultyLabel, ratingTitle, lengthTitle, releaseRaw };
}

/** First decimal/integer number in a string ("Average: 4.31 stars from…" -> 4.31; "…80+ hours…" -> 80), or `null`. */
function firstNumber(text) {
  if (!text) return null;
  const m = String(text).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// ---------------------------------------------------------------------------
// extract() — pure: stored payload -> vocabulary fields
// ---------------------------------------------------------------------------

/**
 * `payload` is what `fetchOne` upserts into `source_records.payload`:
 * `{ pid, url, pageName, difficultyLabel, ratingTitle, lengthTitle,
 * releaseRaw, fetchedAt }` (see `parseGamefaqsPage`).
 *
 * `timeGamefaqs` is exposed only as an informational, source-prefixed key —
 * `src/lib/resolver/index.js` (checked 2026-09-19) only ever reads
 * `timeMain`/`timeComplete` from `fieldsBySource.hltb` (or a bundled
 * legacy-snapshot fallback), never from `fieldsBySource.gamefaqs`, and
 * otherwise ignores any key it doesn't explicitly name — so this never
 * reaches `games.time_main`/`final_time`, matching the legacy behaviour the
 * task calls out (the old gateway.php formula never used `gfq_length`
 * either, per its comments).
 */
export function extract(payload) {
  const out = {};
  if (!payload) return out;

  if (payload.difficultyLabel) out.difficulty = payload.difficultyLabel;

  const rating = firstNumber(payload.ratingTitle);
  if (rating !== null) out.scoreGamefaqs = rating;

  const hours = firstNumber(payload.lengthTitle);
  if (hours !== null) out.timeGamefaqs = hours;

  if (payload.releaseRaw) {
    const release = parseDate(payload.releaseRaw);
    if (release.date) out.release = release;
  }

  if (payload.pid && payload.url) {
    out.links = { gamefaqs: { id: String(payload.pid), url: payload.url } };
  }

  return out;
}

// ---------------------------------------------------------------------------
// Linking — existing game_links, else search (with the subtitle-stripped
// second query), else a default-platform page's PC cross-link
// ---------------------------------------------------------------------------

async function writeConflict(db, gameId, candidates, reason) {
  await db.query(
    `INSERT INTO conflicts (game_id, field, candidates, reason)
     VALUES (?, 'gamefaqs_match', ?, ?)
     ON DUPLICATE KEY UPDATE candidates = VALUES(candidates), reason = VALUES(reason), status = 'open', resolved_at = NULL`,
    [
      gameId,
      JSON.stringify(candidates.map((c) => ({ pid: c.pid, name: c.game_name, plats: c.plats, year: yearOfCandidate(c) }))),
      reason,
    ],
  );
}

/**
 * Resolve `game` (`{ name, release_date }`) to a GameFAQs *PC* product via
 * search. Tries `normalizeName(name)` first (legacy `simplename()`'s
 * default), then — fixing the legacy bug where this fallback was built but
 * never actually used (the old code re-queried with the *original* `$name`
 * at every retry tier instead of the fixed-up variable) — a second query
 * with the subtitle/edition suffix stripped (`removeAdditions: true`) when
 * the first one found no exact match.
 *
 * Returns `{ status: 'ok', pid, url, fuzzy }` | `{ status: 'none', reason }` |
 * `{ status: 'ambiguous', candidates, reason }` | `{ status: 'blocked' }`.
 * `fuzzy` is `true` when `matchGamefaqsCandidate` resolved this via its
 * similarity fallback rather than an exact-title match; `fetchOne` uses it to
 * store the link at a lower confidence.
 */
export async function locateGamefaqsProduct(ctx, game) {
  const year = game?.release_date ? Number(String(game.release_date).slice(0, 4)) : null;

  const primaryQuery = normalizeName(game?.name ?? '');
  const primary = await searchGamefaqs(ctx, primaryQuery);
  if (primary.blocked) return { status: 'blocked' };

  let decision = matchGamefaqsCandidate(game?.name ?? '', primary.results, { year });

  if (decision.status === 'none') {
    const fallbackQuery = normalizeName(game?.name ?? '', { removeAdditions: true });
    if (fallbackQuery && fallbackQuery.toLowerCase() !== primaryQuery.toLowerCase()) {
      const fallback = await searchGamefaqs(ctx, fallbackQuery);
      if (fallback.blocked) return { status: 'blocked' };
      // Compare against the stripped title, not the original full name — a
      // GameFAQs entry that matches this query was, by construction, never
      // going to carry the subtitle we just removed.
      decision = matchGamefaqsCandidate(fallbackQuery, fallback.results, { year });
    }
  }

  if (decision.status === 'none') return { status: 'none', reason: 'no matching GameFAQs entry' };
  if (decision.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      candidates: decision.candidates,
      reason: `Ambiguous GameFAQs match for "${game?.name ?? ''}": ${decision.candidates.length} exact- or fuzzy-name candidates, none confirmed by release year`,
    };
  }

  const candidate = decision.candidate;
  const fuzzy = decision.fuzzy === true;
  if (!platsIncludePc(candidate)) return { status: 'none', reason: 'matched GameFAQs entry has no PC release' };

  if (String(candidate.platform_url).toLowerCase() === 'pc') {
    return { status: 'ok', pid: String(candidate.pid), url: `${BASE}${candidate.url}`, fuzzy };
  }

  // The default platform GameFAQs picked for this game isn't PC even though
  // `plats` lists PC — follow that page's platform switcher to the real PC
  // product (see the module-level comment; their stats differ per platform).
  const defaultPage = await fetchGamefaqsPage(ctx, `${BASE}${candidate.url}`);
  if (defaultPage.blocked) return { status: 'blocked' };
  if (!defaultPage.html) return { status: 'none', reason: 'default-platform GameFAQs page not found' };

  const pcHref = findPcAlternateUrl(defaultPage.html);
  const pid = pidFromUrl(pcHref);
  if (!pcHref || !pid) return { status: 'none', reason: 'no PC cross-link found on the default-platform GameFAQs page' };

  return { status: 'ok', pid, url: `${BASE}${pcHref}`, fuzzy };
}

// ---------------------------------------------------------------------------
// discover() — enqueue games missing difficulty or with a stale record
// ---------------------------------------------------------------------------

async function ensureStateRow(db) {
  await db.query('INSERT INTO source_state (source) VALUES (?) ON DUPLICATE KEY UPDATE source = source', [name]);
}

/**
 * Daily schedule: games with no `gamefaqs` `source_records` row, or one
 * older than `refreshDays` (default 90), or still missing `games.difficulty`
 * — popular first (`owners_estimate DESC`), capped at `dailyCap` (default
 * 1500). Auto-resumes a 24h block pause once its time has passed (see
 * `checkAndMaybeResume`).
 */
export async function discover(ctx) {
  const { db, log, config } = ctx;
  const sourceConfig = config?.sources?.[name] ?? {};
  if (sourceConfig.enabled === false) {
    log.info('gamefaqs: discover skipped (source disabled)');
    return { skipped: true };
  }

  await ensureStateRow(db);
  const resumeStatus = await checkAndMaybeResume(ctx);
  if (resumeStatus.paused) {
    log.info('gamefaqs: discover skipped (paused)', { pausedUntil: resumeStatus.pausedUntil });
    return { skipped: true, paused: true };
  }

  const refreshDays = sourceConfig.refreshDays ?? DEFAULT_REFRESH_DAYS;
  const dailyCap = sourceConfig.dailyCap ?? DEFAULT_DAILY_CAP;

  const rows = await db.query(
    `SELECT g.id FROM games g
     LEFT JOIN source_records sr ON sr.source = ? AND sr.game_id = g.id
     WHERE g.difficulty IS NULL
        OR sr.id IS NULL
        OR sr.fetched_at < DATE_SUB(NOW(), INTERVAL ? DAY)
     ORDER BY g.owners_estimate DESC
     LIMIT ?`,
    [name, refreshDays, dailyCap],
  );

  let enqueued = 0;
  for (const row of rows) {
    await ctx.enqueue(name, { gameId: row.id });
    enqueued += 1;
  }

  await db.query(
    'UPDATE source_state SET last_run_at = NOW(), last_full_pass_at = NOW(), last_error = NULL, stats = ? WHERE source = ?',
    [JSON.stringify({ candidates: rows.length, enqueued }), name],
  );
  log.info('gamefaqs: discover complete', { candidates: rows.length, enqueued });
  return { candidates: rows.length, enqueued };
}

// ---------------------------------------------------------------------------
// fetchOne() — link (if needed), fetch the PC product page, store + resolve
// ---------------------------------------------------------------------------

/**
 * `job.data = { gameId, externalId? }`. `externalId`, when given, is a known
 * GameFAQs pid (e.g. an admin-triggered refetch) and skips straight to the
 * page fetch via the generic `/-/<pid>-` redirect. Otherwise: reuse an
 * existing `game_links('gamefaqs')` row (legacy `gfq_url` or a Wikidata
 * P4769 id, migrated into that table — either already carries a full `url`,
 * or just the pid, redirect scheme above) if one exists, else search (see
 * `locateGamefaqsProduct`). A freshly-located link keeps `method: 'name'`
 * either way, but its `confidence` drops to `FUZZY_LINK_CONFIDENCE` (60) when
 * `locateGamefaqsProduct` resolved it via the similarity fallback
 * (`located.fuzzy`) rather than an exact-title match (which keeps the
 * existing default, 90).
 */
export async function fetchOne(ctx, job) {
  const { db, log } = ctx;
  const gameId = job?.data?.gameId;
  if (!gameId) throw new Error('gamefaqs.fetchOne: job.data.gameId is required');

  const game = await db.one('SELECT id, name, release_date FROM games WHERE id = ?', [gameId]);
  if (!game) {
    log.warn('gamefaqs: fetchOne called for an unknown gameId', { gameId });
    return { status: 'not_found', externalId: null };
  }

  const existingLink = await db.one(
    'SELECT external_id, url, match_method, confidence FROM game_links WHERE game_id = ? AND source = ?',
    [gameId, name],
  );

  let pid = existingLink ? String(existingLink.external_id) : job?.data?.externalId ? String(job.data.externalId) : null;
  let url = existingLink?.url || (pid ? `${BASE}/-/${pid}-` : null);
  let linkMethod = existingLink?.match_method ?? 'name';
  let confidence = existingLink?.confidence ?? 90;

  if (!url) {
    const located = await locateGamefaqsProduct(ctx, game);
    if (located.status === 'blocked') {
      await pauseSource(ctx, `Blocked by GameFAQs while searching for "${game.name}"`);
      throw new Error('gamefaqs: blocked by anti-bot protection while searching, source paused for 24h');
    }
    if (located.status === 'ambiguous') {
      await writeConflict(db, gameId, located.candidates, located.reason);
      await ctx.upsertRecord(name, `game-${gameId}`, { status: 'not_found', error: located.reason, gameId });
      return { status: 'ambiguous', externalId: null };
    }
    if (located.status !== 'ok') {
      await ctx.upsertRecord(name, `game-${gameId}`, { status: 'not_found', error: located.reason, gameId });
      return { status: 'not_found', externalId: null };
    }
    pid = located.pid;
    url = located.url;
    if (located.fuzzy) confidence = FUZZY_LINK_CONFIDENCE;
  }

  const page = await fetchGamefaqsPage(ctx, url);
  if (page.blocked) {
    await ctx.upsertRecord(name, pid, { status: 'error', error: 'blocked by anti-bot protection', gameId });
    await pauseSource(ctx, `Blocked by GameFAQs while fetching ${url}`);
    throw new Error('gamefaqs: blocked by anti-bot protection while fetching the page, source paused for 24h');
  }
  if (!page.html) {
    await ctx.upsertRecord(name, pid, { status: 'not_found', error: `GameFAQs page not found: ${url}`, gameId });
    return { status: 'not_found', externalId: pid };
  }

  const parsed = parseGamefaqsPage(page.html);
  const payload = { pid, url, ...parsed, fetchedAt: new Date().toISOString() };

  await ctx.upsertRecord(name, pid, { status: 'ok', payload, gameId });
  await ctx.upsertLink(gameId, name, pid, { url, method: linkMethod, confidence });
  await ctx.enqueueResolve(gameId);

  return { status: 'ok', externalId: pid, payload };
}

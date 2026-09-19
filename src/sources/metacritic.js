// Metacritic enrichment source (owner's decision, 2026-09-19: Metacritic
// score + link are mandatory for the catalog; OpenCritic is dropped — see
// config.json's `sources.opencritic.enabled = false` and
// src/lib/resolver/index.js's updated critics-score priority). Legacy
// reference: legacy/ajax/scripts/cron_scripts/SGG/functions/
// metacritic_gamefaq_functions.php (metaUrl() — the Metacritic half of that
// file; the GameFAQs half is src/sources/gamefaqs.js, a separate source).
//
// No bulk catalog endpoint exists (Metacritic has no public API), so — like
// gamefaqs.js/hltb.js — this module only ever fetches by game, one at a
// time: `discover()` enqueues `{gameId}` jobs for games needing (re)fetch,
// and `fetchOne()` does the linking (existing `game_links` row, else a slug
// guess) AND the fetch/parse.
//
// Mechanics verified LIVE on 2026-09-19 (this workstation has real internet
// access; see the task report for the full request/response notes):
//
//   - GET https://www.metacritic.com/game/<slug>/ with this bot's own
//     identifying User-Agent (src/lib/http.js's USER_AGENT, unmodified — no
//     browser-UA spoofing needed, unlike some other sources) returns 200
//     (~650-700 KB HTML) for an existing slug, 404 (clean, no soft-404 body)
//     for an unknown one — confirmed live with a deliberately-bogus slug.
//   - The page embeds exactly one `<script type="application/ld+json">`
//     block, `"@type":"VideoGame"`, with `name`, `datePublished` (ABSENT for
//     an unreleased/pre-review game — confirmed live on an early-access
//     title with zero critic reviews yet), `url`, and — only once at least 4
//     critic reviews exist — `aggregateRating: { ratingValue, reviewCount }`.
//     A game below that threshold is a valid page with no `aggregateRating`
//     key at all ("tbd" in the UI) — confirmed live; `fetchOne` keeps the
//     link and stores `metascore: null` for it, it is NOT treated as a 404.
//   - PC-specific Metascore (investigation #2 in the task): obtainable in
//     THIS SAME request, no second fetch needed. Every game whose page has
//     at least one critic review renders an "All Platforms" breakdown list
//     of `<a class="product-score-card" href=".../critic-reviews/?platform=
//     <slug>">` cards, one per platform that has reviews, each carrying its
//     own Metascore + review count (confirmed live on Portal 2: the page's
//     JSON-LD `aggregateRating` reflects the site's *lead* platform — Xbox
//     360, reviewCount 66 — while the PC card in that same list reports the
//     same 95 score off only 52 reviews; confirmed again on a PC-only game,
//     RimWorld, where the sole platform card IS the JSON-LD default). This
//     module always prefers the `?platform=pc` card when the list has one,
//     falling back to the JSON-LD default only when it doesn't (a
//     zero-review "tbd" page renders no platform list at all).
//   - User score (investigation #1): the JSON-LD carries none. The rendered
//     page shows it (0-10, one decimal) inside an element with
//     `data-testid="global-score-value-wrapper"` and an
//     `aria-label="User score <X> out of 10"` (or "...TBD" — same "at least
//     4 (user) ratings" threshold as critics, confirmed live) — that
//     `data-testid` is load-bearing: an *individual* user review's own score
//     badge (e.g. one reviewer's personal "10 out of 10") uses the exact
//     same `aria-label` wording without this attribute, so matching on
//     `aria-label` alone (confirmed live, RimWorld) would occasionally grab
//     a random reviewer's score instead of the aggregate. The total rating
//     count lives in a plain text node elsewhere on the page: "Based on
//     4,109 User Ratings" (same wording pattern as the analogous "Based on
//     66 Critic Reviews" next to each platform card). No PC-specific user
//     score was found (the platform cards above are critic-only) — the task
//     brief allows this: "PC score when available, else the page's default
//     score", and the user score has no platform breakdown to prefer.
//   - Slug rules (investigation #4, `metacriticSlug()` below): confirmed
//     live against a dozen titles (see the task report for the transcript)
//     — lowercase; diacritics transliterated via Unicode NFD decomposition
//     (no genuinely-accented official Metacritic title turned up live to
//     confirm against — "Pokemon Legends: Arceus" surprisingly has NO
//     accent in Metacritic's own JSON-LD `name`, unlike Nintendo's official
//     branding — so this specific rule is a reasonable default, not
//     live-verified, see the task report); apostrophes of every kind DROPPED
//     entirely, not replaced with a separator ("Baldur's Gate 3" ->
//     "baldurs-gate-3", "Tom Clancy's..." -> "tom-clancys-...",
//     "Mirror's Edge" -> "mirrors-edge"); "&" -> " and " ("Sam & Max: Save
//     the World" -> "sam-and-max-save-the-world"); every other run of
//     non-alphanumeric characters (colons, commas, hyphens, spaces) collapses
//     to a single hyphen ("NieR: Automata" -> "nier-automata"); roman
//     numerals are left completely untouched, never converted to/from digits
//     ("Kingdom Hearts III" -> "kingdom-hearts-iii", and — confirmed live,
//     initially the wrong way round — "Divinity: Original Sin II" is
//     "divinity-original-sin-ii", NOT "...-2": the official title itself
//     uses the roman numeral, this module doesn't invent one).
//   - Link normalisation (investigation, from the task's DB facts):
//     `game_links` rows for this source exist in three shapes — legacy
//     (`external_id` already a bare slug, `url` the OLD
//     "/game/pc/<slug>" scheme), Wikidata (`external_id` like "game/<slug>"
//     or "game/pc/<slug>", P... value copied verbatim), and this module's
//     own writes (`external_id` a bare slug). `normalizeMetacriticExternalId`
//     strips an optional leading "game/" then an optional leading "pc/" so
//     all three collapse to the same bare slug before building the current
//     "https://www.metacritic.com/game/<slug>/" URL.
//   - Block detection: no live block was reproduced (deliberately triggering
//     one against the real site was out of scope — see the task report), so
//     this module reuses `gamefaqs.js`'s generic, site-agnostic
//     `isBlockedBody`/`isBlockedResponse` (Cloudflare interstitial + legacy
//     IP-ban wording, no GameFAQs-specific text) via import rather than
//     duplicating that logic. `pauseSource`/`checkAndMaybeResume` are NOT
//     imported — in gamefaqs.js they close over that module's own `name`
//     constant (there is no shared, source-agnostic pause/resume helper in
//     this codebase, checked 2026-09-19), so reusing them as-is would
//     pause/resume GameFAQs's `source_state` row instead of Metacritic's;
//     this module keeps its own copies, same 24h-pause shape.

import { load } from 'cheerio';
import { normalizeName, decodeHtmlEntities } from '../lib/names.js';
import { parseDate } from '../lib/dates.js';
import { isBlockedBody, isBlockedResponse } from './gamefaqs.js';

export const name = 'metacritic';

// 1 request / 2.5s by default (config.sources.metacritic.rateLimit overrides).
// A single fetchOne only ever issues ONE HTTP request in the common case
// (PC score + user score both come off the one page fetch); the legacy-link
// 404 fallback path issues a second request only for that stale-link case.
export const rateLimit = { max: 1, duration: 2500 };

const BASE = 'https://www.metacritic.com';
const pageUrl = (slug) => `${BASE}/game/${slug}/`;

const DEFAULT_REFRESH_DAYS = 60;
const DEFAULT_RETRY_DAYS = 90;
const DEFAULT_DAILY_CAP = 20000;
const BLOCK_PAUSE_HOURS = 24;
const YEAR_TOLERANCE = 1;
const EARLY_ACCESS_YEARS = 3;

// ---------------------------------------------------------------------------
// metacriticSlug() — pure title -> slug (see the module header for the rules)
// ---------------------------------------------------------------------------

// Every kind of apostrophe game titles use, dropped entirely (not replaced
// with a space/hyphen) — "Baldur's Gate 3" -> "baldurs-gate-3".
const APOSTROPHE_RE = /['’‘‛‚´`]/g;

/** Pure: a game title -> the Metacritic URL slug this module would guess for it. */
export function metacriticSlug(input) {
  let s = decodeHtmlEntities(input == null ? '' : String(input));
  // Diacritics -> plain ASCII letters (NFD decomposition, strip the
  // combining marks) — see the module header on why this is a best-effort
  // default rather than a live-verified rule.
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(APOSTROPHE_RE, '');
  // Periods inside a name are dropped, not hyphenated (verified live: BeamNG.drive -> beamngdrive; the
  // hyphenated guess 404s). A period followed by a space still ends up as one hyphen via the space.
  s = s.replace(/\./g, '');
  s = s.replace(/&/g, ' and ');
  s = s.toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s;
}

// ---------------------------------------------------------------------------
// Link normalisation — legacy / wikidata / this module's own writes, all to
// one bare slug (see the module header)
// ---------------------------------------------------------------------------

/** Pure: any stored `game_links('metacritic')` form -> a bare slug, or `null`. */
export function normalizeMetacriticExternalId(value) {
  if (value === null || value === undefined) return null;
  let s = String(value).trim();
  if (s === '') return null;

  const atMetacritic = s.match(/metacritic\.com\/(.+)$/i);
  if (atMetacritic) s = atMetacritic[1];

  s = s.replace(/^\/+|\/+$/g, '');
  s = s.replace(/^game\//i, '');
  s = s.replace(/^pc\//i, '');
  s = s.split('/')[0];

  return s || null;
}

// ---------------------------------------------------------------------------
// Block detection / pause-resume (24h block cooldown — see the module header
// on why pauseSource/checkAndMaybeResume are NOT imported from gamefaqs.js)
// ---------------------------------------------------------------------------

function pageHeaders(ctx) {
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'accept-language': 'en,ru;q=0.9,en-US;q=0.8,ru-RU;q=0.7',
    referer: `${BASE}/`,
  };
}

/** A real game page always carries the schema.org VideoGame JSON-LD block. */
export function isGamePage(html) {
  const text = String(html || '');
  return text.includes('application/ld+json') && text.includes('"@type":"VideoGame"');
}

/** GET one Metacritic game page. Returns `{ blocked, html }` (`html` is `null` on a 404 or a block). */
async function fetchMetacriticPage(ctx, slug) {
  try {
    const html = await ctx.http.getText(pageUrl(slug), { headers: pageHeaders(ctx) });
    // Every normal Metacritic page embeds Cloudflare's `challenge-platform` script (verified live), so the
    // generic body markers only mean "blocked" when the response is not a real game page.
    if (!isGamePage(html) && isBlockedBody(html)) return { blocked: true, html: null };
    return { blocked: false, html };
  } catch (err) {
    if (isBlockedResponse(err?.statusCode, err?.body)) return { blocked: true, html: null };
    if (err?.statusCode === 404) return { blocked: false, html: null };
    throw err;
  }
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
// Page parsing (pure over an HTML string — no network/DB)
// ---------------------------------------------------------------------------

/** First integer in a string ("52 Critic Reviews" / "4,109" -> the number), or `null`. */
function firstInt(text) {
  if (!text) return null;
  const m = String(text).replace(/,/g, '').match(/-?\d+/);
  return m ? Number(m[0]) : null;
}

/**
 * Parse one Metacritic game page into the raw fields `fetchOne` stores as
 * `source_records.payload` (see the module header for the selectors this
 * uses). Pure: takes an HTML string, returns plain data, touches neither the
 * network nor the database — the fixture tests exercise this directly.
 *
 * `platform` is `'pc'` when a PC-specific platform score card was found and
 * used, else `'default'` (the JSON-LD's own, un-platformed aggregate — the
 * only case for a page with too few reviews for any platform breakdown at
 * all, or a genuinely PC-only game where JSON-LD and the PC card agree).
 */
export function parseMetacriticPage(html) {
  const $ = load(html);

  let jsonLd = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (jsonLd) return;
    try {
      const parsed = JSON.parse($(el).contents().text());
      if (parsed && parsed['@type'] === 'VideoGame') jsonLd = parsed;
    } catch {
      // malformed/absent JSON-LD - leave jsonLd null, caller treats as no data
    }
  });

  const pageName = jsonLd?.name ?? null;
  const datePublished = jsonLd?.datePublished ?? null;

  let metascore = jsonLd?.aggregateRating ? Number(jsonLd.aggregateRating.ratingValue) : null;
  let criticReviews = jsonLd?.aggregateRating ? Number(jsonLd.aggregateRating.reviewCount) : null;
  let platform = 'default';

  const pcCard = $('a.product-score-card')
    .filter((_, el) => /\/critic-reviews\/\?platform=pc$/.test($(el).attr('href') || ''))
    .first();
  if (pcCard.length) {
    platform = 'pc';
    const scoreEl = pcCard
      .find('[aria-label]')
      .filter((_, el) => /^metascore/i.test($(el).attr('aria-label') || ''))
      .first();
    const scoreText = scoreEl.find('span').first().text().trim();
    metascore = /^\d+$/.test(scoreText) ? Number(scoreText) : null;
    criticReviews = firstInt(pcCard.find('.product-score-card__review-count').first().text());
  }

  // PC release still "tbd" (fewer than 4 PC reviews) or JSON-LD without aggregateRating: fall back to the
  // page's headline Metascore (the lead platform's), which is better than no critic score at all
  // (Phasmophobia: PC tbd off 2 reviews, PS5 76 off 9).
  if (metascore === null || !Number.isFinite(metascore)) {
    const headline = $('[data-testid="global-score-value-wrapper"]')
      .filter((_, el) => /^metascore \d+/i.test($(el).attr('aria-label') || ''))
      .first();
    const headlineScore = headline.length ? firstInt($(headline).attr('aria-label')) : null;
    if (headlineScore !== null) {
      const countMatch = html.match(/Based on ([\d,]+) Critic Review/);
      metascore = headlineScore;
      criticReviews = countMatch ? firstInt(countMatch[1]) : null;
      platform = 'default';
    }
  }

  const userWrapper = $('[data-testid="global-score-value-wrapper"]')
    .filter((_, el) => /^user score/i.test($(el).attr('aria-label') || ''))
    .first();
  let userScore = null;
  if (userWrapper.length) {
    const val = parseFloat(userWrapper.find('span').first().text().trim());
    userScore = Number.isFinite(val) ? Math.round(val * 10) : null;
  }

  const userRatingsMatch = html.match(/Based on ([\d,]+) User Rating/);
  const userRatings = userRatingsMatch ? firstInt(userRatingsMatch[1]) : null;

  return {
    name: pageName,
    datePublished,
    metascore: Number.isFinite(metascore) ? metascore : null,
    criticReviews: Number.isFinite(criticReviews) ? criticReviews : null,
    userScore,
    userRatings,
    platform,
  };
}

// ---------------------------------------------------------------------------
// Name/year acceptance for a fresh slug guess (pure)
// ---------------------------------------------------------------------------

function normKey(raw, opts) {
  return normalizeName(raw ?? '', { convertRom: true, ...opts }).toLowerCase();
}

/**
 * Whether a slug-guessed page's JSON-LD `name`/`datePublished` confirm it is
 * actually `game` (`{ name, release_date }`). Never called for an existing
 * `game_links` row (those are trusted as-is, same convention as
 * gamefaqs.js/hltb.js/opencritic.js).
 *
 * Returns `{ status: 'ok' }` | `{ status: 'year_mismatch', gameYear,
 * pageYear }` | `{ status: 'no_match' }`.
 */
export function matchesMetacriticPage(payload, game) {
  const pageName = payload?.name;
  if (!pageName) return { status: 'no_match' };

  const wantName = game?.name ?? '';
  const nameMatches =
    normKey(wantName) === normKey(pageName) ||
    normKey(wantName, { removeAdditions: true }) === normKey(pageName, { removeAdditions: true });
  if (!nameMatches) return { status: 'no_match' };

  const gameYear = game?.release_date ? Number(String(game.release_date).slice(0, 4)) : null;
  const pageYear = payload?.datePublished ? Number(String(payload.datePublished).slice(0, 4)) : null;
  // Metacritic dates a game by its 1.0 release, the catalog often by its Early Access launch (Hades: 2018 vs
  // 2020), so the page may be up to EARLY_ACCESS_YEARS later; remakes sharing a name are further apart.
  const diff = gameYear != null && pageYear != null ? pageYear - gameYear : 0;
  if (diff < -YEAR_TOLERANCE || diff > EARLY_ACCESS_YEARS) {
    return { status: 'year_mismatch', gameYear, pageYear };
  }
  return { status: 'ok' };
}

// ---------------------------------------------------------------------------
// extract() — pure: stored payload -> vocabulary fields
// ---------------------------------------------------------------------------

/**
 * `payload` is what `fetchOne` upserts into `source_records.payload`:
 * `{ slug, url, name, datePublished, metascore, criticReviews, userScore,
 * userRatings, platform, fetchedVia }`.
 */
export function extract(payload) {
  const out = {};
  if (!payload) return out;

  if (payload.metascore !== null && payload.metascore !== undefined) {
    out.scoreCritics = payload.metascore;
    out.scoreCriticsSource = 'metacritic';
    if (payload.criticReviews !== null && payload.criticReviews !== undefined) {
      out.scoreCriticsCount = payload.criticReviews;
    }
  }

  if (payload.userScore !== null && payload.userScore !== undefined) {
    out.scoreUsersMetacritic = payload.userScore;
  }

  if (payload.datePublished) {
    const release = parseDate(payload.datePublished);
    if (release.date) out.release = release;
  }

  if (payload.slug && payload.url) {
    out.links = { metacritic: { id: payload.slug, url: payload.url } };
  }

  return out;
}

// ---------------------------------------------------------------------------
// discover() — enqueue games missing a record or with a stale one
// ---------------------------------------------------------------------------

async function ensureStateRow(db) {
  await db.query('INSERT INTO source_state (source) VALUES (?) ON DUPLICATE KEY UPDATE source = source', [name]);
}

/**
 * Daily schedule: games with no `metacritic` `source_records` row, or an
 * `'ok'` one older than `refreshDays` (default 60), or a `not_found`/`error`
 * one older than `retryDays` (default 90, per the task — Metacritic is
 * mandatory for the catalog, so a miss is retried, unlike OpenCritic's tiny
 * quota) — popular first (`score_steam_votes DESC`, per the task; every
 * other source here uses `owners_estimate DESC`, this one deliberately
 * doesn't), capped at `dailyCap` (default 20000). `steam_delisted` games are
 * NOT excluded (per the task: their Metacritic link/score still matter).
 * Auto-resumes a 24h block pause once its time has passed.
 */
export async function discover(ctx) {
  const { db, log, config } = ctx;
  const sourceConfig = config?.sources?.[name] ?? {};
  if (sourceConfig.enabled === false) {
    log.info('metacritic: discover skipped (source disabled)');
    return { skipped: true };
  }

  await ensureStateRow(db);
  const resumeStatus = await checkAndMaybeResume(ctx);
  if (resumeStatus.paused) {
    log.info('metacritic: discover skipped (paused)', { pausedUntil: resumeStatus.pausedUntil });
    return { skipped: true, paused: true };
  }

  const refreshDays = sourceConfig.refreshDays ?? DEFAULT_REFRESH_DAYS;
  const retryDays = sourceConfig.retryDays ?? DEFAULT_RETRY_DAYS;
  const dailyCap = sourceConfig.dailyCap ?? DEFAULT_DAILY_CAP;

  const rows = await db.query(
    `SELECT g.id FROM games g
     LEFT JOIN source_records sr ON sr.source = ? AND sr.game_id = g.id
     WHERE sr.id IS NULL
        OR (sr.status = 'ok' AND sr.fetched_at < DATE_SUB(NOW(), INTERVAL ? DAY))
        OR (sr.status != 'ok' AND sr.fetched_at < DATE_SUB(NOW(), INTERVAL ? DAY))
     ORDER BY g.score_steam_votes DESC
     LIMIT ?`,
    [name, refreshDays, retryDays, dailyCap],
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
  log.info('metacritic: discover complete', { candidates: rows.length, enqueued });
  return { candidates: rows.length, enqueued };
}

// ---------------------------------------------------------------------------
// fetchOne() — link (if needed), fetch, parse, store, resolve
// ---------------------------------------------------------------------------

async function writeConflict(db, gameId, candidates, reason) {
  await db.query(
    `INSERT INTO conflicts (game_id, field, candidates, reason)
     VALUES (?, 'metacritic_match', ?, ?)
     ON DUPLICATE KEY UPDATE candidates = VALUES(candidates), reason = VALUES(reason), status = 'open', resolved_at = NULL`,
    [gameId, JSON.stringify(candidates), reason],
  );
}

/**
 * `job.data = { gameId, externalId? }`. `externalId`, when given, is a known
 * slug (e.g. an admin-triggered refetch). Otherwise: reuse an existing
 * `game_links('metacritic')` row (legacy `meta_url`, a Wikidata P1712 id, or
 * this module's own earlier write — all normalised to a bare slug by
 * `normalizeMetacriticExternalId`), else guess `metacriticSlug(game.name)`.
 *
 * A slug guess is only ever linked once the fetched page's own JSON-LD name
 * (+ year, when both sides know one) confirms it (`matchesMetacriticPage`) —
 * an existing link is never re-validated this way, same convention as
 * gamefaqs.js/hltb.js/opencritic.js. A `legacy`-method link that 404s falls
 * through to a fresh slug guess (per the task — legacy slugs were partly
 * guessed by the old PHP parser and some have rotted); any other link method
 * that 404s is reported `not_found` directly, no fallback.
 */
export async function fetchOne(ctx, job) {
  const { db, log } = ctx;
  const gameId = job?.data?.gameId;
  if (!gameId) throw new Error('metacritic.fetchOne: job.data.gameId is required');

  const game = await db.one('SELECT id, name, release_date FROM games WHERE id = ?', [gameId]);
  if (!game) {
    log.warn('metacritic: fetchOne called for an unknown gameId', { gameId });
    return { status: 'not_found', externalId: null };
  }

  const existingLink = await db.one(
    'SELECT external_id, url, match_method, confidence FROM game_links WHERE game_id = ? AND source = ?',
    [gameId, name],
  );

  let slug;
  let fetchedVia;
  let linkMethod;
  let confidence;
  let requireMatch;

  if (existingLink || job?.data?.externalId) {
    const raw = existingLink ? existingLink.external_id ?? existingLink.url : job.data.externalId;
    slug = normalizeMetacriticExternalId(raw);
    fetchedVia = 'link';
    linkMethod = existingLink?.match_method ?? 'manual';
    confidence = existingLink?.confidence ?? 100;
    requireMatch = false;
  } else {
    slug = metacriticSlug(game.name);
    fetchedVia = 'slug-guess';
    linkMethod = 'name';
    confidence = 90;
    requireMatch = true;
  }

  if (!slug) {
    await ctx.upsertRecord(name, `game-${gameId}`, { status: 'not_found', error: 'could not derive a Metacritic slug', gameId });
    return { status: 'not_found', externalId: null };
  }

  let page = await fetchMetacriticPage(ctx, slug);
  if (page.blocked) {
    await pauseSource(ctx, `Blocked by Metacritic while fetching ${slug}`);
    throw new Error('metacritic: blocked by anti-bot protection, source paused for 24h');
  }

  if (!page.html && existingLink?.match_method === 'legacy') {
    const guessedSlug = metacriticSlug(game.name);
    if (guessedSlug && guessedSlug !== slug) {
      const guessedPage = await fetchMetacriticPage(ctx, guessedSlug);
      if (guessedPage.blocked) {
        await pauseSource(ctx, `Blocked by Metacritic while fetching ${guessedSlug}`);
        throw new Error('metacritic: blocked by anti-bot protection, source paused for 24h');
      }
      if (guessedPage.html) {
        slug = guessedSlug;
        page = guessedPage;
        fetchedVia = 'slug-guess';
        linkMethod = 'name';
        confidence = 90;
        requireMatch = true;
      }
    }
  }

  if (!page.html) {
    await ctx.upsertRecord(name, `game-${gameId}`, { status: 'not_found', error: `Metacritic page not found: ${slug}`, gameId });
    return { status: 'not_found', externalId: null };
  }

  const parsed = parseMetacriticPage(page.html);

  if (requireMatch) {
    const decision = matchesMetacriticPage(parsed, game);
    if (decision.status === 'year_mismatch') {
      await writeConflict(
        db,
        gameId,
        [{ slug, name: parsed.name, year: decision.pageYear }],
        `Metacritic slug guess "${slug}" name-matches "${game.name}" but year differs (game ${decision.gameYear} vs page ${decision.pageYear})`,
      );
      await ctx.upsertRecord(name, `game-${gameId}`, { status: 'not_found', error: 'year mismatch on name-matched slug guess', gameId });
      return { status: 'year_mismatch', externalId: null };
    }
    if (decision.status === 'no_match') {
      await ctx.upsertRecord(name, `game-${gameId}`, {
        status: 'not_found',
        error: `slug-guessed Metacritic page name does not match: "${parsed.name}"`,
        gameId,
      });
      return { status: 'not_found', externalId: null };
    }
  }

  const url = pageUrl(slug);
  const payload = {
    slug,
    url,
    name: parsed.name,
    datePublished: parsed.datePublished,
    metascore: parsed.metascore,
    criticReviews: parsed.criticReviews,
    userScore: parsed.userScore,
    userRatings: parsed.userRatings,
    platform: parsed.platform,
    fetchedVia,
  };

  await ctx.upsertRecord(name, slug, { status: 'ok', payload, gameId });
  await ctx.upsertLink(gameId, name, slug, { url, method: linkMethod, confidence });
  await ctx.enqueueResolve(gameId);

  return { status: 'ok', externalId: slug, payload };
}

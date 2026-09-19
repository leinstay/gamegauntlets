// GOG catalog + Steam-matching source (spec docs/specs/2026-09-19-rewrite-design.md
// §5.2; plan docs/plans/2026-09-19-rewrite-plan.md task T9). Legacy reference:
// legacy/ajax/scripts/cron_scripts/SGG/gog.php.
//
// Endpoints (verified live 2026-09-19 against the current public APIs):
//   - Catalog:  https://catalog.gog.com/v1/catalog?limit=48&page=N&order=asc:title&productType=in:game,pack
//     (48/page is the API's own default; ~8.2k rows over ~171 pages.) GOG now sells some older base
//     games only as a bundled "pack" (e.g. "The Witcher 3: Wild Hunt" only exists as "...Complete
//     Edition", productType 'pack'), and reuses 'pack' for pure DLC/expansions too (e.g. an unreleased
//     "Wild Hunt — Songs of the Past" pack), with no reliable field to tell the two apart (category is
//     'PACK' for both). `isKeepablePack()` below filters packs: dropped when the (normalized) title
//     contains a DLC/addon keyword, or when a separate plain `game` product with the same normalized
//     base title exists elsewhere in the catalog (i.e. the pack is redundant next to a real base game,
//     not itself the only purchasable form).
//   - Details:  https://api.gog.com/v2/games/{id}?locale=en-US and ?locale=ru-RU (unchanged from legacy).
//   - Prices:   https://api.gog.com/products/{id}/prices?countryCode=US and ?countryCode=RU (unchanged
//     from legacy; amounts come back as integer-cents strings, e.g. "1999 USD").
//
// Slug alignment with src/sources/wikidata.js: Wikidata's P2725 value is a `game/<slug>` (or
// `movie/<slug>`) path; wikidata.js's `parseGogValue()` already strips the `game/` prefix before
// storing, so both `games.gog_slug` and its `game_links(source='gog', external_id=...)` rows use the
// *bare* slug (e.g. `the_witcher`) — verified by reading wikidata.js on 2026-09-19. This module stores
// and looks up the same bare form (see `slugFromStoreLink`/MATCH step 2), so no normalisation is needed
// on either side.

import { normalizeName, simpleSim, fixName, isDemo, fromPipeList } from '../lib/names.js';
import { parseDate } from '../lib/dates.js';
import { classifyNonGame, bundleBaseName } from '../lib/non-game.js';
import { isPurgedTombstone, buildTombstonePayload } from '../pipeline/purge-non-games.js';

export const name = 'gog';

// Conservative default per the task: 1 request/second. `fetchOne` makes up to
// four HTTP calls (details en/ru, prices US/RU) per job, so the *effective*
// request rate is roughly this limiter's rate x4; config.sources.gog.rateLimit
// overrides this in production.
export const rateLimit = { max: 1, duration: 1000 };

const CATALOG_URL = 'https://catalog.gog.com/v1/catalog';
const CATALOG_PAGE_LIMIT = 48;
const CATALOG_PRODUCT_TYPE = 'in:game,pack';
const DETAILS_URL = (id, locale) => `https://api.gog.com/v2/games/${id}?locale=${locale}`;
const PRICES_URL = (id, countryCode) => `https://api.gog.com/products/${id}/prices?countryCode=${countryCode}`;

const SIM_THRESHOLD = 95;
const YEAR_TOLERANCE = 1;
// An exact-title single candidate whose known release year differs from the
// GOG product's by more than this is treated as a probable remake/reboot
// (Doom 1993 vs 2016, Prey 2006 vs 2017, Tomb Raider 1996 vs 2013, Thief
// 1998 vs 2014, ...) rather than attached.
const REMAKE_YEAR_THRESHOLD = 3;

// Title keywords (checked against the normalized title) that mark a 'pack'
// catalog entry as an add-on rather than a base game - see isKeepablePack().
const PACK_DROP_KEYWORDS = ['dlc', 'soundtrack', 'artbook', 'season pass', 'expansion', 'upgrade', 'bonus', 'costume', 'skin'];

// Typographic punctuation GOG/Steam titles sometimes use in place of the
// ASCII character normalizeName()/simpleSim() expect (curly quotes, en/em
// dash, ellipsis). Applied before any name comparison so e.g. a curly-quoted
// GOG title still matches a straight-quoted Steam one.
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

/** ASCII-fold + normalizeName + lowercase - the shared key used for name matching. */
function normKey(raw) {
  return normalizeName(toAscii(raw), { convertRom: true }).toLowerCase();
}

// ---------------------------------------------------------------------------
// Small pure helpers (all unit-tested via tests/sources/gog.test.js)
// ---------------------------------------------------------------------------

const OS_MAP = { windows: 'WIN', osx: 'MAC', linux: 'LNX' };

/** Dedupe a list of strings, dropping empties, preserving first-seen order. */
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list ?? []) {
    const v = (item ?? '').toString().trim();
    if (v === '' || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * `_embedded.supportedOperatingSystems` ([{operatingSystem:{name}}]) or the
 * catalog listing's flat `operatingSystems` (['windows','osx']) -> our SET
 * values. Returns `undefined` (not `[]`) when nothing is recognised, per the
 * "all keys optional" vocabulary convention.
 */
export function mapPlatforms(list) {
  const names = (list ?? [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.operatingSystem?.name))
    .filter(Boolean);
  const mapped = dedupe(names.map((n) => OS_MAP[String(n).toLowerCase()]).filter(Boolean));
  return mapped.length ? mapped : undefined;
}

/**
 * Split a `_embedded.localizations` array into `{ languages, voiceovers }`
 * (both already-decoded English names, since we always fetch `locale=en-US`
 * for the English payload). `type === 'audio'` -> voiceovers, else languages.
 */
export function mapLanguages(localizations) {
  const languages = [];
  const voiceovers = [];
  for (const loc of localizations ?? []) {
    const langName = loc?._embedded?.language?.name;
    const type = loc?._embedded?.localizationScope?.type;
    if (!langName) continue;
    if (type === 'audio') voiceovers.push(langName);
    else languages.push(langName);
  }
  const result = {};
  const l = dedupe(languages);
  const v = dedupe(voiceovers);
  if (l.length) result.languages = l;
  if (v.length) result.voiceovers = v;
  return result;
}

/**
 * Strip HTML tags out of a GOG description/overview field into plain text
 * (the vocabulary requires "HTML-free descriptions"). Block-level tags
 * become newlines, `<li>` becomes a leading dash, entities are decoded for
 * the handful that actually show up in GOG copy. Not a general HTML parser -
 * good enough for the fairly regular markup GOG's CMS produces.
 */
export function stripHtml(html) {
  if (html === null || html === undefined) return null;
  const text = String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|h[1-6]|ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  return text === '' ? null : text;
}

/** "1999 USD" / "0 USD" -> 1999 / 0 (integer cents). `null` for anything unparsable. */
function parseMoneyCents(str) {
  if (str === null || str === undefined) return null;
  const m = String(str).match(/-?\d+/);
  return m ? Number(m[0]) : null;
}

/**
 * Pick the price entry matching `currencyCode` out of a
 * `GET /products/{id}/prices` response and turn it into
 * `{ initial, final, discount }` (cents, discount 0..100). `null` when the
 * response has no matching currency entry (product not sold in that region)
 * or is an error body (e.g. `PRICES_NOT_FOUND`).
 */
export function extractPriceBlock(pricesResponse, currencyCode) {
  const entry = pricesResponse?._embedded?.prices?.find((p) => p?.currency?.code === currencyCode);
  if (!entry) return null;
  const initial = parseMoneyCents(entry.basePrice);
  const final = parseMoneyCents(entry.finalPrice);
  if (initial === null && final === null) return null;
  const i = initial ?? final;
  const f = final ?? initial;
  const discount = i > 0 && f !== null ? Math.round(((i - f) / i) * 100) : 0;
  return { initial: i, final: f, discount: Math.max(0, discount) };
}

/**
 * `gogPurchasable` (src/lib/purchasable.js, `games.purchasable` - migrations/005_purchasable.sql):
 * `true`/`false` when `product` has enough evidence to decide, `undefined` ("no opinion") otherwise -
 * mirrors src/sources/steam.js's `computeSteamPurchasable()`. Not-out-yet (`isPreorder`) and a real price
 * in either region both win outright before falling back to the raw `product.isAvailableForSale` flag
 * (verified present on live `GET /v2/games/{id}` responses, e.g. tests/fixtures/gog/*.json - `false` there
 * is the only clean "this store confirms it can't be bought" signal GOG's details endpoint offers, since
 * there's no GOG equivalent of Steam's `package_groups`). `product.isAvailableForSale` being anything other
 * than a boolean (an API shape we haven't seen) falls through to `undefined`, same "tolerate unknown
 * shapes" rule as steam.js.
 */
function computeGogPurchasable(product, usd, rub, isFree) {
  if (!product) return undefined;
  if (product.isPreorder === true) return true;
  if (isFree) return true;
  if (usd || rub) return true;
  return typeof product.isAvailableForSale === 'boolean' ? product.isAvailableForSale : undefined;
}

/** GOG catalog dates ("2025.04.16") -> ISO ("2025-04-16") for parseDate(). */
function dottedToIso(s) {
  if (!s || typeof s !== 'string') return s;
  const m = s.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

/** `https://www.gog.com/en/game/<slug>` -> `<slug>`, or `null`. */
function slugFromStoreLink(href) {
  if (!href) return null;
  const m = String(href).match(/\/game\/([^/?#]+)/);
  return m ? m[1] : null;
}

/** A cheap string summarising the catalog fields we'd notice a change in. */
export function catalogSignature(product) {
  const price = product?.price;
  return JSON.stringify({
    title: product?.title ?? null,
    productType: product?.productType ?? null,
    releaseDate: product?.releaseDate ?? null,
    developers: product?.developers ?? null,
    final: price?.final ?? null,
    discount: price?.discount ?? null,
  });
}

/**
 * Decide whether a catalog `productType: 'pack'` entry should be crawled as
 * a base game. `gameTitleNormSet` is the set of `normKey(title)` for every
 * plain `productType: 'game'` product seen in the same catalog sweep.
 * Dropped when the title looks like an add-on (soundtrack, season pass, ...),
 * or when a separate `game` product with the same normalized title exists
 * (the pack is then redundant packaging of an already-crawled base game, not
 * itself the only purchasable form). `productType !== 'pack'` always keeps
 * (plain games are filtered elsewhere, by `isDemo` only).
 */
export function isKeepablePack(product, gameTitleNormSet) {
  if (product?.productType !== 'pack') return true;
  const norm = normKey(product?.title ?? '');
  if (PACK_DROP_KEYWORDS.some((kw) => norm.includes(kw))) return false;
  return !(gameTitleNormSet?.has?.(norm) ?? false);
}

// ---------------------------------------------------------------------------
// extract() - pure: stored payload -> vocabulary fields
// ---------------------------------------------------------------------------

/**
 * `payload` is what `fetchOne` upserts into `source_records.payload`:
 * `{ en, ru, pricesUsd, pricesRub, catalog }` where `en`/`ru` are raw
 * `GET /v2/games/{id}?locale=...` bodies, `pricesUsd`/`pricesRub` are raw
 * `GET /products/{id}/prices?countryCode=...` bodies (either may be `null`
 * when that call failed/404s), and `catalog` is the (optional) catalog-listing
 * snippet `discover()` saw for this product.
 */
export function extract(payload) {
  const product = payload?.en?._embedded?.product;
  if (!product) return {};

  const out = {};

  out.name = fixName(product.title);
  out.gogId = String(product.id);

  const slug = payload?.catalog?.slug ?? slugFromStoreLink(payload?.en?._links?.store?.href);
  if (slug) out.gogSlug = slug;

  const image = payload?.catalog?.coverHorizontal ?? payload?.en?._links?.boxArtImage?.href ?? null;
  if (image) out.image = image;

  const descEn = stripHtml(payload?.en?.overview ?? payload?.en?.description);
  if (descEn) out.descriptionEn = descEn;
  const descRu = stripHtml(payload?.ru?.overview ?? payload?.ru?.description);
  if (descRu) out.descriptionRu = descRu;

  const releaseRaw = product.globalReleaseDate ?? dottedToIso(payload?.catalog?.releaseDate) ?? dottedToIso(payload?.catalog?.storeReleaseDate);
  const storeRelease = parseDate(releaseRaw);
  if (storeRelease.date) out.storeRelease = storeRelease;

  const platforms = mapPlatforms(payload?.en?._embedded?.supportedOperatingSystems ?? payload?.catalog?.operatingSystems);
  if (platforms) out.platforms = platforms;

  const developers = dedupe((payload?.en?._embedded?.developers ?? []).map((d) => d?.name ?? d));
  if (developers.length) out.developers = developers;
  const publishers = dedupe((payload?.en?._embedded?.publishers ?? []).map((p) => p?.name ?? p));
  if (publishers.length) out.publishers = publishers;

  const genres = dedupe((payload?.catalog?.genres ?? payload?.en?._embedded?.tags ?? []).map((g) => g?.name ?? g));
  if (genres.length) out.genres = genres;
  const tags = dedupe((payload?.en?._embedded?.tags ?? []).map((t) => t?.name ?? t));
  if (tags.length) out.tags = tags;
  const categories = dedupe((payload?.en?._embedded?.features ?? []).map((f) => f?.name ?? f));
  if (categories.length) out.categories = categories;

  Object.assign(out, mapLanguages(payload?.en?._embedded?.localizations));

  const usd = extractPriceBlock(payload?.pricesUsd, 'USD');
  const rub = extractPriceBlock(payload?.pricesRub, 'RUB');
  const prices = {};
  if (usd) prices.usd = usd;
  if (rub) prices.rub = rub;
  if (usd || rub) out.prices = prices;
  const knownFinal = usd?.final ?? rub?.final;
  if (knownFinal !== undefined && knownFinal !== null) out.isFree = knownFinal === 0;

  const gogPurchasable = computeGogPurchasable(product, usd, rub, out.isFree === true);
  if (gogPurchasable !== undefined) out.gogPurchasable = gogPurchasable;

  const storeUrl = payload?.en?._links?.store?.href ?? (slug ? `https://www.gog.com/en/game/${slug}` : null);
  if (storeUrl) out.links = { gog: { id: out.gogId, url: storeUrl } };

  return out;
}

// ---------------------------------------------------------------------------
// matchSteamGame() - pure match decision (MATCH step 3 of fetchOne)
// ---------------------------------------------------------------------------

/**
 * `candidates` rows: `{ id, name, name_normalized, release_date, developers }`
 * (`developers` as stored on `games` - a pipe-list string; `release_date` a
 * `'YYYY-MM-DD'` string or null). `fields` is the output of `extract()` for
 * the GOG product being matched (`name`, `storeRelease`, `developers`).
 *
 * All candidates are evaluated and ranked (exact normalized match first,
 * then highest similarity); typographic quotes/dashes are folded to ASCII
 * before normalizing so e.g. a curly-quoted GOG title still matches a
 * straight-quoted Steam one.
 *
 * Exact normalized-title ties are NOT rare - reboots/remakes reuse a title
 * (Doom 1993/2016, Prey 2006/2017, Tomb Raider 1996/2013, Thief 1998/2014,
 * Alone in the Dark 1992/2024, ...):
 *   - 2+ exact matches: disambiguated strictly by release year (within
 *     `yearTolerance`, default ±1) - developer overlap is deliberately NOT
 *     used as a tiebreaker here, since a remake is very often from a
 *     related studio/publisher too. None or more than one candidate within
 *     tolerance -> ambiguous.
 *   - exactly 1 exact match: attached unless its release year is *known* on
 *     both sides and differs by more than `remakeYearThreshold` (default 3),
 *     which flags it as a probable remake/reboot instead of the same game.
 *
 * With no exact match at all, a single non-exact (similarity < 100) match
 * must be confirmed by release year (±`yearTolerance`) or an overlapping
 * developer before attaching; with several non-exact candidates, the one(s)
 * confirmed by year/developer win. Any unconfirmed/ambiguous case logs a
 * conflict instead of guessing.
 *
 * Returns one of:
 *   `{ status: 'none' }`
 *   `{ status: 'attach', gameId, confidence }`
 *   `{ status: 'ambiguous', bestCandidateId, reason, candidates: [{gameId,name,sim,exact}] }`
 */
export function matchSteamGame(fields, candidates, opts = {}) {
  const simThreshold = opts.simThreshold ?? SIM_THRESHOLD;
  const yearTolerance = opts.yearTolerance ?? YEAR_TOLERANCE;
  const remakeYearThreshold = opts.remakeYearThreshold ?? REMAKE_YEAR_THRESHOLD;
  const gogRaw = toAscii(fields?.name ?? '');
  const gogNorm = normKey(gogRaw);

  const scored = (candidates ?? [])
    .map((candidate) => {
      const candRaw = toAscii(candidate.name ?? '');
      const candNorm = candidate.name_normalized ? normKey(candidate.name_normalized) : normKey(candRaw);
      const exact = candNorm !== '' && candNorm === gogNorm;
      const sim = simpleSim(gogRaw, candRaw);
      return { candidate, exact, sim };
    })
    .filter((m) => m.exact || m.sim >= simThreshold)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.sim - a.sim);

  if (scored.length === 0) return { status: 'none' };

  const exactMatches = scored.filter((m) => m.exact);

  if (exactMatches.length >= 2) {
    const withinYear = exactMatches.filter((m) => isWithinYear(fields, m.candidate, yearTolerance));
    if (withinYear.length === 1) {
      return { status: 'attach', gameId: withinYear[0].candidate.id, confidence: 100 };
    }
    return {
      status: 'ambiguous',
      bestCandidateId: exactMatches[0].candidate.id,
      reason: `Ambiguous GOG match for "${fields?.name ?? ''}": ${exactMatches.length} exact-name ties, ${withinYear.length} within +/-${yearTolerance} year(s) of its release (likely a reboot/remake sharing the title)`,
      candidates: scored.map(toConflictCandidate),
    };
  }

  if (exactMatches.length === 1) {
    const m = exactMatches[0];
    const diff = yearDiffAbs(fields, m.candidate);
    if (diff !== null && diff > remakeYearThreshold) {
      return {
        status: 'ambiguous',
        bestCandidateId: m.candidate.id,
        reason: `Ambiguous GOG match for "${fields?.name ?? ''}": exact name match but release years differ by ${diff} years (probably a different game with the same title, e.g. a remake)`,
        candidates: [toConflictCandidate(m)],
      };
    }
    return { status: 'attach', gameId: m.candidate.id, confidence: 100 };
  }

  // No exact match: fuzzy-only candidates.
  if (scored.length === 1) {
    const m = scored[0];
    if (isConfirmed(fields, m.candidate, yearTolerance)) {
      return { status: 'attach', gameId: m.candidate.id, confidence: Math.round(m.sim) };
    }
    return {
      status: 'ambiguous',
      bestCandidateId: m.candidate.id,
      reason: `Unconfirmed fuzzy GOG match for "${fields?.name ?? ''}" (similarity ${Math.round(m.sim)}, no matching release year or overlapping developer)`,
      candidates: [toConflictCandidate(m)],
    };
  }

  const confirmed = scored.filter((m) => isConfirmed(fields, m.candidate, yearTolerance));
  if (confirmed.length === 1) {
    const m = confirmed[0];
    return { status: 'attach', gameId: m.candidate.id, confidence: Math.round(m.sim) };
  }

  return {
    status: 'ambiguous',
    bestCandidateId: scored[0].candidate.id,
    reason:
      confirmed.length === 0
        ? `Ambiguous GOG match for "${fields?.name ?? ''}": ${scored.length} name-matching candidates, none confirmed by year/developer`
        : `Ambiguous GOG match for "${fields?.name ?? ''}": ${confirmed.length} candidates confirmed by year/developer`,
    candidates: scored.map(toConflictCandidate),
  };
}

function toConflictCandidate(m) {
  return { gameId: m.candidate.id, name: m.candidate.name, sim: Math.round(m.sim), exact: m.exact };
}

function yearOf(dateStr) {
  return dateStr ? Number(String(dateStr).slice(0, 4)) : null;
}

/** Absolute year gap between the GOG product and a Steam candidate, or `null` when either year is unknown. */
function yearDiffAbs(fields, candidate) {
  const gogYear = yearOf(fields?.storeRelease?.date);
  const steamYear = yearOf(candidate?.release_date);
  if (gogYear === null || steamYear === null) return null;
  return Math.abs(gogYear - steamYear);
}

function isWithinYear(fields, candidate, yearTolerance) {
  const diff = yearDiffAbs(fields, candidate);
  return diff !== null && diff <= yearTolerance;
}

function isConfirmed(fields, candidate, yearTolerance) {
  const diff = yearDiffAbs(fields, candidate);
  if (diff !== null) return diff <= yearTolerance;

  const gogDevs = dedupe(fields?.developers ?? []).map((d) => d.toLowerCase());
  const steamDevs = fromPipeList(candidate?.developers ?? '').map((d) => d.toLowerCase());
  if (gogDevs.length && steamDevs.length) return gogDevs.some((d) => steamDevs.includes(d));

  return false;
}

// ---------------------------------------------------------------------------
// discover() - page the catalog, enqueue new/changed products
// ---------------------------------------------------------------------------

async function sleep(ms) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readState(db) {
  const row = await db.one('SELECT cursor_state FROM source_state WHERE source = ?', [name]);
  const cursorState = row?.cursor_state ? (typeof row.cursor_state === 'string' ? JSON.parse(row.cursor_state) : row.cursor_state) : {};
  return { signatures: cursorState.signatures ?? {} };
}

async function writeState(db, { signatures, lastFullPassAt, stats }) {
  const cursorState = JSON.stringify({ signatures });
  await db.query(
    `INSERT INTO source_state (source, cursor_state, last_run_at, last_full_pass_at, stats)
     VALUES (?, ?, NOW(), ?, ?)
     ON DUPLICATE KEY UPDATE
       cursor_state = VALUES(cursor_state),
       last_run_at = VALUES(last_run_at),
       last_full_pass_at = COALESCE(VALUES(last_full_pass_at), source_state.last_full_pass_at),
       stats = VALUES(stats)`,
    [name, cursorState, lastFullPassAt ?? null, stats ? JSON.stringify(stats) : null],
  );
}

/**
 * Fetch every page of `productType=in:game,pack`, sleeping `delayMs` between
 * requests. Catalog fetching is cheap and idempotent (unlike `fetchOne`'s
 * per-product calls, which stay individually queued/deduped/resumable), so a
 * crash simply restarts this from page 1 on the next `discover()` run rather
 * than resuming mid-crawl - deciding which packs to keep needs the *whole*
 * catalog anyway (see `isKeepablePack`).
 */
async function fetchAllCatalogPages(http, delayMs, log) {
  const products = [];
  let page = 1;
  let totalPages = null;
  for (;;) {
    const url = `${CATALOG_URL}?limit=${CATALOG_PAGE_LIMIT}&page=${page}&order=asc:title&productType=${CATALOG_PRODUCT_TYPE}`;
    const body = await http.getJson(url);
    totalPages = body?.pages ?? totalPages;
    for (const product of body?.products ?? []) products.push(product);
    log?.info?.('gog: discover fetched catalog page', { page, totalPages, collected: products.length });
    if (!totalPages || page >= totalPages) break;
    page += 1;
    await sleep(delayMs);
  }
  return { products, totalPages };
}

/**
 * Page through the public GOG catalog (games + packs, see the module-level
 * comment on `isKeepablePack`), enqueueing a `fetch` job per new/changed,
 * non-demo, keepable product. The per-product catalog signature persisted in
 * `source_state.cursor_state` means only products whose catalog snapshot
 * actually changed get re-enqueued on the next pass.
 */
export async function discover(ctx) {
  const db = ctx.db;
  const http = ctx.http;
  const rl = ctx.config?.sources?.[name]?.rateLimit ?? rateLimit;
  const state = await readState(db);
  const signatures = { ...state.signatures };

  const { products, totalPages } = await fetchAllCatalogPages(http, rl?.duration ?? rateLimit.duration, ctx.log);

  const gameTitleNormSet = new Set();
  for (const product of products) {
    if (product?.productType === 'game') gameTitleNormSet.add(normKey(product.title ?? ''));
  }

  let seen = 0;
  let enqueued = 0;
  let skippedDemo = 0;
  let skippedPack = 0;
  let skippedUnchanged = 0;

  for (const product of products) {
    seen += 1;
    if (isDemo(product.title ?? '')) {
      skippedDemo += 1;
      continue;
    }
    if (!isKeepablePack(product, gameTitleNormSet)) {
      skippedPack += 1;
      continue;
    }
    const sig = catalogSignature(product);
    if (signatures[product.id] === sig) {
      skippedUnchanged += 1;
      continue;
    }
    signatures[product.id] = sig;

    await ctx.enqueue(name, {
      externalId: String(product.id),
      catalog: {
        id: product.id,
        slug: product.slug,
        title: product.title,
        productType: product.productType,
        releaseDate: product.releaseDate,
        storeReleaseDate: product.storeReleaseDate,
        developers: product.developers,
        operatingSystems: product.operatingSystems,
        genres: product.genres,
        price: product.price,
        coverHorizontal: product.coverHorizontal,
      },
    });
    enqueued += 1;
  }

  await writeState(db, {
    signatures,
    lastFullPassAt: new Date(),
    stats: { productCount: seen, enqueued, skippedDemo, skippedPack, skippedUnchanged, pages: totalPages },
  });

  ctx.log?.info?.('gog: discover complete', { pages: totalPages, seen, enqueued, skippedDemo, skippedPack, skippedUnchanged });
  return { pages: totalPages, seen, enqueued, skippedDemo, skippedPack, skippedUnchanged };
}

// ---------------------------------------------------------------------------
// fetchOne() - fetch details+prices, upsert source_records, run MATCH
// ---------------------------------------------------------------------------

async function fetchDetails(http, externalId, locale) {
  try {
    return await http.getJson(DETAILS_URL(externalId, locale));
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

async function fetchPrices(http, externalId, countryCode) {
  try {
    return await http.getJson(PRICES_URL(externalId, countryCode));
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

/** Build the two SQL clauses (exact + broad) used to fetch match candidates. */
function candidateQuery(gogName) {
  const norm = normKey(gogName);
  const words = norm.split(' ').filter((w) => w.length >= 4);
  const likeWord = words[0] ?? norm.split(' ')[0] ?? norm;
  return {
    sql: `SELECT id, name, name_normalized, release_date, developers FROM games
          WHERE kind = 'steam' AND gog_id IS NULL
            AND (LOWER(name_normalized) = LOWER(?) OR name_normalized LIKE ?)
          LIMIT 25`,
    params: [norm, `%${likeWord}%`],
  };
}

/** Insert/refresh a `conflicts` row for field `gog_match` on `gameId`. */
async function writeConflict(db, gameId, candidates, reason) {
  await db.query(
    `INSERT INTO conflicts (game_id, field, candidates, reason)
     VALUES (?, 'gog_match', ?, ?)
     ON DUPLICATE KEY UPDATE candidates = VALUES(candidates), reason = VALUES(reason), status = 'open', resolved_at = NULL`,
    [gameId, JSON.stringify(candidates), reason],
  );
}

/** This (source='gog', externalId)'s own `source_records` payload, parsed - see readOwnSourceRecordPayload's use in steam.js. */
async function readOwnSourceRecordPayload(db, externalId) {
  const row = await db.one('SELECT payload FROM source_records WHERE source = ? AND external_id = ?', [name, externalId]);
  if (!row) return null;
  if (row.payload === null || row.payload === undefined) return null;
  if (typeof row.payload !== 'object') {
    try {
      return JSON.parse(row.payload);
    } catch {
      return null;
    }
  }
  return row.payload;
}

export async function fetchOne(ctx, job) {
  const db = ctx.db;
  const http = ctx.http;
  const log = ctx.log;
  const externalId = String(job.data.externalId);

  const en = await fetchDetails(http, externalId, 'en-US');
  if (!en?._embedded?.product) {
    await ctx.upsertRecord(name, externalId, { status: 'not_found', error: 'GOG details not found' });
    return { status: 'not_found', externalId };
  }

  const [ru, pricesUsd, pricesRub] = await Promise.all([
    fetchDetails(http, externalId, 'ru-RU'),
    fetchPrices(http, externalId, 'US'),
    fetchPrices(http, externalId, 'RU'),
  ]);

  const payload = { en, ru, pricesUsd, pricesRub, catalog: job.data.catalog ?? null };
  const fields = extract(payload);

  let gameId = job.data.gameId ? Number(job.data.gameId) : null;
  let method = 'store';
  let confidence = 100;
  let ambiguous = false;

  if (!gameId) {
    const already = await db.one('SELECT id FROM games WHERE gog_id = ? LIMIT 1', [externalId]);
    if (already) gameId = already.id;
  }

  // Step 2: a wikidata/igdb-derived identity, keyed by slug (wikidata.js
  // stores the bare GOG slug on both `games.gog_slug` and its
  // `game_links(source='gog')` row - see the module header comment) or,
  // defensively, by the numeric id in case some other source ever uses it.
  if (!gameId) {
    const slug = fields.gogSlug ?? null;
    let game = null;
    let linkMethod = null;

    if (slug) {
      game = await db.one('SELECT id, gog_id FROM games WHERE gog_slug = ? LIMIT 1', [slug]);
    }
    if (!game) {
      const linked = await db.one(
        `SELECT game_id, match_method FROM game_links
         WHERE source = 'gog' AND external_id IN (?, ?) AND match_method IN ('wikidata','igdb')
         LIMIT 1`,
        [externalId, slug ?? externalId],
      );
      if (linked) {
        game = await db.one('SELECT id, gog_id FROM games WHERE id = ? LIMIT 1', [linked.game_id]);
        linkMethod = linked.match_method;
      }
    }

    if (game) {
      // One-to-one: never attach this GOG product to a game already carrying
      // a *different* gog_id - that is a data conflict, not a match.
      if (game.gog_id && String(game.gog_id) !== externalId) {
        ambiguous = true;
        await writeConflict(
          db,
          game.id,
          [{ gameId: game.id, existingGogId: game.gog_id, incomingGogId: externalId }],
          `games.id=${game.id} already has gog_id ${game.gog_id}, which differs from the GOG product being matched (${externalId})`,
        );
      } else {
        gameId = game.id;
        method = linkMethod ?? 'store';
        confidence = linkMethod ? 95 : 100;
        await db.query('UPDATE games SET gog_id = COALESCE(gog_id, ?), gog_slug = COALESCE(gog_slug, ?) WHERE id = ?', [
          externalId,
          slug,
          game.id,
        ]);
      }
    }
  }

  if (!gameId && !ambiguous && fields.name) {
    const { sql, params } = candidateQuery(fields.name);
    const candidates = await db.query(sql, params);
    const decision = matchSteamGame(fields, candidates);
    if (decision.status === 'attach') {
      gameId = decision.gameId;
      method = 'name';
      confidence = decision.confidence;
      await db.query('UPDATE games SET gog_id = ?, gog_slug = COALESCE(gog_slug, ?) WHERE id = ?', [
        externalId,
        fields.gogSlug ?? null,
        gameId,
      ]);
    } else if (decision.status === 'ambiguous') {
      ambiguous = true;
      await writeConflict(db, decision.bestCandidateId, decision.candidates, decision.reason ?? `Ambiguous GOG name match for "${fields.name}" (${externalId})`);
    }
  }

  if (!gameId && !ambiguous) {
    // A previously purged GOG product (src/pipeline/purge-non-games.js) leaves this exact
    // source_records row tombstoned with a {purged:true,...} payload precisely so this "no match found"
    // branch never recreates a gog_exclusive games row for it.
    const existingPayload = await readOwnSourceRecordPayload(db, externalId);
    if (isPurgedTombstone(existingPayload)) {
      log?.info?.('gog: external id was purged as a non-game, refusing to recreate', { externalId, class: existingPayload.class });
      await ctx.upsertRecord(name, externalId, {
        status: 'not_found',
        error: `purged non-game (${existingPayload.class})`,
        payload: existingPayload,
        gameId: null,
      });
      return { status: 'not_found', externalId, reason: 'purged' };
    }

    // src/pipeline/resolve.js's own "does a separate base-game row exist" lookup (classifyNonGame()'s
    // `bundle` class) - imported lazily to avoid a static import cycle back through resolve.js's own
    // `getSource()` (src/sources/index.js), which loads every source module including this one.
    const gogType = payload?.catalog?.productType ?? payload?.en?._embedded?.product?.productType ?? null;
    const { findBaseGameExists } = await import('../pipeline/resolve.js');
    const base = bundleBaseName(fields.name ?? '');
    const baseGameExists = base ? await findBaseGameExists(db, base) : false;
    const cls = classifyNonGame({ name: fields.name, gogType, genres: fields.genres, baseGameExists });

    if (cls) {
      log?.info?.('gog: new external id classifies as non-game at creation time, not creating a games row', { externalId, class: cls });
      await ctx.upsertRecord(name, externalId, {
        status: 'not_found',
        error: `purged non-game (${cls})`,
        payload: buildTombstonePayload({ cls, name: fields.name ?? null }),
        gameId: null,
      });
      return { status: 'not_found', externalId, reason: 'non_game' };
    }

    const result = await db.query(
      `INSERT INTO games (kind, name, name_normalized, gog_id, gog_slug, image)
       VALUES ('gog_exclusive', ?, ?, ?, ?, ?)`,
      [fields.name ?? `GOG ${externalId}`, normalizeName(fields.name ?? '', { convertRom: true }), externalId, fields.gogSlug ?? null, fields.image ?? null],
    );
    gameId = result.insertId;
    method = 'store';
    confidence = 100;
  }

  await ctx.upsertRecord(name, externalId, { status: 'ok', payload, gameId: ambiguous ? null : gameId });

  if (gameId && !ambiguous) {
    await ctx.upsertLink(gameId, name, externalId, {
      url: fields.links?.gog?.url ?? null,
      method,
      confidence,
    });
    await ctx.enqueueResolve(gameId);
  }

  return { status: 'ok', externalId, gameId: ambiguous ? null : gameId, method, ambiguous };
}

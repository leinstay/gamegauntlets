// Extract-only pseudo-source for the frozen legacy snapshot (spec
// docs/specs/2026-09-19-rewrite-design.md §7, §10). `scripts/migrate-legacy.js`
// (T7) stores one `source_records` row per surviving legacy game with
// `source = 'legacy_steamdb'`, `external_id = <legacy games.id>`, and
// `payload` = the full legacy `steamdb.games` row as JSON (columns per
// `.claude/docs/database-schema.md`). This module only maps that payload to
// the resolver's vocabulary (plan: "Extracted-field vocabulary") — it never
// fetches anything itself, so it has no `discover()`/`fetchOne()` and no
// `rateLimit`; `extractOnly = true` tells src/sources/index.js not to start a
// BullMQ worker/queue for it (nothing ever enqueues a job on a source named
// 'legacy_steamdb').
//
// Legacy column -> vocabulary key (also see database-schema.md's "games
// columns" section for the full legacy column list):
//   published_store                       -> storeRelease {date,precision}
//   published_meta                        -> releaseCandidates[0] (source
//                                             'legacy_gamefaqs' — published_meta
//                                             is actually populated by the
//                                             GameFAQs half of the combined
//                                             metacritic_gamefaq.php scraper,
//                                             see legacy/.../SGG/metacritic_gamefaq.php:167)
//   published_stsp                        -> releaseCandidates[1] (source 'legacy_steamspy')
//   published_hltb                        -> releaseCandidates[2] (source 'legacy_hltb')
//   published_igdb                        -> releaseCandidates[3] (source 'legacy_igdb')
//   store_uscore                          -> scoreSteam
//   meta_score                            -> scoreCritics (scoreCriticsSource: 'metacritic', frozen forever, §7)
//   meta_uscore                           -> scoreUsersMetacritic (frozen)
//   grnk_score                            -> scoreGamerankings (frozen, GameRankings is dead)
//   gfq_rating                            -> scoreGamefaqs (0..5, as-is)
//   igdb_score / igdb_uscore              -> scoreIgdb / scoreIgdbUsers
//   hltb_single / hltb_complete           -> timeMain / timeComplete
//   igdb_single / igdb_complete           -> timeMainIgdb / timeCompleteIgdb (secondary time hint —
//                                             src/lib/resolver/index.js falls back to these when no
//                                             dedicated 'hltb'/'igdb' source exists yet for this game)
//   gfq_difficulty                        -> difficulty
//   stsp_owners                           -> ownersEstimate
//   (stsp_mdntime was mapped to playtimeMedianMinutes as a last-resort games.time_average fallback;
//    dropped 2026-09-19 - it never survived resolution for any of the ~111k migrated games, see
//    src/lib/resolver/time.js's module note)
//   platforms/developers/publishers/
//     genres/tags/categories/languages/
//     voiceovers (comma-separated text)   -> arrays (toPipeList-ready, resolver unions them)
//   price_en/price_final_en/discount_en   -> prices.usd.{initial,final,discount}
//   price_ru/price_final_ru/discount_ru   -> prices.rub.{initial,final,discount}
//   sid + store_platform                  -> steamAppid/gogId (identity — informational only; resolve.js
//                                             never writes id/kind/steam_appid/gog_id from resolved columns)
//   name/image/description_en/description_ru/achievements -> as-is (lowest-priority fallback, see below)
//   store_url (+ store_platform) / meta_url -> links.{steam,gog}/links.metacritic {id,url}
//
// name/image/description_en/description_ru/achievements are mapped as a *lowest-priority fallback*:
// scripts/migrate-legacy.js (T7) already writes them onto the `games` row directly at migration time, and a
// real 'steam'/'gog' source (T8/T9) always wins once it exists (src/lib/resolver/index.js's storeField()),
// but until that catalog re-fetch happens — which for most of the ~111.7k migrated games is days away, not
// immediate — this is the only source with anything to say about them. Reporting them here, combined with
// src/pipeline/resolve.js's rule of never writing a column no source reported this pass, is what keeps a
// resolve pass from blanking them out during that window. `isFree` is deliberately NOT reported: legacy has
// no reliable free-game flag (a 0 `price_en` can just as easily mean "price never captured" as "free"), so
// leaving it unset defers to whatever `is_free` migrate-legacy.js/a later store source set.

import { parseDate } from '../lib/dates.js';

export const name = 'legacy_steamdb';
export const extractOnly = true;

/** 'a,b, c' -> ['a','b','c']; null/'' -> null. `toPipeList` (called by the resolver) handles trimming/dedup. */
function splitList(value) {
  if (value === null || value === undefined || value === '') return null;
  const items = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

/** `{initial, final, discount}` for one price region, or `null` when nothing is known about it. */
function priceRegion(initial, final, discount) {
  if (initial === null || initial === undefined) {
    if (final === null || final === undefined) return null;
  }
  return { initial: initial ?? null, final: final ?? null, discount: discount ?? null };
}

function buildPrices(payload) {
  const usd = priceRegion(payload.price_en, payload.price_final_en, payload.discount_en);
  const rub = priceRegion(payload.price_ru, payload.price_final_ru, payload.discount_ru);
  if (!usd && !rub) return undefined;
  const prices = {};
  if (usd) prices.usd = usd;
  if (rub) prices.rub = rub;
  return prices;
}

/** The store link (steam or gog, whichever `store_platform` says) plus the metacritic link, if any. */
function buildLinks(payload) {
  const links = {};
  if (payload.store_url) {
    if (payload.store_platform === 'Steam') links.steam = { id: payload.sid ?? null, url: payload.store_url };
    else if (payload.store_platform === 'GOG') links.gog = { id: payload.sid ?? null, url: payload.store_url };
  }
  if (payload.meta_url) links.metacritic = { id: null, url: payload.meta_url };
  return Object.keys(links).length ? links : undefined;
}

/** One release candidate from a legacy `published_*` column, tagged with the pseudo-source it stands in for. */
function releaseCandidate(source, rawDate) {
  const { date, precision } = parseDate(rawDate);
  return { source, kind: 'independent', date, precision };
}

/**
 * `extract(payload)` — pure, no I/O. `payload` is the full legacy
 * `steamdb.games` row as stored in `source_records.payload` (already
 * `JSON.parse`d by the caller).
 */
export function extract(payload = {}) {
  const fields = {
    // Lowest-priority fallback (see the file header): a real 'steam'/'gog' source always wins when present.
    name: payload.name ?? null,
    image: payload.image ?? null,
    descriptionEn: payload.description_en ?? null,
    descriptionRu: payload.description_ru ?? null,
    achievements: payload.achievements ?? null,

    storeRelease: parseDate(payload.published_store),
    releaseCandidates: [
      releaseCandidate('legacy_gamefaqs', payload.published_meta),
      releaseCandidate('legacy_steamspy', payload.published_stsp),
      releaseCandidate('legacy_hltb', payload.published_hltb),
      releaseCandidate('legacy_igdb', payload.published_igdb),
    ],

    // Frozen scores (spec §7): the live scrapers behind these are dead; the values are carried forward as-is.
    scoreSteam: payload.store_uscore ?? null,
    scoreCritics: payload.meta_score ?? null,
    scoreUsersMetacritic: payload.meta_uscore ?? null,
    scoreGamerankings: payload.grnk_score ?? null,
    scoreGamefaqs: payload.gfq_rating ?? null,
    scoreIgdb: payload.igdb_score ?? null,
    scoreIgdbUsers: payload.igdb_uscore ?? null,

    // Time to beat: HLTB primary, IGDB secondary (legacy gateway.php order — see time.js).
    timeMain: payload.hltb_single ?? null,
    timeComplete: payload.hltb_complete ?? null,
    timeMainIgdb: payload.igdb_single ?? null,
    timeCompleteIgdb: payload.igdb_complete ?? null,

    difficulty: payload.gfq_difficulty ?? null,
    ownersEstimate: payload.stsp_owners ?? null,

    platforms: splitList(payload.platforms),
    developers: splitList(payload.developers),
    publishers: splitList(payload.publishers),
    genres: splitList(payload.genres),
    tags: splitList(payload.tags),
    categories: splitList(payload.categories),
    languages: splitList(payload.languages),
    voiceovers: splitList(payload.voiceovers),

    prices: buildPrices(payload),
    links: buildLinks(payload),
  };

  if (payload.meta_score !== null && payload.meta_score !== undefined) fields.scoreCriticsSource = 'metacritic';

  if (payload.store_platform === 'Steam' && payload.sid !== null && payload.sid !== undefined) {
    fields.steamAppid = Number(payload.sid);
  } else if (payload.store_platform === 'GOG' && payload.sid !== null && payload.sid !== undefined) {
    fields.gogId = payload.sid;
  }

  return fields;
}

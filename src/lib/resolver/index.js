// Combines the per-source extracted fields of one game into `games` columns (migrations/001_init.sql), applying
// the rules from docs/specs/2026-09-19-rewrite-design.md §6 (store priority, critic score source priority,
// list-field union, release/score/time/ggp formulas), then applies any admin `overrides` last.
//
// `fieldsBySource` is `{ <sourceName>: <extractedFields> }` — one entry per source module that has data for this
// game (source names match `game_links.source` / `source_records.source`: steam, gog, legacy_steamdb, hltb, igdb,
// steamspy, gamefaqs, opencritic, wikidata, ...). The shape of `<extractedFields>` (every key optional) is the
// "Extracted-field vocabulary" in `docs/plans/2026-09-19-rewrite-plan.md` (Shared contracts -> Source module
// interface) — read that instead of duplicating it here; source modules (T8-T16) are expected to produce exactly
// those keys (`storeRelease`/`release`/`earlyAccess` for dates, `descriptionEn`/`descriptionRu`, `prices.{usd,rub,
// cisUsd}.{initial,final,discount}`, `steamAppid`/`gogId`/`gogSlug`, the `score*`/`time*`/`difficulty` fields, etc).
// Legacy -> new column name table (for the frozen `legacy_steamdb` snapshot, and the score/time/ggp formulas that
// consume these fields) lives in score.js/time.js/ggp.js's file headers.

import { toPipeList, normalizeName } from '../names.js';
import { resolveRelease, phpEmpty } from './release.js';
import { ggScore } from './score.js';
import { finalTime as computeFinalTime, resolveAveragePlaytime } from './time.js';
import { ggp as computeGgp } from './ggp.js';

const STORE_PRIORITY = ['steam', 'gog'];
// `platforms` is a real MariaDB SET('WIN','MAC','LNX') column (migrations/001_init.sql) — it needs a plain
// comma-joined string of the allowed values, not the pipe-wrapped format the other (TEXT) list columns use,
// so it's handled separately by unionPlatforms() below instead of through LIST_FIELDS/unionListField.
const ALLOWED_PLATFORMS = ['WIN', 'MAC', 'LNX'];
const LIST_FIELDS = ['developers', 'publishers', 'genres', 'tags', 'categories', 'languages', 'voiceovers'];
// vocabulary key -> [column suffix, "initial" price maps to price_<suffix>]
const PRICE_REGIONS = [
  ['usd', 'usd'],
  ['rub', 'rub'],
  ['cisUsd', 'cis_usd'],
];

function firstDefined(fieldsBySource, sourceNames, key) {
  for (const name of sourceNames) {
    const value = fieldsBySource[name] && fieldsBySource[name][key];
    if (!phpEmpty(value)) return value;
  }
  return null;
}

/** First non-empty `key` across every source, in insertion order — used for fields no two sources realistically compete on. */
function firstAcrossAll(fieldsBySource, key) {
  return firstDefined(fieldsBySource, Object.keys(fieldsBySource), key);
}

/** Like firstAcrossAll(), but a numeric 0 is a real value (phpEmpty() would drop it) — e.g. "0% positive". */
function firstNumberAcrossAll(fieldsBySource, key) {
  for (const fields of Object.values(fieldsBySource)) {
    const value = fields && fields[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function pickStore(fieldsBySource) {
  const name = STORE_PRIORITY.find((n) => fieldsBySource[n]);
  if (name) return fieldsBySource[name];
  // Fallback for a game with no dedicated 'steam'/'gog' source_records yet — e.g. right after the legacy
  // migration (T7), before catalog re-crawl (T8/T9) has run: any source reporting a `storeRelease` is by
  // definition store-shaped data ("store's own release date (Steam/GOG)" — plan's vocabulary), so its
  // name/image/description/achievements/isFree/prices are usable the same way as a real 'steam'/'gog'
  // source. Real 'steam'/'gog' data always wins once it exists (checked above, first).
  return Object.values(fieldsBySource).find((f) => f?.storeRelease) || null;
}

/**
 * Store-priority lookup (Steam > GOG) for one field, falling back to `store` (`pickStore()`'s result —
 * itself already Steam > GOG > any storeRelease-reporting source) only when *neither* Steam nor GOG report
 * anything for this field. This keeps the existing Steam-vs-GOG crossover behaviour of `firstDefined`
 * exactly as it was (e.g. GOG's name is still used if a 'steam' source_records row exists but happens not
 * to report a name), while adding the fallback source (typically `legacy_steamdb.js`'s frozen snapshot) as
 * a last resort for display/catalog fields — see the "never blank" rule in src/pipeline/resolve.js.
 */
function storeField(fieldsBySource, key, store) {
  const direct = firstDefined(fieldsBySource, STORE_PRIORITY, key);
  if (!phpEmpty(direct)) return direct;
  const fallback = store?.[key];
  return phpEmpty(fallback) ? null : fallback;
}

/** True when `fields.prices` has an actual value (initial or final) in at least one region. */
function hasAnyPrice(fields) {
  if (!fields?.prices) return false;
  return PRICE_REGIONS.some(([key]) => {
    const p = fields.prices[key];
    return p && (!phpEmpty(p.initial) || !phpEmpty(p.final));
  });
}

/**
 * Which source's `prices` the PRICE_REGIONS loop should actually read from. Normally this is just
 * `pickStore()`'s result (Steam > GOG, same as every other store field) — but a Steam record can exist and
 * win `pickStore()` while reporting no price at all (e.g. a delisted-but-still-visible store page: Steam
 * appdetails succeeds, so this isn't a `steam_delisted` case, but `price_overview` is absent because the
 * page can't actually be bought — see src/lib/purchasable.js's motivating case, Steam app 1145100). Without
 * this, a GOG record for the same game with a real price would be shadowed and every price column would
 * resolve to `null`. So: prefer the first STORE_PRIORITY source that actually has a price; only fall back
 * to `store` (preserving the old behaviour) when neither Steam nor GOG has any price to offer.
 */
function pickPriceSource(fieldsBySource, store) {
  for (const sourceName of STORE_PRIORITY) {
    if (hasAnyPrice(fieldsBySource[sourceName])) return fieldsBySource[sourceName];
  }
  return store;
}

/** Union every source's array for `field`, normalised (trimmed, deduped) and pipe-listed via `src/lib/names.js`. */
function unionListField(fieldsBySource, field) {
  const values = [];
  for (const fields of Object.values(fieldsBySource)) {
    if (Array.isArray(fields?.[field])) values.push(...fields[field]);
  }
  return toPipeList(values);
}

/**
 * Union every source's `platforms` array into the SET('WIN','MAC','LNX') column's own format: a
 * comma-joined string in that fixed order, deduped, with anything that isn't one of those three values
 * dropped (a SET column rejects an unrecognised member outright) — or `null` when nothing usable was found.
 */
function unionPlatforms(fieldsBySource) {
  const found = new Set();
  for (const fields of Object.values(fieldsBySource)) {
    if (!Array.isArray(fields?.platforms)) continue;
    for (const raw of fields.platforms) {
      if (raw === null || raw === undefined) continue;
      const value = String(raw).trim().toUpperCase();
      if (ALLOWED_PLATFORMS.includes(value)) found.add(value);
    }
  }
  const ordered = ALLOWED_PLATFORMS.filter((p) => found.has(p));
  return ordered.length ? ordered.join(',') : null;
}

/**
 * Build resolveRelease() candidates from every source's `storeRelease` (kind 'store') / `release` (kind
 * 'independent'), plus any `releaseCandidates` array a source bundles in directly.
 *
 * `releaseCandidates` (plan's vocabulary) lets one payload report several independent origins at once — the
 * frozen legacy snapshot (`legacy_steamdb.js`) carries GameFAQs/SteamSpy/HLTB/IGDB release dates from a
 * single `steamdb.games` row, and needs each to become its own candidate so the clustering below treats
 * them as independent sources, the same way the legacy 4-source formula did (see release.js's
 * legacyRelease/findEqualDates). A future multi-origin source can use the same escape hatch.
 */
function buildReleaseCandidates(fieldsBySource) {
  const candidates = [];
  for (const [source, fields] of Object.entries(fieldsBySource)) {
    if (!fields) continue;
    if (fields.storeRelease && !phpEmpty(fields.storeRelease.date)) {
      candidates.push({ source, kind: 'store', date: fields.storeRelease.date, precision: fields.storeRelease.precision });
    }
    if (fields.release && !phpEmpty(fields.release.date)) {
      candidates.push({ source, kind: 'independent', date: fields.release.date, precision: fields.release.precision });
    }
    if (Array.isArray(fields.releaseCandidates)) {
      for (const candidate of fields.releaseCandidates) {
        if (candidate && !phpEmpty(candidate.date)) {
          candidates.push({
            source: candidate.source || source,
            kind: candidate.kind || 'independent',
            date: candidate.date,
            precision: candidate.precision,
          });
        }
      }
    }
  }
  return candidates;
}

/**
 * Fallback HLTB-equivalent source for the time-to-beat glue below: a source that bundles its own
 * `timeMain`/`timeComplete` next to an IGDB-equivalent secondary hint (`timeMainIgdb`/`timeCompleteIgdb`).
 * Only the frozen legacy snapshot (legacy_steamdb.js) does this today; a real per-source module always
 * reports plainly under its own source name ('hltb', 'igdb').
 */
function findTimeFallbackSource(fieldsBySource) {
  return Object.values(fieldsBySource).find((f) => f && (f.timeMainIgdb !== undefined || f.timeCompleteIgdb !== undefined));
}

/** First source that reports an early-access date (there is normally at most one: the store the game is on). */
function bestEarlyAccess(fieldsBySource) {
  for (const fields of Object.values(fieldsBySource)) {
    if (fields?.earlyAccess && !phpEmpty(fields.earlyAccess.date)) return fields.earlyAccess;
  }
  return null;
}

/**
 * Critics score (spec §7, updated for the live src/sources/metacritic.js source): priority is (1) the live
 * `metacritic` source module itself, (2) any *other* source reporting Metacritic provenance — the frozen
 * `legacy_steamdb`/`legacy_metacritic` snapshot, in insertion order — then (3) OpenCritic (disabled by default as of
 * this rewrite, see config.json's `sources.opencritic.enabled`, but still consulted here so a game an admin
 * re-enables it for keeps working). The live source wins even when a legacy-provenance entry happens to iterate
 * first in `fieldsBySource`, which a plain `firstAcrossAll` insertion-order lookup would get wrong. A source is
 * treated as "Metacritic" either because it says so via `scoreCriticsSource`, or, failing that, because its source
 * name mentions it (covers the frozen legacy snapshot regardless of which exact source key T7's migration used).
 */
function resolveCriticsScore(fieldsBySource) {
  const live = fieldsBySource.metacritic;
  if (live && !phpEmpty(live.scoreCritics)) {
    return { score: live.scoreCritics, count: live.scoreCriticsCount ?? null, source: 'metacritic' };
  }

  let metacritic = null;
  let opencritic = null;

  for (const [source, fields] of Object.entries(fieldsBySource)) {
    if (source === 'metacritic') continue; // already checked above (missing/empty live value)
    if (!fields || phpEmpty(fields.scoreCritics)) continue;
    const provenance = fields.scoreCriticsSource || (source.includes('metacritic') ? 'metacritic' : source.includes('opencritic') ? 'opencritic' : null);
    if (provenance === 'metacritic' && !metacritic) metacritic = { fields, provenance };
    else if (provenance === 'opencritic' && !opencritic) opencritic = { fields, provenance };
  }

  const chosen = metacritic || opencritic;
  if (!chosen) return { score: null, count: null, source: null };
  return { score: chosen.fields.scoreCritics, count: chosen.fields.scoreCriticsCount ?? null, source: chosen.provenance };
}

/**
 * `score_users_metacritic` (legacy `meta_uscore`): the live `metacritic` source's own user-score value wins over
 * anything a legacy/bundled snapshot reports under the same key — mirrors `resolveCriticsScore`'s live-source-first
 * rule above rather than `firstAcrossAll`'s plain insertion-order lookup.
 */
function resolveUsersMetacritic(fieldsBySource) {
  const live = fieldsBySource.metacritic;
  if (live && !phpEmpty(live.scoreUsersMetacritic)) return live.scoreUsersMetacritic;
  return firstAcrossAll(fieldsBySource, 'scoreUsersMetacritic');
}

/**
 * `resolveGame(fieldsBySource, overrides, config, now) -> { columns, conflicts }`.
 *
 * `overrides`: `{ [column]: value }` — applied last, unconditionally (admin overrides always win).
 * `config`: the loaded `config.json` (uses `config.resolver.{releaseToleranceMonths,oldGameRuleMonths,ggScore,ggp}`).
 * `now`: `Date` for `ggScore`'s age penalty — pass a fixed value in tests/fixtures.
 */
export function resolveGame(fieldsBySource = {}, overrides = {}, config = {}, now = new Date()) {
  const conflicts = [];
  const columns = {};
  const resolverCfg = config.resolver || {};
  const store = pickStore(fieldsBySource);

  // --- store data: Steam > GOG > (legacy snapshot / any storeRelease-reporting source, see storeField()) ---
  columns.name = storeField(fieldsBySource, 'name', store);
  columns.name_normalized = columns.name ? normalizeName(columns.name) : null;
  columns.image = storeField(fieldsBySource, 'image', store);
  columns.description_en = storeField(fieldsBySource, 'descriptionEn', store);
  columns.description_ru = storeField(fieldsBySource, 'descriptionRu', store);
  columns.achievements = storeField(fieldsBySource, 'achievements', store);
  columns.is_free = store?.isFree ? 1 : 0;
  // steam_delisted is owned by src/sources/steam.js (verified appdetails failures); the resolver never writes it.

  const priceSource = pickPriceSource(fieldsBySource, store);
  for (const [key, suffix] of PRICE_REGIONS) {
    const prices = priceSource?.prices?.[key];
    columns[`price_${suffix}`] = prices?.initial ?? null;
    columns[`price_final_${suffix}`] = prices?.final ?? null;
    columns[`discount_${suffix}`] = prices?.discount ?? null;
  }

  // --- identity / kind ---
  const steamAppid = firstAcrossAll(fieldsBySource, 'steamAppid');
  columns.kind = steamAppid ? 'steam' : 'gog_exclusive';
  columns.steam_appid = steamAppid ?? null;
  columns.gog_id = firstAcrossAll(fieldsBySource, 'gogId');
  columns.gog_slug = firstAcrossAll(fieldsBySource, 'gogSlug');

  // --- list fields: union across every source ---
  columns.platforms = unionPlatforms(fieldsBySource);
  for (const field of LIST_FIELDS) columns[field] = unionListField(fieldsBySource, field);

  columns.owners_estimate = firstAcrossAll(fieldsBySource, 'ownersEstimate');
  columns.difficulty = firstAcrossAll(fieldsBySource, 'difficulty');

  // --- scores ---
  const critics = resolveCriticsScore(fieldsBySource);
  columns.score_critics = critics.score;
  columns.score_critics_count = critics.count;
  columns.score_critics_source = critics.source;

  // Each of these is, in normal operation, only ever reported by its one canonical source (Steam/IGDB/
  // GameFAQs) — `firstAcrossAll` is equivalent to a hardcoded per-source lookup in that case, but (like
  // scoreGamerankings/scoreUsersMetacritic below) also lets a bundled snapshot source report it before the
  // dedicated source module has ever run for this game (see legacy_steamdb.js).
  columns.score_steam = firstAcrossAll(fieldsBySource, 'scoreSteam');
  columns.score_steam_votes = firstAcrossAll(fieldsBySource, 'scoreSteamVotes');
  // Last ~30 days only (src/sources/steam.js's appReviewHistogramUrl) - a separate "Recent reviews"
  // card row (src/lib/steam-review-label.js), deliberately NOT folded into gg_score below.
  // 0 is meaningful here (every recent review negative); the source only emits it when votes > 0.
  columns.score_steam_recent = firstNumberAcrossAll(fieldsBySource, 'scoreSteamRecent');
  columns.score_steam_recent_votes = firstAcrossAll(fieldsBySource, 'scoreSteamRecentVotes');
  columns.score_igdb = firstAcrossAll(fieldsBySource, 'scoreIgdb');
  columns.score_igdb_users = firstAcrossAll(fieldsBySource, 'scoreIgdbUsers');
  columns.score_gamefaqs = firstAcrossAll(fieldsBySource, 'scoreGamefaqs');
  // The archived GameRankings dataset (src/sources/gamerankings.js) beats the legacy snapshot's grnk_score:
  // same site, but matched to the PC release and rounded instead of floored.
  columns.score_gamerankings =
    (fieldsBySource.gamerankings && !phpEmpty(fieldsBySource.gamerankings.scoreGamerankings)
      ? fieldsBySource.gamerankings.scoreGamerankings
      : null) ?? firstAcrossAll(fieldsBySource, 'scoreGamerankings');
  columns.score_users_metacritic = resolveUsersMetacritic(fieldsBySource);

  // --- release date ---
  const releaseCandidates = buildReleaseCandidates(fieldsBySource);
  const release = resolveRelease(releaseCandidates, {
    releaseToleranceMonths: resolverCfg.releaseToleranceMonths,
    oldGameRuleMonths: resolverCfg.oldGameRuleMonths,
    earlyAccess: bestEarlyAccess(fieldsBySource),
  });
  columns.release_date = release.date;
  columns.release_precision = release.precision;
  columns.release_confidence = release.confidence;
  columns.early_access_date = release.earlyAccess;
  columns.store_release_date = release.storeDate;
  if (release.conflict) conflicts.push({ field: 'release_date', ...release.conflict });

  // --- gg score (needs the resolved release date + list fields above) ---
  const { score: ggScoreValue } = ggScore(
    {
      scoreSteam: columns.score_steam,
      scoreSteamVotes: columns.score_steam_votes,
      scoreIgdb: columns.score_igdb,
      scoreIgdbUsers: columns.score_igdb_users,
      scoreCritics: columns.score_critics,
      scoreCriticsCount: columns.score_critics_count,
      scoreUsersMetacritic: columns.score_users_metacritic,
      scoreGamerankings: columns.score_gamerankings,
      scoreGamefaqs: columns.score_gamefaqs,
      ownersEstimate: columns.owners_estimate,
      releaseDate: columns.release_date,
      genres: columns.genres,
    },
    resolverCfg.ggScore,
    now
  );
  columns.gg_score = ggScoreValue;

  // --- time to beat: HLTB primary, IGDB secondary (legacy hltb_single/igdb_single/hltb_complete/igdb_complete) ---
  // `hltb`/`igdb` fall back to a bundled snapshot source (legacy_steamdb.js) when no dedicated 'hltb'/'igdb'
  // source_records exists yet for this game: such a source reports its own HLTB-equivalent timeMain/
  // timeComplete plus an IGDB-equivalent secondary hint (timeMainIgdb/timeCompleteIgdb), filling both slots
  // at once. Real 'hltb'/'igdb' sources always win once they exist (checked first, below).
  const hltb = fieldsBySource.hltb || findTimeFallbackSource(fieldsBySource) || {};
  const igdb =
    fieldsBySource.igdb ||
    (hltb.timeMainIgdb !== undefined || hltb.timeCompleteIgdb !== undefined
      ? { timeMain: hltb.timeMainIgdb, timeComplete: hltb.timeCompleteIgdb }
      : {});
  columns.time_main = hltb.timeMain ?? null;
  const { finalTime: finalTimeValue, timeComplete } = computeFinalTime({
    timeMain: hltb.timeMain,
    igdbSingle: igdb.timeMain,
    timeComplete: hltb.timeComplete,
    igdbComplete: igdb.timeComplete,
  });
  columns.final_time = finalTimeValue;
  columns.time_complete = timeComplete;

  // --- average playtime (Steam reviews median > SteamSpy > legacy - see time.js's resolveAveragePlaytime) ---
  // `playtimeMedianMinutes` is reported under the same key by both a live 'steamspy' source_records row
  // and the legacy_steamdb fallback (stsp_mdntime) - same pattern as `ownersEstimate` above - but
  // time_average_source must say which one actually won, so (unlike firstAcrossAll's plain
  // insertion-order lookup) this reads 'steamspy' specifically first and only then falls back to
  // whatever *other* source reported the same key (in practice always legacy_steamdb).
  const steamFields = fieldsBySource.steam || {};
  const steamspyFields = fieldsBySource.steamspy || {};
  const legacyPlaytimeFields = Object.entries(fieldsBySource).find(
    ([source, fields]) => source !== 'steamspy' && fields && !phpEmpty(fields.playtimeMedianMinutes)
  )?.[1];
  const averagePlaytime = resolveAveragePlaytime(
    {
      steamReviewsMedianMinutes: steamFields.playtimeReviewsMedianMinutes,
      steamReviewsCount: steamFields.playtimeReviewsCount,
      steamspyMedianMinutes: steamspyFields.playtimeMedianMinutes,
      steamspyAverageMinutes: steamspyFields.playtimeAverageMinutes,
      legacyMedianMinutes: legacyPlaytimeFields?.playtimeMedianMinutes,
    },
    resolverCfg.playtime
  );
  columns.time_average = averagePlaytime?.hours ?? null;
  columns.time_average_source = averagePlaytime?.source ?? null;

  // --- ggp ---
  const { ggp: ggpValue, parts: ggpParts } = computeGgp(
    {
      difficulty: columns.difficulty,
      finalTime: columns.final_time,
      finalScore: columns.gg_score,
      ownersEstimate: columns.owners_estimate,
      priceRub: columns.price_rub,
    },
    resolverCfg.ggp
  );
  columns.ggp = ggpValue;
  columns.ggp_parts = ggpParts;

  // --- overrides: always last, unconditionally ---
  for (const [field, value] of Object.entries(overrides || {})) columns[field] = value;

  return { columns, conflicts };
}

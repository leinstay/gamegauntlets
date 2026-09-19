// GG score ("SGG rating"). Exact port of gateway.php lines ~194-239, with every
// constant moved to `config.json` -> `resolver.ggScore` (passed in as `weights`).
//
// Legacy -> new column mapping (steamdb.games -> gg.games; also used by score input keys below):
//   store_uscore  -> score_steam            -> input.scoreSteam
//   igdb_score    -> score_igdb             -> input.scoreIgdb
//   igdb_uscore   -> score_igdb_users       -> input.scoreIgdbUsers
//   meta_score    -> score_critics          -> input.scoreCritics
//   meta_uscore   -> score_users_metacritic -> input.scoreUsersMetacritic (frozen legacy value, never overwritten)
//   grnk_score    -> score_gamerankings     -> input.scoreGamerankings
//   gfq_rating    -> score_gamefaqs (0..5)  -> input.scoreGamefaqs (multiplied by 20 here, exactly like legacy `*20`)
//   stsp_owners   -> owners_estimate        -> input.ownersEstimate
//   genres        -> genres                 -> input.genres (pipe-list string or string[]; checked for "Indie")
//
// The legacy formula also needs "now" (age penalty uses the resolved release date vs. today) — `now` is an explicit
// parameter here instead of `new Date()` so tests (and the regression fixtures, pinned to a fixed date) are deterministic.

// Uses release.js's `legacyMonthsDiff` (PHP `DateTime::diff()`-exact, day-of-month-aware), not dates.js's
// `monthsBetween` — this age penalty is an exact port of gateway.php's `$d2->diff($d1)->y`, so it needs the same
// day-borrowing semantics PHP uses, not the simpler month-index difference `monthsBetween` computes.
import { phpEmpty, phpRound, legacyMonthsDiff } from './release.js';

// [scoreField, voteCountField|null] — only Steam and critics carry a vote/review count in the new schema
// (score_steam_votes, score_critics_count); the others have no count to weight by.
const RATING_FIELDS = [
  ['scoreSteam', 'scoreSteamVotes'],
  ['scoreIgdb', null],
  ['scoreIgdbUsers', null],
  ['scoreCritics', 'scoreCriticsCount'],
  ['scoreUsersMetacritic', null],
  ['scoreGamerankings', null],
];

function average(numbers) {
  const usable = numbers.filter((n) => !phpEmpty(n));
  if (!usable.length) return 0;
  return usable.reduce((a, b) => a + b, 0) / usable.length;
}

function hasGenre(genres, needle) {
  if (!genres) return false;
  const haystack = Array.isArray(genres) ? genres.join('|') : String(genres);
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function ageYears(releaseDate, now) {
  if (phpEmpty(releaseDate)) return null;
  return Math.floor(legacyMonthsDiff(releaseDate, now) / 12);
}

/**
 * Vote-count weighting (spec T6 item 1): OFF by default (`weights.voteWeighting.enabled`), so default output is
 * bit-for-bit identical to legacy (simple average of available ratings). When enabled, each rating is weighted by
 * `log(logBase, votes + offset)` so a score backed by a handful of reviews counts for less than one backed by tens
 * of thousands — votes/counts default to 1 (no down-weighting) when a source didn't report a count.
 */
function weightedAverage(ratingsWithVotes, voteWeighting) {
  const logBase = voteWeighting.logBase ?? 10;
  const offset = voteWeighting.offset ?? 10;
  const minWeight = voteWeighting.minWeight ?? 1;

  let weightedSum = 0;
  let weightSum = 0;
  for (const { value, votes } of ratingsWithVotes) {
    const v = phpEmpty(votes) ? null : Number(votes);
    const weight = v === null ? minWeight : Math.max(minWeight, Math.log(v + offset) / Math.log(logBase));
    weightedSum += value * weight;
    weightSum += weight;
  }
  return weightSum ? weightedSum / weightSum : 0;
}

/**
 * `ggScore(input, weights, now) -> { score, parts }`.
 *
 * `input`: `{ scoreSteam, scoreSteamVotes?, scoreIgdb, scoreIgdbUsers, scoreCritics, scoreCriticsCount?,
 *   scoreUsersMetacritic, scoreGamerankings, scoreGamefaqs, ownersEstimate, releaseDate, genres }`.
 * `weights`: `config.resolver.ggScore` (see config.json for the full shape/defaults).
 * `now`: `Date` (or date-string) used for the age penalty — pass a fixed value in tests/fixtures.
 */
export function ggScore(input = {}, weights = {}, now = new Date()) {
  const missing = weights.missingPenalty || {};
  const parts = { ratingsUsed: [], missingPenalty: 0, ownersAdjustment: 0, agePenalty: 0, indiePenalty: 0 };

  const ratings = [];
  const ratingsWithVotes = [];
  let diminishing = 0;

  for (const [field, votesField] of RATING_FIELDS) {
    const value = input[field];
    const penalty = missing[field] ?? 0;
    if (!phpEmpty(value)) {
      ratings.push(Number(value));
      ratingsWithVotes.push({ value: Number(value), votes: votesField ? input[votesField] : undefined });
      parts.ratingsUsed.push(field);
    } else {
      diminishing += penalty;
      parts.missingPenalty += penalty;
    }
  }

  const gfqPenalty = missing.scoreGamefaqs ?? 0;
  if (!phpEmpty(input.scoreGamefaqs)) {
    const scaled = Number(input.scoreGamefaqs) * 20;
    ratings.push(scaled);
    ratingsWithVotes.push({ value: scaled, votes: undefined });
    parts.ratingsUsed.push('scoreGamefaqs');
  } else {
    diminishing += gfqPenalty;
    parts.missingPenalty += gfqPenalty;
  }

  if (!phpEmpty(input.ownersEstimate)) {
    const bucket = (weights.ownerBuckets || []).find((b) => b.value === Number(input.ownersEstimate));
    if (bucket) {
      diminishing += bucket.penalty;
      parts.ownersAdjustment = bucket.penalty;
    }
  }

  const years = ageYears(input.releaseDate, now);
  let agePenalty = weights.defaultAgePenalty ?? 0;
  if (years !== null) {
    const bracket = (weights.ageBrackets || []).find((b) => years <= b.maxYears);
    agePenalty = bracket ? bracket.penalty : weights.defaultAgePenalty ?? 0;
  }
  diminishing += agePenalty;
  parts.agePenalty = agePenalty;

  if (hasGenre(input.genres, 'Indie')) {
    const indiePenalty = weights.indiePenalty ?? 0;
    diminishing += indiePenalty;
    parts.indiePenalty = indiePenalty;
  }

  let score;
  if (ratings.length === 0) score = 0;
  else if (ratings.length === 1) score = ratings[0];
  else if (weights.voteWeighting?.enabled) score = phpRound(weightedAverage(ratingsWithVotes, weights.voteWeighting));
  else score = phpRound(average(ratings));

  if (score >= 50) score -= diminishing;
  if (score <= 0) score = 0;
  if (score >= 100) score = 100;

  parts.diminishing = diminishing;
  parts.ratingsAverageRaw = ratings.length ? average(ratings) : 0;

  return { score, parts };
}

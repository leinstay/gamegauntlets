// Time-to-beat resolution. Exact port of gateway.php lines ~247-258.
//
// Legacy -> new column mapping (see also score.js / ggp.js / index.js for the rest of the table):
//   hltb_single   -> input.timeMain     (also stored as-is into games.time_main by the caller, not by this function)
//   hltb_complete -> input.timeComplete (this function's `timeComplete` output becomes games.time_complete)
//   igdb_single   -> input.igdbSingle   (secondary/fallback time, not stored in its own column)
//   igdb_complete -> input.igdbComplete (secondary/fallback time, not stored in its own column)
//   (final_time)  -> output.finalTime   (games.final_time)

import { phpEmpty, phpRound } from './release.js';

/** Loose-numeric comparison the way PHP's `>` does for null/'': missing values act like 0. */
function toComparable(v) {
  if (phpEmpty(v)) return 0;
  return Number(v);
}

/**
 * `finalTime(input) -> { finalTime, timeComplete }`.
 *
 * `input`: `{ timeMain, igdbSingle, timeComplete, igdbComplete }` (hours, any of them possibly null/0/undefined).
 *
 * Order (from gateway.php):
 *  1. finalTime = timeMain, else igdbSingle, else timeComplete, else igdbComplete, else 0.
 *  2. If finalTime > timeComplete (the *raw* value, before anything below), bump timeComplete to finalTime + 1 —
 *     this is the legacy "the story can't be shorter than the completionist estimate" guard.
 *  3. Round finalTime.
 *  4. timeComplete = round(timeComplete) if it has a value (after step 2), else round(igdbComplete).
 */
export function finalTime(input = {}) {
  const { timeMain, igdbSingle, igdbComplete } = input;
  let rawTimeComplete = input.timeComplete;

  let ft;
  if (!phpEmpty(timeMain)) ft = timeMain;
  else if (!phpEmpty(igdbSingle)) ft = igdbSingle;
  else if (!phpEmpty(rawTimeComplete)) ft = rawTimeComplete;
  else if (!phpEmpty(igdbComplete)) ft = igdbComplete;
  else ft = 0;

  let tc = rawTimeComplete;
  if (toComparable(ft) > toComparable(tc)) tc = toComparable(ft) + 1;

  const finalTimeValue = phpRound(ft);
  const timeCompleteValue = !phpEmpty(tc) ? phpRound(tc) : phpRound(igdbComplete);

  return { finalTime: finalTimeValue, timeComplete: timeCompleteValue };
}

// --- average playtime (games.time_average / games.time_average_source) ---
//
// New in the rewrite: legacy showed "Average playtime" from stsp_mdntime (SteamSpy's median_forever,
// minutes) as `ceil(stsp_mdntime/100)` - legacy/ajax/scripts/gateway.php line ~438. That /100 is a
// legacy quirk/bug, not really a minutes->hours conversion (which is /60); this function does the
// correct /60 conversion and does NOT reproduce the quirk.
//
// Steam reviews first, NOT SteamSpy: SteamSpy's median_forever/average_forever turned out to be
// essentially dead in production - 0 of 80,339 stored SteamSpy payloads have either > 0 (live-verified
// against Portal 2 and Baldur's Gate 3's own appdetails too - still 0), and the legacy DB only ever had
// stsp_mdntime (the frozen legacy fallback, dropped 2026-09-19 - it never survived resolution for any of
// the ~111k migrated games) for 2 of ~111k games. Steam's own reviews (src/sources/steam.js: median of
// author.playtime_at_review over one helpfulness-ranked page of up to 100 reviews) are the only real
// source, so they're tried first once there are enough of them to trust (`config.resolver.playtime.
// minReviews`); SteamSpy remains a fallback for the rare game that does have it, and a lower-confidence
// small-sample reviews median is tried before giving up.
//
// Bias note (src/sources/steam.js's summarizeReviewPlaytime has the same note next to where these
// numbers are computed): Steam reviewers skew towards more-engaged players than the player base as a
// whole, the page is helpfulness-ranked (not a random sample), and `playtime_at_review` is "time when
// the review was written", not a lifetime total. None of that makes it a *completion time* - it's
// presented as "average playtime", an engagement indicator, which is exactly what it is and exactly
// what legacy's SteamSpy-based row claimed to be too (also never a completion time).

/** Minutes -> hours, rounded to one decimal place (NOT the legacy /100 quirk - see the module note above). */
function minutesToHours(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n / 60) * 10) / 10;
}

function positiveOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const DEFAULT_MIN_REVIEWS = 10;
// A reviews median with fewer samples than `minReviews` is still better than SteamSpy having nothing at
// all - 3 is a low bar (avoids trusting a single/double outlier review) rather than a statistically
// meaningful minimum.
const FEWER_REVIEWS_FLOOR = 3;

/**
 * `resolveAveragePlaytime({ steamReviewsMedianMinutes, steamReviewsCount, steamspyMedianMinutes,
 * steamspyAverageMinutes }, config) -> { hours, source: 'steam_reviews'|'steamspy' } | null`.
 *
 * All minutes inputs are optional. `src/lib/resolver/index.js` sources `steamReviewsMedianMinutes`/
 * `steamReviewsCount` from the `steam` source specifically and `steamspyMedianMinutes`/
 * `steamspyAverageMinutes` from `steamspy` - this function itself is pure and source-name-agnostic.
 * `config`: `config.json`'s `resolver.playtime` (`{ minReviews }`) - defaults to `DEFAULT_MIN_REVIEWS`
 * when absent (e.g. in older test fixtures).
 *
 * Priority (see the module note above):
 *  1. Steam reviews median, when there are at least `minReviews` reviews with usable playtime.
 *  2. SteamSpy median (`median_forever`).
 *  3. SteamSpy average (`average_forever`).
 *  4. Steam reviews median again, with as few as `FEWER_REVIEWS_FLOOR` reviews - better than nothing
 *     once SteamSpy has nothing either.
 *  5. `null` - the resolver then leaves `games.time_average`/`time_average_source` untouched (see
 *     src/pipeline/resolve.js's "never blank a column no source reported" rule).
 */
export function resolveAveragePlaytime(
  { steamReviewsMedianMinutes, steamReviewsCount, steamspyMedianMinutes, steamspyAverageMinutes } = {},
  config = {}
) {
  const minReviews = Number.isFinite(config.minReviews) ? config.minReviews : DEFAULT_MIN_REVIEWS;

  const reviewsCount = Number(steamReviewsCount);
  const reviewsMedian = positiveOrNull(steamReviewsMedianMinutes);
  const hasReviews = Number.isFinite(reviewsCount) && reviewsCount > 0 && reviewsMedian !== null;

  if (hasReviews && reviewsCount >= minReviews) {
    return { hours: minutesToHours(reviewsMedian), source: 'steam_reviews' };
  }

  const steamspyMedian = positiveOrNull(steamspyMedianMinutes);
  if (steamspyMedian !== null) return { hours: minutesToHours(steamspyMedian), source: 'steamspy' };

  const steamspyAverage = positiveOrNull(steamspyAverageMinutes);
  if (steamspyAverage !== null) return { hours: minutesToHours(steamspyAverage), source: 'steamspy' };

  if (hasReviews && reviewsCount >= FEWER_REVIEWS_FLOOR) {
    return { hours: minutesToHours(reviewsMedian), source: 'steam_reviews' };
  }

  return null;
}

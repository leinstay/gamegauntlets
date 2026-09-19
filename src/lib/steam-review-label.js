// Pure: Steam's own review-score label table (the text under "ALL REVIEWS:"/"RECENT REVIEWS:" on a
// store page - e.g. "Very Positive (2,757)"), applied to `games.score_steam`/`score_steam_votes` (all)
// and `score_steam_recent`/`score_steam_recent_votes` (recent) alike - see
// src/lib/resolver/index.js and src/lib/game-card.js for where each is produced/consumed.
//
// Boundaries (task spec, matches Steam's own publicly documented table closely enough for this UI row -
// checked top to bottom, first match wins):
//   votes < 10                      -> null (Steam shows "N user reviews" with no label at all)
//   percent >= 95 AND votes >= 500  -> "Overwhelmingly Positive"
//   percent >= 80 AND votes >= 50   -> "Very Positive"
//   percent >= 80                   -> "Positive"
//   percent >= 70                   -> "Mostly Positive"   (70..79)
//   percent >= 40                   -> "Mixed"              (40..69)
//   percent >= 20                   -> "Mostly Negative"    (20..39)
//   percent < 20, votes >= 500      -> "Overwhelmingly Negative"
//   percent < 20, votes >= 50       -> "Very Negative"
//   percent < 20, else              -> "Negative"
//
// Returned labels are the English strings verbatim - they double as i18n keys (public/i18n/*.json) so
// the frontend translates them via the existing __() / GG.i18n.t() machinery rather than this module
// knowing about languages at all.

/**
 * `steamReviewLabel(percent, votes) -> string|null`. `percent`: 0..100 positive share. `votes`: total
 * review count backing that percent (positive + negative). `null` for missing/non-finite input or
 * `votes < 10`.
 */
export function steamReviewLabel(percent, votes) {
  if (percent === null || percent === undefined || votes === null || votes === undefined) return null;
  const p = Number(percent);
  const v = Number(votes);
  if (!Number.isFinite(p) || !Number.isFinite(v)) return null;
  if (v < 10) return null;

  if (p >= 95 && v >= 500) return 'Overwhelmingly Positive';
  if (p >= 80 && v >= 50) return 'Very Positive';
  if (p >= 80) return 'Positive';
  if (p >= 70) return 'Mostly Positive';
  if (p >= 40) return 'Mixed';
  if (p >= 20) return 'Mostly Negative';
  if (v >= 500) return 'Overwhelmingly Negative';
  if (v >= 50) return 'Very Negative';
  return 'Negative';
}

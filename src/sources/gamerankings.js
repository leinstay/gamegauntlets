// Extract-only pseudo-source for the archived GameRankings dataset (GameRankings itself closed in 2019; the
// owner found a community spreadsheet that preserved it — see data/README.md for provenance). Like
// legacy_steamdb.js, this module never fetches anything: `the one-off import script (not kept in the repository)` is the one-time
// orchestration that matches the archived GameRankings sheet rows to `games` and writes one `source_records` row
// per match (source = 'gamerankings', external_id = the sheet's GameRankings/GameFAQs product id). This
// module only maps that stored payload to the resolver's vocabulary — `extractOnly = true` tells
// src/sources/index.js not to start a BullMQ worker/queue for it (nothing ever enqueues a job on a source
// named 'gamerankings').
//
// `payload` shape (as written by the one-off import script (not kept in the repository), matching data/gamerankings.csv's trimmed
// columns): `{ id, title, platform, year, score, reviews, path, matchedBy, viaSheetId }` — `id` is the
// GameFAQs product id (GameRankings and GameFAQs shared ids/urls; the sheet's `GameFAQs` column is just
// `https://gamefaqs.com/<platform>/<id>-<slug>/index.html`), `path` is that url's `<platform>/<id>-<slug>`
// with the host and `/index.html` stripped. `matchedBy` is `'gamefaqs-id'`, `'gamefaqs-id+pc-sibling'` (the
// game's GameFAQs link pointed at a console product; the matcher substituted that console product's PC
// port instead — see the one-off import script (not kept in the repository)'s header, step a-2) or `'name-year'`; `viaSheetId` is
// the originally-matched console row's sheet id, only set for a pc-sibling match. Both are informational
// only, not consumed here.
//
// `links.gamefaqs` below follows the same shape every other source reports a link in (see steam.js's
// `links.metacritic`, legacy_steamdb.js's `links.{steam,gog,metacritic}`) for consistency with the source
// module interface — but as of this writing src/pipeline/resolve.js's buildFieldsBySource()/
// src/lib/resolver/index.js never read `fields.links` from *any* source's extract() at all; only a source's
// own fetchOne()/discover() persists `game_links` rows, via `ctx.upsertLink()` (see _template.js). Since this
// module is extract-only (no fetchOne), reporting `links.gamefaqs` here has no effect on `game_links` today —
// the one-off import script (not kept in the repository) writes the actual `game_links` row itself, directly, when it applies a
// name-year match for a PC row and the game has no existing GameFAQs link (see that script's header comment).

export const name = 'gamerankings';
export const extractOnly = true;

/**
 * The GameFAQs product url path this row implies: `https://gamefaqs.gamespot.com/<path>`. Matches the
 * convention wikidata.js/legacy-map.js use for the same source (`gamefaqs.gamespot.com`, not the sheet's
 * original `gamefaqs.com` host).
 */
function gamefaqsUrl(path) {
  return `https://gamefaqs.gamespot.com/${path}`;
}

/**
 * `scoreGamerankings` is only reported when the row has at least one review and a finite 0..100 score —
 * a 0-review row is an empty placeholder (GameRankings listed the product but nobody ever rated it), and
 * `games.score_gamerankings` is a 0..100 column (migrations/001_init.sql), same range as every other score
 * column. Returns the rounded integer score, or `null` when the row doesn't qualify. Exported so
 * the one-off import script (not kept in the repository) can report the same "would this game gain/change a score" decision the
 * resolver would eventually make, without duplicating the eligibility rule.
 */
export function eligibleScore({ score, reviews } = {}) {
  const numericScore = Number(score);
  const numericReviews = Number(reviews);
  if (!Number.isFinite(numericReviews) || numericReviews < 1) return null;
  if (!Number.isFinite(numericScore) || numericScore < 0 || numericScore > 100) return null;
  return Math.round(numericScore);
}

/**
 * `extract(payload)` — pure, no I/O. `payload` is one `source_records.payload` row as stored by
 * the one-off import script (not kept in the repository) (already `JSON.parse`d by the caller).
 */
export function extract(payload = {}) {
  const out = {};

  const score = eligibleScore(payload);
  if (score !== null) out.scoreGamerankings = score;

  // Only for PC rows (per the task): GameRankings covered every platform, but GameFAQs links on the site
  // are matched/curated per-platform elsewhere (gamefaqs.js); reporting a link here for every platform this
  // row's game shipped on would risk pointing at the wrong platform's GameFAQs product page.
  if (payload.platform === 'PC' && payload.path && payload.id !== undefined && payload.id !== null) {
    out.links = { gamefaqs: { id: String(payload.id), url: gamefaqsUrl(payload.path) } };
  }

  return out;
}

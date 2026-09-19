// Pure classifier for `games.purchasable` (migrations/005_purchasable.sql). Never touches the network or
// the database — src/pipeline/resolve.js calls classifyPurchasable() with the resolved is_free/price/
// release_date columns plus each live store's own steamPurchasable/gogPurchasable hint
// (src/sources/steam.js's / src/sources/gog.js's extract()) and writes the result — the same reversible,
// always-recomputed-then-overridable flag pattern as `non_game` (migrations/004_non_game.sql,
// src/lib/non-game.js).
//
// Owner's motivating case: Steam app 1145100 "Singaria - Prologue" — its store page still exists ("no
// longer available on the Steam store"), `appdetails` still succeeds (so `games.steam_delisted`, only ever
// set when appdetails itself fails, never catches it), but the page has no price and no purchasable
// package — the wheel kept offering it anyway.
//
// Definition (owner's words): a game is purchasable when ANY of —
//   - it's free (`is_free`);
//   - it has a price in any region (`price_usd`/`price_rub`/`price_cis_usd`) — a bare `0` only counts
//     together with `is_free` (handled above, not specially here: a genuinely free game's price columns
//     are `0`/`null`, never treated as "priced");
//   - a store reports it can be bought right now (Steam: `package_groups` non-empty; GOG: buyable, e.g.
//     `isAvailableForSale`/a price is present — see src/sources/gog.js's `extract()`);
//   - it isn't released yet (resolved `release_date` in the future, or Steam's own
//     `release_date.coming_soon` — already folded into `steamPurchasable` by src/sources/steam.js, so an
//     upcoming Steam game reaches this function as `steamPurchasable: true` even before its resolved
//     release date is known) — upcoming games are not "unbuyable", the wheel's other filters handle them.
//
// A game with NO live store record at all yet (`hasSteamRecord`/`hasGogRecord` both false — e.g. fresh off
// the legacy migration, only a `legacy_steamdb` snapshot) is always purchasable = 1 ("unknown" is never
// "unavailable"), regardless of what the legacy snapshot's own price fields say. Only a live Steam or GOG
// "ok" source_records row can ever set purchasable = 0 — see the per-store handling below for exactly how
// `steamPurchasable`/`gogPurchasable` being `true`/`false`/`undefined` (no opinion, e.g. an old stored
// payload predating the `package_groups` field) combine.

function hasAnyPrice(...values) {
  return values.some((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
}

function isUpcoming(releaseDate, now) {
  if (!releaseDate) return false; // no resolved release date at all is not "known upcoming"
  const d = releaseDate instanceof Date ? releaseDate : new Date(releaseDate);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() > now.getTime();
}

/**
 * `classifyPurchasable({ isFree, priceUsd, priceRub, priceCisUsd, releaseDate, steamPurchasable,
 * gogPurchasable, hasSteamRecord, hasGogRecord, now }) -> 1 | 0`, matching `games.purchasable`'s
 * `TINYINT(1)` column.
 *
 * `steamPurchasable`/`gogPurchasable`: that store's own `extract()` verdict — `true` (that store says this
 * is buyable, or not out yet), `false` (that store positively says it can't be bought), or `undefined`
 * ("no opinion": no live record for that store at all, or an old payload from before the store module
 * tracked this — see steam.js's/gog.js's own `extract()` doc comments). `undefined` must never by itself
 * turn a game unpurchasable.
 *
 * `hasSteamRecord`/`hasGogRecord`: whether a live 'steam'/'gog' *"ok"* `source_records` row exists for this
 * game at all (`Boolean(fieldsBySource.steam)`/`Boolean(fieldsBySource.gog)` in src/pipeline/resolve.js) —
 * distinct from `steamPurchasable`/`gogPurchasable` being defined, since a live record can still report
 * `undefined` (old payload). With neither, the answer is always 1 — see the module doc comment above.
 */
export function classifyPurchasable({
  isFree = false,
  priceUsd = null,
  priceRub = null,
  priceCisUsd = null,
  releaseDate = null,
  steamPurchasable,
  gogPurchasable,
  hasSteamRecord = false,
  hasGogRecord = false,
  now = new Date(),
} = {}) {
  // No live store evidence at all - unknown is never treated as unavailable.
  if (!hasSteamRecord && !hasGogRecord) return 1;

  if (isFree) return 1;
  if (hasAnyPrice(priceUsd, priceRub, priceCisUsd)) return 1;
  if (isUpcoming(releaseDate, now)) return 1;

  if (hasSteamRecord && steamPurchasable === true) return 1;
  if (hasGogRecord && gogPurchasable === true) return 1;

  // Neither store's own hint said "yes" and none of the global signals above fired either. Only mark it
  // unpurchasable when at least one live store *positively* ruled it out (`false`) - a store with no
  // opinion (`undefined`, e.g. an old payload with no `package_groups`, or simply the other store) must
  // never tip the verdict to 0 on its own; that's the "tolerate old payloads" rule from the task.
  const steamSaysNo = hasSteamRecord && steamPurchasable === false;
  const gogSaysNo = hasGogRecord && gogPurchasable === false;
  return steamSaysNo || gogSaysNo ? 0 : 1;
}

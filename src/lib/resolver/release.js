// Release-date resolution.
//
// `legacyRelease(row)` is a byte-for-byte port of the date-picking block in
// `legacy/ajax/scripts/gateway.php` (~lines 166-189, including the
// `findequaldates` helper defined further up in the same file). It exists so
// the regression fixtures (tests/fixtures/resolver/legacy-sample.json) and
// their tests can pin the new code to the exact legacy output on real rows.
// It is deliberately NOT used by the general resolver below — it is a
// frozen reference implementation for one specific 4-source shape
// (Metacritic/SteamSpy/HLTB/store), kept only for comparison.
//
// `resolveRelease(candidates, opts)` is the new, source-agnostic algorithm
// described in the spec (docs/specs/2026-09-19-rewrite-design.md §6.1),
// meant to run over however many source modules a game has (T8-T16 add more
// over time). It generalises the legacy idea ("prefer independent sources
// agreeing with each other; store date is the last resort") to N sources
// instead of the fixed four legacy had, and uses the shared `monthsBetween`/
// `comparePrecision` helpers from `src/lib/dates.js` (T2) rather than a local
// copy, since it doesn't need to be bit-exact to PHP.
//
// `legacyRelease`, by contrast, keeps its own private `legacyMonthsDiff`
// (below) instead of the shared `monthsBetween`: PHP's `DateTime::diff()`
// decomposes a difference into calendar years+months by *borrowing* a month
// when the day-of-month of the later date hasn't been reached yet (e.g.
// 2020-01-31 -> 2020-03-01 is 1 month, not 2). `dates.js`'s `monthsBetween`
// is a simpler `years*12 + monthIndexDiff` that ignores the day entirely.
// That's the right choice for the new algorithm (day-level rounding doesn't
// matter for an 8/12-month tolerance), but it is NOT bit-identical to PHP,
// so `legacyRelease` (and `score.js`'s age penalty, which is also an exact
// port of a `DateTime::diff()` call) need the day-aware version to
// reproduce the legacy regression fixtures exactly.
//
// `phpEmpty`/`phpRound` also live here (no shared equivalent exists yet) and
// are imported by score.js/time.js/ggp.js.

import { monthsBetween, comparePrecision } from '../dates.js';

/**
 * PHP's `empty($v)`: true for null/undefined, '', 0, '0', false, NaN and
 * empty arrays. Every legacy formula gates on `!empty($field)` before using
 * it, so every port needs the exact same notion of "no value".
 */
export function phpEmpty(v) {
  if (v === null || v === undefined || v === '' || v === false) return true;
  if (v === 0 || v === '0') return true;
  if (typeof v === 'number' && Number.isNaN(v)) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

/** PHP's `round()`: half away from zero (unlike JS `Math.round`, which rounds half toward +Infinity). */
export function phpRound(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n >= 0 ? Math.round(n) : -Math.round(-n);
}

/** Parse a 'YYYY-MM-DD' (or full ISO/date-ish) string as a UTC instant, so month/day math is DST-proof. */
function parseLoose(dateLike) {
  if (dateLike instanceof Date) return dateLike;
  const s = String(dateLike);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00Z`);
  return new Date(s);
}

/**
 * Calendar month difference, matching PHP's `$a->diff($b)` decomposition
 * (`interval->y * 12 + interval->m`): full elapsed months the way a
 * calendar would count them, borrowing a month when the day-of-month
 * hasn't been reached yet. Symmetric, like `DateTime::diff()`. Used only by
 * `legacyRelease` and `score.js`'s age penalty — see the file header for
 * why this isn't the same as `dates.js`'s `monthsBetween`.
 */
export function legacyMonthsDiff(a, b) {
  const da = parseLoose(a);
  const db = parseLoose(b);
  const [lo, hi] = da <= db ? [da, db] : [db, da];

  let years = hi.getUTCFullYear() - lo.getUTCFullYear();
  let months = hi.getUTCMonth() - lo.getUTCMonth();
  const days = hi.getUTCDate() - lo.getUTCDate();
  if (days < 0) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return years * 12 + months;
}

// --- legacyRelease: frozen port of gateway.php's date picker ---------------

/**
 * `findequaldates($dates, $months = 8)` (gateway.php): looks for at least 3
 * pairwise agreements (out of the 6 pairs among 4 dates) within `months` of
 * each other, and returns the date it was looking at on the *last* matching
 * pair (this is a legacy quirk, not "the" agreed date — kept verbatim).
 * `dates` is a fixed-length array of 4 date strings (nulls are never passed
 * in by legacyRelease, which only calls this once all four are present).
 */
function findEqualDates(dates, months = 8) {
  let found = null;
  let count = 0;
  for (let i = 0; i < dates.length; i++) {
    for (let j = i + 1; j < dates.length; j++) {
      if (legacyMonthsDiff(dates[i], dates[j]) <= months) {
        count++;
        found = dates[i];
      }
    }
  }
  return count >= 3 ? found : null;
}

/**
 * Exact port of gateway.php lines ~166-189.
 *
 * `row` is a legacy `steamdb.games` row (or the subset of it): expects
 * `published_meta`, `published_stsp`, `published_hltb`, `published_store`
 * (date strings or null/''), and `store_platform` (string, e.g. 'Steam').
 * Returns the picked date as the same string it came in as (legacy never
 * reformats it here — `strftime` happens later in gateway.php, out of
 * scope for the resolver), or `null` if nothing was available at all.
 */
export function legacyRelease(row) {
  const meta = phpEmpty(row.published_meta) ? null : row.published_meta;
  const stsp = phpEmpty(row.published_stsp) ? null : row.published_stsp;
  const hltb = phpEmpty(row.published_hltb) ? null : row.published_hltb;
  const store = phpEmpty(row.published_store) ? null : row.published_store;
  const platform = row.store_platform;

  const d1d2 = meta && stsp ? legacyMonthsDiff(meta, stsp) : null;
  const d1d3 = meta && hltb ? legacyMonthsDiff(meta, hltb) : null;
  const d2d3 = stsp && hltb ? legacyMonthsDiff(stsp, hltb) : null;

  let publishedDate = null;

  if (platform !== 'Steam') publishedDate = store;
  if (meta && stsp && hltb && store) {
    publishedDate = findEqualDates([meta, stsp, hltb, store], 8);
  }

  if (phpEmpty(publishedDate)) {
    if (d1d2 !== null && d1d2 <= 8) publishedDate = meta;
    else if (d1d3 !== null && d1d3 <= 8) publishedDate = meta;
    else if (d2d3 !== null && d2d3 <= 8) publishedDate = stsp;
    else if (stsp && stsp !== store) publishedDate = stsp;
    else publishedDate = meta || hltb || stsp || store || null;
  }

  return publishedDate;
}

// --- resolveRelease: the new, source-agnostic algorithm --------------------

/** Most precise candidate, earlier date breaking ties (spec §6.1: "more precise date wins ... ties -> earlier date"). */
function bestOf(items) {
  return [...items].sort((a, b) => {
    const p = comparePrecision(b.precision, a.precision); // most-precise-first
    if (p !== 0) return p;
    return new Date(a.date) - new Date(b.date);
  })[0];
}

/** Union-find clustering: group candidates that are pairwise within `toleranceMonths` of each other (transitive closure). */
function clusterByTolerance(items, toleranceMonths) {
  const parent = items.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const diff = monthsBetween(items[i].date, items[j].date);
      if (diff !== null && diff <= toleranceMonths) union(i, j);
    }
  }

  const groups = new Map();
  items.forEach((item, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });
  return [...groups.values()];
}

function emptyResult(earlyAccessDate) {
  return { date: null, precision: 'unknown', confidence: 0, earlyAccess: earlyAccessDate, storeDate: null, conflict: null };
}

/**
 * `resolveRelease(candidates, opts)` — spec §6.1.
 *
 * `candidates`: `[{ source, date: 'YYYY-MM-DD'|'YYYY-MM'|'YYYY', precision, kind: 'store'|'independent' }]`
 * (per source, built from its `storeRelease`/`release` fields — see the plan's "Extracted-field vocabulary").
 * Candidates with `precision === 'unknown'` or no `date` are ignored (they carry no information to resolve with —
 * a game with only unknown-precision candidates falls through to "no dates" below).
 *
 * `opts.earlyAccess` (optional `{ date, precision }`) is passed through untouched into `result.earlyAccess` —
 * early access is never a resolveRelease *input* candidate, it is a separate per-source field the caller
 * (index.js) already has and just wants echoed back next to the resolved release (spec: "Early access start is
 * stored separately and never treated as the release").
 *
 * `opts.releaseToleranceMonths` (default 8) and `opts.oldGameRuleMonths` (default 12) mirror `config.resolver`.
 *
 * Design decisions the spec leaves implicit (documented here since there is no legacy equivalent for >4 sources):
 *  - "Most independent sources agree" is implemented as: cluster independent candidates by mutual closeness
 *    (transitive, like the legacy pairwise check but for any N), then take the largest cluster; ties go to the
 *    cluster whose representative date is earlier.
 *  - A cluster of >=2 independent sources is always trusted over the store date (spec 6.1 bullet 2), regardless of
 *    how far it is from the store date.
 *  - With only one independent candidate (either because there is only one independent source at all, or because
 *    every independent source disagrees with every other one — cluster size 1), the store date is preferred UNLESS
 *    the independent candidate is more than `oldGameRuleMonths` earlier than the store date, which is exactly the
 *    "Steam re-release" pattern the old-game rule exists for (spec 6.1 bullet 3). This keeps "store is the last
 *    resort" meaningful: a lone independent source close to the store date is not strong enough evidence to
 *    override it, but a lone independent source far *earlier* is exactly the failure mode being fixed.
 *  - Independent sources that disagree with each other (no cluster >= 2) AND don't trigger the old-game rule against
 *    the store date produce a `conflict` (spec: "Disagreement without a majority -> conflicts row").
 */
export function resolveRelease(candidates, opts = {}) {
  const toleranceMonths = opts.releaseToleranceMonths ?? 8;
  const oldGameRuleMonths = opts.oldGameRuleMonths ?? 12;
  const earlyAccessDate = opts.earlyAccess && !phpEmpty(opts.earlyAccess.date) ? opts.earlyAccess.date : null;

  const dated = (candidates || []).filter((c) => c && !phpEmpty(c.date) && c.precision !== 'unknown');
  const independent = dated.filter((c) => c.kind === 'independent');
  const store = dated.filter((c) => c.kind === 'store');
  const storeDate = store.length ? bestOf(store) : null;

  if (independent.length === 0) {
    if (!storeDate) return emptyResult(earlyAccessDate);
    return {
      date: storeDate.date,
      precision: storeDate.precision,
      confidence: 30,
      earlyAccess: earlyAccessDate,
      storeDate: storeDate.date,
      conflict: null,
    };
  }

  const clusters = clusterByTolerance(independent, toleranceMonths).sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return comparePrecision(bestOf(b).precision, bestOf(a).precision) || new Date(bestOf(a).date) - new Date(bestOf(b).date);
  });
  const majority = clusters[0];

  if (majority.length >= 2) {
    const rep = bestOf(majority);
    return {
      date: rep.date,
      precision: rep.precision,
      confidence: 90,
      earlyAccess: earlyAccessDate,
      storeDate: storeDate ? storeDate.date : null,
      conflict: null,
    };
  }

  // No cluster of >=2: either a single independent source overall, or every independent source disagrees.
  const earliestTime = Math.min(...independent.map((c) => new Date(c.date).getTime()));
  const rep = bestOf(independent.filter((c) => new Date(c.date).getTime() === earliestTime));
  const gapMonths = storeDate ? monthsBetween(rep.date, storeDate.date) : null;
  const isOldGameRule = storeDate && gapMonths !== null && gapMonths > oldGameRuleMonths && new Date(rep.date) < new Date(storeDate.date);

  if (!storeDate) {
    // No store date to compare against: the lone/best independent candidate is all we have.
    return { date: rep.date, precision: rep.precision, confidence: 60, earlyAccess: earlyAccessDate, storeDate: null, conflict: null };
  }

  if (isOldGameRule) {
    return {
      date: rep.date,
      precision: rep.precision,
      confidence: independent.length === 1 ? 80 : 70,
      earlyAccess: earlyAccessDate,
      storeDate: storeDate.date,
      conflict: null,
    };
  }

  if (independent.length === 1) {
    // A single independent source that roughly agrees with the store isn't a disagreement worth flagging.
    return { date: rep.date, precision: rep.precision, confidence: 60, earlyAccess: earlyAccessDate, storeDate: storeDate.date, conflict: null };
  }

  // Multiple independent sources, none of them agreeing with each other, and none of them old-game-earlier than
  // the store by enough to trust alone: fall back to the store date, but flag the disagreement for admin review.
  return {
    date: storeDate.date,
    precision: storeDate.precision,
    confidence: 20,
    earlyAccess: earlyAccessDate,
    storeDate: storeDate.date,
    conflict: {
      reason: 'independent sources disagree without a majority',
      candidates: independent.map((c) => ({ source: c.source, value: c.date, precision: c.precision })),
    },
  };
}

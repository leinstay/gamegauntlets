// Dialogue engine for Pio (Neptune). Pure logic, no DOM/PIXI dependency, so it is easy to unit-test.
//
// Phrase pool schema (see public/pio/dialogues/README.md for the full spec):
//   { "<event>": [ { "text": "...", "mood": "happy", "when": {...}, "weight": 1 }, ... ], "_meta": {...} }
//
// createDialogueEngine() picks a phrase for an event + context: filters by `when` conditions, avoids repeating
// the same line twice in a row for the same event, does a weighted-random pick among the remaining candidates,
// and fills in `{placeholder}` tokens from the context. It also tracks returning-visitor state (localStorage)
// and offers a small idle-timer helper, both used by pio.js.

const DEFAULT_UNITS = { hours: ['hour', 'hours', 'hours'], games: ['game', 'games', 'games'] };

/** Russian-style plural cases (also correct, if degenerate, for languages whose 3 forms are identical). */
function pluralCase(number, forms) {
  const n = Math.abs(Math.trunc(number));
  const cases = [2, 0, 1, 1, 1, 2];
  const idx = n % 100 > 4 && n % 100 < 20 ? 2 : cases[n % 10 < 5 ? n % 10 : 5];
  return forms[idx] != null ? forms[idx] : forms[forms.length - 1];
}

/** Simple 1 / 2-4 / 5+ split, used for "goodCount"-style phrases ported from the legacy dialog.js. */
function pluralCount(number, forms) {
  const n = Math.abs(Math.trunc(number));
  if (n === 1) return forms[0];
  if (n >= 2 && n <= 4) return forms[1];
  return forms[2];
}

function inHourRange(hour, from, to) {
  const f = ((from % 24) + 24) % 24;
  const t = ((to % 24) + 24) % 24;
  if (f === t) return true; // 0..24 (or any equal pair) means "all day"
  if (f < t) return hour >= f && hour < t;
  return hour >= f || hour < t; // wraps past midnight, e.g. 22 -> 5
}

function matchesWhen(when, ctx) {
  if (!when) return true;

  if (when.scoreMin != null && !(typeof ctx.score === 'number' && ctx.score >= when.scoreMin)) return false;
  if (when.scoreMax != null && !(typeof ctx.score === 'number' && ctx.score <= when.scoreMax)) return false;
  if (when.priceMin != null && !(typeof ctx.price === 'number' && ctx.price >= when.priceMin)) return false;
  if (when.priceMax != null && !(typeof ctx.price === 'number' && ctx.price <= when.priceMax)) return false;
  if (when.yearMin != null && !(typeof ctx.year === 'number' && ctx.year >= when.yearMin)) return false;
  if (when.yearMax != null && !(typeof ctx.year === 'number' && ctx.year <= when.yearMax)) return false;
  if (when.hoursMin != null && !(typeof ctx.hours === 'number' && ctx.hours >= when.hoursMin)) return false;
  if (when.hoursMax != null && !(typeof ctx.hours === 'number' && ctx.hours <= when.hoursMax)) return false;

  if (when.genre != null) {
    const genres = Array.isArray(ctx.genres) ? ctx.genres : ctx.genre ? [ctx.genre] : [];
    if (!genres.some((g) => String(g).toLowerCase() === String(when.genre).toLowerCase())) return false;
  }
  if (when.tag != null) {
    const tags = Array.isArray(ctx.tags) ? ctx.tags : [];
    if (!tags.some((t) => String(t).toLowerCase() === String(when.tag).toLowerCase())) return false;
  }
  if (when.platform != null) {
    const platforms = Array.isArray(ctx.platforms) ? ctx.platforms : ctx.platform ? [ctx.platform] : [];
    if (!platforms.some((p) => String(p).toLowerCase() === String(when.platform).toLowerCase())) return false;
  }
  if ((when.hourFrom != null || when.hourTo != null)) {
    const hour = typeof ctx.hour === 'number' ? ctx.hour : new Date().getHours();
    const from = when.hourFrom != null ? when.hourFrom : 0;
    const to = when.hourTo != null ? when.hourTo : 0;
    if (!inHourRange(hour, from, to)) return false;
  }
  if (when.returning != null && Boolean(ctx.returning) !== Boolean(when.returning)) return false;
  if (when.respin != null && ctx.respin !== when.respin) return false;

  return true;
}

function weightedPick(entries) {
  const total = entries.reduce((sum, e) => sum + (e.weight > 0 ? e.weight : 1), 0);
  let r = Math.random() * total;
  for (const entry of entries) {
    r -= entry.weight > 0 ? entry.weight : 1;
    if (r <= 0) return entry;
  }
  return entries[entries.length - 1];
}

function formatText(text, ctx, units) {
  return text.replace(/\{(\w+)\}/g, (whole, key) => {
    if (key === 'hours' && typeof ctx.hours === 'number') {
      return `${ctx.hours} ${pluralCase(ctx.hours, units.hours || DEFAULT_UNITS.hours)}`;
    }
    if (key === 'goodCount' && typeof ctx.goodCount === 'number') {
      return `${ctx.goodCount} ${pluralCount(ctx.goodCount, units.games || DEFAULT_UNITS.games)}`;
    }
    if (Object.prototype.hasOwnProperty.call(ctx, key) && ctx[key] != null) return String(ctx[key]);
    return whole; // leave unresolved placeholders as-is rather than blanking them out
  });
}

/**
 * @param {object} [opts]
 * @param {string} [opts.lang] initial language code
 * @param {Record<string, object>} [opts.pools] pre-loaded phrase pools keyed by language, e.g. { en: {...} }
 * @param {string} [opts.storageKey] localStorage key prefix (default "pio")
 */
export function createDialogueEngine(opts = {}) {
  let lang = opts.lang || 'en';
  const storageKey = opts.storageKey || 'pio';
  const lastTextByEvent = new Map();
  let returning = false;
  let idleTimer = null;

  function setLanguage(newLang) {
    lang = newLang;
  }

  function getLanguage() {
    return lang;
  }

  /** A bare string entry is shorthand for `{ text: entry }` (mood "normal", no conditions, weight 1). */
  function normalizePool(data) {
    const normalized = { _meta: data._meta };
    for (const key of Object.keys(data)) {
      if (key === '_meta') continue;
      const list = data[key];
      normalized[key] = Array.isArray(list)
        ? list.map((entry) => (typeof entry === 'string' ? { text: entry } : entry))
        : list;
    }
    return normalized;
  }

  const pools = {};
  for (const [forLang, data] of Object.entries(opts.pools || {})) {
    pools[forLang] = normalizePool(data || {});
  }

  function setPool(forLang, data) {
    pools[forLang] = normalizePool(data || {});
  }

  function hasPool(forLang) {
    return Boolean(pools[forLang]);
  }

  /** Call once on load. Returns true if this browser has visited before (per localStorage). */
  function markVisit() {
    const key = `${storageKey}.lastVisit`;
    try {
      const prev = window.localStorage.getItem(key);
      window.localStorage.setItem(key, String(Date.now()));
      returning = prev != null;
    } catch (e) {
      returning = false;
    }
    return returning;
  }

  function isReturningVisitor() {
    return returning;
  }

  /**
   * Pick a phrase for `event` given `context`. Returns { text, mood } or null when the pool has nothing
   * eligible (unknown event, or every entry's `when` condition failed).
   */
  function pick(event, context = {}) {
    const pool = pools[lang];
    const list = pool && Array.isArray(pool[event]) ? pool[event] : null;
    if (!list || list.length === 0) return null;

    const ctx = {
      hour: new Date().getHours(),
      returning,
      ...context,
    };
    if (ctx.genre == null && Array.isArray(ctx.genres) && ctx.genres.length) ctx.genre = ctx.genres[0];
    if (ctx.platform == null && Array.isArray(ctx.platforms) && ctx.platforms.length) ctx.platform = ctx.platforms[0];

    // A phrase is only eligible when every {placeholder} in it can be filled from the context — she must never
    // say a literal "{game}".
    const fillable = (entry) => (entry.text.match(/\{(\w+)\}/g) || []).every((ph) => ctx[ph.slice(1, -1)] != null);
    let candidates = list.filter((entry) => matchesWhen(entry.when, ctx) && fillable(entry));
    if (candidates.length === 0) return null;

    const last = lastTextByEvent.get(event);
    if (candidates.length > 1) {
      const withoutLast = candidates.filter((entry) => entry.text !== last);
      if (withoutLast.length > 0) candidates = withoutLast;
    }

    const entry = weightedPick(candidates);
    lastTextByEvent.set(event, entry.text);

    const units = (pool._meta && pool._meta.units) || DEFAULT_UNITS;
    return { text: formatText(entry.text, ctx, units), mood: entry.mood || 'normal' };
  }

  /** (Re)arms an idle timer that fires `cb` after `ms` of no `notifyActivity()` calls. */
  function watchIdle(ms, cb) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(cb, ms);
  }

  function notifyActivity(ms, cb) {
    if (ms != null && cb) watchIdle(ms, cb);
    else if (idleTimer) watchIdle(ms, cb);
  }

  function stopIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  return {
    setLanguage,
    getLanguage,
    setPool,
    hasPool,
    markVisit,
    isReturningVisitor,
    pick,
    watchIdle,
    notifyActivity,
    stopIdle,
  };
}

// Exported for unit tests.
export const _internal = { pluralCase, pluralCount, inHourRange, matchesWhen, weightedPick, formatText };

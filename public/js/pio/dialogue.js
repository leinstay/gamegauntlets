// Dialogue engine for Pio (Neptune). Pure logic, no DOM/PIXI dependency, so it is easy to unit-test.
//
// Phrase pool schema (see public/pio/dialogues/README.md for the full spec):
//   { "<event>": [ { "text": "...", "mood": "happy", "when": {...}, "weight": 1, "once": true }, ... ], "_meta": {...} }
// `text` may also be an array of 2-3 strings: a short sequence shown one bubble after another (see pick()'s
// `sequence` return field, consumed by pio.js's bubble chaining).
//
// createDialogueEngine() picks a phrase for an event + context: filters by `when` conditions, drops entries
// whose placeholders the context can't fill, avoids repeating the same line twice in a row for the same event,
// avoids the last 8 phrases shown for ANY event (cross-event memory, sessionStorage-backed), respects `once`
// (shown at most once per browser session), does a weighted-random pick among the remaining candidates, and
// fills in `{placeholder}` tokens from the context. It also tracks returning-visitor/visit-count state
// (localStorage) and offers a small idle-timer helper, both used by pio.js.

const DEFAULT_UNITS = { hours: ['hour', 'hours', 'hours'], games: ['game', 'games', 'games'] };

// Exported so a content validator (tests/frontend/pio-content.test.js) can flag unknown events/when
// keys/placeholders/moods in public/pio/dialogues/*.json without duplicating this list.
export const MOODS = ['normal', 'happy', 'enjoy', 'unhappy', 'kira', 'deformed'];

export const KNOWN_EVENTS = [
  'load',
  'ambient',
  'idle',
  'idle:long',
  'idle:veryLong',
  'tab:return',
  'click:head',
  'click:body',
  'click:spam',
  'spin:start',
  'spin:retry',
  'spin:streak',
  'spin:middle',
  'spin:end',
  'spin:repeatWinner',
  'spin:sameGenre',
  'list:select',
  'random:game',
  'search:pick',
  'click:store',
  'click:gog',
  'click:metacritic',
  'click:hltb',
  'click:gamefaqs',
  'click:igdb',
  'empty',
  'privacy',
  'longSession',
  'settings:open',
  'settings:change',
  'settings:reset',
  'settings:language',
  'settings:music:on',
  'settings:music:off',
  'auth:login',
  'konami',
  'copy',
  'hover:randomGame',
  'hover:marbles',
  'hover:ggPoints',
  'hover:profile',
  'hover:search',
  'hover:gog',
  'hover:donations',
  'hover:spin',
];

export const KNOWN_WHEN_KEYS = [
  'scoreMin',
  'scoreMax',
  'priceMin',
  'priceMax',
  'yearMin',
  'yearMax',
  'hoursMin',
  'hoursMax',
  'genre',
  'tag',
  'platform',
  'hourFrom',
  'hourTo',
  'returning',
  'respin',
  'visitsMin',
  'visitsMax',
  'spinsMin',
  'spinsMax',
  'dayOfWeek',
  'date',
  'noScore',
  'free',
  'difficulty',
  'reviewsMin',
  'reviewsMax',
  'awayMin',
  'awayMax',
  'loggedIn',
  'mobile',
];

export const KNOWN_PLACEHOLDERS = [
  'game',
  'otherGame',
  'genre',
  'tag',
  'developer',
  'developers',
  'year',
  'score',
  'price',
  'hours',
  'goodCount',
  'longGame',
  'user',
  'spins',
  'visits',
  'awayMinutes',
  'browser',
  'time',
];

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
    const tags = Array.isArray(ctx.tags) ? ctx.tags : ctx.tag ? [ctx.tag] : [];
    if (!tags.some((t) => String(t).toLowerCase() === String(when.tag).toLowerCase())) return false;
  }
  if (when.platform != null) {
    const platforms = Array.isArray(ctx.platforms) ? ctx.platforms : ctx.platform ? [ctx.platform] : [];
    if (!platforms.some((p) => String(p).toLowerCase() === String(when.platform).toLowerCase())) return false;
  }
  if (when.hourFrom != null || when.hourTo != null) {
    const hour = typeof ctx.hour === 'number' ? ctx.hour : new Date().getHours();
    const from = when.hourFrom != null ? when.hourFrom : 0;
    const to = when.hourTo != null ? when.hourTo : 0;
    if (!inHourRange(hour, from, to)) return false;
  }
  if (when.returning != null && Boolean(ctx.returning) !== Boolean(when.returning)) return false;
  if (when.respin != null && ctx.respin !== when.respin) return false;

  if (when.visitsMin != null && !(typeof ctx.visits === 'number' && ctx.visits >= when.visitsMin)) return false;
  if (when.visitsMax != null && !(typeof ctx.visits === 'number' && ctx.visits <= when.visitsMax)) return false;
  if (when.spinsMin != null && !(typeof ctx.spins === 'number' && ctx.spins >= when.spinsMin)) return false;
  if (when.spinsMax != null && !(typeof ctx.spins === 'number' && ctx.spins <= when.spinsMax)) return false;

  if (when.dayOfWeek != null) {
    const days = Array.isArray(when.dayOfWeek) ? when.dayOfWeek : [when.dayOfWeek];
    if (!days.includes(ctx.dayOfWeek)) return false;
  }
  if (when.date != null) {
    const dates = Array.isArray(when.date) ? when.date : [when.date];
    if (!dates.includes(ctx.date)) return false;
  }

  if (when.noScore != null && Boolean(ctx.noScore) !== Boolean(when.noScore)) return false;
  if (when.free != null && Boolean(ctx.free) !== Boolean(when.free)) return false;
  if (when.difficulty != null && ctx.difficulty !== when.difficulty) return false;
  if (when.reviewsMin != null && !(typeof ctx.reviews === 'number' && ctx.reviews >= when.reviewsMin)) return false;
  if (when.reviewsMax != null && !(typeof ctx.reviews === 'number' && ctx.reviews <= when.reviewsMax)) return false;
  if (when.awayMin != null && !(typeof ctx.awaySeconds === 'number' && ctx.awaySeconds >= when.awayMin)) return false;
  if (when.awayMax != null && !(typeof ctx.awaySeconds === 'number' && ctx.awaySeconds <= when.awayMax)) return false;
  if (when.loggedIn != null && Boolean(ctx.loggedIn) !== Boolean(when.loggedIn)) return false;
  if (when.mobile != null && Boolean(ctx.mobile) !== Boolean(when.mobile)) return false;

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
    if (key === 'price' && typeof ctx.price === 'number') {
      const amount = Math.round(ctx.price * 100) / 100; // avoid binary-float noise (e.g. 19.990000000000002)
      const symbol = ctx.priceSymbol || '$';
      return `${amount} ${symbol}`;
    }
    if (key === 'awayMinutes' && typeof ctx.awayMinutes === 'number') {
      return String(ctx.awayMinutes);
    }
    if (Object.prototype.hasOwnProperty.call(ctx, key) && ctx[key] != null) return String(ctx[key]);
    return whole; // leave unresolved placeholders as-is rather than blanking them out
  });
}

/** `entry.text` may be a string or an array (sequence); this is its stable identity for repeat/memory tracking. */
function phraseId(entry) {
  return Array.isArray(entry.text) ? entry.text.join('␟') : entry.text;
}

function twoDigits(n) {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.lang] initial language code
 * @param {Record<string, object>} [opts.pools] pre-loaded phrase pools keyed by language, e.g. { en: {...} }
 * @param {string} [opts.storageKey] localStorage/sessionStorage key prefix (default "pio")
 */
export function createDialogueEngine(opts = {}) {
  let lang = opts.lang || 'en';
  const storageKey = opts.storageKey || 'pio';
  const lastTextByEvent = new Map();
  let returning = false;
  let visits;
  let idleTimer = null;

  // --- sessionStorage-backed cross-event memory (last 8 phrases shown) + `once` bookkeeping. Every access is
  // wrapped in try/catch and guarded against a missing `window`/`sessionStorage` (private mode, non-browser
  // test environment, storage disabled) -- when unavailable the engine just keeps everything in memory only
  // for the life of this instance, which degrades gracefully (no repeats within a page, occasional repeats
  // across a reload) instead of throwing.
  const RECENT_LIMIT = 8;

  function readSessionJson(key, fallback) {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return fallback;
      const raw = window.sessionStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : fallback;
      return Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeSessionJson(key, value) {
    try {
      if (typeof window === 'undefined' || !window.sessionStorage) return;
      window.sessionStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* private mode / storage disabled / quota exceeded: memory just won't persist */
    }
  }

  let recentIds = readSessionJson(`${storageKey}.recentPhrases`, []);
  let onceShown = readSessionJson(`${storageKey}.onceShown`, []);

  function rememberRecent(entry) {
    const id = phraseId(entry);
    recentIds = [id, ...recentIds.filter((x) => x !== id)].slice(0, RECENT_LIMIT);
    writeSessionJson(`${storageKey}.recentPhrases`, recentIds);
  }

  function onceKey(event, entry) {
    return `${event}␟${phraseId(entry)}`;
  }

  function markOnceShown(event, entry) {
    const key = onceKey(event, entry);
    if (!onceShown.includes(key)) {
      onceShown = [...onceShown, key];
      writeSessionJson(`${storageKey}.onceShown`, onceShown);
    }
  }

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
   * Call once on load (alongside markVisit()). Increments and returns the persistent visit counter
   * (localStorage, first visit = 1) used by the `visitsMin`/`visitsMax` `when` keys and the `{visits}`
   * placeholder. Falls back to an in-memory-only counter (starting at 1) when localStorage is unavailable.
   */
  function recordVisit() {
    const key = `${storageKey}.visits`;
    let count = 1;
    try {
      count = (parseInt(window.localStorage.getItem(key), 10) || 0) + 1;
      window.localStorage.setItem(key, String(count));
    } catch (e) {
      count = (visits || 0) + 1;
    }
    visits = count;
    return count;
  }

  function getVisitCount() {
    return visits;
  }

  /**
   * Pick a phrase for `event` given `context`. Returns `{ text, mood }` (plus `sequence: string[]` when the
   * matched entry's `text` was an array with more than one string) or `null` when the pool has nothing
   * eligible (unknown event, every entry's `when` condition failed, or every `once` entry already fired).
   */
  function pick(event, context = {}) {
    const pool = pools[lang];
    const list = pool && Array.isArray(pool[event]) ? pool[event] : null;
    if (!list || list.length === 0) return null;

    const now = new Date();
    const ctx = {
      hour: now.getHours(),
      time: `${twoDigits(now.getHours())}:${twoDigits(now.getMinutes())}`,
      dayOfWeek: now.getDay(),
      date: `${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`,
      returning,
      visits: visits || 0,
      spins: 0,
      ...context,
    };
    if (ctx.genre == null && Array.isArray(ctx.genres) && ctx.genres.length) ctx.genre = ctx.genres[0];
    if (ctx.tag == null && Array.isArray(ctx.tags) && ctx.tags.length) ctx.tag = ctx.tags[0];
    if (ctx.platform == null && Array.isArray(ctx.platforms) && ctx.platforms.length) ctx.platform = ctx.platforms[0];
    if (ctx.awayMinutes == null && typeof ctx.awaySeconds === 'number') ctx.awayMinutes = Math.round(ctx.awaySeconds / 60);

    // A phrase is only eligible when every {placeholder} it uses (across all of its `text` array items, if
    // it is a sequence) can be filled from the context -- she must never say a literal "{game}".
    const fillable = (entry) => {
      const texts = Array.isArray(entry.text) ? entry.text : [entry.text];
      return texts.every((txt) => (txt.match(/\{(\w+)\}/g) || []).every((ph) => ctx[ph.slice(1, -1)] != null));
    };
    const notAlreadyOnce = (entry) => !entry.once || !onceShown.includes(onceKey(event, entry));

    let candidates = list.filter((entry) => matchesWhen(entry.when, ctx) && fillable(entry) && notAlreadyOnce(entry));
    if (candidates.length === 0) return null;

    // Cross-event memory: avoid repeating one of the last few phrases shown for ANY event, but only when
    // doing so still leaves something to say.
    if (candidates.length > 1 && recentIds.length) {
      const withoutRecent = candidates.filter((entry) => !recentIds.includes(phraseId(entry)));
      if (withoutRecent.length > 0) candidates = withoutRecent;
    }

    // No immediate repeat for this specific event.
    const last = lastTextByEvent.get(event);
    if (candidates.length > 1) {
      const withoutLast = candidates.filter((entry) => phraseId(entry) !== last);
      if (withoutLast.length > 0) candidates = withoutLast;
    }

    const entry = weightedPick(candidates);
    lastTextByEvent.set(event, phraseId(entry));
    rememberRecent(entry);
    if (entry.once) markOnceShown(event, entry);

    const units = (pool._meta && pool._meta.units) || DEFAULT_UNITS;
    const texts = Array.isArray(entry.text) ? entry.text : [entry.text];
    const formatted = texts.map((txt) => formatText(txt, ctx, units));

    const result = { text: formatted[0], mood: entry.mood || 'normal' };
    if (formatted.length > 1) result.sequence = formatted.slice(1);
    return result;
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
    recordVisit,
    getVisitCount,
    pick,
    watchIdle,
    notifyActivity,
    stopIdle,
  };
}

// Exported for unit tests.
export const _internal = { pluralCase, pluralCount, inHourRange, matchesWhen, weightedPick, formatText, phraseId };

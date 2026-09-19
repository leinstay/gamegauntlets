// Fuzzy release-date parsing shared by the ingestion sources and the
// resolver (spec docs/specs/2026-09-19-rewrite-design.md §6.1).
//
// `parseDate(input)` turns whatever a source hands us - an ISO string, a
// unix timestamp, a Steam `release_date.date` string in English or
// Russian, "Q2 2024", a bare year, or "Coming soon" - into
// `{ date: 'YYYY-MM-DD' | null, precision }` where precision is one of
// 'day' | 'month' | 'quarter' | 'year' | 'unknown'. A quarter resolves to
// the first day of that quarter, a month to its first day, a year to
// January 1st.

const UNKNOWN_KEYWORDS = new Set([
  'coming soon',
  'tba',
  'to be announced',
  'soon',
  // A few common non-English equivalents seen on Steam/stores; harmless
  // to recognise even though the plan only requires the English set.
  'скоро',
  'дата неизвестна',
  'demnächst',
  'bientôt',
]);

// month-name -> 1-12, covering English, Russian (nominative + genitive +
// abbreviations), German and French (with and without accents).
const MONTHS = {
  // English
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,

  // Russian
  'янв': 1, 'январь': 1, 'января': 1,
  'фев': 2, 'февр': 2, 'февраль': 2, 'февраля': 2,
  'мар': 3, 'март': 3, 'марта': 3,
  'апр': 4, 'апрель': 4, 'апреля': 4,
  'май': 5, 'мая': 5,
  'июн': 6, 'июнь': 6, 'июня': 6,
  'июл': 7, 'июль': 7, 'июля': 7,
  'авг': 8, 'август': 8, 'августа': 8,
  'сен': 9, 'сент': 9, 'сентябрь': 9, 'сентября': 9,
  'окт': 10, 'октябрь': 10, 'октября': 10,
  'ноя': 11, 'нояб': 11, 'ноябрь': 11, 'ноября': 11,
  'дек': 12, 'декабрь': 12, 'декабря': 12,

  // German
  'jan.': 1, 'januar': 1,
  'feb.': 2, 'februar': 2,
  'mär': 3, 'märz': 3, 'marz': 3, 'maerz': 3,
  'apr.': 4,
  'mai': 5,
  'juni': 6,
  'juli': 7,
  'aug.': 8,
  'sept.': 9,
  'okt': 10, 'okt.': 10, 'oktober': 10,
  'dez': 12, 'dez.': 12, 'dezember': 12,

  // French
  'janv': 1, 'janvier': 1,
  'févr': 2, 'fevr': 2, 'février': 2, 'fevrier': 2,
  'mars': 3,
  'avr': 4, 'avril': 4,
  'juin': 6,
  'juillet': 7, 'juil': 7,
  'août': 8, 'aout': 8,
  'septembre': 9,
  'octobre': 10,
  'novembre': 11,
  'décembre': 12, 'decembre': 12, 'déc': 12,
};

function isValidDate(year, month, day) {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

function toISODate(year, month, day) {
  const y = String(year).padStart(4, '0');
  const mo = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function fromUnix(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Heuristic: seconds since epoch for "now" is ~1.7e9; milliseconds is
  // ~1.7e12. Anything with magnitude above 1e11 is treated as milliseconds.
  const ms = Math.abs(n) > 1e11 ? n : n * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return toISODate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Strip surrounding punctuation from a token and drop the RU "г" year marker. */
function tokenize(raw) {
  const rough = raw.toLowerCase().split(/\s+/);
  const tokens = [];
  for (let tok of rough) {
    tok = tok.replace(/^[.,;:()"'`]+|[.,;:()"'`]+$/g, '');
    if (tok === '' || tok === 'г' || tok === 'г.') continue;
    tokens.push(tok);
  }
  return tokens;
}

function tryQuarter(raw) {
  const s = raw.trim();
  let m = s.match(/^q\s*([1-4])\s*[,\s]\s*(\d{4})$/i);
  if (m) return { quarter: Number(m[1]), year: Number(m[2]) };
  m = s.match(/^([1-4])\s*(?:кв|q)\.?\s*(\d{4})/i);
  if (m) return { quarter: Number(m[1]), year: Number(m[2]) };
  return null;
}

/** Generic "day? month? year" tokenizer covering all supported locales/orderings. */
function tryGeneric(raw) {
  const tokens = tokenize(raw);
  if (tokens.length === 0) return null;

  let year = null;
  let month = null;
  const looseNumbers = [];

  for (const tok of tokens) {
    if (/^\d{4}$/.test(tok)) {
      year = Number(tok);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(MONTHS, tok)) {
      month = MONTHS[tok];
      continue;
    }
    if (/^\d{1,2}$/.test(tok)) {
      looseNumbers.push(Number(tok));
      continue;
    }
    // Unrecognised word (e.g. stray text) - ignore it.
  }

  if (year === null) return null;

  let day = null;
  if (month !== null) {
    day = looseNumbers.find((n) => n >= 1 && n <= 31) ?? null;
  }

  if (month !== null && day !== null) return { year, month, day, precision: 'day' };
  if (month !== null) return { year, month, precision: 'month' };
  return { year, precision: 'year' };
}

/**
 * Parse a release-date value of unknown shape into `{ date, precision }`.
 *
 * @param {string|number|null|undefined} input
 * @param {{locale?: string}} [_opts] reserved for future locale hints; the
 *   parser currently recognises all supported locales unconditionally.
 */
export function parseDate(input, _opts = {}) {
  if (input === null || input === undefined) return { date: null, precision: 'unknown' };

  if (typeof input === 'number') {
    const iso = fromUnix(input);
    return iso ? { date: iso, precision: 'day' } : { date: null, precision: 'unknown' };
  }

  const raw = String(input).trim();
  if (raw === '') return { date: null, precision: 'unknown' };

  const lower = raw.toLowerCase();
  if (UNKNOWN_KEYWORDS.has(lower)) return { date: null, precision: 'unknown' };

  // Pure integer -> unix timestamp (seconds or milliseconds).
  if (/^-?\d+$/.test(raw) && raw.length > 4) {
    const iso = fromUnix(raw);
    if (iso) return { date: iso, precision: 'day' };
  }

  // ISO 8601 (date or date-time).
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (isValidDate(year, month, day)) return { date: toISODate(year, month, day), precision: 'day' };
  }

  const q = tryQuarter(raw);
  if (q && q.quarter >= 1 && q.quarter <= 4) {
    const month = (q.quarter - 1) * 3 + 1;
    return { date: toISODate(q.year, month, 1), precision: 'quarter' };
  }

  if (/^\d{4}$/.test(raw)) {
    return { date: toISODate(Number(raw), 1, 1), precision: 'year' };
  }

  const generic = tryGeneric(raw);
  if (generic) {
    if (generic.precision === 'day' && isValidDate(generic.year, generic.month, generic.day)) {
      return { date: toISODate(generic.year, generic.month, generic.day), precision: 'day' };
    }
    if (generic.precision === 'month') {
      return { date: toISODate(generic.year, generic.month, 1), precision: 'month' };
    }
    if (generic.precision === 'year') {
      return { date: toISODate(generic.year, 1, 1), precision: 'year' };
    }
  }

  return { date: null, precision: 'unknown' };
}

function toUTCDate(input) {
  if (input === null || input === undefined) return null;
  const s = typeof input === 'object' ? input.date : input;
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/**
 * Absolute number of calendar months between two dates. Accepts either a
 * 'YYYY-MM-DD' string or a `{ date }` object (as returned by `parseDate`).
 * Returns `null` when either side can't be resolved to a date.
 */
export function monthsBetween(a, b) {
  const da = toUTCDate(a);
  const db = toUTCDate(b);
  if (!da || !db) return null;
  return Math.abs(
    (da.getUTCFullYear() - db.getUTCFullYear()) * 12 + (da.getUTCMonth() - db.getUTCMonth())
  );
}

const PRECISION_RANK = { day: 4, month: 3, quarter: 2, year: 1, unknown: 0 };

/**
 * Compare two precision levels. Returns a positive number when `a` is more
 * precise than `b`, negative when less precise, 0 when equal - suitable for
 * use as `Array.prototype.sort` comparator (most-precise-first: `(x, y) =>
 * comparePrecision(y.precision, x.precision)`).
 */
export function comparePrecision(a, b) {
  const ra = PRECISION_RANK[a] ?? 0;
  const rb = PRECISION_RANK[b] ?? 0;
  return ra - rb;
}

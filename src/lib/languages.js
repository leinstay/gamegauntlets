// Single source of truth for "which UI languages exist" and how to map an arbitrary BCP-47-ish tag
// (URL query, Accept-Language header, whatever) onto one of them. `config.json`'s `site.languages`
// is the deployed subset (normally the same 13 codes as SUPPORTED below, but a deploy could trim
// it); SUPPORTED here is the full set this codebase knows how to display native names for and is
// used as the fallback when config is unavailable/empty (tests, defensive code).
//
// Game DATA (description, price currency, ...) only ever exists in `ru`/`en` (see src/lib/game-card.js,
// src/lib/wheel-query.js) - `dataLang()` is the single place that answers "which data language should
// this UI language read", so every non-ru UI language (including the new ones added here) reads the
// same English data the old `de`/`fr` UI languages always did.

export const SUPPORTED = ['en', 'ru', 'de', 'fr', 'es', 'pt', 'it', 'pl', 'tr', 'uk', 'ja', 'ko', 'zh'];

// Native self-name of each language, e.g. how a German speaker refers to German.
const NATIVE_NAMES = {
  en: 'English',
  ru: 'Русский',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
  it: 'Italiano',
  pl: 'Polski',
  tr: 'Türkçe',
  uk: 'Українська',
  ja: '日本語',
  ko: '한국어',
  zh: '中文',
};

// English name of each language, used as the parenthetical in the language picker (e.g. "Deutsch
// (German)") whenever it differs from the native name -- mirrors the legacy dropdown's
// data-text/data-english pair (public/pages/settings.html's #changeLang).
const ENGLISH_NAMES = {
  en: 'English',
  ru: 'Russian',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
  it: 'Italian',
  pl: 'Polish',
  tr: 'Turkish',
  uk: 'Ukrainian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
};

// A handful of common BCP-47 variants that don't reduce to a supported code just by taking the
// primary subtag (`tag.split('-')[0]`) -- kept short on purpose, the primary-subtag rule below
// already handles the common case (`de-DE` -> `de`, `en-US` -> `en`, `zh-TW` -> `zh`, ...).
const ALIASES = {
  'pt-br': 'pt',
  'pt-pt': 'pt',
  'zh-cn': 'zh',
  'zh-tw': 'zh',
  'zh-hk': 'zh',
  'zh-mo': 'zh',
  'zh-sg': 'zh',
  'zh-hans': 'zh',
  'zh-hant': 'zh',
};

/**
 * Map an arbitrary language tag (URL query value, one Accept-Language entry, ...) onto one of
 * SUPPORTED, or `null` when nothing matches. Case-insensitive; tries an exact match first, then a
 * known alias, then the tag's primary subtag (`xx` out of `xx-YY`) against SUPPORTED and ALIASES.
 */
export function normalizeLang(tag) {
  if (typeof tag !== 'string') return null;
  const trimmed = tag.trim().toLowerCase();
  if (!trimmed || trimmed === '*') return null;

  if (SUPPORTED.includes(trimmed)) return trimmed;
  if (ALIASES[trimmed]) return ALIASES[trimmed];

  const base = trimmed.split(/[-_]/)[0];
  if (SUPPORTED.includes(base)) return base;
  if (ALIASES[base]) return ALIASES[base];

  return null;
}

/** Which game-data language (`en`/`ru` are the only ones the `games` table has) a UI language reads. */
export function dataLang(lang) {
  return lang === 'ru' ? 'ru' : 'en';
}

/**
 * Parse an Accept-Language header into its tags, ordered by descending q-value (ties keep header
 * order, per Array#sort's stability). Malformed/missing q values default to 1.
 */
export function parseAcceptLanguage(header) {
  if (!header || typeof header !== 'string') return [];
  return header
    .split(',')
    .map((part) => {
      const [rawTag, ...params] = part.split(';');
      const tag = rawTag.trim();
      let q = 1;
      for (const param of params) {
        const match = /^\s*q\s*=\s*([\d.]+)\s*$/.exec(param);
        if (match) q = Number(match[1]);
      }
      return { tag, q: Number.isFinite(q) ? q : 0 };
    })
    .filter((entry) => entry.tag)
    .sort((a, b) => b.q - a.q)
    .map((entry) => entry.tag);
}

/**
 * First tag in an Accept-Language header that normalizes to one of `allowed` (defaults to
 * SUPPORTED), or `null` when none does.
 */
export function pickLanguageFromAcceptHeader(header, allowed = SUPPORTED) {
  for (const tag of parseAcceptLanguage(header)) {
    const code = normalizeLang(tag);
    if (code && allowed.includes(code)) return code;
  }
  return null;
}

/** Display name for the language picker: native name, plus "(English name)" only when it differs
 * (e.g. "English", but "Deutsch (German)", "日本語 (Japanese)"). */
export function languageDisplayName(code) {
  const native = NATIVE_NAMES[code] || code;
  const english = ENGLISH_NAMES[code] || code;
  return native === english ? native : `${native} (${english})`;
}

/** `{code, name}` list for the given codes (defaults to SUPPORTED), in the given order -- what
 * GET /api/session exposes so the frontend never needs its own hardcoded language list. */
export function listLanguages(codes = SUPPORTED) {
  return codes.map((code) => ({ code, name: languageDisplayName(code) }));
}

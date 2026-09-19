// Server-rendered SEO shell: GET / (x-default) and GET /:lang/ (one per supported UI language) serve
// public/index.html with just the <head> (title/description/OG/Twitter/canonical/JSON-LD) and the
// <noscript> fallback block rewritten for the requested language; everything else — the actual app —
// is untouched and boots client-side exactly like it does for the raw static file (see public/js/gg-boot.js's
// detectLangFromQuery(), which reads the language back out of this same path). GET /sitemap.xml lists
// all 14 URLs (x-default + 13 languages) with the full reciprocal hreflang set on every entry.
//
// Registered WITHOUT the `/api` prefix (see src/api.js) — these are page routes, not API endpoints, so
// none of the CSRF/same-origin checks in api.js's onRequest hook apply here (GET-only, no state change,
// and stateless: content only ever depends on the URL and Accept-Language, never on the session cookie,
// which is what makes `Cache-Control: public, max-age=600` safe).
//
// public/index.html and public/i18n/<lang>.json already carry a full, correct default (English) SEO
// block on their own (the static files nginx falls back to when Node is down, see
// .claude/docs/infrastructure.md's `error_page 502 503 504 = /index.html`); this module only ever
// *replaces* well-known, uniquely-anchored fragments of that template (marked with HTML comments where
// the anchor isn't already unique on its own, e.g. `<!-- BEGIN og:locale -->`) — it never parses HTML,
// so it stays tolerant of everything else in the file changing around those anchors.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED, pickLanguageFromAcceptHeader } from '../lib/languages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mutable so tests can point these at fixture files (see _setPathsForTests below) without touching
// the real public/ tree.
let INDEX_HTML_PATH = path.join(__dirname, '../../public/index.html');
let I18N_DIR = path.join(__dirname, '../../public/i18n');

let htmlCache = null; // { mtimeMs, html }
const dictCache = new Map(); // lang -> { mtimeMs, dict }

export function _setPathsForTests({ indexHtmlPath, i18nDir } = {}) {
  if (indexHtmlPath) INDEX_HTML_PATH = indexHtmlPath;
  if (i18nDir) I18N_DIR = i18nDir;
  htmlCache = null;
  dictCache.clear();
}

// BCP-47 hreflang tag and Open Graph locale for each supported UI language. `zh` maps to the "Hans"
// (simplified) script subtag for hreflang (owner's spec) and to zh_CN for og:locale (Open Graph only
// defines language_TERRITORY locales, no script subtags).
export const LANG_INFO = {
  en: { hreflang: 'en', ogLocale: 'en_US' },
  ru: { hreflang: 'ru', ogLocale: 'ru_RU' },
  de: { hreflang: 'de', ogLocale: 'de_DE' },
  fr: { hreflang: 'fr', ogLocale: 'fr_FR' },
  es: { hreflang: 'es', ogLocale: 'es_ES' },
  pt: { hreflang: 'pt', ogLocale: 'pt_PT' },
  it: { hreflang: 'it', ogLocale: 'it_IT' },
  pl: { hreflang: 'pl', ogLocale: 'pl_PL' },
  tr: { hreflang: 'tr', ogLocale: 'tr_TR' },
  uk: { hreflang: 'uk', ogLocale: 'uk_UA' },
  ja: { hreflang: 'ja', ogLocale: 'ja_JP' },
  ko: { hreflang: 'ko', ogLocale: 'ko_KR' },
  zh: { hreflang: 'zh-Hans', ogLocale: 'zh_CN' },
};

function configuredLanguages(app) {
  const languages = app.appConfig?.site?.languages;
  return Array.isArray(languages) && languages.length ? languages : SUPPORTED;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readShellHtml() {
  const stat = fs.statSync(INDEX_HTML_PATH);
  if (!htmlCache || htmlCache.mtimeMs !== stat.mtimeMs) {
    htmlCache = { mtimeMs: stat.mtimeMs, html: fs.readFileSync(INDEX_HTML_PATH, 'utf8') };
  }
  return htmlCache;
}

function loadDict(lang) {
  const file = path.join(I18N_DIR, `${lang}.json`);
  const stat = fs.statSync(file);
  const cached = dictCache.get(lang);
  if (!cached || cached.mtimeMs !== stat.mtimeMs) {
    dictCache.set(lang, { mtimeMs: stat.mtimeMs, dict: JSON.parse(fs.readFileSync(file, 'utf8')) });
  }
  return dictCache.get(lang).dict;
}

function safeLoadDict(lang) {
  try {
    return loadDict(lang);
  } catch {
    return {};
  }
}

function seoFields(lang) {
  const dict = safeLoadDict(lang);
  const en = lang === 'en' ? dict : safeLoadDict('en');
  return {
    title: dict['seo.title'] || en['seo.title'] || 'Game Gauntlets',
    description: dict['seo.description'] || en['seo.description'] || '',
    ogTitle: dict['seo.ogTitle'] || en['seo.ogTitle'] || 'Game Gauntlets',
  };
}

// Replaces the content="..." value of a single <meta attrName="attrValue" content="..."> tag,
// tolerant of the tag ending in either ">" or " />". A no-op (returns html unchanged) if the tag
// isn't found, so an unrelated future edit to index.html degrades a field instead of 500ing the page.
function setMetaContent(html, attrName, attrValue, newContent) {
  const re = new RegExp(`(<meta ${attrName}="${escapeRegExp(attrValue)}" content=")[^"]*("\\s*/?>)`);
  return re.test(html) ? html.replace(re, (_, pre, post) => pre + escapeHtml(newContent) + post) : html;
}

const OG_LOCALE_BLOCK_RE = /<!-- BEGIN og:locale[\s\S]*?<!-- END og:locale -->/;

function buildOgLocaleBlock(lang, languages) {
  const primary = (LANG_INFO[lang] || LANG_INFO.en).ogLocale;
  const lines = [`    <meta property="og:locale" content="${primary}" />`];
  for (const code of languages) {
    if (code === lang) continue;
    const info = LANG_INFO[code];
    if (info) lines.push(`    <meta property="og:locale:alternate" content="${info.ogLocale}" />`);
  }
  return lines.join('\n');
}

function renderJsonLd(html, { seo, lang }) {
  const re = /(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/;
  const match = re.exec(html);
  if (!match) return html;
  let data;
  try {
    data = JSON.parse(match[2]);
  } catch {
    return html;
  }
  data.name = seo.ogTitle;
  data.description = seo.description;
  data.inLanguage = (LANG_INFO[lang] || LANG_INFO.en).hreflang;
  const json = JSON.stringify(data, null, 4)
    .split('\n')
    .map((line) => `        ${line}`)
    .join('\n');
  return html.replace(re, `$1\n${json}\n    $3`);
}

function renderNoscript(html, seo) {
  const re = /(<div id="seo-noscript">)[\s\S]*?(<\/div>)/;
  if (!re.test(html)) return html;
  return html.replace(
    re,
    (_, open, close) =>
      `${open}\n            <h1>${escapeHtml(seo.title)}</h1>\n            <p>${escapeHtml(seo.description)}</p>\n        ${close}`,
  );
}

/** Rewrite the <head> (+ the seo-noscript body block) of the cached index.html template for one
 * language / canonical path. Never mutates `html` in place (plain string ops), so the caller's cached
 * template is always the pristine on-disk version. */
export function renderShell(html, { lang, canonicalPath, origin, languages }) {
  const seo = seoFields(lang);
  let out = html;

  out = out.replace(/<html lang="[^"]*">/, `<html lang="${lang}">`);
  out = out.replace(/(<title>)[^<]*(<\/title>)/, (_, a, b) => `${a}${escapeHtml(seo.title)}${b}`);

  out = setMetaContent(out, 'name', 'description', seo.description);
  out = setMetaContent(out, 'name', 'application-name', seo.title);
  out = setMetaContent(out, 'name', 'msapplication-tooltip', seo.description);
  out = setMetaContent(out, 'property', 'og:title', seo.ogTitle);
  out = setMetaContent(out, 'property', 'og:description', seo.description);
  out = setMetaContent(out, 'property', 'og:url', `${origin}${canonicalPath}`);
  out = setMetaContent(out, 'name', 'twitter:title', seo.title);
  out = setMetaContent(out, 'name', 'twitter:description', seo.description);

  out = out.replace(OG_LOCALE_BLOCK_RE, buildOgLocaleBlock(lang, languages));

  out = out.replace(
    /(<link rel="canonical" href=")[^"]*("\s*\/?>)/,
    (_, pre, post) => `${pre}${origin}${canonicalPath}${post}`,
  );

  out = renderJsonLd(out, { seo, lang });
  out = renderNoscript(out, seo);

  return out;
}

function buildSitemapXml(origin, languages, lastmod) {
  const alternates = [
    { hreflang: 'x-default', href: `${origin}/` },
    ...languages.map((code) => ({ hreflang: (LANG_INFO[code] || LANG_INFO.en).hreflang, href: `${origin}/${code}/` })),
  ];
  const urls = [`${origin}/`, ...languages.map((code) => `${origin}/${code}/`)];

  const linksBlock = alternates
    .map((a) => `      <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${escapeHtml(a.href)}"/>`)
    .join('\n');

  const urlBlocks = urls
    .map((loc) => `  <url>\n    <loc>${escapeHtml(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n${linksBlock}\n  </url>`)
    .join('\n');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    `${urlBlocks}\n` +
    '</urlset>\n'
  );
}

export default async function pagesRoutes(app) {
  const languages = configuredLanguages(app);
  const origin = String(app.appConfig?.site?.origin || app.appEnv?.PUBLIC_ORIGIN || '').replace(/\/+$/, '');

  function isSupported(lang) {
    return typeof lang === 'string' && languages.includes(lang);
  }

  function sendShell(reply, { lang, canonicalPath }) {
    const { html } = readShellHtml();
    const body = renderShell(html, { lang, canonicalPath, origin, languages });
    reply
      .type('text/html; charset=utf-8')
      .header('Content-Language', lang)
      .header('Cache-Control', 'public, max-age=600')
      .send(body);
  }

  // x-default: language picked from Accept-Language (never from the session cookie -- this route is
  // stateless/cacheable, see file header), but the canonical URL always stays "/".
  app.get('/', async (req, reply) => {
    // Old-style language links ("/?ru", "/?lang=ru" - indexed and shared for years) move to the localized URL.
    const rawQuery = (req.raw.url.split('?')[1] || '').split('#')[0];
    const bare = rawQuery.split('&')[0].toLowerCase();
    const explicit = typeof req.query?.lang === 'string' ? req.query.lang.toLowerCase() : null;
    const legacyLang = isSupported(explicit) ? explicit : isSupported(bare) ? bare : null;
    if (legacyLang) return reply.redirect(`/${legacyLang}/`, 301);
    const lang = pickLanguageFromAcceptHeader(req.headers['accept-language'], languages) || 'en';
    reply.header('Vary', 'Accept-Language');
    sendShell(reply, { lang, canonicalPath: '/' });
  });

  // Slash-less variant (nginx's `location ~ ^/(en|ru|...)/?$` accepts both): redirect to the
  // trailing-slash canonical form instead of serving duplicate content at two URLs.
  app.get('/:lang', async (req, reply) => {
    const { lang } = req.params;
    if (!isSupported(lang)) return reply.code(404).send({ error: 'not_found' });
    const qIndex = req.raw.url.indexOf('?');
    const qs = qIndex !== -1 ? req.raw.url.slice(qIndex) : '';
    return reply.redirect(`/${lang}/${qs}`, 301);
  });

  app.get('/:lang/', async (req, reply) => {
    const { lang } = req.params;
    if (!isSupported(lang)) return reply.code(404).send({ error: 'not_found' });
    sendShell(reply, { lang, canonicalPath: `/${lang}/` });
  });

  app.get('/sitemap.xml', async (req, reply) => {
    const { mtimeMs } = readShellHtml();
    const lastmod = new Date(mtimeMs).toISOString().slice(0, 10);
    reply.type('application/xml; charset=utf-8').header('Cache-Control', 'public, max-age=600');
    return buildSitemapXml(origin, languages, lastmod);
  });
}

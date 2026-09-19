// Pure mapping: a `games` row (+ its `game_links` rows) → the GameCard shape from the API contract
// (docs/plans/2026-09-19-rewrite-plan.md "Shared contracts" → "API contract"):
//
//   { id, kind, name, image, description, release: {date, precision}, score, scores: {steam, critics,
//     criticsSource, igdb, gamefaqs, steamReviews: {all, recent}}, time: {main, complete, average},
//     difficulty, ggp, price: {amount, final, discount, currency}, platforms, genres, tags, developers,
//     publishers, categories, languages, voiceovers, owners, achievements,
//     links: {steam, gog, hltb, igdb, gamefaqs, opencritic, metacritic, wikipedia} }
//
// `time.average` is `games.time_average` (hours, DECIMAL(6,1)) as resolved by
// src/lib/resolver/time.js's resolveAveragePlaytime - restores legacy's "Average playtime" card row
// (stsp_mdntime), null when no source has produced an estimate for this game yet.
//
// `scores.steamReviews.all` is `{percent, votes, label}` from `score_steam`/`score_steam_votes`
// (`label` from src/lib/steam-review-label.js's steamReviewLabel(), itself `null` under 10 votes), or
// `null` when there's no Steam score at all for this game yet. `scores.steamReviews.recent` is the same
// shape from `score_steam_recent`/`score_steam_recent_votes` (last ~30 days), but the *whole* block is
// `null` under 10 recent votes (not just its label) - Steam only ever shows a "Recent Reviews" summary
// once there's enough recent activity to say anything about it at all.
//
// Language rule (.claude/docs/frontend.md "Localization"): game text is only ever stored in ru/en;
// 'de' and 'fr' always render the English data. So description picks description_ru only for
// lang === 'ru' (falling back to English if the Russian text is missing), and en/de/fr all get
// description_en.
//
// `developers`/`publishers`/`categories`/`languages`/`voiceovers` (like `genres`/`tags`) are stored
// pipe-wrapped ('|a|b|') per migrations/001_init.sql's header comment; verified against real rows
// (games 7, 10, 105853 plus a gog_exclusive sample) on 2026-09-19 — every non-null value in the
// local catalog was pipe-wrapped, no comma-separated legacy leftovers were found — so they reuse
// splitPipeList() like genres/tags rather than splitCommaList() (that one's for `platforms`, a SET
// column MariaDB itself renders comma-separated).
//
// T21: `description_en`/`description_ru` carry raw HTML as scraped from the store (Steam/GOG) or
// migrated from the legacy `games` table — `<br>`, `<b>`/`<strong>`, `<ul><li>`, `<p>`, `<img>`,
// entities. `cleanDescription()` turns that into plain text for the card (rendered via
// `textContent` + CSS `white-space: pre-line` in public/js/card.js — see that file), rather than
// injecting raw HTML into the page.

import { decodeHtmlEntities } from './names.js';
import { steamReviewLabel } from './steam-review-label.js';

const LINK_SOURCES = ['steam', 'gog', 'hltb', 'igdb', 'gamefaqs', 'opencritic', 'metacritic'];

// `<br>`/`<br/>`/`<br />`, a paragraph's closing `</p>`, and an opening `<li>` (with or without
// attributes) each stand in for a line break in the source markup; every other tag is structural
// noise once converted to plain text and is simply dropped (see NEWLINE_TAGS_RE vs ANY_TAG_RE
// below — order matters: newline tags are replaced BEFORE the catch-all strip, so their position
// survives as a line break instead of vanishing with the tag).
const NEWLINE_TAGS_RE = /<br\s*\/?>|<\/p\s*>|<li\b[^>]*>/gi;
const ANY_TAG_RE = /<[^>]+>/g;

const MAX_DESCRIPTION_CHARS = 1500;
// A sentence-ending '.', '!' or '?', optionally followed by a closing quote/paren, and not
// immediately followed by another word character (so "U.S." / "v1.5" don't count as boundaries).
const SENTENCE_END_RE = /[.!?]+[)"'”’]?(?!\w)/g;

/**
 * Convert one legacy/store HTML description into clean plain text: `<br>`/`</p>`/`<li>` become
 * newlines, every other tag is stripped, HTML entities are decoded, runs of blank lines are
 * collapsed to at most one, and the result is capped at ~`MAX_DESCRIPTION_CHARS`, cut at the last
 * sentence boundary at or before the cap when there is one close enough to preserve most of the
 * text (else a hard cut). Returns `null` for empty/HTML-only input (e.g. `"<p></p>"`).
 */
export function cleanDescription(html) {
  if (html === null || html === undefined) return null;
  let text = String(html);
  if (text.trim() === '') return null;

  // Some legacy rows carry a literal backslash-escape sequence as TEXT ("\r\n"/"\n"/"\r", i.e. a
  // backslash followed by the letter r/n, not a real control character) right next to <br> tags —
  // an old double-encoding artifact, confirmed in tests/fixtures/legacy/games-sample.json id 24623
  // ("Sam & Max Hit the Road": "...adventure!<br>\r\n<br>\r\nSolving..." where \r\n is literally
  // four characters). Folded into a real newline up front so it merges with the rest below instead
  // of surviving into the rendered text as visible backslashes.
  text = text.replace(/\\r\\n|\\r|\\n/g, '\n');

  text = text.replace(NEWLINE_TAGS_RE, '\n');
  text = text.replace(ANY_TAG_RE, '');
  text = decodeHtmlEntities(text);

  text = text.replace(/\r\n?/g, '\n'); // normalise CRLF/CR (legacy text often mixes these with <br>)
  // Collapses spaces/tabs AND   (a decoded &nbsp; is a non-breaking space, not a plain ' ' —
  // otherwise "a&nbsp;&nbsp;b" would keep two visually-identical-but-different space characters).
  text = text.replace(/[ \t ]+/g, ' ');
  text = text
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n'); // collapse runs of 3+ newlines to a single blank line
  text = text.trim();

  if (text === '') return null;
  return truncateAtSentence(text, MAX_DESCRIPTION_CHARS);
}

/** Exported for tests. See `cleanDescription()`'s doc for the truncation rule. */
export function truncateAtSentence(text, maxChars) {
  if (text.length <= maxChars) return text;

  let cut = -1;
  for (const match of text.matchAll(SENTENCE_END_RE)) {
    const end = match.index + match[0].length;
    if (end > maxChars) break; // matches are in ascending order — nothing further can qualify
    cut = end;
  }
  // Only trust a boundary that keeps at least half the budget — otherwise a hard cut reads better
  // than truncating after the second sentence of a 1500-char description.
  if (cut >= maxChars * 0.5) return text.slice(0, cut).trim();
  return `${text.slice(0, maxChars).trim()}…`;
}

function splitPipeList(value) {
  if (!value) return [];
  return value.split('|').map((v) => v.trim()).filter(Boolean);
}

function splitCommaList(value) {
  if (!value) return [];
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

/** `{percent, votes, label}` from a percent/votes pair, or `null` when either is missing. */
function steamReviewBlock(percent, votes) {
  if (percent === null || percent === undefined || votes === null || votes === undefined) return null;
  return { percent, votes, label: steamReviewLabel(percent, votes) };
}

/** Same as `steamReviewBlock()`, but `null` outright under 10 votes (see the file header). */
function steamRecentReviewBlock(percent, votes) {
  if (Number(votes) < 10) return null;
  return steamReviewBlock(percent, votes);
}

function description(row, lang) {
  const raw = lang === 'ru' ? row.description_ru || row.description_en : row.description_en;
  return cleanDescription(raw);
}

function priceBlock(row, lang, cisPrices) {
  if (cisPrices) {
    return { amount: row.price_cis_usd, final: row.price_final_cis_usd, discount: row.discount_cis_usd, currency: 'USD' };
  }
  if (lang === 'ru') {
    return { amount: row.price_rub, final: row.price_final_rub, discount: row.discount_rub, currency: 'RUB' };
  }
  return { amount: row.price_usd, final: row.price_final_usd, discount: row.discount_usd, currency: 'USD' };
}

/** Build the `links` object from `game_links` rows (`{ source, url }`). */
export function buildLinks(gameLinks = [], lang = 'en') {
  const bySource = new Map();
  for (const link of gameLinks) {
    if (link && link.source) bySource.set(link.source, link.url ?? null);
  }

  const links = {};
  for (const source of LINK_SOURCES) links[source] = bySource.get(source) ?? null;

  // Two wikipedia sources (wikipedia_en/wikipedia_ru) collapse to one field, lang-preferred with a
  // fallback to whichever language is actually linked.
  const preferred = lang === 'ru' ? 'wikipedia_ru' : 'wikipedia_en';
  const fallback = lang === 'ru' ? 'wikipedia_en' : 'wikipedia_ru';
  links.wikipedia = bySource.get(preferred) ?? bySource.get(fallback) ?? null;

  return links;
}

/**
 * @param {object} row - a full `games` row.
 * @param {Array<{source: string, url: string|null}>} gameLinks - `game_links` rows for this game.
 * @param {object} opts
 * @param {'en'|'ru'|'de'|'fr'} [opts.lang]
 * @param {boolean} [opts.cisPrices]
 */
export function toGameCard(row, gameLinks = [], { lang = 'en', cisPrices = false } = {}) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    image: row.image ?? null,
    description: description(row, lang),
    release: { date: row.release_date ?? null, precision: row.release_precision ?? 'unknown' },
    score: row.gg_score ?? null,
    scores: {
      steam: row.score_steam ?? null,
      critics: row.score_critics ?? null,
      criticsSource: row.score_critics_source ?? null,
      igdb: row.score_igdb ?? null,
      gamefaqs: row.score_gamefaqs ?? null,
      steamReviews: {
        all: steamReviewBlock(row.score_steam, row.score_steam_votes),
        recent: steamRecentReviewBlock(row.score_steam_recent, row.score_steam_recent_votes),
      },
    },
    time: { main: row.final_time ?? null, complete: row.time_complete ?? null, average: row.time_average ?? null },
    difficulty: row.difficulty ?? null,
    ggp: row.ggp ?? null,
    price: priceBlock(row, lang, cisPrices),
    platforms: splitCommaList(row.platforms),
    genres: splitPipeList(row.genres),
    tags: splitPipeList(row.tags),
    developers: splitPipeList(row.developers),
    publishers: splitPipeList(row.publishers),
    categories: splitPipeList(row.categories),
    languages: splitPipeList(row.languages),
    voiceovers: splitPipeList(row.voiceovers),
    owners: row.owners_estimate ?? null,
    achievements: row.achievements ?? null,
    links: buildLinks(gameLinks, lang),
  };
}

// GET /api/games/search — replaces the legacy 6.6 MB name.json dump with a real query.
// GET /api/games/:id — single GameCard, used by direct links and the "hand-picked names" flow.

import { toGameCard } from '../lib/game-card.js';
import { normalizeName } from '../lib/names.js';

const searchSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    required: ['q'],
    properties: {
      // empty q is allowed (the search dropdown queries on focus before anything is typed) -> []
      q: { type: 'string', maxLength: 128 },
      lang: { type: 'string', enum: ['en', 'ru', 'de', 'fr'] },
      // jQuery's cache-buster (`cache: false` in Semantic UI apiSettings appends `_=<timestamp>`)
      _: { type: 'string', maxLength: 32 },
    },
  },
};

const byIdSchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'integer', minimum: 1 } },
  },
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      lang: { type: 'string', enum: ['en', 'ru', 'de', 'fr'] },
      cisPrices: { type: 'boolean' },
    },
  },
};

export default async function gamesRoutes(app) {
  app.get('/games/search', { schema: searchSchema }, async (req) => {
    // normalizeName() falls back to returning its raw input unchanged when everything strips away
    // to nothing (e.g. whitespace-only input) — trim before the emptiness check so those queries
    // short-circuit instead of reaching the DB with a `LIKE '%  %'`.
    const needle = normalizeName(req.query.q).trim();
    if (!needle) return [];

    const rows = await app.db.query(
      `SELECT id, name, image FROM games
       WHERE steam_delisted = 0 AND non_game IS NULL AND purchasable = 1 AND name_normalized LIKE CONCAT('%', ?, '%')
       ORDER BY (name_normalized = ?) DESC,
                (name_normalized LIKE CONCAT(?, '%')) DESC,
                (name_normalized LIKE CONCAT('% ', ?, '%')) DESC,
                COALESCE(owners_estimate, 0) DESC,
                COALESCE(score_steam_votes, 0) DESC,
                name_normalized ASC
       LIMIT 20`,
      // Ranking: exact title, then titles starting with the query, then a word starting with it
      // ("witcher" -> "The Witcher 3" before "Chrome Switcher"), then popularity.
      [needle, needle, needle, needle],
    );
    return rows.map((row) => ({ id: row.id, name: row.name, image: row.image ?? null }));
  });

  app.get('/games/:id', { schema: byIdSchema }, async (req, reply) => {
    const lang = req.query.lang || req.ggSession?.lang || 'en';
    const row = await app.db.one('SELECT * FROM games WHERE id = ? LIMIT 1', [req.params.id]);
    if (!row) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const links = await app.db.query('SELECT source, url FROM game_links WHERE game_id = ?', [req.params.id]);
    return toGameCard(row, links, { lang, cisPrices: !!req.query.cisPrices });
  });
}

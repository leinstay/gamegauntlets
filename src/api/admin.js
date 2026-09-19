// /api/admin/* — the admin panel API (T18). Every route in this plugin requires
// `req.ggSession.steamid` to be a member of `config.admins` (string compare) — enforced by the
// `onRequest` hook below, which (being registered inside this plugin, not on the root app) only
// applies to routes defined here. It runs before Fastify's schema validation (also an `onRequest`
// on the root app handles CSRF/same-origin for every state-changing method, see src/api.js), so an
// anonymous/non-admin caller gets 403 even when the request body would otherwise fail validation.
//
// Every mutation is audit-logged via `log.info('admin: <action>', { steamid, ... })` (`audit()`
// below) — steamid is always the *caller's*, additional identifying fields (gameId, source, ...)
// per call.
//
// BullMQ access (`app.queueFor`/`app.enqueue`/`app.enqueueResolve`, decorated in src/api.js,
// defaulting to the real src/queue.js) is injected so tests can pass fakes instead of talking to
// Redis. `GET /admin/sources` additionally tolerates Redis being unreachable: a failed
// `getJobCounts()` yields `queueCounts: null` for that source rather than failing the whole request.

import { sources, getSource } from '../sources/index.js';
import { log } from '../log.js';

// Fields the admin UI is allowed to override; anything else is rejected by the JSON schema before
// the handler runs. Mirrors the plan's "allow-list of overridable fields".
const OVERRIDABLE_FIELDS = [
  'release_date',
  'release_precision',
  'name',
  'image',
  'description_en',
  'description_ru',
  'difficulty',
  'time_main',
  'time_complete',
  'score_critics',
  'gog_id',
  'steam_delisted',
];

const CONFLICTS_PAGE_SIZE = 50;
const USERS_PAGE_SIZE = 50;

function isAdmin(app, req) {
  const steamid = req.ggSession?.steamid;
  if (!steamid) return false;
  const admins = (app.appConfig.admins || []).map(String);
  return admins.includes(String(steamid));
}

function audit(req, action, meta = {}) {
  log.info(`admin: ${action}`, { steamid: req.ggSession?.steamid, ...meta });
}

/** Random, colon-free suffix — BullMQ >= 6 rejects custom job ids containing ':'. */
function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const paramsSourceSchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: { name: { type: 'string', minLength: 1, maxLength: 32 } },
  },
};

const conflictsQuerySchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['open', 'accepted', 'overridden'] },
      field: { type: 'string', minLength: 1, maxLength: 64 },
      page: { type: 'integer', minimum: 1 },
    },
  },
};

const conflictIdParamsSchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'integer', minimum: 1 } },
  },
};

const overrideBodySchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['gameId', 'field', 'value'],
    properties: {
      gameId: { type: 'integer', minimum: 1 },
      field: { type: 'string', enum: OVERRIDABLE_FIELDS },
      value: {}, // per-field shape varies (string/number/bool/null); the allow-list above is the real guard
      note: { type: 'string', maxLength: 255 },
    },
  },
};

const overrideParamsSchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['gameId', 'field'],
    properties: {
      gameId: { type: 'integer', minimum: 1 },
      field: { type: 'string', minLength: 1, maxLength: 64 },
    },
  },
};

const gameIdParamsSchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'integer', minimum: 1 } },
  },
};

const gameRefreshParamsSchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'source'],
    properties: {
      id: { type: 'integer', minimum: 1 },
      source: { type: 'string', minLength: 1, maxLength: 32 },
    },
  },
};

const presetBodySchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 255 },
      sortOrder: { type: 'integer' },
      gameIds: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 1000 },
    },
  },
};

const presetIdParamsSchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'integer', minimum: 1 } },
  },
};

const usersQuerySchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      q: { type: 'string', maxLength: 128 },
      page: { type: 'integer', minimum: 1 },
    },
  },
};

const userBodySchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['steamid'],
    properties: { steamid: { type: 'string', pattern: '^[0-9]{1,20}$' } },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      // `null` must come first in every anyOf: Fastify's AJV runs with coerceTypes, and an earlier
      // integer branch would coerce a JSON null into 0 before the null branch is tried.
      level: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1, maximum: 6 }] },
      status: { type: 'string', enum: ['normal', 'streamer'] },
    },
  },
};

async function insertPresetGames(db, presetId, gameIds) {
  if (!gameIds.length) return;
  const values = gameIds.map(() => '(?, ?)').join(', ');
  const params = gameIds.flatMap((gameId) => [presetId, gameId]);
  await db.query(`INSERT IGNORE INTO preset_games (preset_id, game_id) VALUES ${values}`, params);
}

export default async function adminRoutes(app) {
  // Runs first (onRequest, before body parsing/validation) for every route this plugin registers.
  app.addHook('onRequest', async (req, reply) => {
    if (!isAdmin(app, req)) {
      reply.code(403).send({ error: 'forbidden' });
      return reply;
    }
  });

  // ---------------- sources ----------------

  app.get('/admin/sources', async () => {
    const configSources = app.appConfig.sources || {};
    const [stateRows, recordCounts, linkCounts] = await Promise.all([
      app.db.query('SELECT source, paused, last_run_at, last_full_pass_at, last_error, stats FROM source_state'),
      app.db.query('SELECT source, COUNT(*) AS c FROM source_records GROUP BY source'),
      app.db.query('SELECT source, COUNT(*) AS c FROM game_links GROUP BY source'),
    ]);
    const stateBySource = new Map(stateRows.map((r) => [r.source, r]));
    const recordsBySource = new Map(recordCounts.map((r) => [r.source, Number(r.c)]));
    const linksBySource = new Map(linkCounts.map((r) => [r.source, Number(r.c)]));

    const list = await Promise.all(
      sources.map(async (mod) => {
        const state = stateBySource.get(mod.name);
        let queueCounts = null;
        try {
          queueCounts = await app.queueFor(mod.name).getJobCounts();
        } catch (err) {
          log.warn('admin: getJobCounts failed (Redis down?)', { source: mod.name, error: err });
          queueCounts = null;
        }
        return {
          name: mod.name,
          enabled: configSources[mod.name]?.enabled !== false,
          paused: !!state?.paused,
          lastRunAt: state?.last_run_at ?? null,
          lastFullPassAt: state?.last_full_pass_at ?? null,
          lastError: state?.last_error ?? null,
          stats: state?.stats ?? null,
          queueCounts,
          recordsCount: recordsBySource.get(mod.name) ?? 0,
          linksCount: linksBySource.get(mod.name) ?? 0,
        };
      }),
    );

    return { sources: list };
  });

  async function setPaused(req, reply, paused) {
    const { name } = req.params;
    if (!sources.some((mod) => mod.name === name)) {
      reply.code(404);
      return { error: 'unknown_source' };
    }
    await app.db.query(
      `INSERT INTO source_state (source, paused) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE paused = VALUES(paused)`,
      [name, paused ? 1 : 0],
    );
    audit(req, paused ? 'source pause' : 'source resume', { source: name });
    return { ok: true };
  }

  app.post('/admin/sources/:name/pause', { schema: paramsSourceSchema }, (req, reply) => setPaused(req, reply, true));
  app.post('/admin/sources/:name/resume', { schema: paramsSourceSchema }, (req, reply) => setPaused(req, reply, false));

  app.post('/admin/sources/:name/run', { schema: paramsSourceSchema }, async (req, reply) => {
    const { name } = req.params;
    const mod = sources.find((m) => m.name === name);
    if (!mod) {
      reply.code(404);
      return { error: 'unknown_source' };
    }
    if (typeof mod.discover !== 'function') {
      reply.code(400);
      return { error: 'no_discover' };
    }
    const jobId = `${name}-run-${uniqueSuffix()}`;
    await app.queueFor(name).add('discover', {}, { jobId });
    audit(req, 'source run', { source: name, jobId });
    return { ok: true, jobId };
  });

  // ---------------- conflicts ----------------

  app.get('/admin/conflicts', { schema: conflictsQuerySchema }, async (req) => {
    const status = req.query.status || 'open';
    const { field } = req.query;
    const page = req.query.page || 1;

    const conditions = ['c.status = ?'];
    const params = [status];
    if (field) {
      conditions.push('c.field = ?');
      params.push(field);
    }
    const where = conditions.join(' AND ');
    const offset = (page - 1) * CONFLICTS_PAGE_SIZE;

    const [rows, totalRow] = await Promise.all([
      app.db.query(
        `SELECT c.id, c.game_id, c.field, c.candidates, c.reason, c.status, c.created_at, c.resolved_at,
                g.name AS game_name
         FROM conflicts c
         JOIN games g ON g.id = c.game_id
         WHERE ${where}
         ORDER BY c.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, CONFLICTS_PAGE_SIZE, offset],
      ),
      app.db.one(`SELECT COUNT(*) AS c FROM conflicts c WHERE ${where}`, params),
    ]);

    return { conflicts: rows, total: Number(totalRow?.c ?? 0), page };
  });

  app.post('/admin/conflicts/:id/accept', { schema: conflictIdParamsSchema }, async (req, reply) => {
    const { id } = req.params;
    const conflict = await app.db.one('SELECT id FROM conflicts WHERE id = ? LIMIT 1', [id]);
    if (!conflict) {
      reply.code(404);
      return { error: 'not_found' };
    }
    await app.db.query("UPDATE conflicts SET status = 'accepted', resolved_at = NOW() WHERE id = ?", [id]);
    audit(req, 'conflict accept', { conflictId: id });
    return { ok: true };
  });

  // ---------------- overrides ----------------

  app.post('/admin/overrides', { schema: overrideBodySchema }, async (req, reply) => {
    const { gameId, field, value, note } = req.body;
    const game = await app.db.one('SELECT id FROM games WHERE id = ? LIMIT 1', [gameId]);
    if (!game) {
      reply.code(404);
      return { error: 'game_not_found' };
    }

    await app.db.query(
      `INSERT INTO overrides (game_id, field, value, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE value = VALUES(value), note = VALUES(note), created_by = VALUES(created_by),
         created_at = VALUES(created_at)`,
      [gameId, field, JSON.stringify(value ?? null), note ?? null, req.ggSession.steamid],
    );
    await app.db.query(
      "UPDATE conflicts SET status = 'overridden', resolved_at = NOW() WHERE game_id = ? AND field = ?",
      [gameId, field],
    );
    await app.enqueueResolve(gameId);

    audit(req, 'override upsert', { gameId, field });
    return { ok: true };
  });

  app.delete('/admin/overrides/:gameId/:field', { schema: overrideParamsSchema }, async (req, reply) => {
    const { gameId, field } = req.params;
    if (!OVERRIDABLE_FIELDS.includes(field)) {
      reply.code(404);
      return { error: 'unknown_field' };
    }
    await app.db.query('DELETE FROM overrides WHERE game_id = ? AND field = ?', [gameId, field]);
    // Re-open a conflict that was only closed because of this override, so it surfaces again for review.
    await app.db.query(
      "UPDATE conflicts SET status = 'open', resolved_at = NULL WHERE game_id = ? AND field = ? AND status = 'overridden'",
      [gameId, field],
    );
    await app.enqueueResolve(gameId);

    audit(req, 'override delete', { gameId, field });
    return { ok: true };
  });

  // ---------------- games ----------------

  app.get('/admin/games/:id', { schema: gameIdParamsSchema }, async (req, reply) => {
    const { id } = req.params;
    const game = await app.db.one('SELECT * FROM games WHERE id = ? LIMIT 1', [id]);
    if (!game) {
      reply.code(404);
      return { error: 'not_found' };
    }

    const [links, sourceRecords, overrides, conflicts] = await Promise.all([
      app.db.query(
        'SELECT source, external_id, url, match_method, confidence, checked_at FROM game_links WHERE game_id = ?',
        [id],
      ),
      // Deliberately excludes `payload` — this is a summary for the admin list view, not a payload dump.
      app.db.query(
        'SELECT source, external_id, status, fetched_at, error FROM source_records WHERE game_id = ?',
        [id],
      ),
      app.db.query('SELECT field, value, note, created_by, created_at FROM overrides WHERE game_id = ?', [id]),
      app.db.query(
        'SELECT id, field, candidates, reason, status, created_at, resolved_at FROM conflicts WHERE game_id = ?',
        [id],
      ),
    ]);

    return { game, links, sourceRecords, overrides, conflicts };
  });

  app.post('/admin/games/:id/resolve', { schema: gameIdParamsSchema }, async (req, reply) => {
    const { id } = req.params;
    const game = await app.db.one('SELECT id FROM games WHERE id = ? LIMIT 1', [id]);
    if (!game) {
      reply.code(404);
      return { error: 'not_found' };
    }
    await app.enqueueResolve(Number(id));
    audit(req, 'game resolve', { gameId: id });
    return { ok: true };
  });

  app.post('/admin/games/:id/refresh/:source', { schema: gameRefreshParamsSchema }, async (req, reply) => {
    const { id, source } = req.params;
    const mod = getSource(source);
    if (!mod || typeof mod.fetchOne !== 'function') {
      reply.code(404);
      return { error: 'unknown_source' };
    }
    const game = await app.db.one('SELECT id FROM games WHERE id = ? LIMIT 1', [id]);
    if (!game) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const link = await app.db.one('SELECT external_id FROM game_links WHERE game_id = ? AND source = ? LIMIT 1', [
      id,
      source,
    ]);
    await app.enqueue(source, { gameId: Number(id), externalId: link?.external_id });
    audit(req, 'game refresh', { gameId: id, source });
    return { ok: true };
  });

  // ---------------- presets ----------------

  app.get('/admin/presets', async () => {
    const [presets, gameRows] = await Promise.all([
      app.db.query('SELECT id, name, sort_order AS sortOrder FROM presets ORDER BY sort_order ASC, name ASC'),
      app.db.query('SELECT preset_id, game_id FROM preset_games'),
    ]);
    const gamesByPreset = new Map();
    for (const row of gameRows) {
      if (!gamesByPreset.has(row.preset_id)) gamesByPreset.set(row.preset_id, []);
      gamesByPreset.get(row.preset_id).push(row.game_id);
    }
    return presets.map((p) => ({ ...p, gameIds: gamesByPreset.get(p.id) || [] }));
  });

  app.post('/admin/presets', { schema: presetBodySchema }, async (req) => {
    const { name, sortOrder = 0, gameIds = [] } = req.body;
    const result = await app.db.query('INSERT INTO presets (name, sort_order) VALUES (?, ?)', [name, sortOrder]);
    const presetId = result.insertId;
    await insertPresetGames(app.db, presetId, gameIds);
    audit(req, 'preset create', { presetId, name });
    return { id: presetId, name, sortOrder, gameIds };
  });

  app.put('/admin/presets/:id', { schema: { ...presetIdParamsSchema, ...presetBodySchema } }, async (req, reply) => {
    const { id } = req.params;
    const existing = await app.db.one('SELECT id FROM presets WHERE id = ? LIMIT 1', [id]);
    if (!existing) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const { name, sortOrder = 0, gameIds = [] } = req.body;
    await app.db.query('UPDATE presets SET name = ?, sort_order = ? WHERE id = ?', [name, sortOrder, id]);
    await app.db.query('DELETE FROM preset_games WHERE preset_id = ?', [id]);
    await insertPresetGames(app.db, id, gameIds);
    audit(req, 'preset update', { presetId: id, name });
    return { id: Number(id), name, sortOrder, gameIds };
  });

  app.delete('/admin/presets/:id', { schema: presetIdParamsSchema }, async (req, reply) => {
    const { id } = req.params;
    const existing = await app.db.one('SELECT id FROM presets WHERE id = ? LIMIT 1', [id]);
    if (!existing) {
      reply.code(404);
      return { error: 'not_found' };
    }
    // preset_games rows cascade via fk_pg_preset ON DELETE CASCADE.
    await app.db.query('DELETE FROM presets WHERE id = ?', [id]);
    audit(req, 'preset delete', { presetId: id });
    return { ok: true };
  });

  // ---------------- users ----------------

  app.get('/admin/users', { schema: usersQuerySchema }, async (req) => {
    const q = (req.query.q || '').trim();
    const page = req.query.page || 1;
    const offset = (page - 1) * USERS_PAGE_SIZE;

    let where = '';
    let params = [];
    if (q) {
      where = 'WHERE name LIKE ? OR steamid LIKE ?';
      params = [`%${q}%`, `%${q}%`];
    }

    const [rows, totalRow] = await Promise.all([
      app.db.query(
        `SELECT steamid, name, avatar, level, status, last_login_at FROM users ${where}
         ORDER BY id DESC LIMIT ? OFFSET ?`,
        [...params, USERS_PAGE_SIZE, offset],
      ),
      app.db.one(`SELECT COUNT(*) AS c FROM users ${where}`, params),
    ]);

    return { users: rows, total: Number(totalRow?.c ?? 0), page };
  });

  app.put('/admin/users/:steamid', { schema: userBodySchema }, async (req, reply) => {
    const { steamid } = req.params;
    const existing = await app.db.one('SELECT steamid FROM users WHERE steamid = ? LIMIT 1', [steamid]);
    if (!existing) {
      reply.code(404);
      return { error: 'not_found' };
    }

    const sets = [];
    const params = [];
    if ('level' in req.body) {
      sets.push('level = ?');
      params.push(req.body.level);
    }
    if ('status' in req.body) {
      sets.push('status = ?');
      params.push(req.body.status);
    }
    if (!sets.length) return { ok: true };

    params.push(steamid);
    await app.db.query(`UPDATE users SET ${sets.join(', ')} WHERE steamid = ?`, params);
    audit(req, 'user update', { targetSteamid: steamid, level: req.body.level, status: req.body.status });
    return { ok: true };
  });
}

// Builds the `ctx` object passed to every source module's discover()/
// fetchOne() (interface: docs/plans/2026-09-19-rewrite-plan.md, "Source
// module interface"). SQL is written inline here against the schema in
// migrations/001_init.sql.
//
// `upsertRecord`/`upsertLink` are plain functions that take `db` explicitly
// so they can be unit-tested with a fake `{ query }` — no real MySQL pool
// needed. `createContext` closes over the real `db` (or a fake one, in
// tests) to build the `ctx.upsertRecord(...)`/`ctx.upsertLink(...)` shape
// the plan specifies (no `db` argument).
//
// `buildCtxForSources` builds one `ctx` per source module, so a source
// configured with an egress proxy (`config.sources.<name>.proxy`, e.g.
// gamefaqs — see src/lib/http.js's module comment) gets a `ctx.http` whose
// getText/getJson/postJson/postText calls automatically carry that proxy
// (via `withProxy`), with no change needed in the source module itself.
// Sources without a configured proxy all share one `defaultCtx` (no `http`
// wrapping, no extra object per source).

import { withProxy } from '../lib/http.js';

const UPSERT_RECORD_SQL = `
  INSERT INTO source_records (source, external_id, game_id, status, payload, error, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, NOW())
  ON DUPLICATE KEY UPDATE
    game_id = VALUES(game_id),
    status = VALUES(status),
    payload = VALUES(payload),
    error = VALUES(error),
    fetched_at = VALUES(fetched_at)
`;

const UPSERT_LINK_SQL = `
  INSERT INTO game_links (game_id, source, external_id, url, match_method, confidence, checked_at)
  VALUES (?, ?, ?, ?, ?, ?, NOW())
  ON DUPLICATE KEY UPDATE
    external_id = VALUES(external_id),
    url = VALUES(url),
    match_method = VALUES(match_method),
    confidence = VALUES(confidence),
    checked_at = VALUES(checked_at)
`;

/**
 * Upsert a `source_records` row (unique on `source`+`external_id`), keyed
 * `(source, externalId)`. `status` defaults to `'ok'` (the enum's other
 * values are `'not_found'`/`'error'`); `payload` is stored as a JSON string
 * (or `NULL`), never re-serialized on the raw string a module may already
 * hold.
 */
export function upsertRecord(db, source, externalId, { status = 'ok', payload = null, error = null, gameId = null } = {}) {
  const payloadJson = payload === null || payload === undefined ? null : JSON.stringify(payload);
  return db.query(UPSERT_RECORD_SQL, [source, externalId, gameId, status, payloadJson, error]);
}

/**
 * Upsert a `game_links` row (unique on `game_id`+`source`) linking `gameId`
 * to `externalId` on `source`. `method` must be one of the
 * `match_method` enum values (`store`, `wikidata`, `igdb`, `name`, `manual`,
 * `legacy`); defaults to `'name'` for the fallback similarity match.
 */
export function upsertLink(db, gameId, source, externalId, { url = null, method = 'name', confidence = 100 } = {}) {
  return db.query(UPSERT_LINK_SQL, [gameId, source, externalId, url, method, confidence]);
}

/**
 * Build `ctx = { db, http, log, env, config, enqueue, enqueueResolve,
 * queueCounts, trimQueue, upsertRecord, upsertLink }`. Every dependency is
 * passed in explicitly (no hidden imports of the real db/queue modules) so
 * callers — the real worker/CLI, or a test — fully control what `ctx` can
 * reach. `ctx.db` is stored as given (not wrapped/cloned), so a caller that
 * wants `src/pipeline/resolve.js`'s resolve step to run as one real
 * transaction per game passes `db = { query, one, tx }` with `tx` imported
 * from `src/db.js` (as `src/worker.js` and `scripts/run-source.js` do); a
 * `db` without `tx` (e.g. a fake `{ query, one }` in a test) still works,
 * just without that guarantee.
 *
 * `queueCounts(source)` -> `{ waiting, delayed }` and `trimQueue(source,
 * keep)` -> number removed are optional (default to a no-Redis stand-in:
 * always-empty counts / nothing removed) so every existing caller/test that
 * doesn't pass them keeps working unchanged; `src/worker.js` wires the real
 * BullMQ-backed versions (see its own comment) for `src/sources/steam.js`'s
 * `discover()`, which is the only current reader.
 */
export function createContext({ db, http, log, env, config, enqueue, enqueueResolve, queueCounts, trimQueue }) {
  return {
    db,
    http,
    log,
    env,
    config,
    enqueue,
    enqueueResolve,
    queueCounts: queueCounts ?? (async () => ({ waiting: 0, delayed: 0 })),
    trimQueue: trimQueue ?? (async () => 0),
    upsertRecord: (source, externalId, opts) => upsertRecord(db, source, externalId, opts),
    upsertLink: (gameId, source, externalId, opts) => upsertLink(db, gameId, source, externalId, opts),
  };
}

/**
 * Build a `Map<sourceName, ctx>` for `sourceModules`: a source with
 * `config.sources.<name>.proxy` set gets its own `createContext(...)` whose
 * `http` is `defaultDeps.http` wrapped with `withProxy(http, proxy)`; every
 * other source maps to `defaultCtx` (already built by the caller with the
 * plain `http`), so nothing extra is allocated for sources that don't need
 * a proxy. `defaultDeps` supplies everything else `createContext` needs
 * (`db`, `http`, `log`, `env`, `config`, `enqueue`, `enqueueResolve`) — same
 * shape as `createContext`'s own argument, `config` is also where each
 * source's `proxy` setting is read from.
 */
export function buildCtxForSources(sourceModules, { defaultCtx, ...defaultDeps }) {
  const ctxForSource = new Map();
  for (const mod of sourceModules) {
    const proxy = defaultDeps.config?.sources?.[mod.name]?.proxy ?? null;
    if (!proxy) {
      ctxForSource.set(mod.name, defaultCtx);
      continue;
    }
    ctxForSource.set(mod.name, createContext({ ...defaultDeps, http: withProxy(defaultDeps.http, proxy) }));
  }
  return ctxForSource;
}

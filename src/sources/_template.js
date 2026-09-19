// Template for a new source module (src/sources/<name>.js). Copy this file,
// rename it, fill in `name`/`rateLimit`, implement `fetchOne` (and, for a
// catalog source, `discover`), and add a fixture-based test of `extract()`.
//
// This file is intentionally excluded from the registry
// (src/sources/index.js ignores `_template.js`), so it never needs to be a
// working module itself.
//
// Interface reference: docs/plans/2026-09-19-rewrite-plan.md, "Source module
// interface"; ingestion order and per-source responsibilities: §5 of
// docs/specs/2026-09-19-rewrite-design.md.

// Must equal `game_links.source` / `source_records.source` for this source.
export const name = '_template';

// BullMQ limiter default for this source's queue; overridable per source in
// config.json (`sources.<name>.rateLimit`), read by src/worker.js.
export const rateLimit = { max: 1, duration: 1500 };

/**
 * Catalog sources only (e.g. steam, gog): enumerate everything the source
 * currently has, enqueue a `fetch` job per item via `ctx.enqueue(name, {
 * gameId?, externalId })`, and record progress in `source_state`
 * (`cursor_state`, `last_run_at`) so a restart resumes rather than
 * re-scanning from scratch. Scheduled daily by `scheduleRepeatables()`
 * (src/queue.js) — see `config.sources.<name>.discoverCron`.
 *
 * Enrichment (non-catalog) sources omit this export entirely; the registry
 * and scheduler both check `typeof mod.discover === 'function'`.
 */
export async function discover(ctx) {
  throw new Error(`${name}: discover() not implemented`);
}

/**
 * Fetch and store one record. `job.data` is `{ gameId, externalId? }` (a
 * source with no source-specific id, e.g. one only matched by name, may omit
 * `externalId` and rely on `gameId` alone).
 *
 * Must:
 *  1. Fetch the raw data (via `ctx.http`), respecting the source's rate limit.
 *  2. Upsert it with `ctx.upsertRecord(name, externalId, { status, payload, error, gameId })`.
 *  3. If this call learned/confirmed the external id for a game, upsert
 *     `ctx.upsertLink(gameId, name, externalId, { url, method, confidence })`.
 *  4. Enqueue a resolve for the affected game: `ctx.enqueueResolve(gameId)`.
 *
 * Returns `{ status, externalId, payload }` (used for logging/tests).
 */
export async function fetchOne(ctx, job) {
  throw new Error(`${name}: fetchOne() not implemented`);
}

/**
 * Pure: the raw stored `payload` (as saved by `fetchOne`, i.e. already
 * `JSON.parse`d) -> normalized fields the resolver understands, e.g.
 * `{ release: { date, precision }, timeMain, timeComplete, scoreX, ... }`.
 * Must never touch the network or the database — every source module has a
 * fixture-based test that feeds this function a recorded payload.
 */
export function extract(payload) {
  throw new Error(`${name}: extract() not implemented`);
}

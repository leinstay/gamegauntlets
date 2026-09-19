// Shared ioredis connection + BullMQ Queue helpers.
//
// One Redis connection is reused by every Queue/Worker (BullMQ's recommended
// pattern, see https://docs.bullmq.io/guide/going-to-production) instead of
// one connection per queue. `maxRetriesPerRequest: null` is required on that
// connection because BullMQ issues blocking commands that must not time out
// on their own.
//
// Every higher-level helper here (`enqueue`, `enqueueResolve`,
// `scheduleRepeatables`) takes an optional `{ getQueue }` override so it can
// be unit-tested with a fake queue instead of a real Redis connection —
// `queueFor` (the real, caching provider) is only reached in production code.

import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { env, config } from './config.js';
import { log } from './log.js';

export const QUEUE_PREFIX = 'gg';

// attempts/backoff/retention applied to every job unless a call overrides it.
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

export const DEFAULT_DISCOVER_CRON = '0 3 * * *'; // daily 03:00 UTC
export const DEFAULT_MAINTENANCE_CRON = '0 4 * * *'; // daily 04:00 UTC
export const DEFAULT_EXPORT_CRON = '48 23 * * *'; // daily 23:48 UTC
export const RESOLVE_BATCH_DELAY_MS = 5000; // batch resolves that land close together

let sharedConnection;

/**
 * Lazily create the shared ioredis connection from REDIS_URL. Lazy so that
 * merely importing this module (e.g. transitively, from a test) never opens
 * a socket — only calling `queueFor`/`getConnection` does.
 */
export function getConnection() {
  if (!sharedConnection) {
    sharedConnection = new Redis(env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
    });
  }
  return sharedConnection;
}

const queues = new Map();

/** Return the cached BullMQ Queue for `name`, creating it on first use. */
export function queueFor(name) {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: getConnection(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    queues.set(name, queue);
  }
  return queue;
}

/**
 * The dedupe jobId used by `enqueue()` when the caller didn't pass one:
 * `<source>:<gameId ?? externalId>`. Exported (pure, no I/O) for tests.
 */
export function jobIdFor(source, data = {}) {
  // BullMQ >= 6 rejects custom job ids containing ":" (its own key separator).
  return `${source}-${data?.gameId ?? data?.externalId}`;
}

/**
 * Enqueue one `fetch` job (processed by a source module's `fetchOne`) on the
 * queue named after `source`. Deduped by jobId, so re-enqueueing the same
 * game/external id while a job for it is still pending/delayed is a no-op.
 */
export function enqueue(source, data, opts = {}, { getQueue = queueFor } = {}) {
  const jobId = opts.jobId ?? jobIdFor(source, data);
  return getQueue(source).add('fetch', data, { ...opts, jobId });
}

/**
 * Enqueue a `resolve` job for `gameId` on the `resolve` queue. Deduped by
 * jobId and delayed a few seconds so several sources finishing close
 * together for the same game collapse into a single resolve.
 */
export function enqueueResolve(gameId, opts = {}, { getQueue = queueFor } = {}) {
  const jobId = opts.jobId ?? `resolve-${gameId}`;
  return getQueue('resolve').add(
    'resolve',
    { gameId },
    { delay: RESOLVE_BATCH_DELAY_MS, ...opts, jobId },
  );
}

/**
 * Create/update every repeatable job from config:
 * - a `discover` job scheduler per module in `sourceModules` that implements
 *   `discover()` (catalog sources), cron from
 *   `config.sources.<name>.discoverCron` (default daily 03:00 UTC); skipped
 *   when `config.sources.<name>.enabled === false`.
 * - `maintenance:retention` daily 04:00 UTC (roll_log retention).
 * - `maintenance:export` daily 23:48 UTC (steamdb export).
 *
 * `upsertJobScheduler` is idempotent on its id, so this is safe to call every
 * time the worker starts.
 */
export async function scheduleRepeatables(sourceModules = [], { getQueue = queueFor } = {}) {
  const scheduled = [];

  for (const mod of sourceModules) {
    if (typeof mod.discover !== 'function') continue;
    const sourceConfig = config.sources?.[mod.name] ?? {};
    if (sourceConfig.enabled === false) continue;
    const pattern = sourceConfig.discoverCron ?? DEFAULT_DISCOVER_CRON;
    await getQueue(mod.name).upsertJobScheduler(
      `${mod.name}:discover`,
      { pattern, tz: 'UTC' },
      { name: 'discover', data: {} },
    );
    scheduled.push(mod.name);
  }

  const maintenance = getQueue('maintenance');
  await maintenance.upsertJobScheduler(
    'maintenance:retention',
    { pattern: config.retention?.cron ?? DEFAULT_MAINTENANCE_CRON, tz: 'UTC' },
    { name: 'retention', data: {} },
  );
  await maintenance.upsertJobScheduler(
    'maintenance:export',
    { pattern: config.export?.cron ?? DEFAULT_EXPORT_CRON, tz: 'UTC' },
    { name: 'export', data: {} },
  );

  log.info('queue: repeatables scheduled', { discover: scheduled });
  return scheduled;
}

// Jobs removed per `queue.getWaiting()` round trip while trimming (bounded so
// one call never asks Redis for an unbounded range at once).
const TRIM_CHUNK_SIZE = 1000;

/**
 * Remove waiting jobs beyond the first `keep` (oldest-first — BullMQ's own
 * FIFO order, see `Queue#getWaiting`), in `TRIM_CHUNK_SIZE` chunks, and
 * return how many were removed. One-off backlog drain for a queue that grew
 * far beyond what its rate limit can ever work through (see
 * `src/sources/steam.js`'s `discover()`): nothing is lost by trimming — the
 * removed jobs' underlying candidates are re-selected by that source's own
 * SQL-driven priority query on a later `discover()` run, they just stop
 * occupying Redis in the meantime.
 *
 * Repeatedly re-reads the same `[keep, keep + TRIM_CHUNK_SIZE - 1]` window
 * rather than advancing an offset: removing a job shifts every later job's
 * index down by one, so the next chunk of "everything past `keep`" is always
 * at that same window until nothing is left there.
 */
export async function trimQueue(queue, keep) {
  const boundedKeep = Math.max(0, Number(keep) || 0);
  let removed = 0;
  for (;;) {
    const jobs = await queue.getWaiting(boundedKeep, boundedKeep + TRIM_CHUNK_SIZE - 1);
    if (!jobs || jobs.length === 0) break;
    await Promise.all(jobs.map((job) => job.remove()));
    removed += jobs.length;
    if (jobs.length < TRIM_CHUNK_SIZE) break;
  }
  return removed;
}

/** Close every cached Queue and the shared Redis connection. */
export async function closeQueues() {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  if (sharedConnection) {
    await sharedConnection.quit().catch(() => sharedConnection.disconnect());
    sharedConnection = undefined;
  }
}

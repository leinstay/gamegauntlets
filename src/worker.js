// Worker process (`npm run worker`): one BullMQ Worker per registered source
// module (src/sources/index.js), plus a `resolve` worker and a `maintenance`
// worker (retention + export). Also (re)installs the repeatable jobs on
// every start via `scheduleRepeatables` — idempotent, so safe to restart.
//
// Which source workers actually start is controlled by WORKER_SOURCES /
// WORKER_EXCLUDE_SOURCES (see src/lib/worker-sources.js) — used to run a
// single source (e.g. `gamefaqs`) as a standalone satellite process
// elsewhere (behind an SSH tunnel to this DB/Redis) while the main process here runs
// every other source. See resolveWorkerSources()'s doc comment and the
// `selection.mode` handling below for exactly what each mode starts.
//
// All the real wiring (DB pool, Redis-backed Workers, scheduleRepeatables)
// lives in `main()`, only run when this file is executed directly (`node
// src/worker.js`) — same split as src/api.js's `buildApp()`/`main()`, so
// tests can import `createRunSourceJob`/`buildCtxForSources` (via
// src/pipeline/context.js) without opening a real DB/Redis connection.

import { pathToFileURL } from 'node:url';
import { Worker } from 'bullmq';
import {
  getConnection,
  queueFor,
  QUEUE_PREFIX,
  enqueue,
  enqueueResolve,
  trimQueue,
  scheduleRepeatables,
  closeQueues,
} from './queue.js';
import { createContext, buildCtxForSources } from './pipeline/context.js';
import { runRetention, runExport } from './pipeline/maintenance.js';
import { getJson, getText, postJson, postText } from './lib/http.js';
import { env, config } from './config.js';
import { log } from './log.js';
import { sources } from './sources/index.js';
import { resolveWorkerSources } from './lib/worker-sources.js';

export const PAUSED_REQUEUE_DELAY_MS = 10 * 60 * 1000; // 10 minutes
export const EGRESS_OFFLINE_LOG_INTERVAL_MS = 60 * 1000; // at most once/minute

/**
 * Factory for the per-job handler each source's BullMQ Worker runs: `discover`
 * for a job named `'discover'`, `fetchOne` otherwise. Every dependency is
 * injected so this is unit-testable without a real DB/Redis (see
 * tests/worker.test.js):
 *  - skips (and requeues delayed `requeueDelayMs`, same as the paused case)
 *    when `isPaused(source)` is true;
 *  - on an error whose `code` is `'EPROXY_UNAVAILABLE'` (thrown by
 *    src/lib/http.js's proxied path when the egress proxy itself can't be
 *    reached — see its module comment), ALSO requeues delayed instead of
 *    throwing: this is egress being offline, not a source failure, so it
 *    must not count as a failed job attempt, must not touch
 *    `source_state.last_error`, and must not pause the source. Logs at most
 *    once per `egressLogIntervalMs` (not once per job) so a long outage
 *    doesn't spam the log;
 *  - otherwise runs the module and records `last_run_at`/`last_error` via
 *    `touchSourceState`, rethrowing on error (a real job failure).
 */
export function createRunSourceJob({
  ctxForSource,
  defaultCtx,
  isPaused,
  touchSourceState,
  queueFor: queueForFn,
  log: logger,
  requeueDelayMs = PAUSED_REQUEUE_DELAY_MS,
  egressLogIntervalMs = EGRESS_OFFLINE_LOG_INTERVAL_MS,
  now = () => Date.now(),
}) {
  let lastEgressOfflineLogAt = -Infinity;

  return async function runSourceJob(mod, job) {
    const sourceCtx = ctxForSource?.get(mod.name) ?? defaultCtx;

    if (await isPaused(mod.name)) {
      logger.info('worker: source paused, requeuing', { source: mod.name, job: job.name, jobId: job.id });
      await queueForFn(mod.name).add(job.name, job.data, { delay: requeueDelayMs });
      return { skipped: true, reason: 'paused' };
    }

    try {
      const result = job.name === 'discover' ? await mod.discover(sourceCtx) : await mod.fetchOne(sourceCtx, job);
      await touchSourceState(mod.name, { last_run_at: new Date() });
      return result;
    } catch (err) {
      if (err?.code === 'EPROXY_UNAVAILABLE') {
        const nowMs = now();
        if (nowMs - lastEgressOfflineLogAt >= egressLogIntervalMs) {
          lastEgressOfflineLogAt = nowMs;
          logger.info('worker: egress proxy offline, requeuing', { source: mod.name, job: job.name, jobId: job.id });
        }
        await queueForFn(mod.name).add(job.name, job.data, { delay: requeueDelayMs });
        return { skipped: true, reason: 'egress-proxy-offline' };
      }
      await touchSourceState(mod.name, { last_run_at: new Date(), last_error: String(err?.message ?? err) });
      throw err;
    }
  };
}

async function main() {
  // Dynamically imported (not a static top-level import) so merely importing this file — as
  // tests do, to reach createRunSourceJob above — never requires DB_HOST/DB_NAME/DB_USER or
  // opens a real connection pool (same reasoning as src/api.js's main()).
  const { query, one, tx, closePool } = await import('./db.js');

  // `tx` (a real per-connection SQL transaction, see src/db.js) is included so the `resolve`
  // worker below can run each game's resolve as one transaction (src/pipeline/resolve.js uses
  // ctx.db.tx when present).
  const db = { query, one, tx };
  const http = { getJson, getText, postJson, postText };
  // Real BullMQ-backed versions of the hooks src/pipeline/context.js defaults to no-ops: steam's discover()
  // checks its queue depth before enqueueing the next rolling batch and trims an oversized backlog.
  const queueCounts = async (source) => {
    const counts = await queueFor(source).getJobCounts('waiting', 'delayed');
    return { waiting: counts.waiting ?? 0, delayed: counts.delayed ?? 0 };
  };
  const workerTrimQueue = (source, keep) => trimQueue(queueFor(source), keep);
  const ctx = createContext({ db, http, log, env, config, enqueue, enqueueResolve, queueCounts, trimQueue: workerTrimQueue });

  // `selection.mode`:
  // - 'all' (both env vars unset): every registered source, resolve worker,
  //   maintenance worker and scheduleRepeatables — today's behaviour,
  //   byte-for-byte (selection.names === sources.map((mod) => mod.name), so
  //   nothing below observably changes and no extra line is logged).
  // - 'only' (WORKER_SOURCES set): a standalone satellite for exactly the
  //   listed sources. No resolve worker, no maintenance worker, no
  //   scheduleRepeatables call — a remote satellite must not schedule
  //   discover jobs or run retention/export; the source jobs it consumes
  //   already call `ctx.enqueueResolve(gameId)`, which only adds a job to the
  //   shared Redis `resolve` queue (see src/queue.js) for the main process's
  //   resolve worker to pick up, so nothing here needs a local resolve worker.
  // - 'exclude' (WORKER_EXCLUDE_SOURCES set, WORKER_SOURCES unset): every
  //   registered source except the listed ones, but resolve/maintenance/
  //   scheduleRepeatables stay ON and scheduleRepeatables still gets the FULL
  //   `sources` list (not the filtered one) — an excluded source's repeatable
  //   `<source>:discover` job must still be registered so a satellite running
  //   only that source has a `discover` job to consume from its queue.
  const selection = resolveWorkerSources(env, sources.map((mod) => mod.name), {
    warn: (message, meta) => log.warn(message, meta),
  });
  if (selection.mode !== 'all') {
    log.info('worker: source selection', { mode: selection.mode, sources: selection.names });
  }
  const activeSources = sources.filter((mod) => selection.names.includes(mod.name));

  // One ctx per source that has config.sources.<name>.proxy set (e.g. gamefaqs — see
  // src/pipeline/context.js's buildCtxForSources), so ctx.http.* calls made by that source
  // module automatically route through its egress proxy. Every other source shares `ctx`.
  const ctxForSource = buildCtxForSources(activeSources, { defaultCtx: ctx, db, http, log, env, config, enqueue, enqueueResolve, queueCounts, trimQueue: workerTrimQueue });

  async function isPaused(sourceName) {
    const state = await db.one('SELECT paused FROM source_state WHERE source = ?', [sourceName]);
    return Boolean(state?.paused);
  }

  async function touchSourceState(sourceName, fields) {
    const columns = Object.keys(fields);
    if (columns.length === 0) return;
    const assignments = columns.map((c) => `${c} = VALUES(${c})`).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    await db.query(
      `INSERT INTO source_state (source, ${columns.join(', ')})
       VALUES (?, ${placeholders})
       ON DUPLICATE KEY UPDATE ${assignments}`,
      [sourceName, ...columns.map((c) => fields[c])],
    );
  }

  const runSourceJob = createRunSourceJob({ ctxForSource, defaultCtx: ctx, isPaused, touchSourceState, queueFor, log });

  const workers = activeSources.map((mod) => {
    const sourceConfig = config.sources?.[mod.name] ?? {};
    const worker = new Worker(mod.name, (job) => runSourceJob(mod, job), {
      connection: getConnection(),
      prefix: QUEUE_PREFIX,
      concurrency: sourceConfig.concurrency ?? 1,
      limiter: sourceConfig.rateLimit ?? mod.rateLimit,
    });
    worker.on('failed', (job, err) => {
      log.error('worker: job failed', { source: mod.name, job: job?.name, jobId: job?.id, error: err });
    });
    return worker;
  });

  // A standalone single-source satellite ('only' mode) never runs these: it
  // has no business scheduling discover jobs or running retention/export, and
  // resolve jobs it can't process locally are simply left for the main
  // process (elsewhere, sharing the same Redis) to pick up.
  const resolveWorker = selection.mode === 'only' ? null : new Worker(
    'resolve',
    async (job) => {
      let mod;
      try {
        mod = await import('./pipeline/resolve.js');
      } catch (err) {
        if (err?.code === 'ERR_MODULE_NOT_FOUND') {
          log.info('worker: pipeline/resolve.js not present yet, skipping resolve', { gameId: job.data.gameId });
          return { skipped: true };
        }
        throw err;
      }
      return mod.resolveGame(ctx, job.data.gameId);
    },
    { connection: getConnection(), prefix: QUEUE_PREFIX, concurrency: config.resolve?.concurrency ?? 2 },
  );
  resolveWorker?.on('failed', (job, err) => {
    log.error('worker: resolve job failed', { jobId: job?.id, gameId: job?.data?.gameId, error: err });
  });

  const maintenanceWorker = selection.mode === 'only' ? null : new Worker(
    'maintenance',
    async (job) => {
      if (job.name === 'retention') {
        const months = config.retention?.rollLogMonths ?? 12;
        const deleted = await runRetention(db, months, { log });
        return { deleted };
      }
      if (job.name === 'export') {
        return runExport({ log });
      }
      log.warn('worker: unknown maintenance job', { name: job.name });
      return { skipped: true };
    },
    { connection: getConnection(), prefix: QUEUE_PREFIX, concurrency: 1 },
  );
  maintenanceWorker?.on('failed', (job, err) => {
    log.error('worker: maintenance job failed', { job: job?.name, jobId: job?.id, error: err });
  });

  const allWorkers = [workers, resolveWorker, maintenanceWorker].flat().filter(Boolean);

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('worker: shutting down', { signal });
    try {
      await Promise.all(allWorkers.map((w) => w.close()));
      await closeQueues();
      await closePool();
    } catch (err) {
      log.error('worker: error during shutdown', err);
    } finally {
      process.exit(0);
    }
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Always the full `sources` list, never `activeSources`: in 'exclude' mode
  // an excluded source's `<source>:discover` scheduler must still be
  // (re)installed on its queue so a satellite running only that source has a
  // discover job to consume (see the `selection` comment above). Skipped
  // entirely in 'only' mode — a satellite must not schedule anything.
  if (selection.mode !== 'only') {
    await scheduleRepeatables(sources);
  }
  log.info('worker: started', { sources: selection.names, workers: allWorkers.length });
}

// Only boot the real workers when this file is run directly (`node src/worker.js`), not when
// imported by tests. Compared as file:// URLs (via pathToFileURL) so this also works with
// Windows drive-letter paths — same guard as src/api.js.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

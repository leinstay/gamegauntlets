import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  jobIdFor,
  enqueue,
  enqueueResolve,
  scheduleRepeatables,
  trimQueue,
  DEFAULT_JOB_OPTIONS,
  DEFAULT_DISCOVER_CRON,
  DEFAULT_MAINTENANCE_CRON,
  DEFAULT_EXPORT_CRON,
  RESOLVE_BATCH_DELAY_MS,
} from '../src/queue.js';
import { listSourceFiles, loadSources, sources, getSource } from '../src/sources/index.js';
import { retentionDeleteSql, runRetention, runExport } from '../src/pipeline/maintenance.js';
import { createContext, upsertRecord, upsertLink } from '../src/pipeline/context.js';
import { config } from '../src/config.js';

// Every test below drives queue.js/context.js/maintenance.js through injected
// fakes (a fake BullMQ queue, a fake db) so nothing here touches Redis or
// MySQL. Real connections are only opened by `getConnection`/`queueFor`
// (queue.js) and `pool` (db.js), which no test imports.

// --- queue.js: jobId dedupe ------------------------------------------------

test('jobIdFor: uses gameId when present', () => {
  assert.equal(jobIdFor('hltb', { gameId: 42 }), 'hltb-42');
});

test('jobIdFor: falls back to externalId when gameId is absent', () => {
  assert.equal(jobIdFor('steam', { externalId: '730' }), 'steam-730');
});

test('jobIdFor: prefers gameId over externalId when both are present', () => {
  assert.equal(jobIdFor('steam', { gameId: 1, externalId: '730' }), 'steam-1');
});

// --- queue.js: default job options -----------------------------------------

test('DEFAULT_JOB_OPTIONS: attempts, exponential backoff, retention', () => {
  assert.equal(DEFAULT_JOB_OPTIONS.attempts, 5);
  assert.deepEqual(DEFAULT_JOB_OPTIONS.backoff, { type: 'exponential', delay: 30_000 });
  assert.equal(DEFAULT_JOB_OPTIONS.removeOnComplete, 1000);
  assert.equal(DEFAULT_JOB_OPTIONS.removeOnFail, 5000);
});

// --- queue.js: enqueue / enqueueResolve (fake queue, option merging) -------

function fakeQueueProvider() {
  const calls = [];
  const getQueue = (name) => ({
    add: (jobName, data, opts) => {
      calls.push({ queue: name, jobName, data, opts });
      return Promise.resolve({ id: `${name}:${calls.length}` });
    },
  });
  return { getQueue, calls };
}

test('enqueue: adds a "fetch" job on the source queue, deduped by jobId', async () => {
  const { getQueue, calls } = fakeQueueProvider();
  await enqueue('hltb', { gameId: 7 }, {}, { getQueue });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].queue, 'hltb');
  assert.equal(calls[0].jobName, 'fetch');
  assert.deepEqual(calls[0].data, { gameId: 7 });
  assert.equal(calls[0].opts.jobId, 'hltb-7');
});

test('enqueue: an explicit opts.jobId wins over the computed one', async () => {
  const { getQueue, calls } = fakeQueueProvider();
  await enqueue('hltb', { gameId: 7 }, { jobId: 'custom-id' }, { getQueue });
  assert.equal(calls[0].opts.jobId, 'custom-id');
});

test('enqueue: other opts are merged alongside the jobId', async () => {
  const { getQueue, calls } = fakeQueueProvider();
  await enqueue('hltb', { gameId: 7 }, { attempts: 1, priority: 5 }, { getQueue });
  assert.deepEqual(calls[0].opts, { attempts: 1, priority: 5, jobId: 'hltb-7' });
});

test('enqueueResolve: adds a delayed, deduped "resolve" job', async () => {
  const { getQueue, calls } = fakeQueueProvider();
  await enqueueResolve(99, {}, { getQueue });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].queue, 'resolve');
  assert.equal(calls[0].jobName, 'resolve');
  assert.deepEqual(calls[0].data, { gameId: 99 });
  assert.equal(calls[0].opts.jobId, 'resolve-99');
  assert.equal(calls[0].opts.delay, RESOLVE_BATCH_DELAY_MS);
});

test('enqueueResolve: opts can override the default delay/jobId', async () => {
  const { getQueue, calls } = fakeQueueProvider();
  await enqueueResolve(99, { delay: 0, jobId: 'resolve-custom' }, { getQueue });
  assert.equal(calls[0].opts.delay, 0);
  assert.equal(calls[0].opts.jobId, 'resolve-custom');
});

// --- queue.js: scheduleRepeatables (fake queue) ----------------------------

test('scheduleRepeatables: cron defaults, per-source override, disabled skip, and maintenance jobs', async () => {
  const originalSteam = config.sources?.steam;
  const testSourceName = 'zzTestDiscoverSource';
  const disabledSourceName = 'zzTestDisabledSource';
  config.sources = config.sources ?? {};
  // Real config.json sets sources.steam.discoverCron (rolling-batch discover
  // runs every 2h, see src/sources/steam.js) - override it back to "nothing
  // configured" here so this case still exercises the DEFAULT_DISCOVER_CRON
  // fallback; restored in the `finally` block below either way.
  config.sources.steam = {};
  config.sources[testSourceName] = { discoverCron: '*/5 * * * *' };
  config.sources[disabledSourceName] = { enabled: false };

  const upsertCalls = [];
  const getQueue = (name) => ({
    upsertJobScheduler: (id, repeatOpts, template) => {
      upsertCalls.push({ queue: name, id, repeatOpts, template });
      return Promise.resolve({ id });
    },
  });

  try {
    const modules = [
      { name: 'steam', discover: async () => {} }, // no config override -> default cron
      { name: testSourceName, discover: async () => {} },
      { name: disabledSourceName, discover: async () => {} }, // enabled: false -> skipped
      { name: 'hltb' }, // no discover() -> never considered
    ];
    const scheduled = await scheduleRepeatables(modules, { getQueue });
    assert.deepEqual(scheduled, ['steam', testSourceName]);

    const steamCall = upsertCalls.find((c) => c.queue === 'steam');
    assert.equal(steamCall.id, 'steam:discover');
    assert.deepEqual(steamCall.repeatOpts, { pattern: DEFAULT_DISCOVER_CRON, tz: 'UTC' });
    assert.deepEqual(steamCall.template, { name: 'discover', data: {} });

    const customCall = upsertCalls.find((c) => c.queue === testSourceName);
    assert.deepEqual(customCall.repeatOpts, { pattern: '*/5 * * * *', tz: 'UTC' });

    assert.equal(upsertCalls.some((c) => c.queue === disabledSourceName), false);

    const retentionCall = upsertCalls.find((c) => c.id === 'maintenance:retention');
    assert.equal(retentionCall.queue, 'maintenance');
    assert.deepEqual(retentionCall.repeatOpts, { pattern: DEFAULT_MAINTENANCE_CRON, tz: 'UTC' });
    assert.deepEqual(retentionCall.template, { name: 'retention', data: {} });

    const exportCall = upsertCalls.find((c) => c.id === 'maintenance:export');
    assert.equal(exportCall.queue, 'maintenance');
    assert.deepEqual(exportCall.repeatOpts, { pattern: DEFAULT_EXPORT_CRON, tz: 'UTC' });
    assert.deepEqual(exportCall.template, { name: 'export', data: {} });
  } finally {
    delete config.sources[testSourceName];
    delete config.sources[disabledSourceName];
    if (originalSteam !== undefined) config.sources.steam = originalSteam;
  }
});

// --- queue.js: trimQueue (fake queue mimicking BullMQ's Queue#getWaiting/Job#remove) ---

// `count` waiting jobs, oldest at index 0 (BullMQ's own FIFO order - see
// `Queue#getWaiting`'s doc in bullmq). `getWaiting(start, end)` returns only
// the still-present ones re-indexed from 0, exactly like the real backend
// does once earlier jobs are removed.
function fakeWaitingQueue(count) {
  const jobs = Array.from({ length: count }, (_, i) => ({ id: `job-${i}`, removed: false }));
  const removedIds = [];
  return {
    removedIds,
    remaining: () => jobs.filter((j) => !j.removed).length,
    getWaiting: async (start = 0, end = -1) => {
      const present = jobs.filter((j) => !j.removed);
      const slice = end < 0 ? present.slice(start) : present.slice(start, end + 1);
      return slice.map((j) => ({
        id: j.id,
        remove: async () => {
          j.removed = true;
          removedIds.push(j.id);
        },
      }));
    },
  };
}

test('trimQueue: below keep - nothing is removed', async () => {
  const queue = fakeWaitingQueue(50);
  const removed = await trimQueue(queue, 100);
  assert.equal(removed, 0);
  assert.equal(queue.remaining(), 50);
});

test('trimQueue: removes only the excess beyond keep, oldest-index-first', async () => {
  const queue = fakeWaitingQueue(2500);
  const removed = await trimQueue(queue, 1000);
  assert.equal(removed, 1500);
  assert.equal(queue.remaining(), 1000);
  // The 1000 that remain are exactly the first 1000 (lowest-index / oldest) jobs.
  const stillWaiting = await queue.getWaiting(0, -1);
  assert.deepEqual(stillWaiting.map((j) => j.id).slice(0, 3), ['job-0', 'job-1', 'job-2']);
  assert.equal(stillWaiting.length, 1000);
});

test('trimQueue: exactly at keep - nothing is removed', async () => {
  const queue = fakeWaitingQueue(1000);
  const removed = await trimQueue(queue, 1000);
  assert.equal(removed, 0);
  assert.equal(queue.remaining(), 1000);
});

test('trimQueue: keep=0 removes everything', async () => {
  const queue = fakeWaitingQueue(150);
  const removed = await trimQueue(queue, 0);
  assert.equal(removed, 150);
  assert.equal(queue.remaining(), 0);
});

test('trimQueue: a negative/NaN keep is treated as 0 (removes everything, never throws/loops forever)', async () => {
  const queue = fakeWaitingQueue(5);
  const removed = await trimQueue(queue, -10);
  assert.equal(removed, 5);
  assert.equal(queue.remaining(), 0);
});

test('trimQueue: an empty queue is a no-op', async () => {
  const queue = fakeWaitingQueue(0);
  const removed = await trimQueue(queue, 100);
  assert.equal(removed, 0);
});

// --- src/sources/index.js: registry discovery ------------------------------

test('listSourceFiles: excludes index.js and _template.js, sorts the rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-sources-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.js'), '');
    fs.writeFileSync(path.join(dir, '_template.js'), '');
    fs.writeFileSync(path.join(dir, 'zeta.js'), '');
    fs.writeFileSync(path.join(dir, 'alpha.js'), '');
    fs.writeFileSync(path.join(dir, 'readme.txt'), '');
    assert.deepEqual(listSourceFiles(dir), ['alpha.js', 'zeta.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listSourceFiles: a missing directory yields an empty list', () => {
  assert.deepEqual(listSourceFiles(path.join(os.tmpdir(), 'gg-sources-does-not-exist')), []);
});

test('loadSources: imports valid modules and skips ones missing name/fetchOne', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-sources-'));
  try {
    // Outside the project tree there's no ancestor package.json declaring
    // "type": "module", so Node would otherwise treat these .js files as
    // CommonJS and choke on `export`.
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(
      path.join(dir, 'alpha.js'),
      "export const name = 'alpha';\nexport const rateLimit = { max: 1, duration: 1000 };\nexport async function fetchOne() { return 'alpha-ok'; }\n",
    );
    fs.writeFileSync(
      path.join(dir, 'broken.js'),
      "export const name = 'broken';\n// no fetchOne export\n",
    );
    const modules = await loadSources(dir);
    assert.equal(modules.length, 1);
    assert.equal(modules[0].name, 'alpha');
    assert.equal(await modules[0].fetchOne(), 'alpha-ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registry: the real src/sources directory loads every source module present', () => {
  // Assert presence of known modules instead of an exact list, so adding a source never breaks this test.
  assert.ok(Array.isArray(sources));
  for (const name of ['steam', 'wikidata', 'gog']) {
    const mod = getSource(name);
    assert.ok(mod, `expected the ${name} source module to be registered`);
    assert.equal(mod.name, name);
  }
  assert.equal(typeof getSource('steam').fetchOne, 'function');
  assert.equal(getSource('no-such-source'), undefined);
});

// --- src/pipeline/maintenance.js: retention SQL + loop ----------------------

test('retentionDeleteSql: deletes by bound INTERVAL/LIMIT, never interpolated', () => {
  const sql = retentionDeleteSql();
  assert.match(sql, /DELETE FROM roll_log/);
  assert.match(sql, /INTERVAL \? MONTH/);
  assert.match(sql, /LIMIT \?/);
});

// Both tests below disable config.maintenance.purgeNonGames for their duration: runRetention() now also
// runs src/pipeline/purge-non-games.js's purgeNonGames() (see maintenance.js's module comment) unless
// this is false, which would otherwise need these fake `db`s to additionally understand its SELECTs -
// purgeNonGames() itself is covered on its own terms in tests/pipeline/purge-non-games.test.js, and its
// wiring into runRetention() in the "calls purgeNonGames" test further below.
test('runRetention: loops until a batch deletes fewer rows than the limit', async () => {
  const originalMaintenance = config.maintenance;
  config.maintenance = { purgeNonGames: false };
  try {
    const batches = [{ affectedRows: 50_000 }, { affectedRows: 1200 }];
    const queries = [];
    const db = {
      query: async (sql, params) => {
        queries.push({ sql, params });
        return batches.shift();
      },
    };
    const total = await runRetention(db, 12, { limit: 50_000 });
    assert.equal(total, 51_200);
    assert.equal(queries.length, 2);
    assert.deepEqual(queries[0].params, [12, 50_000]);
    assert.deepEqual(queries[1].params, [12, 50_000]);
  } finally {
    config.maintenance = originalMaintenance;
  }
});

test('runRetention: a single under-limit batch stops after one query', async () => {
  const originalMaintenance = config.maintenance;
  config.maintenance = { purgeNonGames: false };
  try {
    const db = { query: async () => ({ affectedRows: 3 }) };
    let calls = 0;
    const countingDb = { query: async (...args) => { calls += 1; return db.query(...args); } };
    const total = await runRetention(countingDb, 12, { limit: 50_000 });
    assert.equal(total, 3);
    assert.equal(calls, 1);
  } finally {
    config.maintenance = originalMaintenance;
  }
});

test('runRetention: also runs purgeNonGames when config.maintenance.purgeNonGames is not false (default)', async () => {
  const originalMaintenance = config.maintenance;
  delete config.maintenance; // exercise the "?? true" default explicitly
  try {
    const queries = [];
    const db = {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.trim().startsWith('DELETE FROM roll_log')) return { affectedRows: 0 };
        if (sql.trim().startsWith('SELECT g.id, g.name, g.non_game')) return []; // no purge candidates
        return [];
      },
      one: async () => ({ c: 0 }),
    };
    await runRetention(db, 12, { limit: 50_000 });
    assert.ok(
      queries.some((q) => q.sql.trim().startsWith('SELECT g.id, g.name, g.non_game')),
      'expected runRetention to also query purge-non-games candidates by default',
    );
  } finally {
    config.maintenance = originalMaintenance;
  }
});

test('runExport: skips without throwing when config.export.enabled is not true (T20 default)', async () => {
  // scripts/export-steamdb.js now exists (T20) but its own main() no-ops
  // unless config.export.enabled is true — the legacy site's exec.sh cron
  // still pushes to leinstay/steamdb nightly on the same server, so the
  // worker-triggered export must stay off until the lead flips it at
  // cutover. This only pins maintenance.js's side of that contract (it
  // calls the imported module's main()/default with no arguments and
  // returns whatever comes back without throwing); scripts/export-steamdb.js's
  // own gating is covered in tests/export.test.js.
  assert.equal(config.export?.enabled, false, 'expected config.export.enabled to default to false');
  const result = await runExport({});
  assert.deepEqual(result, { skipped: true, reason: 'disabled' });
});

// --- src/pipeline/context.js: upsert SQL shape (fake db) --------------------

test('upsertRecord: INSERT ... ON DUPLICATE KEY UPDATE with the expected column order', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { affectedRows: 1 }; } };

  await upsertRecord(db, 'hltb', 'ext-1', { gameId: 5, payload: { a: 1 } });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO source_records/);
  assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE/);
  assert.deepEqual(calls[0].params, ['hltb', 'ext-1', 5, 'ok', JSON.stringify({ a: 1 }), null]);
});

test('upsertRecord: defaults status to "ok", null payload stays null (not "null")', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push(params); return {}; } };
  await upsertRecord(db, 'hltb', 'ext-2', {});
  assert.deepEqual(calls[0], ['hltb', 'ext-2', null, 'ok', null, null]);
});

test('upsertLink: INSERT ... ON DUPLICATE KEY UPDATE with defaults url=null, method="name", confidence=100', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return {}; } };

  await upsertLink(db, 5, 'hltb', 'ext-1');

  assert.match(calls[0].sql, /INSERT INTO game_links/);
  assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE/);
  assert.deepEqual(calls[0].params, [5, 'hltb', 'ext-1', null, 'name', 100]);
});

test('upsertLink: overrides are passed through', async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push(params); return {}; } };
  await upsertLink(db, 5, 'wikidata', 'Q123', { url: 'https://x', method: 'wikidata', confidence: 80 });
  assert.deepEqual(calls[0], [5, 'wikidata', 'Q123', 'https://x', 'wikidata', 80]);
});

test('createContext: builds the documented ctx shape and binds upsertRecord/upsertLink to db', async () => {
  const queries = [];
  const db = { query: async (sql, params) => { queries.push({ sql, params }); return { affectedRows: 1 }; } };
  const http = { getJson: async () => ({}) };
  const log = { info: () => {} };
  const enqueue = () => {};
  const enqueueResolve = () => {};

  const ctx = createContext({ db, http, log, env: {}, config: {}, enqueue, enqueueResolve });

  assert.equal(ctx.db, db);
  assert.equal(ctx.http, http);
  assert.equal(ctx.log, log);
  assert.equal(ctx.enqueue, enqueue);
  assert.equal(ctx.enqueueResolve, enqueueResolve);
  assert.equal(typeof ctx.upsertRecord, 'function');
  assert.equal(typeof ctx.upsertLink, 'function');

  await ctx.upsertRecord('hltb', 'ext-1', { gameId: 1 });
  assert.match(queries[0].sql, /INSERT INTO source_records/);

  await ctx.upsertLink(1, 'hltb', 'ext-1');
  assert.match(queries[1].sql, /INSERT INTO game_links/);
});

test('createContext: queueCounts/trimQueue default to no-Redis stand-ins when not passed', async () => {
  const ctx = createContext({
    db: { query: async () => ({}) },
    http: {},
    log: { info: () => {} },
    env: {},
    config: {},
    enqueue: () => {},
    enqueueResolve: () => {},
  });

  assert.deepEqual(await ctx.queueCounts('steam'), { waiting: 0, delayed: 0 });
  assert.equal(await ctx.trimQueue('steam', 100), 0);
});

test('createContext: passed-in queueCounts/trimQueue are used as-is', async () => {
  const queueCounts = async (source) => ({ waiting: source === 'steam' ? 42 : 0, delayed: 1 });
  const trimQueue = async () => 7;
  const ctx = createContext({
    db: { query: async () => ({}) },
    http: {},
    log: { info: () => {} },
    env: {},
    config: {},
    enqueue: () => {},
    enqueueResolve: () => {},
    queueCounts,
    trimQueue,
  });

  assert.deepEqual(await ctx.queueCounts('steam'), { waiting: 42, delayed: 1 });
  assert.equal(await ctx.trimQueue('steam', 5), 7);
});

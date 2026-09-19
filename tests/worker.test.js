// Tests for src/worker.js's createRunSourceJob (all real DB/Redis wiring
// lives in main(), only run when the file is executed directly — see the
// module comment — so importing this file never opens a real connection).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRunSourceJob, PAUSED_REQUEUE_DELAY_MS, EGRESS_OFFLINE_LOG_INTERVAL_MS } from '../src/worker.js';

function fakeLogger() {
  const info = [];
  const warn = [];
  return { info: (msg, meta) => info.push({ msg, meta }), warn: (msg, meta) => warn.push({ msg, meta }), info_calls: info, warn_calls: warn };
}

function fakeQueue() {
  const added = [];
  const queues = new Map();
  const queueFor = (name) => {
    let q = queues.get(name);
    if (!q) {
      q = { add: async (jobName, data, opts) => added.push({ source: name, jobName, data, opts }) };
      queues.set(name, q);
    }
    return q;
  };
  return { queueFor, added };
}

function job(name, data = {}, id = 'j1') {
  return { name, data, id };
}

test('createRunSourceJob: paused source -> requeues delayed, does not run the module, does not throw', async () => {
  const { queueFor, added } = fakeQueue();
  const logger = fakeLogger();
  const ctx = { marker: 'ctx' };
  let ran = false;
  const mod = { name: 'gamefaqs', fetchOne: async () => { ran = true; } };

  const runSourceJob = createRunSourceJob({
    ctxForSource: new Map(),
    defaultCtx: ctx,
    isPaused: async () => true,
    touchSourceState: async () => { throw new Error('must not be called'); },
    queueFor,
    log: logger,
  });

  const result = await runSourceJob(mod, job('fetch', { gameId: 1 }));
  assert.deepEqual(result, { skipped: true, reason: 'paused' });
  assert.equal(ran, false);
  assert.equal(added.length, 1);
  assert.equal(added[0].source, 'gamefaqs');
  assert.equal(added[0].opts.delay, PAUSED_REQUEUE_DELAY_MS);
});

test('createRunSourceJob: normal success -> runs fetchOne with the per-source ctx, touches last_run_at', async () => {
  const { queueFor } = fakeQueue();
  const logger = fakeLogger();
  const defaultCtx = { marker: 'default' };
  const gamefaqsCtx = { marker: 'gamefaqs-proxied' };
  let seenCtx;
  const touched = [];
  const mod = { name: 'gamefaqs', fetchOne: async (ctx) => { seenCtx = ctx; return { status: 'ok' }; } };

  const runSourceJob = createRunSourceJob({
    ctxForSource: new Map([['gamefaqs', gamefaqsCtx]]),
    defaultCtx,
    isPaused: async () => false,
    touchSourceState: async (source, fields) => touched.push({ source, fields }),
    queueFor,
    log: logger,
  });

  const result = await runSourceJob(mod, job('fetch', { gameId: 1 }));
  assert.deepEqual(result, { status: 'ok' });
  assert.equal(seenCtx, gamefaqsCtx); // not defaultCtx — the proxy-wrapped one for this source
  assert.equal(touched.length, 1);
  assert.equal(touched[0].source, 'gamefaqs');
  assert.ok('last_run_at' in touched[0].fields);
  assert.ok(!('last_error' in touched[0].fields));
});

test('createRunSourceJob: discover() is called for a job named "discover", fetchOne otherwise', async () => {
  const { queueFor } = fakeQueue();
  const calls = [];
  const mod = {
    name: 'gamefaqs',
    discover: async () => { calls.push('discover'); return { enqueued: 0 }; },
    fetchOne: async () => { calls.push('fetchOne'); return { status: 'ok' }; },
  };
  const runSourceJob = createRunSourceJob({
    ctxForSource: new Map(),
    defaultCtx: {},
    isPaused: async () => false,
    touchSourceState: async () => {},
    queueFor,
    log: fakeLogger(),
  });

  await runSourceJob(mod, job('discover'));
  await runSourceJob(mod, job('fetch', { gameId: 1 }));
  assert.deepEqual(calls, ['discover', 'fetchOne']);
});

test('createRunSourceJob: a normal error -> touches last_error and rethrows (counts as a real job failure)', async () => {
  const { queueFor, added } = fakeQueue();
  const touched = [];
  const mod = { name: 'gamefaqs', fetchOne: async () => { throw new Error('boom'); } };
  const runSourceJob = createRunSourceJob({
    ctxForSource: new Map(),
    defaultCtx: {},
    isPaused: async () => false,
    touchSourceState: async (source, fields) => touched.push({ source, fields }),
    queueFor,
    log: fakeLogger(),
  });

  await assert.rejects(() => runSourceJob(mod, job('fetch', { gameId: 1 })), /boom/);
  assert.equal(touched.length, 1);
  assert.equal(touched[0].fields.last_error, 'boom');
  assert.equal(added.length, 0); // not requeued — this is a real failure, BullMQ's own retry/backoff applies
});

// --- EPROXY_UNAVAILABLE: egress offline, not a source failure --------------

function proxyUnavailableError(message = 'proxy down') {
  const err = new Error(message);
  err.code = 'EPROXY_UNAVAILABLE';
  return err;
}

test('createRunSourceJob: EPROXY_UNAVAILABLE -> requeues delayed (same mechanism as paused), does not throw, does not touch last_error', async () => {
  const { queueFor, added } = fakeQueue();
  const touched = [];
  const mod = { name: 'gamefaqs', fetchOne: async () => { throw proxyUnavailableError(); } };
  const runSourceJob = createRunSourceJob({
    ctxForSource: new Map(),
    defaultCtx: {},
    isPaused: async () => false,
    touchSourceState: async (source, fields) => touched.push({ source, fields }),
    queueFor,
    log: fakeLogger(),
  });

  const result = await runSourceJob(mod, job('fetch', { gameId: 1 }));
  assert.deepEqual(result, { skipped: true, reason: 'egress-proxy-offline' });
  assert.equal(touched.length, 0); // not counted as a failure, source_state untouched
  assert.equal(added.length, 1);
  assert.equal(added[0].source, 'gamefaqs');
  assert.equal(added[0].jobName, 'fetch');
  assert.deepEqual(added[0].data, { gameId: 1 });
  assert.equal(added[0].opts.delay, PAUSED_REQUEUE_DELAY_MS);
});

test('createRunSourceJob: EPROXY_UNAVAILABLE also applies to discover() jobs', async () => {
  const { queueFor, added } = fakeQueue();
  const mod = { name: 'gamefaqs', discover: async () => { throw proxyUnavailableError(); } };
  const runSourceJob = createRunSourceJob({
    ctxForSource: new Map(),
    defaultCtx: {},
    isPaused: async () => false,
    touchSourceState: async () => { throw new Error('must not be called'); },
    queueFor,
    log: fakeLogger(),
  });

  const result = await runSourceJob(mod, job('discover'));
  assert.deepEqual(result, { skipped: true, reason: 'egress-proxy-offline' });
  assert.equal(added.length, 1);
  assert.equal(added[0].jobName, 'discover');
});

test('createRunSourceJob: EPROXY_UNAVAILABLE logs at most once per egressLogIntervalMs, across many jobs', async () => {
  const { queueFor } = fakeQueue();
  const logger = fakeLogger();
  const mod = { name: 'gamefaqs', fetchOne: async () => { throw proxyUnavailableError(); } };
  let clock = 1_000_000;
  const runSourceJob = createRunSourceJob({
    ctxForSource: new Map(),
    defaultCtx: {},
    isPaused: async () => false,
    touchSourceState: async () => {},
    queueFor,
    log: logger,
    egressLogIntervalMs: 60_000,
    now: () => clock,
  });

  await runSourceJob(mod, job('fetch', { gameId: 1 }, 'j1')); // logs (first ever)
  clock += 10_000;
  await runSourceJob(mod, job('fetch', { gameId: 2 }, 'j2')); // within the minute: no log
  clock += 10_000;
  await runSourceJob(mod, job('fetch', { gameId: 3 }, 'j3')); // still within the minute: no log
  clock += 45_000; // now 65s after the first log
  await runSourceJob(mod, job('fetch', { gameId: 4 }, 'j4')); // past the minute: logs again

  const egressLogs = logger.info_calls.filter((c) => c.msg === 'worker: egress proxy offline, requeuing');
  assert.equal(egressLogs.length, 2);
});

test('createRunSourceJob: falls back to defaultCtx when a source has no entry in ctxForSource', async () => {
  const { queueFor } = fakeQueue();
  const defaultCtx = { marker: 'default' };
  let seenCtx;
  const mod = { name: 'gog', fetchOne: async (ctx) => { seenCtx = ctx; return {}; } };
  const runSourceJob = createRunSourceJob({
    ctxForSource: new Map(), // empty — gog isn't proxied
    defaultCtx,
    isPaused: async () => false,
    touchSourceState: async () => {},
    queueFor,
    log: fakeLogger(),
  });
  await runSourceJob(mod, job('fetch', { gameId: 1 }));
  assert.equal(seenCtx, defaultCtx);
});

test('module: exports the shared requeue delay and log-interval constants used elsewhere', () => {
  assert.equal(PAUSED_REQUEUE_DELAY_MS, 10 * 60 * 1000);
  assert.equal(EGRESS_OFFLINE_LOG_INTERVAL_MS, 60 * 1000);
});

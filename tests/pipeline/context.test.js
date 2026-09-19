import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createContext, buildCtxForSources } from '../../src/pipeline/context.js';

function fakeDb() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push([sql, params]); return { affectedRows: 1 }; } };
}

test('createContext: exposes every dependency plus bound upsertRecord/upsertLink', async () => {
  const db = fakeDb();
  const http = { getText: async () => 'x' };
  const ctx = createContext({ db, http, log: console, env: {}, config: {}, enqueue: async () => {}, enqueueResolve: async () => {} });

  assert.equal(ctx.db, db);
  assert.equal(ctx.http, http);
  await ctx.upsertRecord('gamefaqs', '123', { status: 'ok', gameId: 1 });
  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0][1], ['gamefaqs', '123', 1, 'ok', null, null]);
});

// --- buildCtxForSources: per-source proxy wrapping --------------------------

test('buildCtxForSources: a source with config.sources.<name>.proxy set gets its own ctx with a proxy-wrapped http', () => {
  const defaultCtx = { http: { getText: async () => {} }, marker: 'default' };
  const config = { sources: { gamefaqs: { proxy: 'http://127.0.0.1:8118' }, gog: {} } };
  const sourceModules = [{ name: 'gamefaqs' }, { name: 'gog' }, { name: 'hltb' }];

  const seenCalls = [];
  const http = {
    getText: async (url, opts) => { seenCalls.push(['getText', url, opts]); },
    getJson: async () => {},
    postJson: async () => {},
    postText: async () => {},
  };

  const ctxForSource = buildCtxForSources(sourceModules, {
    defaultCtx,
    db: { query: async () => {} },
    http,
    log: console,
    env: {},
    config,
    enqueue: async () => {},
    enqueueResolve: async () => {},
  });

  // Unconfigured sources share the exact same ctx object — no extra allocation.
  assert.equal(ctxForSource.get('gog'), defaultCtx);
  assert.equal(ctxForSource.get('hltb'), defaultCtx);

  // The configured source gets its own ctx, distinct from defaultCtx, whose http auto-applies the proxy.
  const gamefaqsCtx = ctxForSource.get('gamefaqs');
  assert.notEqual(gamefaqsCtx, defaultCtx);
  assert.notEqual(gamefaqsCtx.http, http);
});

test('buildCtxForSources: the wrapped ctx.http carries the configured proxy on every call, with no per-call change', async () => {
  const seenOpts = [];
  const http = {
    getText: async (url, opts) => { seenOpts.push(opts); return 'html'; },
    getJson: async (url, opts) => { seenOpts.push(opts); return {}; },
    postJson: async () => {},
    postText: async () => {},
  };
  const config = { sources: { gamefaqs: { proxy: 'http://127.0.0.1:8118' } } };
  const ctxForSource = buildCtxForSources([{ name: 'gamefaqs' }], {
    defaultCtx: { http },
    db: {},
    http,
    log: console,
    env: {},
    config,
    enqueue: async () => {},
    enqueueResolve: async () => {},
  });

  const gamefaqsCtx = ctxForSource.get('gamefaqs');
  await gamefaqsCtx.http.getText('https://gamefaqs.gamespot.com/x');
  await gamefaqsCtx.http.getJson('https://gamefaqs.gamespot.com/ajax/y');

  assert.equal(seenOpts[0].proxy, 'http://127.0.0.1:8118');
  assert.equal(seenOpts[1].proxy, 'http://127.0.0.1:8118');
});

test('buildCtxForSources: no proxy configured anywhere -> every source maps to defaultCtx', () => {
  const defaultCtx = { marker: 'default' };
  const ctxForSource = buildCtxForSources([{ name: 'gog' }, { name: 'hltb' }], {
    defaultCtx,
    db: {},
    http: {},
    log: console,
    env: {},
    config: { sources: {} },
    enqueue: async () => {},
    enqueueResolve: async () => {},
  });
  assert.equal(ctxForSource.get('gog'), defaultCtx);
  assert.equal(ctxForSource.get('hltb'), defaultCtx);
});

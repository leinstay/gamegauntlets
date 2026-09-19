import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createContext, buildCtxForSources, upsertRecord, upsertLink } from '../../src/pipeline/context.js';

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

// --- upsertLink/upsertRecord: a deleted game's FK failure must not throw ---

function fkError() {
  const err = new Error(
    "Cannot add or update a child row: a foreign key constraint fails (`gg`.`game_links`, CONSTRAINT `fk_links_game` FOREIGN KEY (`game_id`) REFERENCES `games` (`id`) ON DELETE CASCADE)",
  );
  err.errno = 1452;
  err.code = 'ER_NO_REFERENCED_ROW_2';
  return err;
}

function fakeDbFailingLink() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push([sql, params]);
      if (/INSERT INTO game_links/.test(sql)) throw fkError();
      return { affectedRows: 1 };
    },
  };
}

test('upsertLink: FK failure (game deleted between enqueue and fetch) does not throw — returns a skipped result', async () => {
  const db = fakeDbFailingLink();
  const infoLogs = [];
  const result = await upsertLink(db, 999, 'gog', 'ext-1', { method: 'store' }, { info: (msg, meta) => infoLogs.push({ msg, meta }) });

  assert.deepEqual(result, { status: 'skipped', reason: 'game-gone' });
  assert.equal(infoLogs.length, 1);
  assert.equal(infoLogs[0].meta.gameId, 999);
});

test('upsertLink: FK failure nulls out the matching source_records.game_id (so it never keeps pointing at a deleted game)', async () => {
  const db = fakeDbFailingLink();
  await upsertLink(db, 999, 'gog', 'ext-1', {});

  const nullingCall = db.calls.find(([sql]) => /UPDATE source_records SET game_id = NULL/.test(sql));
  assert.ok(nullingCall, 'expected an UPDATE clearing the stale game_id');
  assert.deepEqual(nullingCall[1], ['gog', 'ext-1', 999]);
});

test('upsertLink: a non-FK error still throws (not swallowed)', async () => {
  const db = { query: async () => { throw new Error('connection reset'); } };
  await assert.rejects(() => upsertLink(db, 1, 'gog', 'ext-1', {}), /connection reset/);
});

test('createContext: ctx.upsertLink is wired through the same FK-tolerant behavior', async () => {
  const db = fakeDbFailingLink();
  const ctx = createContext({ db, http: {}, log: { info: () => {} }, env: {}, config: {}, enqueue: async () => {}, enqueueResolve: async () => {} });
  const result = await ctx.upsertLink(999, 'gog', 'ext-1', {});
  assert.deepEqual(result, { status: 'skipped', reason: 'game-gone' });
});

test('upsertRecord: an FK failure on the record itself (defensive - source_records has no FK today) retries with game_id = NULL instead of throwing', async () => {
  const calls = [];
  let attempt = 0;
  const db = {
    query: async (sql, params) => {
      calls.push([sql, params]);
      if (/INSERT INTO source_records/.test(sql)) {
        attempt += 1;
        if (attempt === 1) throw fkError();
      }
      return { affectedRows: 1 };
    },
  };
  const result = await upsertRecord(db, 'gog', 'ext-1', { status: 'ok', gameId: 999 });
  assert.deepEqual(result, { affectedRows: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1][2], null); // second attempt's game_id param is null
});

test('upsertRecord: a non-FK error still throws', async () => {
  const db = { query: async () => { throw new Error('deadlock'); } };
  await assert.rejects(() => upsertRecord(db, 'gog', 'ext-1', { gameId: 1 }), /deadlock/);
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

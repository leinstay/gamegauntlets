import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveWorkerSources } from '../../src/lib/worker-sources.js';

const ALL = ['gamefaqs', 'gog', 'hltb', 'igdb', 'steam', 'steamspy'];

function warnCollector() {
  const calls = [];
  return { warn: (msg, meta) => calls.push({ msg, meta }), calls };
}

// --- both unset: today's behaviour, unchanged --------------------------

test('resolveWorkerSources: both unset -> mode "all", every source, in order', () => {
  const { warn, calls } = warnCollector();
  const result = resolveWorkerSources({}, ALL, { warn });
  assert.deepEqual(result, { mode: 'all', names: ALL });
  assert.equal(calls.length, 0);
});

test('resolveWorkerSources: default warn is a no-op (no options object needed)', () => {
  assert.deepEqual(resolveWorkerSources({}, ALL), { mode: 'all', names: ALL });
});

// --- WORKER_SOURCES ("only" mode) ---------------------------------------

test('resolveWorkerSources: WORKER_SOURCES selects only the listed sources, in registry order', () => {
  const result = resolveWorkerSources({ WORKER_SOURCES: 'hltb,gamefaqs' }, ALL);
  assert.deepEqual(result, { mode: 'only', names: ['gamefaqs', 'hltb'] });
});

test('resolveWorkerSources: WORKER_SOURCES trims whitespace around names', () => {
  const result = resolveWorkerSources({ WORKER_SOURCES: ' gamefaqs , hltb ' }, ALL);
  assert.deepEqual(result, { mode: 'only', names: ['gamefaqs', 'hltb'] });
});

test('resolveWorkerSources: WORKER_SOURCES matches names case-insensitively', () => {
  const result = resolveWorkerSources({ WORKER_SOURCES: 'GameFAQs,HLTB' }, ALL);
  assert.deepEqual(result, { mode: 'only', names: ['gamefaqs', 'hltb'] });
});

test('resolveWorkerSources: WORKER_SOURCES drops duplicate/empty entries', () => {
  const result = resolveWorkerSources({ WORKER_SOURCES: 'gamefaqs,,gamefaqs,' }, ALL);
  assert.deepEqual(result, { mode: 'only', names: ['gamefaqs'] });
});

// --- WORKER_EXCLUDE_SOURCES ("exclude" mode) ----------------------------

test('resolveWorkerSources: WORKER_EXCLUDE_SOURCES runs everything except the listed sources', () => {
  const result = resolveWorkerSources({ WORKER_EXCLUDE_SOURCES: 'gamefaqs' }, ALL);
  assert.deepEqual(result, { mode: 'exclude', names: ['gog', 'hltb', 'igdb', 'steam', 'steamspy'] });
});

test('resolveWorkerSources: WORKER_EXCLUDE_SOURCES is case/whitespace-insensitive too', () => {
  const result = resolveWorkerSources({ WORKER_EXCLUDE_SOURCES: ' GameFAQs ' }, ALL);
  assert.deepEqual(result, { mode: 'exclude', names: ['gog', 'hltb', 'igdb', 'steam', 'steamspy'] });
});

// --- unknown names -------------------------------------------------------

test('resolveWorkerSources: unknown name in WORKER_SOURCES is warned about and ignored', () => {
  const { warn, calls } = warnCollector();
  const result = resolveWorkerSources({ WORKER_SOURCES: 'gamefaqs,not-a-source' }, ALL, { warn });
  assert.deepEqual(result, { mode: 'only', names: ['gamefaqs'] });
  assert.equal(calls.length, 1);
  assert.match(calls[0].msg, /unknown source "not-a-source"/);
  assert.deepEqual(calls[0].meta, { name: 'not-a-source' });
});

test('resolveWorkerSources: unknown name in WORKER_EXCLUDE_SOURCES is warned about and ignored', () => {
  const { warn, calls } = warnCollector();
  const result = resolveWorkerSources({ WORKER_EXCLUDE_SOURCES: 'not-a-source' }, ALL, { warn });
  assert.deepEqual(result, { mode: 'exclude', names: ALL });
  assert.equal(calls.length, 1);
  assert.match(calls[0].msg, /unknown source "not-a-source"/);
});

test('resolveWorkerSources: WORKER_SOURCES made entirely of unknown names yields an empty "only" selection', () => {
  const result = resolveWorkerSources({ WORKER_SOURCES: 'nope' }, ALL, { warn: () => {} });
  assert.deepEqual(result, { mode: 'only', names: [] });
});

// --- both set: WORKER_SOURCES wins, with a warning ----------------------

test('resolveWorkerSources: both set -> WORKER_SOURCES wins and a warning is reported', () => {
  const { warn, calls } = warnCollector();
  const result = resolveWorkerSources(
    { WORKER_SOURCES: 'gamefaqs', WORKER_EXCLUDE_SOURCES: 'hltb' },
    ALL,
    { warn },
  );
  assert.deepEqual(result, { mode: 'only', names: ['gamefaqs'] });
  assert.equal(calls.length, 1);
  assert.match(calls[0].msg, /both WORKER_SOURCES and WORKER_EXCLUDE_SOURCES set/);
  assert.deepEqual(calls[0].meta, { WORKER_SOURCES: 'gamefaqs', WORKER_EXCLUDE_SOURCES: 'hltb' });
});

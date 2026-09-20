// tests/frontend/pio-engine.test.js — exercises public/js/pio/pio.js's v2 scheduling rules (priorities, the
// global/hover gaps, the settings-page pending-event queue, and the session spin/winner bookkeeping) that sit
// on top of the pure dialogue.js engine already covered by tests/pio-dialogue.test.mjs. Uses the same minimal
// fake DOM approach as tests/frontend/pio-language-fallback.test.js (no real browser/PIXI available here),
// extended with a working classList (Set-backed, so assertions on "is a bubble showing" are meaningful) and a
// fake sessionStorage/localStorage (Map-backed) so the sessionStorage-driven counters/queue can be exercised.
//
// Timing notes: dialogue.js/pio.js's gap constants (1.2s global, 8s hover, 25s ambient, 45s+ idle tiers) are
// hardcoded, not injectable, so only the FAST-to-verify rules are exercised here with real (short) waits; the
// long-window ones (hover 8s throttle, ambient 25s/90-150s, idle tiers, tab:return 20s) are reviewed by reading
// the code instead — flagged for a human/browser sanity check in the implementer report.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeClassList(el) {
  const classes = new Set();
  return {
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    toggle: (c, force) => (force == null ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : force ? classes.add(c) : classes.delete(c)),
    contains: (c) => classes.has(c),
  };
}

function fakeElement() {
  const el = {
    className: '',
    textContent: '',
    innerHTML: '',
    style: {},
    children: [],
    parentElement: null,
    parentNode: null,
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      el.children.push(child);
      child.parentElement = el;
      child.parentNode = el;
      return child;
    },
  };
  el.classList = fakeClassList(el);
  return el;
}

function fakeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

function installFakeDom() {
  const listeners = new Map(); // event -> Set<fn>, so the (unused-by-these-tests) document-level listeners don't throw
  globalThis.window = {
    localStorage: fakeStorage(),
    sessionStorage: fakeStorage(),
    devicePixelRatio: 1,
  };
  globalThis.document = {
    createElement: () => fakeElement(),
    querySelector: () => fakeElement(),
    body: fakeElement(),
    visibilityState: 'visible',
    addEventListener(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    removeEventListener(event, fn) {
      if (listeners.has(event)) listeners.get(event).delete(fn);
    },
  };
  // No PIXI global: createPio()'s init() stops right after resolving the dialogue language/pending-event
  // queue, same cutoff point tests/frontend/pio-language-fallback.test.js relies on. Crucially, the
  // priority/gap/idle/ambient/click-spam/konami/copy wiring all happens OUTSIDE that PIXI-gated branch (see
  // pio.js), so it's exercised here too.
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await sleep(0);
}

/** Builds a pio instance with an inspectable container (so the dialog bubble's DOM state is observable). */
async function buildPio(pools) {
  installFakeDom();
  const container = fakeElement();
  const { createPio } = await import('../../public/js/pio/pio.js');
  const pio = createPio({ modelUrl: 'x', lang: 'en', dialogues: { en: pools }, container });
  await flushMicrotasks();
  // buildDom() appends canvas, dialog, toggle (in that order) to the container; dialog's only child is dialogText.
  const dialogEl = container.children[1];
  const dialogText = dialogEl.children[0];
  return { pio, dialogEl, dialogText };
}

test('emit(): a bubble right after another is dropped (global 1.2s gap)', async () => {
  const { pio } = await buildPio({ empty: [{ text: 'a' }], idle: [{ text: 'b' }] });
  const first = pio.emit('empty', {});
  assert.ok(first);
  const second = pio.emit('idle', {}); // ~0ms later -- well within the 1.2s gap
  assert.equal(second, null);
  pio.destroy();
});

test('emit(): once the gap has passed, a LOW priority event still never interrupts a bubble that is showing, but a NORMAL one does', async () => {
  const { pio } = await buildPio({
    empty: [{ text: 'high priority, shows for a while' }],
    idle: [{ text: 'low, should be dropped' }],
    'click:head': [{ text: 'normal, should interrupt' }],
  });
  assert.ok(pio.emit('empty', {})); // HIGH priority -- bubble now showing for >=3s
  await sleep(1300); // past the 1.2s global gap, but still well within the >=3s bubble display time
  assert.equal(pio.emit('idle', {}), null); // LOW: dropped, doesn't interrupt
  assert.ok(pio.emit('click:head', {})); // NORMAL: interrupts
  pio.destroy();
});

test('emit(): "spin:start" bumps the session spin counter and flags 5/10/25/50 milestones (sessionStorage)', async () => {
  const { pio } = await buildPio({ 'spin:start': [{ text: 'go' }] });
  for (let i = 0; i < 5; i++) pio.emit('spin:start', {});
  assert.equal(window.sessionStorage.getItem('pio.spins'), '5');
  assert.deepEqual(JSON.parse(window.sessionStorage.getItem('pio.spinMilestones')), [5]);
  pio.destroy();
});

test('emit(): "spin:end" tracks winners across calls (repeat game / same-genre-3x bookkeeping)', async () => {
  const { pio } = await buildPio({ 'spin:end': [{ text: 'won' }] });
  pio.emit('spin:end', { game: 'Portal', genre: 'Puzzle' });
  pio.emit('spin:end', { game: 'Portal', genre: 'Puzzle' });
  const winners = JSON.parse(window.sessionStorage.getItem('pio.winners'));
  assert.deepEqual(winners.names.slice(0, 2), ['Portal', 'Portal']);
  assert.deepEqual(winners.genres, ['Puzzle', 'Puzzle']);
  pio.destroy();
});

test('settings-page pending event: a queued sessionStorage entry is played once, right after mount', async () => {
  installFakeDom();
  window.sessionStorage.setItem('pio.pendingEvent', JSON.stringify({ event: 'settings:change', context: {}, ts: Date.now() }));
  const container = fakeElement();
  const { createPio } = await import('../../public/js/pio/pio.js');
  const pio = createPio({ modelUrl: 'x', lang: 'en', dialogues: { en: { 'settings:change': [{ text: 'reacted' }] } }, container });
  await flushMicrotasks();
  await sleep(250); // 'reacted' is 7 chars * 24ms/char =~168ms to finish typing
  const dialogEl = container.children[1];
  const dialogText = dialogEl.children[0];
  assert.equal(dialogText.textContent, 'reacted');
  assert.equal(dialogEl.classList.contains('pio-dialog-active'), true);
  assert.equal(window.sessionStorage.getItem('pio.pendingEvent'), null); // consumed, not replayed on a 2nd mount
  pio.destroy();
});

test('settings-page pending event: a stale (>2min old) entry is dropped, not played', async () => {
  installFakeDom();
  window.sessionStorage.setItem('pio.pendingEvent', JSON.stringify({ event: 'settings:change', context: {}, ts: Date.now() - 3 * 60 * 1000 }));
  const container = fakeElement();
  const { createPio } = await import('../../public/js/pio/pio.js');
  const pio = createPio({ modelUrl: 'x', lang: 'en', dialogues: { en: { 'settings:change': [{ text: 'reacted' }] } }, container });
  await flushMicrotasks();
  await sleep(250);
  const dialogEl = container.children[1];
  const dialogText = dialogEl.children[0];
  assert.equal(dialogText.textContent, '');
  assert.equal(dialogEl.classList.contains('pio-dialog-active'), false);
  pio.destroy();
});

test('destroy(): clears every timer it owns (process/test exits promptly instead of hanging on ambient/idle timers)', async () => {
  const { pio } = await buildPio({ load: [{ text: 'hi' }] });
  pio.emit('load', {});
  pio.destroy();
  // No explicit assertion needed beyond "this test (and the process) doesn't hang" -- ambient alone is
  // scheduled 90-150s out, idle:veryLong 10min out; if destroy() didn't clear them, `node --test` would
  // keep the process alive waiting for those timers to fire.
  assert.ok(true);
});

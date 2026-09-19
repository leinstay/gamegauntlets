// tests/frontend/pio-language-fallback.test.js — public/pio/dialogues/ only ships en/ru/de/fr.json
// (owner decision, no new dialogue files); every UI language public/i18n/*.json now supports beyond
// those four (es/pt/it/pl/tr/uk/ja/ko/zh) must make Pio fall back to the English dialogue pool
// instead of silently never speaking. Exercises public/js/pio/pio.js's createPio() up to the point
// where it notices PIXI isn't loaded and stops (this file has no browser/PIXI available), which is
// far enough to prove ensurePoolWithFallback()'s language-resolution logic runs correctly — with a
// minimal fake `document`/`window` since pio.js is written for a real DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeElement() {
  const el = {
    className: '',
    textContent: '',
    style: {},
    children: [],
    parentElement: null,
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) {
      el.children.push(child);
      child.parentElement = el;
      return child;
    },
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
  };
  return el;
}

function installFakeDom() {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    devicePixelRatio: 1,
  };
  globalThis.document = {
    createElement: () => fakeElement(),
    querySelector: () => fakeElement(),
    body: fakeElement(),
    addEventListener() {},
    removeEventListener() {},
  };
  // Deliberately no global PIXI -- createPio()'s init() detects that and stops right after resolving
  // the dialogue language, which is exactly the part under test here.
}

async function flushMicrotasks() {
  // ensurePoolWithFallback() awaits ensurePool() (a fetch + json parse, both promise-based) twice in
  // the worst case; a couple of microtask/macrotask turns is enough for init()'s fire-and-forget call
  // to settle before assertions run.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

test('createPio(): falls back to the English dialogue pool for a language with no dialogue file', async () => {
  installFakeDom();
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    const lang = String(url).match(/\/(\w+)\.json$/)[1];
    if (lang === 'en') return { ok: true, json: async () => ({ load: ['Hello!'] }) };
    return { ok: false, json: async () => ({}) }; // ja.json (and every other new language) doesn't exist
  };

  const { createPio } = await import('../../public/js/pio/pio.js');
  const pio = createPio({ modelUrl: 'pio/models/neptune/model.json', lang: 'ja', dialogues: 'pio/dialogues' });
  await flushMicrotasks();

  // Both the requested (missing) language and the English fallback were attempted...
  assert.ok(requested.some((u) => u.endsWith('/ja.json')));
  assert.ok(requested.some((u) => u.endsWith('/en.json')));
  // ...and emit() (which reads the dialogue engine's *current* language pool) now finds the English
  // phrase instead of finding nothing because the engine was left on a poolless "ja".
  const picked = pio.emit('load', {});
  assert.equal(picked && picked.text, 'Hello!');

  pio.destroy();
});

test('createPio(): a language with its own dialogue file never touches the English fallback', async () => {
  installFakeDom();
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    if (String(url).endsWith('/ru.json')) return { ok: true, json: async () => ({ load: ['Привет!'] }) };
    return { ok: false, json: async () => ({}) };
  };

  const { createPio } = await import('../../public/js/pio/pio.js');
  const pio = createPio({ modelUrl: 'pio/models/neptune/model.json', lang: 'ru', dialogues: 'pio/dialogues' });
  await flushMicrotasks();

  assert.ok(requested.some((u) => u.endsWith('/ru.json')));
  assert.ok(!requested.some((u) => u.endsWith('/en.json')));
  assert.equal(pio.emit('load', {}).text, 'Привет!');

  pio.destroy();
});

test('createPio(): setLanguage() to an unsupported language also falls back to English at runtime', async () => {
  installFakeDom();
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/en.json')) return { ok: true, json: async () => ({ load: ['Hello again!'] }) };
    return { ok: false, json: async () => ({}) };
  };

  const { createPio } = await import('../../public/js/pio/pio.js');
  const pio = createPio({ modelUrl: 'pio/models/neptune/model.json', lang: 'en', dialogues: 'pio/dialogues' });
  await flushMicrotasks();

  await pio.setLanguage('ko'); // no ko.json -- must not leave the engine stuck on a poolless "ko"
  assert.equal(pio.emit('load', {}).text, 'Hello again!');

  pio.destroy();
});

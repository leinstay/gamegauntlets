import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SUPPORTED,
  normalizeLang,
  dataLang,
  parseAcceptLanguage,
  pickLanguageFromAcceptHeader,
  languageDisplayName,
  listLanguages,
} from '../../src/lib/languages.js';

test('SUPPORTED matches config.json\'s default site.languages set (single source of truth)', async () => {
  const { config } = await import('../../src/config.js');
  assert.deepEqual([...config.site.languages].sort(), [...SUPPORTED].sort());
});

test('normalizeLang: exact matches pass through unchanged (case-insensitive)', () => {
  assert.equal(normalizeLang('en'), 'en');
  assert.equal(normalizeLang('RU'), 'ru');
  assert.equal(normalizeLang(' de '), 'de');
});

test('normalizeLang: region/script subtags reduce to their base language', () => {
  assert.equal(normalizeLang('en-US'), 'en');
  assert.equal(normalizeLang('de-DE'), 'de');
  assert.equal(normalizeLang('pt-BR'), 'pt');
  assert.equal(normalizeLang('pt-PT'), 'pt');
  assert.equal(normalizeLang('zh-CN'), 'zh');
  assert.equal(normalizeLang('zh-TW'), 'zh');
  assert.equal(normalizeLang('zh-Hans'), 'zh');
  assert.equal(normalizeLang('zh-Hant-HK'), 'zh');
});

test('normalizeLang: unsupported/garbage input is null', () => {
  assert.equal(normalizeLang('garbage'), null);
  assert.equal(normalizeLang('xx-XX'), null);
  assert.equal(normalizeLang('*'), null);
  assert.equal(normalizeLang(''), null);
  assert.equal(normalizeLang(null), null);
  assert.equal(normalizeLang(undefined), null);
});

test('dataLang: only "ru" reads Russian game data, every other UI language reads English', () => {
  assert.equal(dataLang('ru'), 'ru');
  for (const lang of SUPPORTED.filter((l) => l !== 'ru')) {
    assert.equal(dataLang(lang), 'en');
  }
});

test('parseAcceptLanguage: orders tags by descending q-value, defaulting missing q to 1', () => {
  assert.deepEqual(parseAcceptLanguage('ja,en-US;q=0.9'), ['ja', 'en-US']);
  assert.deepEqual(parseAcceptLanguage('en-US;q=0.5,ja;q=0.9,de;q=0.9'), ['ja', 'de', 'en-US']);
  assert.deepEqual(parseAcceptLanguage(''), []);
  assert.deepEqual(parseAcceptLanguage(undefined), []);
});

test('pickLanguageFromAcceptHeader: first supported match wins, in q-value order', () => {
  assert.equal(pickLanguageFromAcceptHeader('ja,en-US;q=0.9'), 'ja');
  assert.equal(pickLanguageFromAcceptHeader('zh-TW,pt-BR;q=0.5'), 'zh');
  assert.equal(pickLanguageFromAcceptHeader('xx-XX,garbage;q=0.5'), null);
  assert.equal(pickLanguageFromAcceptHeader(''), null);
});

test('pickLanguageFromAcceptHeader: only matches languages in the given `allowed` list', () => {
  assert.equal(pickLanguageFromAcceptHeader('ja,en;q=0.9', ['en', 'ru']), 'en');
});

test('languageDisplayName: native name alone when it equals the English name, "(English)" otherwise', () => {
  assert.equal(languageDisplayName('en'), 'English');
  assert.equal(languageDisplayName('de'), 'Deutsch (German)');
  assert.equal(languageDisplayName('ja'), '日本語 (Japanese)');
  assert.equal(languageDisplayName('ru'), 'Русский (Russian)');
});

test('listLanguages: {code, name} for every SUPPORTED language, in order, by default', () => {
  const list = listLanguages();
  assert.deepEqual(list.map((l) => l.code), SUPPORTED);
  assert.ok(list.every((l) => typeof l.name === 'string' && l.name.length > 0));
});

test('listLanguages: honors a custom (e.g. config-restricted) code list and order', () => {
  assert.deepEqual(listLanguages(['fr', 'en']), [
    { code: 'fr', name: 'Français (French)' },
    { code: 'en', name: 'English' },
  ]);
});

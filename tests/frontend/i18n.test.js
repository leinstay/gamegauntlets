// tests/frontend/i18n.test.js — every public/i18n/<lang>.json file must carry exactly the same key
// set (same keys, same order) as en.json (the reference dictionary GG.i18n.load() falls back to
// missing keys against — see public/js/gg-i18n.js), and every {placeholder} used in an English
// string must appear, verbatim, in every translation of that string (gg-i18n.js does plain string
// substitution, it doesn't know which placeholders exist).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const I18N_DIR = path.join(__dirname, '../../public/i18n');

const EN = JSON.parse(fs.readFileSync(path.join(I18N_DIR, 'en.json'), 'utf8'));
const EN_KEYS = Object.keys(EN);

function otherLanguageFiles() {
  return fs
    .readdirSync(I18N_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'en.json');
}

function placeholders(value) {
  return (String(value).match(/\{\w+\}/g) || []).sort();
}

test('public/i18n: every language file exists and is valid JSON', () => {
  const files = otherLanguageFiles();
  assert.ok(files.length >= 12); // ru, de, fr (legacy) + es, pt, it, pl, tr, uk, ja, ko, zh
  for (const file of files) {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(I18N_DIR, file), 'utf8')), file);
  }
});

for (const file of otherLanguageFiles()) {
  const lang = file.replace(/\.json$/, '');

  test(`public/i18n/${file}: has exactly the same key set, in the same order, as en.json`, () => {
    const data = JSON.parse(fs.readFileSync(path.join(I18N_DIR, file), 'utf8'));
    assert.deepEqual(Object.keys(data), EN_KEYS);
  });

  test(`public/i18n/${file}: every {placeholder} in the English string is preserved in the translation`, () => {
    const data = JSON.parse(fs.readFileSync(path.join(I18N_DIR, file), 'utf8'));
    for (const key of EN_KEYS) {
      const expected = placeholders(key);
      if (expected.length === 0) continue;
      const actual = placeholders(data[key]);
      assert.deepEqual(actual, expected, `${lang} "${key}" -> "${data[key]}"`);
    }
  });

  test(`public/i18n/${file}: no entry is empty (falls back to the raw key, per gg-i18n.js's t())`, () => {
    const data = JSON.parse(fs.readFileSync(path.join(I18N_DIR, file), 'utf8'));
    for (const key of EN_KEYS) {
      assert.notEqual(data[key], '', `${lang} "${key}" is empty`);
      assert.notEqual(data[key], undefined, `${lang} "${key}" is missing`);
    }
  });
}

// tests/frontend/cis-region-toggle.test.js — "Use CIS region" (Goal B, owner's rule: "it only
// concerns Russian and can never be on in other languages; on switching to any language but Russian
// it turns off; off by default"). public/js/pgsettings.js and public/js/pgwheel.js are classic
// jQuery scripts with no DOM available under `node --test` (no jsdom/jQuery -- no new npm deps
// allowed), so this asserts the fix by inspecting the source for the exact statements rather than
// executing them; src/api/wheel.js's/games.js's server-side half of this rule is covered by
// tests/api/wheel.test.js and tests/api/games.test.js's "forced off" tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pgwheel = fs.readFileSync(path.join(__dirname, '../../public/js/pgwheel.js'), 'utf8');
const pgsettings = fs.readFileSync(path.join(__dirname, '../../public/js/pgsettings.js'), 'utf8');

test('pgwheel.js: backupRegion defaults to off (not on)', () => {
  assert.match(pgwheel, /sessionStorage\.getItem\("backupRegion"\) \|\| sessionStorage\.setItem\("backupRegion", !1\)/);
  assert.doesNotMatch(pgwheel, /sessionStorage\.getItem\("backupRegion"\) \|\| sessionStorage\.setItem\("backupRegion", !0\)/);
});

test('pgwheel.js: cisPricesEnabled() only returns true for lang "ru"', () => {
  assert.match(pgwheel, /function cisPricesEnabled\(\)\s*{\s*return \(!__language \|\| __language === "ru"\) && "true" == sessionStorage\.getItem\("backupRegion"\);/);
});

function resetSettingsHandlerBody(source) {
  const start = source.indexOf("$(\"#resetSettings\").on('click'");
  assert.ok(start !== -1, 'could not find the #resetSettings click handler');
  const end = source.indexOf('\n});', start);
  return source.slice(start, end);
}

test('pgsettings.js: "Reset Settings" turns the CIS toggle off, not on', () => {
  const body = resetSettingsHandlerBody(pgsettings);
  assert.match(body, /\$\('#backupRegion'\)\.checkbox\('uncheck'\)/);
  assert.match(body, /sessionStorage\.setItem\('backupRegion', false\)/);
  assert.doesNotMatch(body, /\$\('#backupRegion'\)\.checkbox\('check'\)/);
  assert.doesNotMatch(body, /sessionStorage\.setItem\('backupRegion', true\)/);
});

test('pgsettings.js: switching the language away from "ru" turns the CIS toggle off immediately', () => {
  assert.match(pgsettings, /if \(value !== 'ru'\) sessionStorage\.setItem\('backupRegion', false\);/);
});

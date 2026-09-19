// tests/frontend/gg-boot-languages.test.js — public/js/gg-boot.js keeps its own SUPPORTED_LANGS array
// (a classic script, not an ES module, so it can't import src/lib/languages.js) purely to parse the
// legacy bare "?xx" URL query shortcut before the first GET /api/session call exists to hand it the
// authoritative list. That copy must stay in sync with src/lib/languages.js's SUPPORTED by hand --
// this test is the tripwire for the two silently drifting apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED } from '../../src/lib/languages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('gg-boot.js SUPPORTED_LANGS matches src/lib/languages.js SUPPORTED', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/gg-boot.js'), 'utf8');
  const match = source.match(/var SUPPORTED_LANGS = (\[[^\]]*\]);/);
  assert.ok(match, 'could not find "var SUPPORTED_LANGS = [...]" in gg-boot.js');
  const list = JSON.parse(match[1].replace(/'/g, '"'));
  assert.deepEqual(list, SUPPORTED);
});

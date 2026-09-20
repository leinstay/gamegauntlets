// tests/frontend/pio-content.test.js — validates every public/pio/dialogues/*.json content file against the
// engine's own notion of what's valid (public/js/pio/dialogue.js's KNOWN_EVENTS/KNOWN_WHEN_KEYS/
// KNOWN_PLACEHOLDERS/MOODS), so a typo or a made-up event/condition/placeholder in hand-written dialogue
// content fails the test suite instead of silently never firing (unknown event/`when` key) or never being
// picked (unknown placeholder makes every phrase using it permanently ineligible — see dialogue.js's
// `fillable()`). Also flags empty text, phrases over 160 chars, and `text` sequences longer than 3 items
// (see public/pio/dialogues/README.md "Phrase format additions" / .claude/docs/pio-spec.md).
//
// Every failure message names the exact file/event/index so whoever is filling in content (this is expected
// to be edited a lot, by multiple people in parallel — see the README's "What's ported vs. newly written")
// can find and fix it without re-deriving which of the ~50-100 phrases per file was the problem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_EVENTS, KNOWN_WHEN_KEYS, KNOWN_PLACEHOLDERS, MOODS } from '../../public/js/pio/dialogue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIALOGUES_DIR = path.join(__dirname, '../../public/pio/dialogues');
const MAX_TEXT_CHARS = 160;
const MAX_SEQUENCE_LENGTH = 3;

const KNOWN_EVENTS_SET = new Set(KNOWN_EVENTS);
const KNOWN_WHEN_KEYS_SET = new Set(KNOWN_WHEN_KEYS);
const KNOWN_PLACEHOLDERS_SET = new Set(KNOWN_PLACEHOLDERS);
const MOODS_SET = new Set(MOODS);

function dialogueFiles() {
  return fs.readdirSync(DIALOGUES_DIR).filter((f) => f.endsWith('.json'));
}

function placeholdersIn(text) {
  return (String(text).match(/\{(\w+)\}/g) || []).map((p) => p.slice(1, -1));
}

/** One line per problem found in `file`, e.g. "en.json spin:end[3]: unknown mood 'exited'". */
function validate(file, data) {
  const problems = [];

  for (const event of Object.keys(data)) {
    if (event === '_meta') continue;

    if (!KNOWN_EVENTS_SET.has(event)) {
      problems.push(`${file} "${event}": unknown event (not in dialogue.js's KNOWN_EVENTS)`);
      continue; // nothing else meaningful to check against an event the engine doesn't know either
    }

    const list = data[event];
    if (!Array.isArray(list)) {
      problems.push(`${file} "${event}": expected an array of phrases, got ${typeof list}`);
      continue;
    }

    list.forEach((raw, index) => {
      const where = `${file} "${event}"[${index}]`;
      const entry = typeof raw === 'string' ? { text: raw } : raw;

      if (entry == null || typeof entry !== 'object') {
        problems.push(`${where}: expected a string or an object, got ${typeof entry}`);
        return;
      }

      const texts = Array.isArray(entry.text) ? entry.text : [entry.text];

      if (Array.isArray(entry.text) && entry.text.length > MAX_SEQUENCE_LENGTH) {
        problems.push(`${where}: text sequence has ${entry.text.length} items, max is ${MAX_SEQUENCE_LENGTH}`);
      }
      if (Array.isArray(entry.text) && entry.text.length === 0) {
        problems.push(`${where}: text sequence is empty`);
      }

      texts.forEach((text, textIndex) => {
        const label = Array.isArray(entry.text) ? `${where} sequence item ${textIndex}` : where;
        if (typeof text !== 'string' || text.trim() === '') {
          problems.push(`${label}: empty/non-string text`);
          return;
        }
        if (text.length > MAX_TEXT_CHARS) {
          problems.push(`${label}: text is ${text.length} chars, max is ${MAX_TEXT_CHARS} ("${text.slice(0, 40)}...")`);
        }
        for (const placeholder of placeholdersIn(text)) {
          if (!KNOWN_PLACEHOLDERS_SET.has(placeholder)) {
            problems.push(`${label}: unknown placeholder "{${placeholder}}" (not in dialogue.js's KNOWN_PLACEHOLDERS)`);
          }
        }
      });

      if (entry.mood != null && !MOODS_SET.has(entry.mood)) {
        problems.push(`${where}: unknown mood "${entry.mood}" (not in dialogue.js's MOODS)`);
      }

      if (entry.when != null) {
        if (typeof entry.when !== 'object' || Array.isArray(entry.when)) {
          problems.push(`${where}: "when" must be an object, got ${Array.isArray(entry.when) ? 'array' : typeof entry.when}`);
        } else {
          for (const key of Object.keys(entry.when)) {
            if (!KNOWN_WHEN_KEYS_SET.has(key)) {
              problems.push(`${where}: unknown "when" key "${key}" (not in dialogue.js's KNOWN_WHEN_KEYS)`);
            }
          }
        }
      }

      if (entry.weight != null && typeof entry.weight !== 'number') {
        problems.push(`${where}: "weight" must be a number, got ${typeof entry.weight}`);
      }
      if (entry.once != null && typeof entry.once !== 'boolean') {
        problems.push(`${where}: "once" must be a boolean, got ${typeof entry.once}`);
      }
    });
  }

  return problems;
}

test('public/pio/dialogues: every *.json file exists and is valid JSON', () => {
  const files = dialogueFiles();
  assert.deepEqual(files.sort(), ['de.json', 'en.json', 'fr.json', 'ru.json']);
  for (const file of files) {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(DIALOGUES_DIR, file), 'utf8')), file);
  }
});

for (const file of dialogueFiles()) {
  test(`public/pio/dialogues/${file}: no unknown events/when-keys/placeholders/moods, no empty/oversized/overlong-sequence text`, () => {
    const data = JSON.parse(fs.readFileSync(path.join(DIALOGUES_DIR, file), 'utf8'));
    const problems = validate(file, data);
    assert.deepEqual(problems, []);
  });
}

test('public/pio/dialogues: hover:gabestore was renamed to hover:gog everywhere', () => {
  for (const file of dialogueFiles()) {
    const data = JSON.parse(fs.readFileSync(path.join(DIALOGUES_DIR, file), 'utf8'));
    assert.ok(!('hover:gabestore' in data), `${file} still has the old "hover:gabestore" key`);
  }
});

test('public/pio/dialogues/en.json: every KNOWN_EVENTS entry either has phrases or is the known-inert hover:donations', () => {
  const en = JSON.parse(fs.readFileSync(path.join(DIALOGUES_DIR, 'en.json'), 'utf8'));
  const missing = KNOWN_EVENTS.filter((event) => !Array.isArray(en[event]) || en[event].length === 0);
  // hover:donations: UI removed per the rewrite spec, nothing fires it -- kept in the pool for data
  // completeness only (see README.md), so it's the one known exception that's allowed to be absent/empty.
  assert.deepEqual(missing.filter((e) => e !== 'hover:donations'), []);
});

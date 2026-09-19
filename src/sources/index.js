// Source module registry: dynamically imports every `src/sources/<name>.js`
// file (one module per data source: steam, gog, hltb, igdb, ...) except this
// file itself and `_template.js`. Tolerates zero source modules existing yet
// (returns an empty list) so the queue/worker can be built and tested before
// any source is written.
//
// Discovery is split into a pure, synchronous `listSourceFiles` (easy to
// unit-test against a temp directory) and an async `loadSources` that
// actually imports the files.
//
// A module may export `extractOnly = true` (e.g. `legacy_steamdb.js`, the
// frozen legacy snapshot: no `discover`/`fetchOne`, nothing ever enqueues a
// fetch job for it) instead of `fetchOne`. Such modules only ever supply
// `extract()` for src/pipeline/resolve.js to run over `source_records`
// already in the database — `sources` (consumed by worker.js/queue.js to
// start a BullMQ Worker/queue and to schedule discover jobs) excludes them,
// while `getSource()` (consumed by the resolve pipeline) still finds them via
// the internal `allSources` superset.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { log } from '../log.js';

export const SOURCES_DIR = path.dirname(fileURLToPath(import.meta.url));

const EXCLUDED_FILES = new Set(['index.js', '_template.js']);

/**
 * List candidate source module filenames in `dir` (default: this
 * directory), sorted: every `*.js` file except `index.js` and
 * `_template.js`. Pure and synchronous. A missing directory yields `[]`
 * rather than throwing.
 */
export function listSourceFiles(dir = SOURCES_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.js') && !EXCLUDED_FILES.has(file))
    .sort();
}

/**
 * Dynamically import every source module file in `dir`. A normal module must
 * export `name` and `fetchOne` (per the source module interface); an
 * extract-only module (`extractOnly = true`) must export `name` and
 * `extract` instead. Anything else is skipped with a warning so one
 * broken/incomplete file doesn't take down the whole registry. Returns the
 * modules in filename order.
 */
export async function loadSources(dir = SOURCES_DIR) {
  const modules = [];
  for (const file of listSourceFiles(dir)) {
    const url = pathToFileURL(path.join(dir, file)).href;
    try {
      const mod = await import(url);
      if (mod.extractOnly) {
        if (!mod.name || typeof mod.extract !== 'function') {
          log.warn('sources: skipping extract-only module missing name/extract', { file });
          continue;
        }
        modules.push(mod);
        continue;
      }
      if (!mod.name || typeof mod.fetchOne !== 'function') {
        log.warn('sources: skipping module missing name/fetchOne', { file });
        continue;
      }
      modules.push(mod);
    } catch (err) {
      log.error('sources: failed to load module', { file, error: err });
    }
  }
  return modules;
}

// Loaded once at import time for the common case (worker.js, run-source.js,
// queue.js callers): `import { sources, getSource } from './sources/index.js'`.
// `allSources` is the full registry (including extract-only modules);
// `sources` is the subset that runs as a BullMQ worker/queue.
export const allSources = await loadSources();
export const sources = allSources.filter((mod) => !mod.extractOnly);

/** Find any registered source module (including extract-only ones) by its `name`, or `undefined`. */
export function getSource(name) {
  return allSources.find((mod) => mod.name === name);
}
